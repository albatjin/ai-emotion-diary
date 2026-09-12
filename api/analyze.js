// Vercel Serverless Function: /api/analyze
// 보안: GEMINI_API_KEY는 클라이언트에 절대 노출되지 않으며 Vercel 서버리스 환경(Node.js)에서만 안전하게 실행됩니다.

const fs = require('fs');
const path = require('path');

// 로컬 환경(.env) 및 Vercel 환경변수 지원 헬퍼
function getGeminiApiKey() {
  // 1. Vercel 서버리스 환경변수 우선
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim() !== '') {
    return process.env.GEMINI_API_KEY.trim();
  }

  // 2. 로컬 개발 환경용 (.env 파일 직접 파싱)
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const [k, ...vParts] = trimmed.split('=');
          if (k.trim() === 'GEMINI_API_KEY') {
            return vParts.join('=').trim().replace(/^['"]|['"]$/g, '');
          }
        }
      }
    }
  } catch {
    // 파일 시스템 읽기 불가 시 무시
  }

  return null;
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

    // 5. 서버 환경변수에서 Gemini API 키 확인 (클라이언트에는 절대 전달되지 않음)
    const apiKey = getGeminiApiKey();
    if (!apiKey || apiKey === 'your_gemini_api_key_here') {
      console.error('[Security/Config Error] GEMINI_API_KEY 환경변수가 설정되지 않았습니다.');
      return res.status(500).json({
        success: false,
        error: '서버에 AI API 설정이 완료되지 않았습니다. Vercel 환경변수(GEMINI_API_KEY)를 확인해주세요.'
      });
    }

    // 6. Gemini API 호출 (최신 및 안정화된 모델 목록을 순차 시도)
    const targetModels = [
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-flash-latest'
    ];

    const prompt = `너는 심리상담가야. 사용자가 작성한 일기 내용을 읽고, 사용자의 감정을 한 단어(예: 기쁨, 슬픔, 분노, 불안, 평온)로 요약해줘. 그리고 그 감정에 공감해주고, 따뜻한 응원의 메시지를 2~3문장으로 작성해줘. 답변 형식은 반드시 '감정:[요약된 감정]\n\n[응원메시지]'와 같이 줄바꿈을 포함해서 보내줘.\n\n사용자 일기:\n${diaryText}`;

    let reply = null;
    let lastErrorMessage = '';

    for (const model of targetModels) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // 15초 타임아웃 방지

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
          break; // 성공 시 루프 종료
        }
      } catch (err) {
        clearTimeout(timeoutId);
        // 에러 메시지 내 API 키 유출 방지 마스킹
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

    // 7. 성공 결과 반환 (reply 필드는 기존 프론트엔드와 100% 호환)
    return res.status(200).json({
      success: true,
      reply: reply
    });

  } catch (error) {
    console.error('[Serverless Handler Uncaught Error]:', error);
    return res.status(500).json({
      success: false,
      error: '서버 내부 오류가 발생했습니다. 잠시 후 다시 시도해주세요.'
    });
  }
};
