import { createHash } from 'crypto';
import { readOpsJson, storageIsConfigured, writeOpsJson } from './storage.js';

export const AUTH_FAIL_DELAY_MS = 500;
const RATE_LIMIT_SCOPES = new Set(['jobs', 'analyze']);
const memoryMaps = new Map();

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
    return;
  }
  memoryMaps.clear();
}

function hashedObjectKey(scope, ip) {
  const hash = createHash('sha256').update(`${scope}:${ip}`).digest('hex');
  return `ops/rate-limits/${scope}/${hash}.json`;
}

function freshEntry(now) {
  return { count: 0, failedAuth: 0, windowStart: now };
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
    const error = new Error('storage_unconfigured');
    error.code = 'STORAGE_UNCONFIGURED';
    throw error;
  }
  await writeOpsJson(hashedObjectKey(scope, ip), entry, { generation });
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

/**
 * Shared IP limiter. Prefers GCS (or a test backend) so Cloud Run instances share
 * strike/count windows. Falls back to process memory when GCS is unset or errors.
 */
export async function mutateSharedRateLimit({ scope, ip, windowMs, update }) {
  if (!RATE_LIMIT_SCOPES.has(scope)) {
    throw new Error(`Unknown rate-limit scope: ${scope}`);
  }
  const keyIp = String(ip || 'unknown');
  const injected = globalThis.__TITLE_ANALYZER_RATE_LIMIT_BACKEND__;
  const useShared = Boolean(injected) || storageIsConfigured();
  if (!useShared) {
    return mutateMemory(scope, keyIp, windowMs, update);
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const record = await readBackend(scope, keyIp);
      const generation = Number(record?.generation) || 0;
      const now = Date.now();
      const entry = normalizeEntry(record?.data, now, windowMs);
      const result = update(entry, now);
      await writeBackend(scope, keyIp, entry, generation);
      return result;
    } catch (err) {
      if (isPreconditionFailure(err)) continue;
      console.warn(JSON.stringify({
        event: 'shared_rate_limit_fallback',
        scope,
        message: String(err?.message || err).slice(0, 300),
      }));
      return mutateMemory(scope, keyIp, windowMs, update);
    }
  }
  return mutateMemory(scope, keyIp, windowMs, update);
}
