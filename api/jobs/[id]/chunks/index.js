import {
  getRouteParam,
  prepareStorageRoute,
  validPrefixedId,
} from '../../../_lib/storage-routes.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 15,
};

export default async function handler(req, res) {
  const route = await prepareStorageRoute(req, res, ['GET'], { rateLimitWrites: false });
  if (!route) return;
  const { requestId, store } = route;

  const jobId = getRouteParam(req, 'id', /\/api\/jobs\/([^/?#]+)\/chunks/);
  if (!validPrefixedId(jobId, 'job_')) {
    return res.status(400).json({ error: 'Invalid job id.', requestId });
  }

  try {
    const job = await store.getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found.', requestId });
    }
    const chunks = await store.listChunks(jobId);
    return res.status(200).json({ chunks, requestId });
  } catch (err) {
    console.error(JSON.stringify({
      event: 'chunk_list_error',
      requestId,
      jobId,
      reason: err?.message || String(err),
    }));
    return res.status(500).json({ error: 'Could not list chunk metadata.', requestId });
  }
}
