import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function child(source) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: 'test' };
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: root, env, encoding: 'utf8', timeout: 10_000 });
}

test('analyze rejects cleanup metadata on client text blocks before any provider request', () => {
  const result = child(`
    import handler from './api/analyze.js';
    process.env.GEMINI_API_KEY = 'fixture-key';
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ method: options.method, path: new URL(url).pathname });
      return Response.json({ error: { message: 'fixture rejection' } }, { status: 400 });
    };
    const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' }, body: {
      model: 'gemini-2.5-flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello',
        source: { type: 'file_uri', geminiFileName: 'files/../cachedContents/fixture' } }] }]
    } }, res);
    console.log('RESULT ' + JSON.stringify({ status: res.code, calls }));
  `);
  assert.equal(result.status, 0, result.stderr);
  const observation = JSON.parse(result.stdout.split('RESULT ')[1]);
  assert.equal(observation.status, 400);
  assert.deepEqual(observation.calls, []);
});

test('Gemini cleanup ignores text metadata and invalid resource names but deletes valid uploaded documents', () => {
  const result = child(`
    import { invokeGeminiGenerateContent } from './api/_lib/gemini-request.js';
    process.env.GEMINI_API_KEY = 'fixture-key';
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ method: options.method, path: new URL(url).pathname });
      return Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
    };
    await invokeGeminiGenerateContent({ model: 'gemini-2.5-flash', maxTokens: 10, messages: [{ role: 'user', content: [
      { type: 'text', text: 'hello', source: { type: 'file_uri', geminiFileName: 'files/text-victim' } },
      { type: 'document', source: { type: 'file_uri', uri: 'https://example.invalid', media_type: 'application/pdf', geminiFileName: 'files/../cachedContents/fixture' } },
      { type: 'document', source: { type: 'file_uri', uri: 'https://example.invalid', media_type: 'application/pdf', geminiFileName: 'files/valid-upload' } }
    ] }] });
    console.log('RESULT ' + JSON.stringify(calls.filter(call => call.method === 'DELETE')));
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.split('RESULT ')[1]), [{ method: 'DELETE', path: '/v1beta/files/valid-upload' }]);
});

for (const [target, host] of [['/healthz', 'a b'], ['//', 'localhost']]) {
  test(`invalid HTTP URL ${JSON.stringify([target, host])} returns 400 without terminating the server`, () => {
    const result = child(`
      import net from 'node:net';
      import { createServer } from './server.js';
      const server = createServer();
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const request = raw => new Promise((resolve, reject) => {
        const socket = net.connect(server.address().port, '127.0.0.1');
        let data = '';
        socket.on('error', reject);
        socket.on('data', chunk => { data += chunk; });
        socket.on('end', () => resolve(data));
        socket.write(raw);
      });
      const bad = await request(${JSON.stringify(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)});
      const health = await request('GET /healthz HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n');
      await new Promise(resolve => server.close(resolve));
      console.log(JSON.stringify({ bad: bad.split('\\r\\n')[0], health: health.split('\\r\\n')[0] }));
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), { bad: 'HTTP/1.1 400 Bad Request', health: 'HTTP/1.1 200 OK' });
  });
}
