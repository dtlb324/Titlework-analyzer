import {
  getRouteParam,
  prepareStorageRoute,
  validPrefixedId,
} from '../../../_lib/storage-routes.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 15,
};

function publicFailedChunk(chunk) {
  return {
    id: chunk.id,
    documentId: chunk.documentId,
    chunkOrder: chunk.chunkOrder,
    originalFilename: chunk.originalFilename,
    mediaType: chunk.mediaType,
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd,
    attemptCount: chunk.abstractionAttempts,
    errorType: chunk.abstractionErrorType,
    errorMessage: chunk.abstractionErrorMessage,
  };
}

export default async function handler(req, res) {
  const route = await prepareStorageRoute(req, res, ['GET'], { rateLimitWrites: false });
  if (!route) return;
  const { requestId, store } = route;
  if (!process.env.APP_PASSWORD) {
    return res.status(401).json({ error: 'APP_PASSWORD is required for server-side abstraction endpoints.', requestId });
  }

  const jobId = getRouteParam(req, 'id', /\/api\/jobs\/([^/?#]+)\/abstraction\/status/);
  if (!validPrefixedId(jobId, 'job_')) {
    return res.status(400).json({ error: 'Invalid job id.', requestId });
  }

  try {
    const job = await store.getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found.', requestId });
    }
    const status = store.getAbstractionStatus
      ? await store.getAbstractionStatus(jobId)
      : { total: 0, pending: 0, processing: 0, completed: 0, failed: 0, failedChunks: [], job };
    return res.status(200).json({
      status: {
        ...status,
        failedChunks: (status.failedChunks || []).map(publicFailedChunk),
      },
      job: status.job || job,
      requestId,
    });
  } catch (err) {
    console.error(JSON.stringify({
      event: 'abstraction_status_error',
      requestId,
      jobId,
      reason: err?.message || String(err),
    }));
    return res.status(500).json({ error: 'Could not fetch abstraction status.', requestId });
  }
}
