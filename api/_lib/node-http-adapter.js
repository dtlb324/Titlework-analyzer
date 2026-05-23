const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024;

function configuredMaxBodyBytes() {
  const raw = Number(process.env.CLOUD_RUN_MAX_BODY_BYTES || DEFAULT_MAX_BODY_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_BODY_BYTES;
}

export async function readNodeRequestBody(req, maxBodyBytes = configuredMaxBodyBytes()) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBodyBytes) {
      const error = new Error('Request body too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  const contentType = String(req.headers['content-type'] || '');
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(raw);
    } catch {
      const error = new Error('Invalid JSON in request body.');
      error.statusCode = 400;
      throw error;
    }
  }
  return raw;
}

export function createApiRequest(req, url, body) {
  const query = Object.fromEntries(url.searchParams.entries());
  if (url.pathname.startsWith('/api/jobs/') && !query.path) {
    query.path = url.pathname.slice('/api/jobs/'.length).split('/').filter(Boolean).map(decodeURIComponent);
  }
  return {
    method: req.method,
    headers: req.headers,
    socket: req.socket,
    url: `${url.pathname}${url.search}`,
    query,
    body,
  };
}

export function createApiResponse(res) {
  return {
    statusCode: 200,
    setHeader(name, value) {
      res.setHeader(name, value);
    },
    getHeader(name) {
      return res.getHeader(name);
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      if (!res.headersSent) {
        res.statusCode = this.statusCode;
        res.setHeader('content-type', 'application/json; charset=utf-8');
      }
      res.end(JSON.stringify(body));
      return this;
    },
    send(body) {
      res.statusCode = this.statusCode;
      res.end(body);
      return this;
    },
  };
}

export async function callApiHandler(handler, req, res, url) {
  const body = await readNodeRequestBody(req);
  const apiReq = createApiRequest(req, url, body);
  const apiRes = createApiResponse(res);
  await handler(apiReq, apiRes);
}
