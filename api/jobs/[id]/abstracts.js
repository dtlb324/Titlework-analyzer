import {
  getRouteParam,
  prepareStorageRoute,
  validPrefixedId,
} from '../../_lib/storage-routes.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 15,
};

function publicAbstract(record) {
  return {
    id: record.id,
    jobId: record.jobId,
    documentId: record.documentId,
    chunkId: record.chunkId,
    chunk_id: record.chunkId,
    chunkOrder: record.chunkOrder,
    sequence_index: record.chunkOrder,
    originalFilename: record.originalFilename,
    display_name: record.originalFilename,
    filename: record.originalFilename,
    abstractText: record.abstractText,
    abstract_text: record.abstractText,
    abstract: record.abstractText,
    modelUsed: record.modelUsed,
    payloadBytes: record.payloadBytes,
    latencyMs: record.latencyMs,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    status: record.status,
    attemptCount: record.attemptCount,
    createdAt: record.createdAt,
  };
}

export default async function handler(req, res) {
  const route = await prepareStorageRoute(req, res, ['GET'], { rateLimitWrites: false });
  if (!route) return;
  const { requestId, store } = route;
  if (!process.env.APP_PASSWORD) {
    return res.status(401).json({ error: 'APP_PASSWORD is required for server-side abstraction endpoints.', requestId });
  }

  const jobId = getRouteParam(req, 'id', /\/api\/jobs\/([^/?#]+)\/abstracts/);
  if (!validPrefixedId(jobId, 'job_')) {
    return res.status(400).json({ error: 'Invalid job id.', requestId });
  }

  try {
    const job = await store.getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found.', requestId });
    }
    const abstracts = store.listDocumentAbstracts ? await store.listDocumentAbstracts(jobId) : [];
    return res.status(200).json({ abstracts: abstracts.map(publicAbstract), requestId });
  } catch (err) {
    console.error(JSON.stringify({
      event: 'abstract_list_error',
      requestId,
      jobId,
      reason: err?.message || String(err),
    }));
    return res.status(500).json({ error: 'Could not fetch stored abstracts.', requestId });
  }
}
