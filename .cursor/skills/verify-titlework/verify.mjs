#!/usr/bin/env node
// Verification harness for the Titlework Analyzer web UI.
// Starts an isolated server, drives it through headless Chrome, and tears down
// only the processes this run recorded.

import { spawn, execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readlinkSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const STRIP_ENV = [
  'NODE_ENV',
  'K_SERVICE',
  'K_REVISION',
  'CLOUD_RUN_REVISION',
  'RELEASE_VERSION',
  'DATABASE_URL',
  'POSTGRES_URL',
  'POSTGRES_PRISMA_URL',
  'APP_PASSWORD',
  'GCS_BUCKET',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'MODEL_PROVIDER',
  'INTERNAL_DRAIN_TOKEN',
];

function fail(error, extra = {}) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error), ...extra })}\n`);
  process.exit(1);
}

function succeed(payload) {
  process.stdout.write(`${JSON.stringify({ ok: true, ...payload })}\n`);
}

function parseArgs(argv) {
  const command = argv[0];
  if (!command) fail('Missing command. Use launch, doctor, browser, http, or cleanup.');
  const hasSub = command === 'browser' || command === 'http';
  const sub = hasSub ? argv[1] : null;
  if (hasSub && !sub) fail(`Missing ${command} subcommand.`);
  const rest = argv.slice(hasSub ? 2 : 1);
  const flags = {};
  const positionals = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
    } else positionals.push(token);
  }
  return { command, sub, flags, positionals };
}

function runDirFrom(flags) {
  const dir = flags['run-dir'];
  if (!dir || dir === true) fail('Pass --run-dir for this verification instance.');
  return resolve(String(dir));
}

function statePath(runDir) {
  return resolve(runDir, 'state.json');
}

function readState(runDir) {
  const path = statePath(runDir);
  if (!existsSync(path)) fail(`No state file at ${path}. Launch first.`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeState(runDir, state) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(statePath(runDir), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function cmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch {
    return '';
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listenerPids(port) {
  const hex = Number(port).toString(16).toUpperCase().padStart(4, '0');
  const inodes = new Set();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10) continue;
      const portHex = (parts[1].split(':').pop() || '').toUpperCase();
      if (parts[3] === '0A' && portHex === hex) inodes.add(parts[9]);
    }
  }
  if (!inodes.size) return { ok: true, pids: [] };
  const pids = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let fds = [];
    try {
      fds = readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const target = readlinkSync(`/proc/${entry}/fd/${fd}`);
        const match = /^socket:\[(\d+)\]$/.exec(target);
        if (match && inodes.has(match[1])) {
          pids.push(Number(entry));
          break;
        }
      } catch {
        // The fd can disappear while we read it.
      }
    }
  }
  return { ok: true, pids: [...new Set(pids)] };
}

function portFree(port) {
  return new Promise(resolveFree => {
    const server = net.createServer();
    server.once('error', () => resolveFree(false));
    server.listen(port, '0.0.0.0', () => {
      server.close(() => resolveFree(true));
    });
  });
}

function packageVersion() {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
  return pkg.version;
}

function chromeBinary() {
  const candidates = [process.env.CHROME_PATH, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const found = execFileSync('bash', ['-lc', `command -v ${JSON.stringify(candidate)}`], { encoding: 'utf8' }).trim();
      if (found) return found;
    } catch {
      // try the next candidate
    }
  }
  fail('Chrome is not on PATH. Set CHROME_PATH.');
  return '';
}

async function killRecorded(pid, marker) {
  if (!pid) return { pid, killed: false, reason: 'no pid' };
  if (!alive(pid)) return { pid, killed: false, reason: 'already exited' };
  const cmd = cmdline(pid);
  if (!cmd.includes(marker)) return { pid, killed: false, reason: 'cmdline mismatch', cmd };
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 25; i += 1) {
    if (!alive(pid)) return { pid, killed: true, signal: 'SIGTERM' };
    await delay(100);
  }
  if (alive(pid) && cmdline(pid).includes(marker)) process.kill(pid, 'SIGKILL');
  return { pid, killed: true, signal: 'SIGKILL' };
}

async function launch(flags) {
  const runDir = runDirFrom(flags);
  const port = Number(flags.port || 4173);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('--port must be an integer from 1024 to 65535.');
  if (port === 8080) fail('Refusing port 8080. That is the app default and may already be a user session.');
  if (existsSync(statePath(runDir))) {
    const existing = JSON.parse(readFileSync(statePath(runDir), 'utf8'));
    if (alive(existing.pid) && cmdline(existing.pid).includes('server.js')) {
      fail(`A verification server is already recorded in ${runDir}.`, { pid: existing.pid, baseUrl: existing.baseUrl });
    }
  }
  if (!(await portFree(port))) fail(`Port ${port} is already in use. Pick another port above 1024 other than 8080.`);

  mkdirSync(runDir, { recursive: true });
  const logPath = resolve(runDir, 'server.log');
  const logFd = openSync(logPath, 'a');
  const isolated = !flags['keep-env'];
  const env = isolated ? { ...process.env } : { ...process.env };
  if (isolated) {
    for (const key of STRIP_ENV) delete env[key];
  }
  const passwordConfigured = Boolean(flags.password && flags.password !== true);
  if (passwordConfigured) env.APP_PASSWORD = String(flags.password);
  env.PORT = String(port);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: repoRoot,
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  closeSync(logFd);

  const state = {
    pid: child.pid,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    logPath,
    runDir,
    repoRoot,
    isolated,
    passwordConfigured,
    chromePid: null,
    chromeDebugPort: null,
    pageId: null,
    userDataDir: resolve(runDir, 'chrome-profile'),
    startedAt: new Date().toISOString(),
  };
  writeState(runDir, state);

  const deadline = Date.now() + 15000;
  let lastError = 'server did not become ready';
  while (Date.now() < deadline) {
    if (!alive(child.pid)) {
      const log = existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-2000) : '';
      fail('Verification server exited before listen.', { log });
    }
    try {
      const response = await fetch(`${state.baseUrl}/api/healthz`);
      if (response.ok) {
        const body = await response.json();
        if (body.ok && body.service === 'title-analyzer') {
          succeed({
            baseUrl: state.baseUrl,
            pid: state.pid,
            port,
            isolated,
            passwordConfigured,
            version: body.release?.version || null,
            logPath,
          });
          return;
        }
      }
    } catch (err) {
      lastError = err?.message || String(err);
    }
    await delay(200);
  }
  fail(lastError, { logPath });
}

async function doctor(flags) {
  const runDir = runDirFrom(flags);
  const state = readState(runDir);
  const expectedVersion = `v${packageVersion()}`;
  const problems = [];
  if (!alive(state.pid)) problems.push('server pid is not running');
  const cmd = cmdline(state.pid);
  if (alive(state.pid) && !cmd.includes('server.js')) problems.push('server pid cmdline is not server.js');
  const listeners = listenerPids(state.port);
  if (!listeners.ok) problems.push(`could not inspect port ${state.port}: ${listeners.error}`);
  else if (!listeners.pids.includes(state.pid)) problems.push(`port ${state.port} listeners ${listeners.pids.join(',') || 'none'} do not include pid ${state.pid}`);

  let health = null;
  let pingStatus = null;
  try {
    const response = await fetch(`${state.baseUrl}/api/healthz`);
    health = await response.json();
    if (!response.ok || health.ok !== true || health.service !== 'title-analyzer') problems.push('healthz payload is not the title-analyzer service');
    if (health?.release?.version !== expectedVersion) problems.push(`version ${health?.release?.version} != ${expectedVersion}`);
  } catch (err) {
    problems.push(`healthz request failed: ${err?.message || err}`);
  }
  if (state.passwordConfigured) {
    // An unauthenticated ping counts as a failed password attempt (limit 5).
    pingStatus = null;
  } else {
    try {
      const response = await fetch(`${state.baseUrl}/api/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ping: true }),
      });
      pingStatus = response.status;
    } catch (err) {
      problems.push(`analyze ping failed: ${err?.message || err}`);
    }
  }
  try {
    const home = await fetch(state.baseUrl);
    const html = await home.text();
    if (!html.includes('<title>Mineral Title Analyzer</title>') || !html.includes('<h1>Mineral Ownership Builder</h1>')) {
      problems.push('home page is missing the Mineral Title Analyzer title or Mineral Ownership Builder heading');
    }
  } catch (err) {
    problems.push(`home request failed: ${err?.message || err}`);
  }

  const report = {
    baseUrl: state.baseUrl,
    pid: state.pid,
    port: state.port,
    listenerPids: listeners.pids,
    version: health?.release?.version || null,
    expectedVersion,
    isolated: state.isolated,
    passwordConfigured: state.passwordConfigured,
    passwordRequired: state.passwordConfigured || pingStatus === 401,
    analyzePingStatus: pingStatus,
    service: health?.service || null,
    problems,
  };
  if (problems.length) fail('doctor failed', report);
  succeed(report);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || 'cdp error'));
      else resolve(message.result || {});
    });
  }

  send(method, params = {}, timeoutMs = 15000) {
    const id = this.next;
    this.next += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket open timeout')), 10000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`websocket failed for ${wsUrl}`));
    }, { once: true });
  });
  return new Cdp(ws);
}

