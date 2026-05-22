import {
  createRequestId,
  enforceJobRateLimit,
  getJobStore,
  parseJsonBody,
  requireJobPassword,
  sendStorageNotConfigured,
  setJobSecurityHeaders,
  validatePatchJobInput,
} from '../_lib/jobs.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 15,
};

function getJobId(req) {
  if (typeof req.query?.id === 'string') return req.query.id;
  if (Array.isArray(req.query?.id)) return req.query.id[0];
  const match = String(req.url || '').match(/\/api\/jobs\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

export default async function handler(req, res) {
  setJobSecurityHeaders(res);
  const requestId = req.headers['x-request-id'] || createRequestId();
  res.setHeader('X-Request-Id', requestId);

  if (!['GET', 'PATCH'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed.', requestId });
  }
  if (req.method === 'PATCH' && !enforceJobRateLimit(req, res, requestId)) return;
  if (!requireJobPassword(req, res, requestId)) return;

  const id = getJobId(req);
  if (!id || !id.startsWith('job_')) {
    return res.status(400).json({ error: 'Invalid job id.', requestId });
  }

  const store = getJobStore();
  if (!store) return sendStorageNotConfigured(res, requestId);

  try {
    const existing = await store.getJob(id);
    if (!existing) {
      return res.status(404).json({ error: 'Job not found.', requestId });
    }

    if (req.method === 'GET') {
      return res.status(200).json({ job: existing, requestId });
    }

    let body;
    try {
      body = parseJsonBody(req.body);
    } catch {
      return res.status(400).json({ error: 'Invalid JSON in request body.', requestId });
    }

    const validation = validatePatchJobInput(body, existing);
    if (!validation.valid) {
      return res.status(validation.statusCode).json({ error: validation.reason, requestId });
    }

    const updated = await store.updateJob(id, validation.patch);
    return res.status(200).json({ job: updated, requestId });
  } catch (err) {
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ error: err.message, requestId });
    }
    console.error(JSON.stringify({
      event: 'job_status_error',
      requestId,
      jobId: id,
      reason: err?.message || String(err),
    }));
    return res.status(500).json({ error: 'Could not update job metadata.', requestId });
  }
}
