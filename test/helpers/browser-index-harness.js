import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(join(root, 'public/index.html'), 'utf8');
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const scriptStart = html.lastIndexOf('<script>\nconst MAX_FILES') + '<script>\n'.length;
const scriptSource = html.slice(scriptStart, html.indexOf('</script>', scriptStart));

export class StubElement {
  constructor(id) {
    this.id = id;
    this.style = {};
    this.value = '';
    this.files = [];
    this.disabled = false;
    this.innerHTML = '';
    this.textContent = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.listeners = {};
    this.classList = { add() {}, remove() {}, contains: () => false };
  }

  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }

  listenerCount(name) { return (this.listeners[name] || []).length; }

  dispatch(name, event = {}) {
    const e = { target: this, preventDefault() {}, stopPropagation() {}, ...event };
    return Promise.all((this.listeners[name] || []).map(fn => fn(e)));
  }

  querySelectorAll() { return []; }
  querySelector() { return null; }
  setAttribute(k, v) { this[k] = v; }
  getAttribute(k) { return this[k] ?? null; }
  click() {}
  focus() {}
}

export const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

export const pngFile = (name, extra = '') =>
  new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...Buffer.from(extra)])], name, { type: 'image/png' });

export const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const loadedApps = [];

// Stops the page's timers so a still-polling page cannot keep the test process alive.
export function disposeAll() {
  loadedApps.splice(0).forEach(app => app.dispose());
}

export function loadIndex({ fetchImpl, log = [], storage = 'memory' }) {
  let disposed = false;
  const elements = new Map();
  const getEl = id => {
    if (!htmlIds.has(id)) return null;
    if (!elements.has(id)) elements.set(id, new StubElement(id));
    return elements.get(id);
  };
  const memoryStorage = () => {
    const map = new Map();
    return {
      getItem: key => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => map.set(key, String(value)),
      removeItem: key => map.delete(key),
    };
  };
  const realSetTimeout = globalThis.setTimeout;
  const sandbox = {
    document: {
      getElementById: getEl,
      hidden: false,
      addEventListener() {},
      querySelectorAll: () => [],
      createElement: () => new StubElement(''),
    },
    location: { hash: '', origin: 'https://harness.invalid', pathname: '/', search: '' },
    history: { replaceState() {} },
    sessionStorage: memoryStorage(),
    fetch: fetchImpl,
    File, Blob, TextEncoder, URLSearchParams, URL, Uint8Array, ArrayBuffer,
    crypto: webcrypto,
    console: {
      debug() {},
      log: (...a) => log.push(a.join(' ')),
      warn: (...a) => log.push('WARN ' + a.join(' ')),
      error: (...a) => log.push('ERR ' + a.join(' ')),
    },
    setTimeout: fn => (disposed ? 0 : realSetTimeout(fn, 0)),
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    alert: message => log.push('ALERT ' + message),
    confirm: () => true,
    FileReader: class {
      readAsDataURL(file) {
        file.arrayBuffer().then(buffer => {
          this.result = `data:${file.type};base64,${Buffer.from(buffer).toString('base64')}`;
          this.onload?.();
        }, error => this.onerror?.(error));
      }
      readAsText(file) { file.text().then(text => { this.result = text; this.onload?.(); }); }
    },
    Node: { TEXT_NODE: 3 },
    unescape, encodeURIComponent, Promise, Date, Math, JSON, Array, Object, Map, Set, String, Number, Error, RegExp,
    Boolean, Infinity, parseInt, isNaN,
  };
  if (storage === 'memory') sandbox.localStorage = memoryStorage();
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(scriptSource, context, { filename: 'public/index.html:inline-script' });
  const app = {
    ctx: context,
    run: code => vm.runInContext(code, context),
    getEl,
    log,
    dispose: () => { disposed = true; },
  };
  loadedApps.push(app);
  return app;
}

const ABSTRACT_REPLY = 'DOCUMENT #1:\nDOC TYPE: Deed\nGRANTOR: A\nCONFIDENCE: high\n\n## FINAL OWNERSHIP DETERMINATION\nA owns all.';

