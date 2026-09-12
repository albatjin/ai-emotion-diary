const http = require('http');
const fs = require('fs');
const path = require('path');
const analyzeHandler = require('./api/analyze');

const PORT = process.env.PORT || 3000;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

// HTTP 서버 생성 (로컬 개발용 정적 서빙 및 Vercel 서버리스 함수 모의 실행)
const server = http.createServer(async (req, res) => {
  // Vercel Serverless Function 헬퍼 메서드 호환성 추가 (res.status, res.json)
  res.status = function (code) {
    this.statusCode = code;
    return this;
  };
  res.json = function (data) {
    this.setHeader('Content-Type', 'application/json; charset=utf-8');
    this.end(JSON.stringify(data));
    return this;
  };

  // API 엔드포인트: /api/analyze -> Vercel 서버리스 함수(api/analyze.js) 위임
  if (req.url === '/api/analyze') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      req.body = body;
      try {
        await analyzeHandler(req, res);
      } catch (err) {
        console.error('Serverless execution error:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: err.message });
        }
      }
    });
    return;
  }

  // CORS 프리플라이트 처리 (정적 자산 또는 기타 경로)
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.writeHead(204);
    res.end();
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
  console.log(`\n✨ AI 감정일기 로컬 서버 실행 중: http://localhost:${PORT}`);
  console.log(`⚡ 서버리스 함수 경로: /api/analyze (api/analyze.js)`);
  console.log(`🔒 GEMINI_API_KEY는 서버 사이드에서만 안전하게 사용됩니다.\n`);
});
