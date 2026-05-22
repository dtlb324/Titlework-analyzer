import {
  validateCreateDocumentInput,
} from '../../_lib/jobs.js';
import {
  getRouteParam,
  parseRouteJson,
  prepareStorageRoute,
  validPrefixedId,
} from '../../_lib/storage-routes.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 15,
};

export default async function handler(req, res) {
  const route = await prepareStorageRoute(req, res, ['POST']);
  if (!route) return;
  const { requestId, store } = route;

  const jobId = getRouteParam(req, 'id', /\/api\/jobs\/([^/?#]+)\/documents/);
  if (!validPrefixedId(jobId, 'job_')) {
    return res.status(400).json({ error: 'Invalid job id.', requestId });
  }

  const existingJob = await store.getJob(jobId);
  if (!existingJob) {
    return res.status(404).json({ error: 'Job not found.', requestId });
  }

  const body = parseRouteJson(req, res, requestId);
  if (!body) return;
  const validation = validateCreateDocumentInput(body);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.reason, requestId });
  }

  try {
    const document = await store.createDocument(jobId, validation.value);
    if (!document) {
      return res.status(404).json({ error: 'Job not found.', requestId });
    }
    return res.status(201).json({ document, requestId });
  } catch (err) {
    console.error(JSON.stringify({
      event: 'document_register_error',
      requestId,
      jobId,
      reason: err?.message || String(err),
    }));
    return res.status(500).json({ error: 'Could not register document metadata.', requestId });
  }
}
