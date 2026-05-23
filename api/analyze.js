// Cloud Run API handler — hardened for production use
// Protections: rate limiting, input validation, secure password comparison,
// request size limiting, XSS headers, data leakage prevention

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};

// In-memory rate limiter
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
// Default 200 req/min supports bulk runs (~400 docs). Override via ANALYZE_RATE_LIMIT_MAX env var.
const RATE_LIMIT_MAX_REQUESTS = Math.min(
  Math.max(parseInt(process.env.ANALYZE_RATE_LIMIT_MAX || '300', 10) || 300, 10),
  600
);
const PASSWORD_RATE_LIMIT_MAX = 5;
const DEFAULT_MAX_REQUEST_BYTES = 20_000_000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 240_000;

function clampInt(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function getAnalyzeConfig() {
  return {
    maxRequestBytes: clampInt(process.env.ANALYZE_MAX_REQUEST_BYTES || process.env.CLOUD_RUN_MAX_REQUEST_BYTES, DEFAULT_MAX_REQUEST_BYTES, 1, 32_000_000),
    upstreamTimeoutMs: clampInt(process.env.ANALYZE_UPSTREAM_TIMEOUT_MS || process.env.CLOUD_RUN_UPSTREAM_TIMEOUT_MS, DEFAULT_UPSTREAM_TIMEOUT_MS, 10_000, 300_000),
  };
}

function createRequestId() {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function logRequestEvent(event, fields = {}) {
  console.log(JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    ...fields,
  }));
}

function isAbortError(err) {
  const name = String(err?.name || '');
  const message = String(err?.message || '');
  return name.includes('Abort')
    || name.includes('Timeout')
    || message.includes('aborted')
    || message.includes('timeout')
    || message.includes('Timeout');
}

function createTimeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return { signal: AbortSignal.timeout(ms), cleanup() {} };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cleanup: () => clearTimeout(timeout) };
}

function getRateLimitEntry(ip) {
  const now = Date.now();
  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 0, failedAuth: 0, windowStart: now });
  }
  const entry = rateLimitMap.get(ip);
  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry.count = 0;
    entry.failedAuth = 0;
    entry.windowStart = now;
  }
  return entry;
}

function cleanupRateLimitMap() {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(ip);
    }
  }
}

function secureCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length !== b.length ? 1 : 0;
  for (let i = 0; i < maxLen; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function validateRequestBody(body) {
  if (body && body.ping === true) return { valid: true, isPing: true };
  if (!body || !Array.isArray(body.messages)) {
    return { valid: false, reason: 'Invalid request structure.' };
  }
  const allowedModels = ['claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-haiku-4-5'];
  if (!body.model || !allowedModels.includes(body.model)) {
    return { valid: false, reason: 'Invalid or disallowed model.' };
  }
  if (body.max_tokens && (typeof body.max_tokens !== 'number' || body.max_tokens > 8000 || body.max_tokens < 1)) {
    return { valid: false, reason: 'Invalid max_tokens value.' };
  }
  for (const msg of body.messages) {
    if (!msg.role || !['user', 'assistant'].includes(msg.role)) {
      return { valid: false, reason: 'Invalid message role.' };
    }
    if (!msg.content) {
      return { valid: false, reason: 'Message missing content.' };
    }
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block.type || !['text', 'image', 'document'].includes(block.type)) {
          return { valid: false, reason: 'Invalid content block type.' };
        }
        if (block.type === 'image') {
          if (!block.source || block.source.type !== 'base64') {
            return { valid: false, reason: 'Invalid image block.' };
          }
          const allowedImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
          if (!allowedImageTypes.includes(block.source.media_type)) {
            return { valid: false, reason: 'Invalid image type.' };
          }
        }
        if (block.type === 'document') {
          if (!block.source || block.source.type !== 'base64' || block.source.media_type !== 'application/pdf') {
            return { valid: false, reason: 'Invalid document block.' };
          }
        }
      }
    }
  }
  return { valid: true, isPing: false };
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
}

