import { createServer } from '../server.js';

const port = 3456;
const server = createServer();

server.listen(port, '127.0.0.1', () => {
  console.log(`Smoke test server listening on http://127.0.0.1:${port}`);
});
