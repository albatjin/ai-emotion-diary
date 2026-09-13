// Vercel Serverless Function: /api/history
// Serverless Redis에 저장된 모든 일기 히스토리를 최신순으로 조회하여 반환합니다.

const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');
const { verifyAuthToken } = require('../lib/supabase');

// 환경변수 로더 (Vercel 환경 및 로컬 .env.* 지원)
function getEnvValue(key) {
  if (process.env[key] && process.env[key].trim() !== '') {
    return process.env[key].trim();
  }

  const envFiles = [
    '.env.production.local',
    '.env.local',
    '.env.development.local',
    '.env'
  ];

  for (const file of envFiles) {
    try {
      const filePath = path.join(process.cwd(), file);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        for (const line of content.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#')) {
            const [k, ...vParts] = trimmed.split('=');
            if (k.trim() === key) {
              const val = vParts.join('=').trim().replace(/^['"]|['"]$/g, '');
              if (val && val !== '[SENSITIVE]') {
                return val;
              }
            }
          }
        }
      }
    } catch {
      // 파일 읽기 실패 무시
    }
  }

  return null;
}

// Redis 연결 URL 조회
function getRedisUrl() {
  return (
    getEnvValue('REDIS_URL') ||
    getEnvValue('KV_URL') ||
    getEnvValue('UPSTASH_REDIS_URL') ||
    getEnvValue('REDIS_CONNECTION_STRING')
  );
}

// Redis 클라이언트 싱글톤 인스턴스 (서버리스 웜 컨테이너 커넥션 재사용)
let redisClient = null;

function getRedisClient() {
  const redisUrl = getRedisUrl();
  if (!redisUrl) {
    return null;
  }

  if (!redisClient) {
    const isTls = redisUrl.startsWith('rediss://');
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      connectTimeout: 8000,
      lazyConnect: true,
      enableReadyCheck: false,
      ...(isTls ? { tls: { rejectUnauthorized: false } } : {}),
      retryStrategy(times) {
        if (times > 3) return null;
        return Math.min(times * 100, 2000);
      }
    });

    redisClient.on('error', (err) => {
      console.warn('[Redis History Error]:', err.message);
    });
  }

  return redisClient;
}

// 로컬 파일(data/diaries.json)에서 일기 조회 (Redis 미설정 환경 지원, 엄격한 사용자별 격리)
function getLocalDiaries(userId) {
  try {
    const filePath = path.join(process.cwd(), 'data', 'diaries.json');
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const list = JSON.parse(content);
      if (Array.isArray(list)) {
        if (!userId) return [];
        // 오직 현재 로그인한 사용자 본인의 일기만 엄격하게 반환 (타인 또는 공용 일기 제외)
        return list.filter(item => item && item.userId === userId);
      }
    }
  } catch (e) {
    console.warn('[Local Diaries] 로컬 파일 읽기 오류:', e.message);
  }
  return [];
}

module.exports = async function handler(req, res) {
  // 1. CORS 및 보안 헤더 설정
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  // 2. OPTIONS 프리플라이트 요청 처리
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 3. GET 메서드만 허용
  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      error: '허용되지 않는 요청 메서드입니다. GET 방식을 사용해주세요.'
    });
  }

  // 4. 세션 토큰 검증 및 사용자 ID 확인
  const authHeader = req.headers.authorization || req.headers.Authorization;
  const authResult = await verifyAuthToken(authHeader);
  console.log('[History Debug] authHeader exists:', !!authHeader, 'authResult success:', authResult.success, 'userId:', authResult.userId);
  if (!authResult.success) {
    return res.status(401).json({
      success: false,
      error: authResult.error || '인증이 필요합니다. 다시 로그인해주세요.'
    });
  }
  const userId = authResult.userId;

  try {
    const client = getRedisClient();
    if (!client) {
      console.warn('[Redis History] REDIS_URL 미설정 -> 로컬 파일 저장소(data/diaries.json)에서 사용자별 일기를 조회합니다.');
      const localDiaries = getLocalDiaries(userId);
      console.log(`[History Debug] getLocalDiaries for userId '${userId}' returned count:`, localDiaries.length, 'IDs:', localDiaries.map(d => d.id));
      return res.status(200).json({
        success: true,
        count: localDiaries.length,
        diaries: localDiaries
      });
    }

    if (client.status === 'wait') {
      await client.connect();
    }

    // 5. Redis에서 현재 로그인 사용자의 일기 키 조회
    // 1) 신규 네임스페이스 키: user:[사용자ID]:diary-*
    const userPattern = `user:${userId}:diary-*`;
    const userKeys = (await client.keys(userPattern)) || [];

    // 2) 레거시 키: diary-* (기존 일기 중 본인 데이터 호환 복원)
    const legacyKeys = (await client.keys('diary-*')) || [];
    const allCandidateKeys = [...new Set([...userKeys, ...legacyKeys])];

    console.log(`[History Debug] Redis keys found: userKeys=${userKeys.length}, legacyKeys=${legacyKeys.length}`);

    if (!allCandidateKeys || allCandidateKeys.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        diaries: []
      });
    }

    // 6. MGET으로 모든 후보 일기 데이터 한 번에 병렬 조회
    const rawDataList = await client.mget(allCandidateKeys);
    console.log('[History Debug] allCandidateKeys:', allCandidateKeys);
    console.log('[History Debug] rawDataList:', rawDataList);

    const userDiaries = [];
    for (let i = 0; i < rawDataList.length; i++) {
      const raw = rawDataList[i];
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          // 💡 핵심: 오직 현재 로그인한 사용자 본인의 일기만 엄격하게 수집!
          if (parsed && parsed.userId === userId) {
            userDiaries.push(parsed);
          }
        } catch {
          // JSON 파싱 에러 무시
        }
      }
    }

    // 7. 최신순 정렬 (ID 또는 createdAt 기준 내림차순)
    userDiaries.sort((a, b) => {
      const keyA = a.id || a.createdAt || '';
      const keyB = b.id || b.createdAt || '';
      return keyB.localeCompare(keyA);
    });

    // 8. 결과 반환
    return res.status(200).json({
      success: true,
      count: userDiaries.length,
      diaries: userDiaries
    });

  } catch (error) {
    console.error('[Redis History Handler Error]:', error);
    return res.status(500).json({
      success: false,
      error: '일기 히스토리를 불러오는 중 오류가 발생했습니다.'
    });
  }
};

