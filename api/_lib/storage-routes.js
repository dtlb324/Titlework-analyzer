import {
  createRequestId,
  enforceJobRateLimit,
  getJobStore,
  parseJsonBody,
  requireJobPassword,
  sendStorageNotConfigured,
  setJobSecurityHeaders,
} from './jobs.js';

export function getRouteParam(req, name, prefixPattern) {
  const value = req.query?.[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  if (!prefixPattern) return '';
  const match = String(req.url || '').match(prefixPattern);
  return match ? decodeURIComponent(match[1]) : '';
}

export function validPrefixedId(id, prefix) {
  return typeof id === 'string' && id.startsWith(prefix) && id.length > prefix.length;
}

export async function prepareStorageRoute(req, res, methods, { rateLimitWrites = true } = {}) {
  setJobSecurityHeaders(res);
  const requestId = req.headers['x-request-id'] || createRequestId();
  res.setHeader('X-Request-Id', requestId);

  if (!methods.includes(req.method)) {
    res.status(405).json({ error: 'Method not allowed.', requestId });
    return null;
  }
  if (rateLimitWrites && req.method !== 'GET' && !enforceJobRateLimit(req, res, requestId)) return null;
  if (!requireJobPassword(req, res, requestId)) return null;

  const store = getJobStore();
  if (!store) {
    sendStorageNotConfigured(res, requestId);
    return null;
  }
  return { requestId, store };
}

export function parseRouteJson(req, res, requestId) {
  try {
    return parseJsonBody(req.body);
  } catch {
    res.status(400).json({ error: 'Invalid JSON in request body.', requestId });
    return null;
  }
}
