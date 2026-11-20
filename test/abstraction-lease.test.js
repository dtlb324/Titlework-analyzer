import { readFileSync } from 'node:fs';
import {
  callLeaseMs,
  chunkLeaseLostError,
  isChunkLeaseLostError,
  renewChunkLease,
  renewChunkLeases,
} from '../api/_lib/abstraction-lease.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const chunk = { id: 'chk_1', jobId: 'job_1' };

test('callLeaseMs outlives one upstream call', () => {
  assert(callLeaseMs(300_000, 240_000) === 300_000, 'default queue lease already covers one call');
  assert(callLeaseMs(90_000, 240_000) === 300_000, 'short lease is raised to timeout + 60s');
  assert(callLeaseMs(900_000, 240_000) === 900_000, 'longer lease is kept');
});

test('lease-lost errors are recognisable and carry the chunk id', () => {
  const err = chunkLeaseLostError('chk_9');
  assert(isChunkLeaseLostError(err), 'lost error must be recognised');
  assert(err.chunkId === 'chk_9', 'chunk id is kept');
  assert(!isChunkLeaseLostError(new Error('timeout')), 'other errors are not lease errors');
  assert(!isChunkLeaseLostError(null), 'null is not a lease error');
});

test('renewChunkLease reports renewed, lost and unavailable', async () => {
  const seen = [];
  const owner = { async renewChunkAbstractionLease(jobId, chunkId, options) { seen.push([jobId, chunkId, options]); return { id: chunkId }; } };
  const taken = { async renewChunkAbstractionLease() { return null; } };
  assert(await renewChunkLease(owner, chunk, { workerId: 'wkr_A', leaseMs: 5000 }) === 'renewed', 'owner renews');
  assert(seen[0][0] === 'job_1' && seen[0][1] === 'chk_1' && seen[0][2].workerId === 'wkr_A' && seen[0][2].leaseMs === 5000, 'owner, job, chunk and lease are passed through');
  assert(await renewChunkLease(taken, chunk, { workerId: 'wkr_A', leaseMs: 5000 }) === 'lost', 'null means another worker owns it');
  assert(await renewChunkLease({}, chunk, { workerId: 'wkr_A', leaseMs: 5000 }) === 'unavailable', 'a store without the method cannot renew');
  assert(await renewChunkLease(null, chunk, { workerId: 'wkr_A', leaseMs: 5000 }) === 'unavailable', 'no store cannot renew');
});

test('renewChunkLease treats a store error as best effort and never logs its message', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = line => warnings.push(String(line));
  try {
    const failing = { async renewChunkAbstractionLease() { throw Object.assign(new Error('connect failed postgres://user:hunter2@db.example/neon Bearer tok_abc123'), { code: 'ECONNRESET' }); } };
    const outcome = await renewChunkLease(failing, chunk, { workerId: 'wkr_A', leaseMs: 5000 });
    assert(outcome === 'unavailable', `a failing renewal must not be treated as lost, got ${outcome}`);
  } finally {
    console.warn = originalWarn;
  }
  assert(warnings.length === 1, `expected one warning, got ${warnings.length}`);
  const parsed = JSON.parse(warnings[0]);
  assert(parsed.event === 'abstraction_chunk_lease_renew_failed' && parsed.chunkId === 'chk_1' && parsed.errorType === 'ECONNRESET', 'warning names the event, chunk and error code');
  assert(!/hunter2|tok_abc123|db\.example/.test(warnings[0]), 'the warning must not carry the store error message');
});

test('the Postgres renewal is owner- and status-checked', () => {
  const source = readFileSync(new URL('../api/_lib/jobs.js', import.meta.url), 'utf8');
  const start = source.indexOf('async renewChunkAbstractionLease(');
  assert(start > 0, 'renewChunkAbstractionLease must exist on the Postgres store');
  const end = source.indexOf('\n    async ', start + 10);
  const body = source.slice(start, end);
  assert(/abstraction_status = 'processing'/.test(body), 'only a processing chunk may be renewed');
  assert(/abstraction_worker_id = \$\{options\.workerId \?\? null\}::text/.test(body), 'only the owning worker may renew');
  assert(/abstraction_lease_expires_at = now\(\) \+ make_interval/.test(body), 'the lease moves forward from now');
  assert(/RETURNING \*/.test(body), 'a lost lease must return no row');
});