// Fake durable-job backend. Every POST /api/analyze is the billable provider call and is recorded.
export function makeJobServer({ hooks = {}, analyzeReply, abstractionReadyAfter = Infinity, synthesisReadyAfter = Infinity } = {}) {
  const server = {
    calls: [],
    analyze: [],
    state: { canceled: false, abstractionReads: 0, synthesisReads: 0, resultSaves: [], patches: [] },
  };
  server.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    const path = String(url).replace('https://harness.invalid', '');
    server.calls.push(`${method} ${path}`);
    const hook = hooks[`${method} ${path}`];
    if (hook) {
      const response = await hook(server, options);
      if (response) return response;
    }
    const st = server.state;
    if (path === '/api/analyze') {
      const body = JSON.parse(options.body);
      if (body.ping) return jsonResponse(200, {});
      const content = body.messages[0].content;
      server.analyze.push({ model: body.model, content: typeof content === 'string' ? content : JSON.stringify(content) });
      return jsonResponse(200, { content: [{ type: 'text', text: analyzeReply ? analyzeReply(body) : ABSTRACT_REPLY }] });
    }
    if (path === '/api/jobs' && method === 'POST') return jsonResponse(201, { job: { id: 'job_1', status: 'created' } });
    if (path === '/api/jobs/job_1' && method === 'PATCH') {
      const body = JSON.parse(options.body);
      st.patches.push(body);
      if (st.canceled && body.status && body.status !== 'canceled') return jsonResponse(409, { error: 'Invalid job status transition from canceled.' });
      return jsonResponse(200, { job: { id: 'job_1', status: body.status || 'abstracting', completedDocuments: body.completedDocuments || 0 } });
    }
    if (path === '/api/blob/upload' && method === 'GET') return jsonResponse(200, { available: true, maxUploadBytes: 1e9 });
    if (path === '/api/blob/upload' && method === 'POST') return jsonResponse(200, { upload: { uploadUrl: 'https://storage.invalid/up', method: 'PUT', headers: {}, blobKey: 'k1' } });
    if (path === 'https://storage.invalid/up') return jsonResponse(200, {});
    if (path === '/api/jobs/job_1/documents') return jsonResponse(200, { document: { id: 'doc_1' } });
    if (path === '/api/jobs/job_1/documents/doc_1/chunks') return jsonResponse(200, { chunk: { id: 'chunk_1' } });
    if (path === '/api/jobs/job_1/chunks/chunk_1') return jsonResponse(200, { chunk: { id: 'chunk_1' } });
    if (path === '/api/jobs/job_1/finalize-uploads') return jsonResponse(200, { job: { id: 'job_1', status: 'ready' } });
    if (path === '/api/jobs/job_1/abstraction/start') return jsonResponse(202, { status: { total: 1, pending: 1, processing: 0, completed: 0, failed: 0, retry_wait: 0 } });
    if (path === '/api/jobs/job_1/abstraction/process') return st.canceled ? jsonResponse(409, { error: 'Job has been canceled.' }) : jsonResponse(200, { status: { total: 1, pending: 1 } });
    if (path === '/api/jobs/job_1/abstraction/status') {
      if (st.canceled) return jsonResponse(200, { status: { total: 1, pending: 0, processing: 0, completed: 0, failed: 1, retry_wait: 0 } });
      st.abstractionReads++;
      if (st.abstractionReads > abstractionReadyAfter) return jsonResponse(200, { status: { total: 1, pending: 0, processing: 0, completed: 1, failed: 0, retry_wait: 0 } });
      return jsonResponse(200, { status: { total: 1, pending: 0, processing: 1, completed: 0, failed: 0, retry_wait: 0 } });
    }
    if (path === '/api/jobs/job_1/abstracts') {
      return jsonResponse(200, { abstracts: st.canceled ? [] : [{ sourceFilename: 'deed.png', abstract: 'DOC TYPE: Deed\nGRANTOR: A', chunkId: 'chunk_1', documentId: 'doc_1', chunkOrder: 0 }] });
    }
    if (path === '/api/jobs/job_1/synthesis/start') return jsonResponse(202, { status: { total: 1, pending: 0, processing: 0, complete: 0, failed: 0, mergeInProgress: true, mergeLeaseHeld: true, hasResult: false } });
    if (path === '/api/jobs/job_1/synthesis/process') return jsonResponse(200, { status: { total: 1, mergeInProgress: true, mergeLeaseHeld: true } });
    if (path === '/api/jobs/job_1/synthesis/status') {
      st.synthesisReads++;
      const ready = st.synthesisReads > synthesisReadyAfter;
      return jsonResponse(200, { status: { total: 1, pending: 0, processing: 0, complete: 1, failed: 0, mergeInProgress: !ready, mergeLeaseHeld: !ready, hasResult: ready } });
    }
    if (path === '/api/jobs/job_1/import-continuation') return jsonResponse(200, { imported: 1, nextChunkOrder: 1 });
    if (path === '/api/jobs/job_1/synthesis/preview') return jsonResponse(200, { preview: { text: '', bytesReceived: 0 } });
    if (path === '/api/jobs/job_1/result' && method === 'POST') {
      st.resultSaves.push(JSON.parse(options.body));
      return st.canceled ? jsonResponse(409, { error: 'Cannot save a result for a canceled job.' }) : jsonResponse(200, { ok: true });
    }
    if (path === '/api/jobs/job_1/result') {
      if (st.synthesisReads > synthesisReadyAfter) return jsonResponse(200, { result: { finalTitleOpinion: 'SERVER OPINION', warnings: [], failedDocuments: [] } });
      return jsonResponse(404, {});
    }
    if (path === '/api/jobs/job_1/cancel') { st.canceled = true; return jsonResponse(200, { job: { id: 'job_1', status: 'canceled' } }); }
    return jsonResponse(404, { error: `unmapped ${method} ${path}` });
  };
  return server;
}
