import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join, extname } from 'path';
import handler from '../api/analyze.js';

const root = join(import.meta.dirname, '..');
const port = 3456;

const mime = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  if (req.url === '/api/analyze' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const mockReq = {
      method: 'POST',
      body: JSON.parse(body || '{}'),
      headers: req.headers,
      socket: req.socket,
    };
    const mockRes = {
      statusCode: 200,
      setHeader(k, v) { res.setHeader(k, v); },
      status(code) { this.statusCode = code; return this; },
      json(data) {
        res.statusCode = this.statusCode;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(data));
      },
    };
    await handler(mockReq, mockRes);
    return;
  }

  const filePath = join(root, 'public', req.url === '/' ? 'index.html' : req.url);
  try {
    const data = readFileSync(filePath);
    res.setHeader('Content-Type', mime[extname(filePath)] || 'text/plain');
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
});

server.listen(port, () => {
  console.log(`Smoke test server listening on http://127.0.0.1:${port}`);
});
