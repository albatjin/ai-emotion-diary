// Vercel Serverless Function: /api/analyze
// 사용자의 일기 내용을 받아 Google Gemini API로 감정을 분석하고 응답을 반환합니다.

module.exports = async function handler(req, res) {
  // CORS 헤더 설정
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  // OPTIONS 프리플라이트 요청 처리
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // POST 요청만 허용
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '허용되지 않은 메서드입니다. POST 요청을 사용해주세요.' });
  }

  try {
    // Vercel에서는 JSON 본문이 req.body에 자동으로 파싱됩니다.
    // 혹시 문자열로 들어오는 경우를 대비한 안전 처리
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const diaryText = body?.diaryText || body?.content;

    if (!diaryText || !diaryText.trim()) {
      return res.status(400).json({ error: '일기 내용(diaryText)을 입력해주세요.' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: 'GEMINI_API_KEY 환경변수가 설정되지 않았습니다. Vercel 대시보드의 Environment Variables 설정을 확인해주세요.'
      });
    }

    // Gemini API 호출 (최신 모델 우선 시도)
    const models = ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-flash-latest'];
    let reply = null;
    let lastError = null;

    const prompt = `너는 심리상담가야. 사용자가 작성한 일기 내용을 읽고, 사용자의 감정을 한 단어(예: 기쁨, 슬픔, 분노, 불안, 평온)로 요약해줘. 그리고 그 감정에 공감해주고, 따뜻한 응원의 메시지를 2~3문장으로 작성해줘. 답변 형식은 반드시 '감정:[요약된 감정]\n\n[응원메시지]'와 같이 줄바꿈을 포함해서 보내줘.\n\n사용자 일기:\n${diaryText}`;

    for (const model of models) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const requestBody = {
          contents: [
            {
              role: 'user',
              parts: [{ text: prompt }]
            }
          ],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1000
          }
        };

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error?.message || `HTTP ${response.status}`);
        }

        const candidateText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (candidateText) {
          reply = candidateText;
          break;
        }
      } catch (err) {
        lastError = err;
        console.warn(`[Gemini API] ${model} 모델 호출 실패, 대체 모델 시도:`, err.message);
      }
    }

    if (!reply) {
      throw lastError || new Error('Gemini API로부터 유효한 응답을 받지 못했습니다.');
    }

    // 성공 응답 반환
    return res.status(200).json({
      success: true,
      reply: reply
    });
  } catch (error) {
    console.error('Serverless Function Error:', error);
    return res.status(500).json({
      error: error.message || '서버 내부 오류가 발생했습니다.'
    });
  }
};

