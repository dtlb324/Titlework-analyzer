import {
  validatePatchChunkInput,
} from '../../../_lib/jobs.js';
import {
  getRouteParam,
  parseRouteJson,
  prepareStorageRoute,
  validPrefixedId,
} from '../../../_lib/storage-routes.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 15,
};

export default async function handler(req, res) {
  const route = await prepareStorageRoute(req, res, ['PATCH']);
  if (!route) return;
  const { requestId, store } = route;

  const jobId = getRouteParam(req, 'id', /\/api\/jobs\/([^/?#]+)\/chunks\//);
  const chunkId = getRouteParam(req, 'chunkId', /\/chunks\/([^/?#]+)/);
  if (!validPrefixedId(jobId, 'job_') || !validPrefixedId(chunkId, 'chk_')) {
    return res.status(400).json({ error: 'Invalid job or chunk id.', requestId });
  }

  const body = parseRouteJson(req, res, requestId);
  if (!body) return;
  const validation = validatePatchChunkInput(body);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.reason, requestId });
  }

  try {
    const chunk = await store.updateChunk(jobId, chunkId, validation.patch);
    if (!chunk) {
      return res.status(404).json({ error: 'Chunk not found.', requestId });
    }
    return res.status(200).json({ chunk, requestId });
  } catch (err) {
    console.error(JSON.stringify({
      event: 'chunk_update_error',
      requestId,
      jobId,
      chunkId,
      reason: err?.message || String(err),
    }));
    return res.status(500).json({ error: 'Could not update chunk metadata.', requestId });
  }
}