async function ensureChrome(state, runDir) {
  if (state.chromeDebugPort) {
    const listeners = listenerPids(state.chromeDebugPort);
    if (listeners.ok && listeners.pids.length && alive(state.chromePid)) return state;
  }
  mkdirSync(state.userDataDir, { recursive: true });
  const logPath = resolve(runDir, 'chrome.log');
  const logFd = openSync(logPath, 'a');
  const child = spawn(chromeBinary(), [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--window-size=1280,1600',
    `--user-data-dir=${state.userDataDir}`,
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    'about:blank',
  ], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  closeSync(logFd);

  const portFile = resolve(state.userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + 15000;
  let debugPort = 0;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const [line] = readFileSync(portFile, 'utf8').split('\n');
      debugPort = Number(line);
      if (debugPort) break;
    }
    if (!alive(child.pid)) fail('Chrome exited during startup.', { logPath });
    await delay(100);
  }
  if (!debugPort) fail('Chrome did not write DevToolsActivePort.', { logPath });
  const listeners = listenerPids(debugPort);
  state.chromeDebugPort = debugPort;
  state.chromePid = listeners.pids[0] || child.pid;
  state.chromeSpawnPid = child.pid;
  state.pageId = null;
  writeState(runDir, state);
  return state;
}

async function withPage(state, runDir, fn) {
  await ensureChrome(state, runDir);
  const listResponse = await fetch(`http://127.0.0.1:${state.chromeDebugPort}/json/list`);
  const list = await listResponse.json();
  let page = list.find(target => target.id === state.pageId && target.type === 'page' && target.webSocketDebuggerUrl);
  if (!page) page = list.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
  if (!page) {
    const created = await fetch(`http://127.0.0.1:${state.chromeDebugPort}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
    if (!created.ok) fail(`Chrome json/new failed with ${created.status}.`);
    page = await created.json();
  }
  if (page.id !== state.pageId) {
    state.pageId = page.id;
    writeState(runDir, state);
  }
  const cdp = await connectCdp(page.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');
    return await fn(cdp);
  } finally {
    cdp.close();
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluate failed';
    throw new Error(text);
  }
  return result.result?.value;
}

function queryExpression(selector, body) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { found: false };
    ${body}
  })()`;
}

async function browser(flags, sub) {
  const runDir = runDirFrom(flags);
  const state = readState(runDir);
  const selector = flags.selector && flags.selector !== true ? String(flags.selector) : '';
  const timeout = Number(flags.timeout || (sub === 'open' || sub === 'goto' ? 30000 : 15000));

  if (sub === 'open' || sub === 'goto') {
    const url = String(flags.url || '');
    if (!url) fail(`browser ${sub} requires --url.`);
    await withPage(state, runDir, async cdp => {
      const loaded = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for page load')), timeout);
        const onMessage = event => {
          const message = JSON.parse(event.data);
          if (message.method === 'Page.loadEventFired') {
            clearTimeout(timer);
            cdp.ws.removeEventListener('message', onMessage);
            resolve();
          }
        };
        cdp.ws.addEventListener('message', onMessage);
      });
      await cdp.send('Page.navigate', { url });
      await loaded;
    });
    succeed({ url });
    return;
  }

  if (sub === 'wait') {
    if (!selector) fail('browser wait requires --selector.');
    const expectText = flags.text && flags.text !== true ? String(flags.text) : null;
    const deadline = Date.now() + timeout;
    let last = null;
    while (Date.now() < deadline) {
      last = await withPage(state, runDir, cdp => evaluate(cdp, queryExpression(selector, `
        const style = getComputedStyle(el);
        const visible = style.display !== 'none' && style.visibility !== 'hidden';
        return { found: true, visible, text: el.innerText || '' };
      `)));
      const found = last?.found;
      const visibleOk = flags.hidden ? found && last.visible === false : flags.visible ? found && last.visible === true : found;
      const textOk = expectText == null || String(last?.text || '').includes(expectText);
      if (visibleOk && textOk) {
        succeed({ selector, ...last });
        return;
      }
      await delay(200);
    }
    fail(`timed out waiting for ${selector}`, { last });
  }

  if (sub === 'fill') {
    if (!selector) fail('browser fill requires --selector.');
    if (flags.value === undefined || flags.value === true) fail('browser fill requires --value.');
    const value = await withPage(state, runDir, cdp => evaluate(cdp, queryExpression(selector, `
      el.focus();
      el.value = ${JSON.stringify(String(flags.value))};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { found: true, value: el.value };
    `)));
    if (!value?.found) fail(`selector not found: ${selector}`);
    succeed({ selector, value: value.value });
    return;
  }

  if (sub === 'upload') {
    if (!selector) fail('browser upload requires --selector.');
    const file = flags.file && flags.file !== true ? resolve(String(flags.file)) : '';
    if (!file || !existsSync(file)) fail(`upload file not found: ${file}`);
    const uploaded = await withPage(state, runDir, async cdp => {
      const doc = await cdp.send('DOM.getDocument', { depth: 0 });
      const found = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
      if (!found.nodeId) throw new Error(`selector not found: ${selector}`);
      await cdp.send('DOM.setFileInputFiles', { nodeId: found.nodeId, files: [file] });
      return evaluate(cdp, queryExpression(selector, 'return { found: true, files: el.files ? el.files.length : 0 };'));
    });
    succeed({ selector, file, files: uploaded?.files ?? null });
    return;
  }

  if (sub === 'click') {
    if (!selector) fail('browser click requires --selector.');
    const clicked = await withPage(state, runDir, cdp => evaluate(cdp, queryExpression(selector, `
      if (el.disabled) return { found: true, clicked: false, disabled: true };
      el.click();
      return { found: true, clicked: true, disabled: false };
    `)));
    if (!clicked?.found) fail(`selector not found: ${selector}`);
    if (!clicked.clicked) fail(`selector is disabled: ${selector}`);
    succeed({ selector, clicked: true });
    return;
  }

  if (sub === 'text') {
    if (!selector) fail('browser text requires --selector.');
    const value = await withPage(state, runDir, cdp => evaluate(cdp, queryExpression(selector, 'return { found: true, text: el.innerText || "" };')));
    if (!value?.found) fail(`selector not found: ${selector}`);
    succeed({ selector, text: value.text });
    return;
  }

  if (sub === 'prop') {
    if (!selector || !flags.name || flags.name === true) fail('browser prop requires --selector and --name.');
    if (!/^[A-Za-z]+$/.test(String(flags.name))) fail('--name must be a plain property.');
    const value = await withPage(state, runDir, cdp => evaluate(cdp, queryExpression(selector, `return { found: true, value: el[${JSON.stringify(String(flags.name))}] };`)));
    if (!value?.found) fail(`selector not found: ${selector}`);
    succeed({ selector, name: flags.name, value: value.value });
    return;
  }

  if (sub === 'attr') {
    if (!selector || !flags.name || flags.name === true) fail('browser attr requires --selector and --name.');
    const value = await withPage(state, runDir, cdp => evaluate(cdp, queryExpression(selector, `return { found: true, value: el.getAttribute(${JSON.stringify(String(flags.name))}) };`)));
    if (!value?.found) fail(`selector not found: ${selector}`);
    succeed({ selector, name: flags.name, value: value.value });
    return;
  }

  if (sub === 'screenshot') {
    const path = flags.path && flags.path !== true ? resolve(String(flags.path)) : '';
    if (!path) fail('browser screenshot requires --path.');
    const image = await withPage(state, runDir, async cdp => {
      if (selector) {
        await evaluate(cdp, queryExpression(selector, 'el.scrollIntoView({ block: "center" }); return { found: true };'));
      }
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      return shot.data;
    });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(image, 'base64'));
    succeed({ path, bytes: Buffer.from(image, 'base64').length });
    return;
  }

  if (sub === 'snapshot') {
    const snapshot = await withPage(state, runDir, cdp => evaluate(cdp, `(() => {
      const shown = el => {
        if (!el) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      };
      const text = el => (el ? (el.innerText || '') : '');
      return {
        title: document.title,
        heading: document.querySelector('h1')?.innerText || '',
        hash: location.hash,
        version: document.querySelector('#appVersion')?.innerText || '',
        disclaimer: shown(document.querySelector('#disclaimer')),
        passwordGate: shown(document.querySelector('#passwordGate')),
        mainApp: shown(document.querySelector('#mainApp')),
        viewHome: shown(document.querySelector('#view-home')),
        viewJob: shown(document.querySelector('#view-job')),
        viewHistory: shown(document.querySelector('#view-history')),
        tract: document.querySelector('#tractDescription')?.value || '',
        notes: document.querySelector('#contextNotes')?.value || '',
        analyzeDisabled: document.querySelector('#analyzeBtn')?.disabled ?? null,
        analyzeLabel: document.querySelector('#analyzeBtn')?.innerText || '',
        fileList: text(document.querySelector('#fileList')),
        error: text(document.querySelector('#errorBox')),
        uploadVisible: shown(document.querySelector('#uploadSection')),
        progressVisible: shown(document.querySelector('#progressSection')),
        followupVisible: shown(document.querySelector('#followupSection')),
        jobFollowupVisible: shown(document.querySelector('#jobFollowup')),
        recentJobsLabel: text(document.querySelector('#recentJobsButton')),
        recentJobsDisabled: document.querySelector('#recentJobsButton')?.getAttribute('aria-disabled'),
        historyText: text(document.querySelector('#view-history')),
        jobHeader: text(document.querySelector('#jobHeader')),
      };
    })()`));
    if (flags.path && flags.path !== true) {
      const path = resolve(String(flags.path));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
    }
    succeed({ snapshot });
    return;
  }

  fail(`Unknown browser subcommand: ${sub}`);
}

