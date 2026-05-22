import {
  validateCreateChunkInput,
} from '../../../../_lib/jobs.js';
import {
  getRouteParam,
  parseRouteJson,
  prepareStorageRoute,
  validPrefixedId,
} from '../../../../_lib/storage-routes.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 15,
};

export default async function handler(req, res) {
  const route = await prepareStorageRoute(req, res, ['POST']);
  if (!route) return;
  const { requestId, store } = route;

  const jobId = getRouteParam(req, 'id', /\/api\/jobs\/([^/?#]+)\/documents\//);
  const documentId = getRouteParam(req, 'documentId', /\/documents\/([^/?#]+)\/chunks/);
  if (!validPrefixedId(jobId, 'job_') || !validPrefixedId(documentId, 'doc_')) {
    return res.status(400).json({ error: 'Invalid job or document id.', requestId });
  }

  const body = parseRouteJson(req, res, requestId);
  if (!body) return;
  const validation = validateCreateChunkInput(body);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.reason, requestId });
  }

  const document = await store.getDocument(jobId, documentId);
  if (!document) {
    return res.status(404).json({ error: 'Document not found.', requestId });
  }

  try {
    const chunk = await store.createChunk(jobId, documentId, validation.value);
    if (!chunk) {
      return res.status(404).json({ error: 'Document not found.', requestId });
    }
    return res.status(201).json({ chunk, requestId });
  } catch (err) {
    console.error(JSON.stringify({
      event: 'chunk_register_error',
      requestId,
      jobId,
      documentId,
      reason: err?.message || String(err),
    }));
    return res.status(500).json({ error: 'Could not register chunk metadata.', requestId });
  }
}
