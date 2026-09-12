const http = require('http');
const fs = require('fs');
const path = require('path');

// .env 파일 동적 로드 함수 (요청 시마다 항상 최신 값을 읽음)
function getApiKey() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const envContent = fs.readFileSync(envPath, 'utf-8');
      for (const line of envContent.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx !== -1) {
            const key = trimmed.substring(0, eqIdx).trim();
            const val = trimmed.substring(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
            if (key === 'GEMINI_API_KEY') {
              return val;
            }
          }
        }
      }
    } catch (e) {
      console.error('.env 파일 읽기 오류:', e.message);
    }
  }
  return process.env.GEMINI_API_KEY || '';
}

const PORT = process.env.PORT || 3000;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

// Google Gemini API 호출 함수
async function analyzeWithGemini(diaryText) {
  const apiKey = getApiKey();
  if (!apiKey || apiKey.trim() === '' || apiKey === 'your_gemini_api_key_here') {
    throw new Error('GEMINI_API_KEY가 설정되지 않았습니다. .env 파일에 올바른 API 키를 입력해 주세요.');
  }

  // Gemini API 추천 모델 (gemini-3.6-flash 우선 시도)
  const models = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-flash-latest'];
  let lastError = null;

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const prompt = `너는 심리상담가야, 사용자가 작성한 일기 내용을 읽고, 사용자의 감정을 한 단어(예:기쁨, 슬픔,분노, 불안, 평온)로 요약해줘. 그리고 그 감정에 공감해주고, 따뜻한 응원의 메시지를 2~3문장으로 작성해줘, 답변 형식은 반드시 '감정:[요약된 감정]\n\n[응원메시지]'와 같이 줄바꿈을 포함해서 보내줘.\n\n사용자 일기:\n${diaryText}`;

    const requestBody = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: prompt
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 8192
      }
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      const data = await response.json();

      if (!response.ok) {
        const errorMsg = data.error?.message || `HTTP ${response.status} error`;
        throw new Error(errorMsg);
      }

      const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (reply) {
        return reply;
      }
    } catch (err) {
      lastError = err;
      console.warn(`[Gemini] ${model} 호출 실패, 다음 모델 시도 중:`, err.message);
    }
  }

  throw lastError || new Error('Gemini API 응답을 가져오지 못했습니다.');
}

// HTTP 서버 생성
const server = http.createServer(async (req, res) => {
  // CORS 및 공통 헤더
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API 엔드포인트: /api/analyze
  if (req.url === '/api/analyze' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { diaryText } = JSON.parse(body || '{}');
        if (!diaryText || !diaryText.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '일기 내용을 입력해주세요.' }));
          return;
        }

        const reply = await analyzeWithGemini(diaryText);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ reply }));
      } catch (error) {
        console.error('API Error:', error.message);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });
    return;
  }

  // 정적 파일 서빙 (index.html 등)
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500 Server Error');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  const currentKey = getApiKey();
  console.log(`\n✨ AI 감정일기 서버가 실행되었습니다!`);
  console.log(`🔑 GEMINI_API_KEY 상태: ${currentKey ? '✅ 설정 완료 (키 앞자리: ' + currentKey.substring(0, 5) + '...)' : '⚠️ 미설정 (.env 파일을 확인하세요)'}`);
  console.log(`👉 브라우저 접속 주소: http://localhost:${PORT}\n`);
});
