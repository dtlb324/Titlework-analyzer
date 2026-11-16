import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { getClientIp } from '../api/_lib/client-ip.js';
import { createServer } from '../server.js';
import { resetJobRateLimits } from '../api/_lib/jobs.js';
import { processAbstractionBatch } from '../api/_lib/queue.js';
import { processMultiChunkAbstraction } from '../api/_lib/abstraction-batch.js';
import { readObject } from '../api/_lib/storage.js';
import { Readable } from 'node:stream';

function httpRequest(server, path, headers = {}, method = 'POST', body = '{"ping":true}') {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, path, method, headers: { 'content-type': 'application/json', ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function restoreEnv(key, previous) {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

function queueFixture(count = 1, overrides = {}) {
  const chunks = Array.from({ length: count }, (_, i) => ({
    id: `chk_security_${i}`, jobId: 'job_security', documentId: `doc_security_${i}`, chunkOrder: i,
    originalFilename: `security-${i}.csv`, mediaType: 'text/csv', sizeBytes: 32,
    blobKey: `jobs/job_security/chunks/chk_security_${i}/source.csv`,
    blobUrl: `gs://synthetic-bucket/jobs/job_security/chunks/chk_security_${i}/source.csv`,
    uploadStatus: 'uploaded', abstractionStatus: 'pending', abstractionAttempts: 0, ...overrides,
  }));
  const job = { id: 'job_security', status: 'abstracting' };
  const saved = [];
  const store = {
    async getJob() { return job; },
    async listChunks() { return chunks; },
    async claimChunkForAbstraction(_jobId, id, { workerId }) {
      const chunk = chunks.find(value => value.id === id);
      if (chunk.abstractionStatus !== 'pending' && !(chunk.abstractionStatus === 'processing' && chunk.abstractionWorkerId === workerId)) return null;
      if (chunk.abstractionStatus === 'pending') chunk.abstractionAttempts += 1;
      chunk.abstractionStatus = 'processing';
      chunk.abstractionWorkerId = workerId;
      return { ...chunk };
    },
    async markChunkAbstractionFailed(_jobId, id, failure) {
      const chunk = chunks.find(value => value.id === id);
      chunk.abstractionStatus = 'failed';
      chunk.failure = failure;
      return chunk;
    },
    async saveDocumentAbstract(record) {
      const chunk = chunks.find(value => value.id === record.chunkId);
      chunk.abstractionStatus = 'completed';
      saved.push(record);
      return record;
    },
    async getAbstractionStatus() {
      return { job, total: chunks.length, pending: chunks.filter(value => value.abstractionStatus === 'pending').length, processing: 0, failed: chunks.filter(value => value.abstractionStatus === 'failed').length, completed: saved.length, retry_wait: 0 };
    },
  };
  return { chunks, saved, store, job };
}

test('queue rejects oversized registered CSV before reading the object', async () => {
  const fixture = queueFixture(1, { sizeBytes: 100 * 1024 * 1024 });
  let reads = 0;
  let modelCalls = 0;
  const result = await processAbstractionBatch(fixture.job.id, {
    store: fixture.store, concurrency: 1, batchLimit: 1, budgetMs: 1000,
    objectReader: async () => { reads += 1; throw new Error('oversized object must never be requested'); },
    modelClient: async () => { modelCalls += 1; throw new Error('model must never run'); },
  });
  assert.equal(reads, 0, 'raw size admission must precede storage download on the actual queue path');
  assert.equal(modelCalls, 0);
  assert.equal(result.failedInBatch, 1);
  assert.equal(fixture.chunks[0].failure.errorType, 'payload_too_large');
});

test('queue object-reader hooks remain below raw-size admission', async () => {
  const fixture = queueFixture(1, { sizeBytes: 100 * 1024 * 1024 });
  const previous = globalThis.__TITLE_ANALYZER_OBJECT_READER__;
  let reads = 0;
  globalThis.__TITLE_ANALYZER_OBJECT_READER__ = async () => { reads += 1; throw new Error('must not read'); };
  try {
    await processAbstractionBatch(fixture.job.id, { store: fixture.store, budgetMs: 1000, maxAttempts: 1 });
    assert.equal(reads, 0);
    assert.equal(fixture.chunks[0].failure.errorType, 'payload_too_large');
  } finally {
    if (previous === undefined) delete globalThis.__TITLE_ANALYZER_OBJECT_READER__;
    else globalThis.__TITLE_ANALYZER_OBJECT_READER__ = previous;
  }
});

const safeAbstract = 'DOC TYPE: Deed\nGRANTOR: A\nGRANTEE: B\nFRACTION CONVEYED: 100%\nLEGAL DESC: Test tract\nISSUES: none noted\nCONFIDENCE: High, all fields clearly legible.';

test('queue admits at most 128 MB of raw inputs before earlier model work finishes', async () => {
  const fixture = queueFixture(16, { sizeBytes: 17_000_000 });
  const previous = process.env.ABSTRACTION_BATCH_ENABLED;
  process.env.ABSTRACTION_BATCH_ENABLED = 'false';
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const reads = [];
  let calls = 0;
  const work = processAbstractionBatch(fixture.job.id, {
    store: fixture.store, concurrency: 16, batchLimit: 64, budgetMs: 2000,
    objectReader: async chunk => { reads.push(chunk.id); return { bytes: Buffer.from('A,1'), mediaType: 'text/csv' }; },
    modelClient: async () => { calls += 1; await gate; return { text: safeAbstract, model: 'synthetic', usage: {} }; },
  });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert(reads.length > 0 && reads.length * 17_000_000 <= 128_000_000, 'raw reservations must stay bounded while model work retains earlier buffers');
    assert.equal(fixture.chunks[7].abstractionStatus, 'pending', 'unadmitted work must not consume its lease');
  } finally {
    release();
    await work;
    restoreEnv('ABSTRACTION_BATCH_ENABLED', previous);
  }
  assert.equal(fixture.saved.length, 16);
  assert.equal(calls, 16, 'raw admission must not add model retries');
});

test('queue releases successful read cache entries between ready-list passes', async () => {
  const fixture = queueFixture(2);
  fixture.chunks[1].blobUrl = fixture.chunks[0].blobUrl;
  fixture.chunks[1].blobKey = fixture.chunks[0].blobKey;
  fixture.chunks[1].originalFilename = fixture.chunks[0].originalFilename;
  const previous = process.env.ABSTRACTION_BATCH_ENABLED;
  process.env.ABSTRACTION_BATCH_ENABLED = 'false';
  let reads = 0;
  try {
    const result = await processAbstractionBatch(fixture.job.id, {
      store: fixture.store, concurrency: 1, batchLimit: 1, budgetMs: 2000,
      objectReader: async () => { reads += 1; return { bytes: Buffer.from('A,1'), mediaType: 'text/csv' }; },
      modelClient: async () => ({ text: safeAbstract, model: 'synthetic', usage: {} }),
    });
    assert.equal(result.completedInBatch, 2);
    assert.equal(reads, 2, 'a completed wave must not keep a buffer alive for a later wave');
  } finally {
    restoreEnv('ABSTRACTION_BATCH_ENABLED', previous);
  }
});

test('queue rejects understated bytes and does not let a cache hit bypass a stricter limit', async () => {
  const fixture = queueFixture(2, { sizeBytes: 4 });
  fixture.chunks[1].blobUrl = fixture.chunks[0].blobUrl;
  fixture.chunks[1].blobKey = fixture.chunks[0].blobKey;
  fixture.chunks[1].originalFilename = fixture.chunks[0].originalFilename;
  fixture.chunks[1].sizeBytes = 2;
  const previous = process.env.ABSTRACTION_BATCH_ENABLED;
  process.env.ABSTRACTION_BATCH_ENABLED = 'false';
  try {
    const result = await processAbstractionBatch(fixture.job.id, {
      store: fixture.store, concurrency: 1, batchLimit: 2, budgetMs: 1000,
      objectReader: async () => ({ bytes: Buffer.from('ABCD'), mediaType: 'text/csv' }),
      modelClient: async () => ({ text: safeAbstract, model: 'synthetic', usage: {} }),
    });
    assert.equal(result.completedInBatch, 1);
    assert.equal(result.failedInBatch, 1);
    assert.equal(fixture.chunks[1].failure.errorType, 'payload_too_large');
  } finally {
    restoreEnv('ABSTRACTION_BATCH_ENABLED', previous);
  }
});

test('batched queue rejects oversized declared inputs without a read or model call', async () => {
  const fixture = queueFixture(2, { sizeBytes: 101_000_000, mediaType: 'application/pdf', originalFilename: 'security.pdf' });
  let reads = 0;
  let calls = 0;
  const previous = process.env.ABSTRACTION_BATCH_ENABLED;
  delete process.env.ABSTRACTION_BATCH_ENABLED;
  try {
    const result = await processAbstractionBatch(fixture.job.id, {
      store: fixture.store, maxAttempts: 1, budgetMs: 1000,
      objectReader: async () => { reads += 1; throw new Error('must not read'); },
      modelClient: async () => { calls += 1; throw new Error('must not call model'); },
    });
    assert.equal(result.failedInBatch, 2);
    assert.equal(reads, 0);
    assert.equal(calls, 0);
    assert(fixture.chunks.every(chunk => chunk.failure.errorType === 'payload_too_large'));
  } finally {
    restoreEnv('ABSTRACTION_BATCH_ENABLED', previous);
  }
});

test('unknown-size inputs reserve their full media limit before a later wave starts', async () => {
  const fixture = queueFixture(16, { sizeBytes: 0 });
  const previous = process.env.ABSTRACTION_BATCH_ENABLED;
  process.env.ABSTRACTION_BATCH_ENABLED = 'false';
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let reads = 0;
  const work = processAbstractionBatch(fixture.job.id, {
    store: fixture.store, concurrency: 16, batchLimit: 64, budgetMs: 2000,
    objectReader: async () => { reads += 1; return { bytes: Buffer.from('A,1'), mediaType: 'text/csv' }; },
    modelClient: async () => { await gate; return { text: safeAbstract, model: 'synthetic', usage: {} }; },
  });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert(reads > 0 && reads * 17_650_000 <= 128_000_000);
    assert.equal(fixture.chunks[7].abstractionStatus, 'pending');
  } finally {
    release();
    await work;
    restoreEnv('ABSTRACTION_BATCH_ENABLED', previous);
  }
  assert.equal(fixture.saved.length, 16);
});

test('queue cancellation leaves later raw waves unclaimed', async () => {
  const fixture = queueFixture(16, { sizeBytes: 17_000_000 });
  const previous = process.env.ABSTRACTION_BATCH_ENABLED;
  process.env.ABSTRACTION_BATCH_ENABLED = 'false';
  try {
    await processAbstractionBatch(fixture.job.id, {
      store: fixture.store, concurrency: 1, batchLimit: 64, budgetMs: 2000,
      objectReader: async () => ({ bytes: Buffer.from('A,1'), mediaType: 'text/csv' }),
      modelClient: async () => { fixture.job.status = 'canceled'; return { text: safeAbstract, model: 'synthetic', usage: {} }; },
    });
    assert(fixture.chunks.slice(7).every(chunk => chunk.abstractionStatus === 'pending' && chunk.abstractionAttempts === 0));
  } finally {
    restoreEnv('ABSTRACTION_BATCH_ENABLED', previous);
  }
});

test('bounded storage reads accept the ceiling and stop an oversized stream', async () => {
  const { chunks } = queueFixture();
  for (const overflow of [false, true]) {
    let closed = false;
    const stream = Readable.from((async function* () {
      try {
        yield Buffer.from('AB');
        yield Buffer.from('CD');
        if (overflow) yield Buffer.from('E');
      } finally {
        closed = true;
      }
    })());
    const bucket = {
      file() {
        return {
          createReadStream: () => stream,
          download() { throw new Error('unbounded download must not be used'); },
          getMetadata: async () => [{ contentType: 'text/csv', size: '1' }],
        };
      },
    };
    const result = readObject(chunks[0], { bucket, config: { bucket: 'synthetic-bucket' }, maxBytes: 4 });
    if (overflow) await assert.rejects(result, error => error.status === 413);
    else assert.equal((await result).bytes.toString(), 'ABCD');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, true);
    assert.equal(stream.destroyed, true);
  }
});

