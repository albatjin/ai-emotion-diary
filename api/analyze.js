// Vercel Serverless Function: /api/analyze
// 보안: GEMINI_API_KEY와 REDIS_URL은 Vercel 서버리스 환경(Node.js)에서만 안전하게 실행됩니다.

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

// Redis 클라이언트 싱글톤 인스턴스 (서버리스 웜 컨테이너에서 커넥션 재사용)
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
      console.warn('[Redis Client Warning]:', err.message);
    });
  }

  return redisClient;
}

// 현재 한국 시간(KST) 기준 고유 ID 생성 (예: 'diary-202609121600' 형식)
function generateDiaryId() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
  const kst = new Date(utc + (9 * 60 * 60 * 1000));

  const pad = (n) => String(n).padStart(2, '0');
  const year = kst.getFullYear();
  const month = pad(kst.getMonth() + 1);
  const day = pad(kst.getDate());
  const hours = pad(kst.getHours());
  const minutes = pad(kst.getMinutes());
  const seconds = pad(kst.getSeconds());

  return `diary-${year}${month}${day}${hours}${minutes}${seconds}`;
}

// Serverless Redis에 일기 데이터 묶음 저장 (Redis 미설정 시 로컬 파일 data/diaries.json에 자동 저장)
async function saveDiaryToRedis(diaryId, diaryData) {
  const client = getRedisClient();
  if (client) {
    try {
      if (client.status === 'wait') {
        await client.connect();
      }
      await client.set(diaryId, JSON.stringify(diaryData));
      console.log(`[Redis] 일기 데이터가 성공적으로 저장되었습니다. Key: ${diaryId}`);
      return { success: true, storage: 'redis' };
    } catch (err) {
      console.error('[Redis Error] 데이터 저장 중 오류 발생:', err.message);
    }
  }

  // Redis 미설정 또는 오류 시 로컬 파일(data/diaries.json)에 영구 저장
  try {
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const filePath = path.join(dataDir, 'diaries.json');
    let diaries = [];
    if (fs.existsSync(filePath)) {
      try {
        diaries = JSON.parse(fs.readFileSync(filePath, 'utf8')) || [];
      } catch {}
    }
    // 최신 일기를 맨 앞에 추가
    diaries.unshift(diaryData);
    fs.writeFileSync(filePath, JSON.stringify(diaries, null, 2), 'utf8');
    console.log(`[Local File] 일기 데이터가 data/diaries.json에 안전하게 저장되었습니다. Key: ${diaryId}`);
    return { success: true, storage: 'local_file' };
  } catch (fileErr) {
    console.error('[Local File Error] 로컬 파일 저장 실패:', fileErr.message);
    return { success: false, reason: fileErr.message };
  }
}

module.exports = async function handler(req, res) {
  // 1. CORS 및 보안 헤더 설정
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  // 2. OPTIONS 프리플라이트 요청 처리
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 3. POST 메서드만 허용
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: '허용되지 않는 요청 메서드입니다. POST 방식을 사용해주세요.'
    });
  }

  // 4. 인증 토큰 검증 (요청 헤더의 Authorization Bearer 토큰)
  const authHeader = req.headers.authorization || req.headers.Authorization;
  const authResult = await verifyAuthToken(authHeader);
  if (!authResult.success) {
    return res.status(401).json({
      success: false,
      error: authResult.error || '인증이 필요합니다. 로그인 후 다시 시도해주세요.'
    });
  }
  const userId = authResult.userId;

  try {
    // 4. 요청 본문 파싱 및 입력값 유효성 검사
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({
          success: false,
          error: '올바르지 않은 JSON 요청 형식입니다.'
        });
      }
    }

    const diaryText = (body?.diaryText || body?.content || '').trim();

    if (!diaryText) {
      return res.status(400).json({
        success: false,
        error: '일기 내용이 비어있습니다. 오늘 하루의 이야기를 입력해주세요.'
      });
    }

    if (diaryText.length > 5000) {
      return res.status(400).json({
        success: false,
        error: '일기 내용은 최대 5,000자까지 분석할 수 있습니다.'
      });
    }

    // 5. 서버 환경변수에서 Gemini API 키 확인
    const apiKey = getEnvValue('GEMINI_API_KEY');
    if (!apiKey || apiKey === 'your_gemini_api_key_here') {
      console.error('[Security/Config Error] GEMINI_API_KEY 환경변수가 설정되지 않았습니다.');
      return res.status(500).json({
        success: false,
        error: '서버에 AI API 설정이 완료되지 않았습니다. Vercel 환경변수(GEMINI_API_KEY)를 확인해주세요.'
      });
    }

    // 6. Gemini API 호출 (안정적인 모델 순차 시도)
    const targetModels = [
      'gemini-3.5-flash',
      'gemini-3.6-flash',
      'gemini-flash-latest'
    ];

    const prompt = `너는 심리상담가야. 사용자가 작성한 일기 내용을 읽고, 사용자의 감정을 한 단어(예: 기쁨, 슬픔, 분노, 불안, 평온)로 요약해줘. 그리고 그 감정에 공감해주고, 따뜻한 응원의 메시지를 2~3문장으로 작성해줘. 답변 형식은 반드시 '감정:[요약된 감정]\n\n[응원메시지]'와 같이 줄바꿈을 포함해서 보내줘.\n\n사용자 일기:\n${diaryText}`;

    let reply = null;
    let lastErrorMessage = '';

    for (const model of targetModels) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000);

      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const requestPayload = {
          contents: [
            {
              role: 'user',
              parts: [{ text: prompt }]
            }
          ],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 2048
          }
        };

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestPayload),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        const data = await response.json();

        if (!response.ok) {
          const apiError = data.error?.message || `HTTP ${response.status}`;
          throw new Error(apiError);
        }

        const candidateText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (candidateText && candidateText.trim()) {
          reply = candidateText.trim();
          break;
        }
      } catch (err) {
        clearTimeout(timeoutId);
        lastErrorMessage = (err.message || 'Unknown error').replace(new RegExp(apiKey, 'g'), '***');
        console.warn(`[Gemini API] 모델(${model}) 호출 실패:`, lastErrorMessage);
      }
    }

    if (!reply) {
      return res.status(502).json({
        success: false,
        error: `AI 분석 응답을 생성하지 못했습니다. (${lastErrorMessage})`
      });
    }

    // 7. 사용자 ID를 포함한 고유 키 생성 및 Serverless Redis에 일기 데이터 저장
    const diaryId = generateDiaryId();
    const redisKey = `user:${userId}:${diaryId}`;
    const createdAt = new Date().toISOString();
    const diaryData = {
      id: diaryId,
      key: redisKey,
      userId: userId,
      diaryText: diaryText,
      aiReply: reply,
      createdAt: createdAt
    };

    const redisResult = await saveDiaryToRedis(redisKey, diaryData);

    // 8. 성공 결과 반환 (프론트엔드 호환을 위해 reply 필드 유지 + 고유 ID 및 Redis 저장 상태 포함)
    return res.status(200).json({
      success: true,
      reply: reply,
      diaryId: diaryId,
      savedToRedis: redisResult.success
    });

  } catch (error) {
    console.error('[Serverless Handler Uncaught Error]:', error);
    return res.status(500).json({
      success: false,
      error: '서버 내부 오류가 발생했습니다. 잠시 후 다시 시도해주세요.'
    });
  }
};
