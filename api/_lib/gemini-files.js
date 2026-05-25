// Gemini Files API — upload large PDFs/images for generateContent by URI (avoids base64 in JSON).

const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
const DEFAULT_UPLOAD_BASE_URL = 'https://generativelanguage.googleapis.com/upload';

function geminiApiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
}

function clampInt(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function getGeminiFileApiConfig() {
  return {
    enabled: process.env.GEMINI_FILE_API_ENABLED !== 'false',
    minBytes: clampInt(process.env.GEMINI_FILE_API_MIN_BYTES, 1_500_000, 100_000, 50_000_000),
    maxBytes: clampInt(process.env.GEMINI_FILE_API_MAX_BYTES, 48_000_000, 1_000_000, 50_000_000),
    pollIntervalMs: clampInt(process.env.GEMINI_FILE_API_POLL_MS, 500, 100, 5000),
    pollMaxMs: clampInt(process.env.GEMINI_FILE_API_POLL_MAX_MS, 60_000, 1000, 120_000),
  };
}

export function shouldUseGeminiFileApi(byteLength, configOverrides = {}) {
  const config = { ...getGeminiFileApiConfig(), ...configOverrides };
  if (!config.enabled) return false;
  const size = Number(byteLength) || 0;
  return size >= config.minBytes && size <= config.maxBytes;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function uploadBaseUrl() {
  return String(process.env.GEMINI_UPLOAD_BASE_URL || DEFAULT_UPLOAD_BASE_URL).replace(/\/$/, '');
}

function apiBaseUrl() {
  return String(process.env.GEMINI_API_BASE_URL || `${DEFAULT_GEMINI_BASE_URL}/v1beta`).replace(/\/$/, '');
}

/**
 * Upload bytes to Gemini Files API (multipart). Returns { uri, name, mimeType }.
 */
export async function uploadGeminiFile(bytes, mimeType, displayName, options = {}) {
  const key = geminiApiKey();
  if (!key) {
    const error = new Error('GEMINI_API_KEY is required for Gemini Files API uploads.');
    error.statusCode = 503;
    throw error;
  }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const config = { ...getGeminiFileApiConfig(), ...options };
  if (buffer.byteLength > config.maxBytes) {
    const error = new Error(`File exceeds Gemini Files API max size (${(config.maxBytes / 1024 / 1024).toFixed(1)} MB).`);
    error.status = 413;
    throw error;
  }

  const metadata = JSON.stringify({
    file: {
      displayName: String(displayName || 'document').slice(0, 240),
    },
  });
  const boundary = `gemini_file_${Date.now().toString(36)}`;
  const preamble = Buffer.from(
    `--${boundary}\r\n`
    + 'Content-Type: application/json; charset=UTF-8\r\n\r\n'
    + `${metadata}\r\n`
    + `--${boundary}\r\n`
    + `Content-Type: ${mimeType}\r\n\r\n`,
    'utf8',
  );
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([preamble, buffer, closing]);

  const uploadUrl = `${uploadBaseUrl()}/v1beta/files?uploadType=multipart`;
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'x-goog-api-key': key,
    },
    body,
    signal: options.signal,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || data?.error || `Gemini file upload failed (HTTP ${response.status}).`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  const file = data.file || data;
  const uri = file.uri;
  const name = file.name;
  if (!uri) {
    throw new Error('Gemini file upload did not return a file URI.');
  }

  await waitForGeminiFileActive(name, { ...options, signal: options.signal });

  return {
    uri,
    name,
    mimeType: file.mimeType || mimeType,
    sizeBytes: buffer.byteLength,
  };
}

async function waitForGeminiFileActive(fileName, options = {}) {
  if (!fileName) return;
  const config = { ...getGeminiFileApiConfig(), ...options };
  const key = geminiApiKey();
  const started = Date.now();
  const resource = fileName.startsWith('files/') ? fileName : `files/${fileName}`;
  const url = `${apiBaseUrl()}/${resource}`;

  while (Date.now() - started < config.pollMaxMs) {
    const response = await fetch(url, {
      headers: { 'x-goog-api-key': key },
      signal: options.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error?.message || `Gemini file status check failed (HTTP ${response.status}).`;
      throw new Error(message);
    }
    const state = data.state || data.file?.state;
    if (state === 'ACTIVE') return;
    if (state === 'FAILED') {
      throw new Error(data.error?.message || 'Gemini file processing failed.');
    }
    await sleep(config.pollIntervalMs);
  }
  throw new Error('Timed out waiting for Gemini file to become ACTIVE.');
}

/**
 * Best-effort delete of an uploaded Gemini file (48h TTL makes this optional).
 */
export async function deleteGeminiFile(fileName) {
  const key = geminiApiKey();
  if (!key || !fileName) return;
  const resource = String(fileName).startsWith('files/') ? fileName : `files/${fileName}`;
  const url = `${apiBaseUrl()}/${resource}`;
  try {
    await fetch(url, { method: 'DELETE', headers: { 'x-goog-api-key': key } });
  } catch {
    // Non-fatal cleanup.
  }
}

export async function deleteGeminiFiles(fileNames = []) {
  for (const name of fileNames) {
    await deleteGeminiFile(name);
  }
}