test('batch fallback waits for every preparation sibling to settle', async () => {
  const fixture = queueFixture(2);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const reads = [0, 0];
  let modelCalls = 0;
  const work = processMultiChunkAbstraction(fixture.chunks, {
    store: fixture.store, workerId: 'wkr_security', escalationEnabled: false,
    blobLoader: async chunk => {
      const index = chunk.chunkOrder;
      reads[index] += 1;
      if (reads[index] === 1 && index === 0) throw new Error('synthetic preparation failure');
      if (reads[index] === 1 && index === 1) await gate;
      return { bytes: Buffer.from('A,1'), mediaType: 'text/csv' };
    },
    modelClient: async () => { modelCalls += 1; return { text: safeAbstract, model: 'synthetic', usage: {} }; },
  });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reads, [1, 1], 'failed preparation must not start fallback while a sibling still owns work');
    assert.equal(modelCalls, 0);
  } finally {
    release();
    await work;
  }
  assert.equal(fixture.saved.length, 2, 'the established singles fallback must remain usable');
  assert.equal(modelCalls, 2);
});

test('manual smoke server contains raw and encoded traversal while serving public files', async () => {
  const smokeUrl = new URL('./smoke-server.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { Server } from 'node:net';
    const listen = Server.prototype.listen;
    Server.prototype.listen = function (...args) {
      if (args[0] === 3456) args[0] = 0;
      this.once('listening', () => console.log('SMOKE_ADDRESS=' + JSON.stringify(this.address())));
      return listen.apply(this, args);
    };
    await import(${JSON.stringify(smokeUrl)});
  `], { env: { PATH: process.env.PATH, NODE_ENV: 'test', APP_PASSWORD: 'synthetic-smoke-password' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  let output = '';
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  try {
    const address = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`smoke listener did not start: ${errors}`)), 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`smoke exited ${code}: ${errors}`)); });
      child.stdout.on('data', data => {
        output += data;
        const line = output.split('\n').find(value => value.startsWith('SMOKE_ADDRESS='));
        if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice('SMOKE_ADDRESS='.length))); }
      });
    });
    const server = { address: () => address };
    const normal = await httpRequest(server, '/', {}, 'GET', '');
    assert.equal(normal.status, 200);
    assert.match(normal.text, /Mineral/);
    for (const path of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/..%2fpackage.json?ignored=yes']) {
      const response = await httpRequest(server, path, {}, 'GET', '');
      assert(!response.text.includes('"name": "title-analyzer"'), `${path} must not return the source manifest`);
    }
    assert.equal(address.address, '127.0.0.1', 'the manual utility must bind only loopback');
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
});

test('standalone password lockout ignores rotating forwarded headers', async () => {
  const previousPassword = process.env.APP_PASSWORD;
  const previousService = process.env.K_SERVICE;
  delete process.env.K_SERVICE;
  process.env.APP_PASSWORD = 'synthetic-security-regression-password';
  resetJobRateLimits();
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (let i = 0; i < 5; i++) {
      const response = await httpRequest(server, '/api/analyze', { 'x-app-password': 'wrong', 'x-forwarded-for': `198.51.100.${i + 1}` });
      assert.equal(response.status, 401);
    }
    const locked = await httpRequest(server, '/api/analyze', { 'x-app-password': 'wrong', 'x-forwarded-for': '192.0.2.200, 203.0.113.201' });
    assert.equal(locked.status, 429, 'changing the complete forwarded chain must not reset a direct peer lockout');
    resetJobRateLimits();
    const valid = await httpRequest(server, '/api/analyze', { 'x-app-password': process.env.APP_PASSWORD, 'x-forwarded-for': 'attacker-label' });
    assert.equal(valid.status, 200);
    assert.equal(JSON.parse(valid.text).ok, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
    resetJobRateLimits();
    restoreEnv('APP_PASSWORD', previousPassword);
    restoreEnv('K_SERVICE', previousService);
  }
});

test('standalone client identity uses the socket for every forwarded representation', () => {
  const previous = process.env.K_SERVICE;
  const previousNode = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    for (const service of [undefined, '', '   ']) {
      restoreEnv('K_SERVICE', service);
      for (const forwarded of ['198.51.100.1', '198.51.100.2, 203.0.113.3', ['198.51.100.4', '203.0.113.5'], '', ' , ']) {
        const headers = { 'x-forwarded-for': forwarded, 'x-real-ip': '203.0.113.77', forwarded: 'for=203.0.113.78' };
        assert.equal(getClientIp({ headers, socket: { remoteAddress: '192.0.2.9' } }), '192.0.2.9');
        assert.equal(getClientIp({ headers, socket: { remoteAddress: '192.0.2.10' } }), '192.0.2.10');
        assert.equal(getClientIp({ headers }), 'unknown');
      }
    }
  } finally {
    restoreEnv('K_SERVICE', previous);
    restoreEnv('NODE_ENV', previousNode);
  }
});

test('Cloud Run preserves its appended final hop and socket fallback', () => {
  const previous = process.env.K_SERVICE;
  process.env.K_SERVICE = 'synthetic-cloud-run-api';
  try {
    for (const forwarded of ['198.51.100.1, 203.0.113.9', '192.0.2.2, 198.51.100.8, 203.0.113.9', ['192.0.2.3', '203.0.113.9']]) {
      assert.equal(getClientIp({ headers: { 'x-forwarded-for': forwarded }, socket: { remoteAddress: '10.0.0.1' } }), '203.0.113.9');
    }
    assert.equal(getClientIp({ headers: {}, socket: { remoteAddress: '10.0.0.1' } }), '10.0.0.1');
  } finally {
    restoreEnv('K_SERVICE', previous);
  }
});
