import {
  getRouteParam,
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

  const jobId = getRouteParam(req, 'id', /\/api\/jobs\/([^/?#]+)\/finalize-uploads/);
  if (!validPrefixedId(jobId, 'job_')) {
    return res.status(400).json({ error: 'Invalid job id.', requestId });
  }

  try {
    const result = await store.finalizeUploads(jobId);
    if (!result) {
      return res.status(404).json({ error: 'Job not found.', requestId });
    }
    if (!result.ready) {
      return res.status(409).json({
        error: 'Uploads are not complete.',
        pendingChunks: result.pendingChunks,
        job: result.job,
        requestId,
      });
    }
    return res.status(200).json({ job: result.job, pendingChunks: 0, requestId });
  } catch (err) {
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ error: err.message, requestId });
    }
    console.error(JSON.stringify({
      event: 'uploads_finalize_error',
      requestId,
      jobId,
      reason: err?.message || String(err),
    }));
    return res.status(500).json({ error: 'Could not finalize uploads.', requestId });
  }
}