test('renewChunkLeases batches by job, deduplicates, and separates renewed from lost', async () => {
  const bulkCalls = [];
  const store = {
    async renewChunkAbstractionLeases(jobId, chunkIds, options) {
      bulkCalls.push({ jobId, chunkIds: [...chunkIds], options });
      return chunkIds.filter(id => id !== 'chk_lost').map(id => ({ id }));
    },
    async renewChunkAbstractionLease() {
      throw new Error('singular renewChunkAbstractionLease should not be called when bulk exists');
    },
  };
  const outcomes = await renewChunkLeases(
    store,
    [
      { id: 'chk_1', jobId: 'job_1' },
      { id: 'chk_lost', jobId: 'job_1' },
      { id: 'chk_1', jobId: 'job_1' },
      { id: 'chk_2', jobId: 'job_2' },
    ],
    { workerId: 'wkr_A', leaseMs: 120_000 },
  );
  assert(bulkCalls.length === 2, `Expected 1 bulk call per job (2), got ${bulkCalls.length}`);
  assert(JSON.stringify(bulkCalls[0].chunkIds) === JSON.stringify(['chk_1', 'chk_lost']), `Expected deduplicated job_1 chunks, got ${JSON.stringify(bulkCalls[0].chunkIds)}`);
  assert(outcomes.get('chk_1') === 'renewed', 'chk_1 must be renewed');
  assert(outcomes.get('chk_lost') === 'lost', 'missing row must be lost');
  assert(outcomes.get('chk_2') === 'renewed', 'chk_2 in job_2 must be renewed');
  assert((await renewChunkLeases(store, [], { workerId: 'wkr_A', leaseMs: 120_000 })).size === 0, 'empty input returns empty map');
});

test('renewChunkLeases handles bulk errors safely, falls back to singular, and reports unavailable', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = line => warnings.push(String(line));
  try {
    const failingBulk = {
      async renewChunkAbstractionLeases() {
        throw Object.assign(new Error('postgres://user:secret@db.internal/neon Bearer tok_xyz'), { code: 'ETIMEDOUT' });
      },
    };
    const errOutcomes = await renewChunkLeases(
      failingBulk,
      [{ id: 'chk_1', jobId: 'job_1' }, { id: 'chk_2', jobId: 'job_1' }],
      { workerId: 'wkr_A', leaseMs: 5000 },
    );
    assert(errOutcomes.get('chk_1') === 'unavailable' && errOutcomes.get('chk_2') === 'unavailable', 'failing bulk renewal must yield unavailable');
  } finally {
    console.warn = originalWarn;
  }
  assert(warnings.length === 1, `Expected 1 sanitized warning for the bulk call, got ${warnings.length}`);
  const parsed = JSON.parse(warnings[0]);
  assert(parsed.event === 'abstraction_chunk_lease_renew_failed' && parsed.errorType === 'ETIMEDOUT', 'warning logs event and errorType');
  assert(JSON.stringify(parsed.chunkIds) === JSON.stringify(['chk_1', 'chk_2']), 'warning lists affected chunkIds');
  assert(!/secret|tok_xyz|db\.internal/.test(warnings[0]), 'warning must not leak store error message');

  const singularOnly = {
    async renewChunkAbstractionLease(_jobId, chunkId) {
      return chunkId === 'chk_2' ? null : { id: chunkId };
    },
  };
  const singularOutcomes = await renewChunkLeases(
    singularOnly,
    [{ id: 'chk_1', jobId: 'job_1' }, { id: 'chk_2', jobId: 'job_1' }],
    { workerId: 'wkr_A', leaseMs: 5000 },
  );
  assert(singularOutcomes.get('chk_1') === 'renewed' && singularOutcomes.get('chk_2') === 'lost', 'singular fallback preserves renewed/lost');

  const noneOutcomes = await renewChunkLeases({}, [{ id: 'chk_1', jobId: 'job_1' }], { workerId: 'wkr_A', leaseMs: 5000 });
  assert(noneOutcomes.get('chk_1') === 'unavailable', 'store without renewal methods returns unavailable');
});

test('the Postgres bulk renewal is owner- and status-checked with ANY()', () => {
  const source = readFileSync(new URL('../api/_lib/jobs.js', import.meta.url), 'utf8');
  const start = source.indexOf('async renewChunkAbstractionLeases(');
  assert(start > 0, 'renewChunkAbstractionLeases must exist on the Postgres store');
  const end = source.indexOf('\n    async ', start + 10);
  const body = source.slice(start, end);
  assert(/id = ANY\(\$\{ids\}::text\[\]\)/.test(body), 'bulk renewal must match id = ANY(${ids}::text[])');
  assert(/abstraction_status = 'processing'/.test(body), 'only processing chunks may be renewed');
  assert(/abstraction_worker_id = \$\{options\.workerId \?\? null\}::text/.test(body), 'only the owning worker may renew');
  assert(/abstraction_lease_expires_at = now\(\) \+ make_interval/.test(body), 'the lease moves forward from now');
  assert(/RETURNING \*/.test(body), 'lost leases must be omitted from returned rows');
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`✗ ${name}\n  ${err.message}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
