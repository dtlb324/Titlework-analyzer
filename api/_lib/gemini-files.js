
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
const DEFAULT_UPLOAD_BASE_URL = 'https://generativelanguage.googleapis.com/upload';
const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_TIMEOUT_MS = 30_000;
const DEFAULT_DELETE_TIMEOUT_MS = 10_000;

function extractGeminiErrorMessage(errorField, fallback) {
  if (typeof errorField === 'string' && errorField.trim()) return errorField;
  if (errorField && typeof errorField === 'object') {
    if (typeof errorField.message === 'string' && errorField.message.trim()) return errorField.message;
    if (typeof errorField.status === 'string' && errorField.status.trim()) return errorField.status;
    if (errorField.code != null) return `${fallback} (${errorField.code})`;
    try {
      const serialized = JSON.stringify(errorField);
      if (serialized && serialized !== '{}') return `${fallback}: ${serialized}`;
    } catch {}
  }
  return fallback;
}

function createTimeoutSignal(ms, externalSignal) {
  const timeoutMs = Number(ms);
  const effectiveMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_UPLOAD_TIMEOUT_MS;
  let timer = null;
  let timeoutSignal;
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    timeoutSignal = AbortSignal.timeout(effectiveMs);
  } else {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), effectiveMs);
    timeoutSignal = controller.signal;
  }
  let signal = timeoutSignal;
  let cleanupExternal = null;
  if (externalSignal) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
      signal = AbortSignal.any([externalSignal, timeoutSignal]);
    } else {
      const combined = new AbortController();
      const abortCombined = () => combined.abort();
      if (externalSignal.aborted || timeoutSignal.aborted) {
        combined.abort();
      } else {
        externalSignal.addEventListener('abort', abortCombined, { once: true });
        timeoutSignal.addEventListener('abort', abortCombined, { once: true });
      }
      signal = combined.signal;
      cleanupExternal = () => {
        externalSignal.removeEventListener('abort', abortCombined);
        timeoutSignal.removeEventListener('abort', abortCombined);
      };
    }
  }
  return {
    signal,
    cleanup() {
      if (timer) clearTimeout(timer);
      if (cleanupExternal) cleanupExternal();
    },
  };
}

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
    error.code = 'missing_api_key';
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
  const timeout = createTimeoutSignal(options.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS, options.signal);
  let response;
  let data;
  try {
    response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'x-goog-api-key': key,
      },
      body,
      signal: timeout.signal,
    });
    data = await response.json().catch(() => ({}));
  } finally {
    timeout.cleanup();
  }
  if (!response.ok) {
    const message = extractGeminiErrorMessage(data?.error, `Gemini file upload failed (HTTP ${response.status}).`);
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

  try {
    await waitForGeminiFileActive(name, { ...options, signal: options.signal });
  } catch (err) {
    await deleteGeminiFile(name);
    throw err;
  }

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
    const timeout = createTimeoutSignal(options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS, options.signal);
    let response;
    let data;
    try {
      response = await fetch(url, {
        headers: { 'x-goog-api-key': key },
        signal: timeout.signal,
      });
      data = await response.json().catch(() => ({}));
    } finally {
      timeout.cleanup();
    }
    if (!response.ok) {
      const message = extractGeminiErrorMessage(data?.error, `Gemini file status check failed (HTTP ${response.status}).`);
      throw new Error(message);
    }
    const state = data.state || data.file?.state;
    if (state === 'ACTIVE') return;
    if (state === 'FAILED') {
      throw new Error(extractGeminiErrorMessage(data.error, 'Gemini file processing failed.'));
    }
    await sleep(config.pollIntervalMs);
  }
  throw new Error('Timed out waiting for Gemini file to become ACTIVE.');
}

/**
 * Best-effort delete of an uploaded Gemini file (48h TTL makes this optional).
 */
export async function deleteGeminiFile(fileName, options = {}) {
  const key = geminiApiKey();
  if (!key || typeof fileName !== 'string' || !/^files\/[A-Za-z0-9_-]+$/.test(fileName)) return;
  const resource = fileName;
  const url = `${apiBaseUrl()}/${resource}`;
  const timeout = createTimeoutSignal(options.timeoutMs ?? DEFAULT_DELETE_TIMEOUT_MS, options.signal);
  try {
    await fetch(url, { method: 'DELETE', headers: { 'x-goog-api-key': key }, signal: timeout.signal });
  } catch {
  } finally {
    timeout.cleanup();
  }
}

export async function deleteGeminiFiles(fileNames = []) {
  for (const name of fileNames) {
    await deleteGeminiFile(name);
  }
}
