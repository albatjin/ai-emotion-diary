// Vercel Serverless Function: /api/history
// Serverless Redis에 저장된 모든 일기 히스토리를 최신순으로 조회하여 반환합니다.

const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');

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

// Redis 클라이언트 싱글톤 인스턴스 (서버리스 웜 컨테이너 커넥션 재사용)
let redisClient = null;

function getRedisClient() {
  const redisUrl = getEnvValue('REDIS_URL');
  if (!redisUrl) {
    return null;
  }

  if (!redisClient) {
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      connectTimeout: 5000,
      lazyConnect: true,
      enableReadyCheck: false,
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

  try {
    const client = getRedisClient();
    if (!client) {
      console.warn('[Redis History] REDIS_URL 환경변수가 설정되지 않았습니다.');
      return res.status(200).json({
        success: true,
        count: 0,
        diaries: []
      });
    }

    if (client.status === 'wait') {
      await client.connect();
    }

    // 4. Redis에서 모든 일기 키('diary-*') 조회
    const keys = await client.keys('diary-*');

    if (!keys || keys.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        diaries: []
      });
    }

    // 5. MGET으로 모든 일기 데이터 한 번에 병렬 조회
    const rawDataList = await client.mget(keys);

    const diaries = [];
    for (let i = 0; i < rawDataList.length; i++) {
      const raw = rawDataList[i];
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          diaries.push(parsed);
        } catch {
          // JSON 파싱 에러 시 기본 구조로 폴백
          diaries.push({
            id: keys[i],
            diaryText: raw,
            aiReply: '',
            createdAt: ''
          });
        }
      }
    }

    // 6. 최신순 정렬 (ID 또는 createdAt 기준 내림차순)
    diaries.sort((a, b) => {
      const keyA = a.id || a.createdAt || '';
      const keyB = b.id || b.createdAt || '';
      return keyB.localeCompare(keyA);
    });

    // 7. 결과 반환
    return res.status(200).json({
      success: true,
      count: diaries.length,
      diaries: diaries
    });

  } catch (error) {
    console.error('[Redis History Handler Error]:', error);
    return res.status(500).json({
      success: false,
      error: '일기 히스토리를 불러오는 중 오류가 발생했습니다.'
    });
  }
};

