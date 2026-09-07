import { createHash } from 'crypto';
import { readOpsJson, storageIsConfigured, writeOpsJson } from './storage.js';

export const AUTH_FAIL_DELAY_MS = 500;
export const RATE_LIMIT_READ_TTL_MS = 1000;
const RATE_LIMIT_SCOPES = new Set(['jobs', 'analyze']);
const memoryMaps = new Map();
const readCache = new Map();
const inflight = new Map();

export class SharedRateLimitError extends Error {
  constructor(message = 'Rate limiter unavailable.') {
    super(message);
    this.name = 'SharedRateLimitError';
    this.code = 'SHARED_RATE_LIMIT_UNAVAILABLE';
    this.statusCode = 503;
  }
}

export function delayAuthFailure() {
  return new Promise(resolve => setTimeout(resolve, AUTH_FAIL_DELAY_MS));
}

function scopeMap(scope) {
  if (!memoryMaps.has(scope)) memoryMaps.set(scope, new Map());
  return memoryMaps.get(scope);
}

export function resetSharedRateLimits(scope = null) {
  if (scope) {
    memoryMaps.delete(scope);
    for (const key of [...readCache.keys()]) {
      if (key.startsWith(`${scope}:`)) readCache.delete(key);
    }
    return;
  }
  memoryMaps.clear();
  readCache.clear();
}

function hashedObjectKey(scope, ip) {
  const hash = createHash('sha256').update(`${scope}:${ip}`).digest('hex');
  return `ops/rate-limits/${scope}/${hash}.json`;
}

function cacheKey(scope, ip) {
  return `${scope}:${ip}`;
}

function freshEntry(now) {
  return { count: 0, failedAuth: 0, windowStart: now };
}

function cloneEntry(entry) {
  return {
    count: entry.count,
    failedAuth: entry.failedAuth,
    windowStart: entry.windowStart,
  };
}

function normalizeEntry(data, now, windowMs) {
  const entry = {
    count: Math.max(0, Number(data?.count) || 0),
    failedAuth: Math.max(0, Number(data?.failedAuth) || 0),
    windowStart: Number(data?.windowStart) || now,
  };
  if (now - entry.windowStart > windowMs) return freshEntry(now);
  return entry;
}

function isPreconditionFailure(err) {
  const code = Number(err?.code || err?.statusCode || 0);
  return code === 412 || /precondition/i.test(String(err?.message || ''));
}

function usesSharedStore() {
  return Boolean(globalThis.__TITLE_ANALYZER_RATE_LIMIT_BACKEND__) || storageIsConfigured();
}

async function readBackend(scope, ip) {
  const injected = globalThis.__TITLE_ANALYZER_RATE_LIMIT_BACKEND__;
  if (injected?.read) return await injected.read(hashedObjectKey(scope, ip));
  if (!storageIsConfigured()) return null;
  return await readOpsJson(hashedObjectKey(scope, ip));
}

async function writeBackend(scope, ip, entry, generation) {
  const injected = globalThis.__TITLE_ANALYZER_RATE_LIMIT_BACKEND__;
  if (injected?.write) {
    await injected.write(hashedObjectKey(scope, ip), entry, generation);
    return;
  }
  if (!storageIsConfigured()) {
    throw new SharedRateLimitError('Google Cloud Storage is not configured.');
  }
  await writeOpsJson(hashedObjectKey(scope, ip), entry, { generation });
}

function rememberCache(scope, ip, entry, generation, now, extra = {}) {
  const key = cacheKey(scope, ip);
  const prev = readCache.get(key) || {};
  readCache.set(key, {
    entry: cloneEntry(entry),
    generation: Number(generation) || 0,
    at: now,
    flushedAt: extra.flushedAt ?? prev.flushedAt ?? now,
    pendingCount: extra.pendingCount ?? 0,
  });
}

