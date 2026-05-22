// Vercel Serverless Function — hardened for production use
// Protections: rate limiting, input validation, secure password comparison,
// request size limiting, XSS headers, data leakage prevention

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};

// In-memory rate limiter
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
// Default 60 req/min supports bulk runs (~400 docs). Override via ANALYZE_RATE_LIMIT_MAX env var.
const RATE_LIMIT_MAX_REQUESTS = Math.min(
  Math.max(parseInt(process.env.ANALYZE_RATE_LIMIT_MAX || '60', 10) || 60, 10),
  200
);
const PASSWORD_RATE_LIMIT_MAX = 5;

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

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';

  cleanupRateLimitMap();
  const rateEntry = getRateLimitEntry(ip);

  rateEntry.count++;
  if (rateEntry.count > RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({ error: 'Rate limit exceeded. Wait 60 seconds and try again.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured on server.' });
  }

  const requiredPassword = process.env.APP_PASSWORD;
  if (requiredPassword) {
    const providedPassword = req.headers['x-app-password'];
    if (rateEntry.failedAuth >= PASSWORD_RATE_LIMIT_MAX) {
      return res.status(429).json({ error: 'Too many failed attempts. Wait 60 seconds and try again.' });
    }
    if (!secureCompare(providedPassword || '', requiredPassword)) {
      rateEntry.failedAuth++,
      await new Promise(r => setTimeout(r, 500));
      return res.status(401).json({ error: 'Invalid password.' });
    }
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: 'Invalid JSON in request body.' }); }
  }

  const validation = validateRequestBody(body);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.reason });
  }

  if (validation.isPing) {
    return res.status(200).json({ ok: true });
  }

  const safeBody = {
    model: body.model,
    max_tokens: body.max_tokens || 4000,
    messages: body.messages,
  };
  if (body.system) safeBody.system = body.system;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(safeBody),
    });

    const data = await response.json();

    const safeResponse = {
      content: data.content,
      model: data.model,
      stop_reason: data.stop_reason,
      usage: data.usage,
      error: data.error,
    };

    return res.status(response.status).json(safeResponse);
  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(500).json({ error: 'Internal server error. Please try again.' });
  }
}