export default async function handler(req, res) {
  setSecurityHeaders(res);
  const requestId = req.headers['x-request-id'] || createRequestId();
  const startedAt = Date.now();
  res.setHeader('X-Request-Id', requestId);

  if (req.method !== 'POST') {
    logRequestEvent('api_reject', { requestId, status: 405, reason: 'method_not_allowed', latencyMs: Date.now() - startedAt });
    return res.status(405).json({ error: 'Method not allowed.', requestId });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch {
      logRequestEvent('api_reject', { requestId, status: 400, reason: 'invalid_json', latencyMs: Date.now() - startedAt });
      return res.status(400).json({ error: 'Invalid JSON in request body.', requestId });
    }
  }

  const validation = validateRequestBody(body);
  if (!validation.valid) {
    logRequestEvent('api_reject', { requestId, status: 400, reason: validation.reason, latencyMs: Date.now() - startedAt });
    return res.status(400).json({ error: validation.reason, requestId });
  }

  if (validation.isPing) {
    return res.status(200).json({ ok: true });
  }

  cleanupRateLimitMap();
  const rateEntry = getRateLimitEntry(ip);

  rateEntry.count++;
  if (rateEntry.count > RATE_LIMIT_MAX_REQUESTS) {
    res.setHeader('Retry-After', '60');
    logRequestEvent('api_reject', { requestId, status: 429, reason: 'rate_limit', ip, latencyMs: Date.now() - startedAt });
    return res.status(429).json({ error: 'Rate limit exceeded. Wait 60 seconds and try again.', requestId });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logRequestEvent('api_error', { requestId, status: 500, reason: 'missing_api_key', latencyMs: Date.now() - startedAt });
    return res.status(500).json({ error: 'API key not configured on server.', requestId });
  }

  const requiredPassword = process.env.APP_PASSWORD;
  if (requiredPassword) {
    const providedPassword = req.headers['x-app-password'];
    if (rateEntry.failedAuth >= PASSWORD_RATE_LIMIT_MAX) {
      res.setHeader('Retry-After', '60');
      logRequestEvent('api_reject', { requestId, status: 429, reason: 'password_rate_limit', ip, latencyMs: Date.now() - startedAt });
      return res.status(429).json({ error: 'Too many failed attempts. Wait 60 seconds and try again.', requestId });
    }
    if (!secureCompare(providedPassword || '', requiredPassword)) {
      rateEntry.failedAuth++,
      await new Promise(r => setTimeout(r, 500));
      logRequestEvent('api_reject', { requestId, status: 401, reason: 'invalid_password', ip, latencyMs: Date.now() - startedAt });
      return res.status(401).json({ error: 'Invalid password.', requestId });
    }
  }

  const safeBody = {
    model: body.model,
    max_tokens: body.max_tokens || 4000,
    messages: body.messages,
  };
  if (body.system) safeBody.system = body.system;

  const serializedBody = JSON.stringify(safeBody);
  const payloadSize = Buffer.byteLength(serializedBody, 'utf8');
  const analyzeConfig = getAnalyzeConfig();
  if (payloadSize > analyzeConfig.maxRequestBytes) {
    logRequestEvent('api_reject', {
      requestId,
      status: 413,
      reason: 'payload_too_large',
      model: safeBody.model,
      payloadBytes: payloadSize,
      latencyMs: Date.now() - startedAt,
    });
    return res.status(413).json({
      error: `Request too large (${(payloadSize / 1024 / 1024).toFixed(1)} MB). This exceeds the configured server request limit of ${(analyzeConfig.maxRequestBytes / 1024 / 1024).toFixed(1)} MB. Split very large PDFs or reduce scan resolution before retrying.`,
      requestId,
    });
  }

  try {
    logRequestEvent('api_request', {
      requestId,
      model: safeBody.model,
      payloadBytes: payloadSize,
      messageCount: safeBody.messages.length,
    });
    const timeout = createTimeoutSignal(analyzeConfig.upstreamTimeoutMs);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: serializedBody,
      signal: timeout.signal,
    });
    timeout.cleanup();

    const data = await response.json();

    const safeResponse = {
      content: data.content,
      model: data.model,
      stop_reason: data.stop_reason,
      usage: data.usage,
      error: data.error,
      requestId,
    };

    logRequestEvent('api_response', {
      requestId,
      model: safeBody.model,
      status: response.status,
      payloadBytes: payloadSize,
      latencyMs: Date.now() - startedAt,
      errorType: data.error?.type || null,
    });
    return res.status(response.status).json(safeResponse);
  } catch (err) {
    const status = isAbortError(err) ? 504 : 500;
    const reason = isAbortError(err) ? 'upstream_timeout' : 'internal_error';
    logRequestEvent('api_error', {
      requestId,
      status,
      reason,
      model: safeBody.model,
      payloadBytes: payloadSize,
      latencyMs: Date.now() - startedAt,
      errorType: err.name || 'Error',
    });
    if (status === 504) {
      return res.status(504).json({
        error: `Timeout error: Anthropic did not respond within ${Math.round(analyzeConfig.upstreamTimeoutMs / 1000)} seconds. The app will retry smaller batches when possible.`,
        requestId,
      });
    }
    return res.status(500).json({ error: 'Internal server error. Please try again.', requestId });
  }
}