async function httpCommand(flags, sub, positionals) {
  const runDir = runDirFrom(flags);
  const state = readState(runDir);
  const method = String(sub || 'GET').toUpperCase();
  const path = positionals[0];
  if (!path || !path.startsWith('/')) fail('http requires a path that starts with /.');
  const headers = {};
  if (flags.json && flags.json !== true) headers['content-type'] = 'application/json';
  if (flags.header && flags.header !== true) {
    const raw = String(flags.header);
    const splitAt = raw.indexOf(':');
    if (splitAt < 1) fail('--header must look like Name:value');
    headers[raw.slice(0, splitAt).trim().toLowerCase()] = raw.slice(splitAt + 1).trim();
  }
  const response = await fetch(`${state.baseUrl}${path}`, {
    method,
    headers,
    body: flags.json && flags.json !== true ? String(flags.json) : undefined,
  });
  const text = await response.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  const report = { method, path, status: response.status, body };
  if (flags.out && flags.out !== true) {
    const pathOut = resolve(String(flags.out));
    mkdirSync(dirname(pathOut), { recursive: true });
    writeFileSync(pathOut, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (flags.expect && Number(flags.expect) !== response.status) fail(`expected HTTP ${flags.expect}`, report);
  succeed(report);
}

async function cleanup(flags) {
  const runDir = runDirFrom(flags);
  if (!existsSync(statePath(runDir))) {
    succeed({ removed: false, reason: 'no state file' });
    return;
  }
  const state = readState(runDir);
  const chrome = await killRecorded(state.chromePid, 'chrome');
  const chromeSpawn = state.chromeSpawnPid && state.chromeSpawnPid !== state.chromePid
    ? await killRecorded(state.chromeSpawnPid, 'chrome')
    : null;
  const server = await killRecorded(state.pid, 'server.js');
  await rm(runDir, { recursive: true, force: true });
  succeed({ removed: runDir, server, chrome, chromeSpawn });
}

const parsed = parseArgs(process.argv.slice(2));
const runners = {
  launch: () => launch(parsed.flags),
  doctor: () => doctor(parsed.flags),
  browser: () => browser(parsed.flags, parsed.sub),
  http: () => httpCommand(parsed.flags, parsed.sub, parsed.positionals),
  cleanup: () => cleanup(parsed.flags),
};
if (!runners[parsed.command]) fail(`Unknown command: ${parsed.command}`);
runners[parsed.command]().catch(err => fail(err));
