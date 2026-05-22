import {
  createRequestId,
  enforceJobRateLimit,
  getJobStore,
  parseJsonBody,
  requireJobPassword,
  sendStorageNotConfigured,
  setJobSecurityHeaders,
  validateCreateJobInput,
} from '../_lib/jobs.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 15,
};

export default async function handler(req, res) {
  setJobSecurityHeaders(res);
  const requestId = req.headers['x-request-id'] || createRequestId();
  res.setHeader('X-Request-Id', requestId);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.', requestId });
  }
  if (!enforceJobRateLimit(req, res, requestId)) return;
  if (!requireJobPassword(req, res, requestId)) return;

  let body;
  try {
    body = parseJsonBody(req.body);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON in request body.', requestId });
  }

  const validation = validateCreateJobInput(body);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.reason, requestId });
  }

  const store = getJobStore();
  if (!store) return sendStorageNotConfigured(res, requestId);

  try {
    const job = await store.createJob(validation.value);
    return res.status(201).json({ job, requestId });
  } catch (err) {
    console.error(JSON.stringify({
      event: 'job_create_error',
      requestId,
      reason: err?.message || String(err),
    }));
    return res.status(500).json({ error: 'Could not create job metadata.', requestId });
  }
}