function mutateMemory(scope, ip, windowMs, update) {
  const now = Date.now();
  const map = scopeMap(scope);
  const entry = normalizeEntry(map.get(ip), now, windowMs);
  const result = update(entry, now);
  map.set(ip, entry);
  for (const [storedIp, storedEntry] of map.entries()) {
    if (now - storedEntry.windowStart > windowMs * 2) map.delete(storedIp);
  }
  return result;
}

function previewUpdate(entry, now, windowMs, update) {
  const windowReset = (now - (Number(entry.windowStart) || now)) > windowMs;
  const copy = normalizeEntry(entry, now, windowMs);
  const before = cloneEntry(copy);
  const result = update(copy, now);
  return {
    result,
    next: copy,
    strikeChanged: copy.failedAuth !== before.failedAuth,
    windowChanged: windowReset || copy.windowStart !== before.windowStart,
    countDelta: copy.count - before.count,
  };
}

async function rmwShared(scope, ip, windowMs, update) {
  const key = cacheKey(scope, ip);
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const record = await readBackend(scope, ip);
      const generation = Number(record?.generation) || 0;
      const now = Date.now();
      const cached = readCache.get(key);
      const entry = normalizeEntry(record?.data, now, windowMs);
      if (cached?.pendingCount) entry.count += cached.pendingCount;
      const result = update(entry, now);
      await writeBackend(scope, ip, entry, generation);
      rememberCache(scope, ip, entry, generation + 1, now, { flushedAt: now, pendingCount: 0 });
      return result;
    } catch (err) {
      if (isPreconditionFailure(err)) continue;
      console.warn(JSON.stringify({
        event: 'shared_rate_limit_unavailable',
        scope,
        message: String(err?.message || err).slice(0, 300),
      }));
      throw err instanceof SharedRateLimitError ? err : new SharedRateLimitError();
    }
  }
  throw new SharedRateLimitError();
}

async function refreshShared(scope, ip, windowMs) {
  const now = Date.now();
  const record = await readBackend(scope, ip);
  const entry = normalizeEntry(record?.data, now, windowMs);
  rememberCache(scope, ip, entry, Number(record?.generation) || 0, now, { flushedAt: now, pendingCount: 0 });
  return entry;
}

/**
 * Shared IP limiter. GCS (or a test backend) is the source of truth for strikes
 * and flushed counts. Fresh in-process cache avoids a GCS RMW on unchanged
 * auth/rate reads. Non-412 store errors fail closed.
 */
export async function mutateSharedRateLimit({ scope, ip, windowMs, update }) {
  if (!RATE_LIMIT_SCOPES.has(scope)) {
    throw new Error(`Unknown rate-limit scope: ${scope}`);
  }
  const keyIp = String(ip || 'unknown');
  if (!usesSharedStore()) {
    return mutateMemory(scope, keyIp, windowMs, update);
  }

  const key = cacheKey(scope, keyIp);
  const run = async () => {
    const now = Date.now();
    let cached = readCache.get(key);
    const fresh = cached && (now - cached.at) <= RATE_LIMIT_READ_TTL_MS;
    if (!fresh) {
      await refreshShared(scope, keyIp, windowMs);
      cached = readCache.get(key);
    }
    const preview = previewUpdate(cached.entry, Date.now(), windowMs, update);
    if (!preview.strikeChanged && !preview.windowChanged && preview.countDelta === 0) {
      return preview.result;
    }
    if (!preview.strikeChanged && !preview.windowChanged && preview.countDelta > 0
      && (Date.now() - cached.flushedAt) <= RATE_LIMIT_READ_TTL_MS) {
      cached.entry = preview.next;
      cached.pendingCount = (cached.pendingCount || 0) + preview.countDelta;
      cached.at = Date.now();
      return preview.result;
    }
    return await rmwShared(scope, keyIp, windowMs, update);
  };

  const previous = inflight.get(key);
  const pending = previous ? previous.then(run, run) : run();
  inflight.set(key, pending);
  try {
    return await pending;
  } finally {
    if (inflight.get(key) === pending) inflight.delete(key);
  }
}
