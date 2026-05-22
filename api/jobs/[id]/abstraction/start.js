import {
  getRouteParam,
  prepareStorageRoute,
  validPrefixedId,
} from '../../../_lib/storage-routes.js';
import {
  processJobAbstraction,
  serverAbstractionSetupError,
} from '../../../_lib/abstraction.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};

export default async function handler(req, res) {
  const route = await prepareStorageRoute(req, res, ['POST']);
  if (!route) return;
  const { requestId, store } = route;
  if (!process.env.APP_PASSWORD) {
    return res.status(401).json({ error: 'APP_PASSWORD is required for server-side abstraction endpoints.', requestId });
  }

  const jobId = getRouteParam(req, 'id', /\/api\/jobs\/([^/?#]+)\/abstraction\/start/);
  if (!validPrefixedId(jobId, 'job_')) {
    return res.status(400).json({ error: 'Invalid job id.', requestId });
  }

  const setupError = serverAbstractionSetupError();
  if (setupError) {
    return res.status(503).json({
      error: setupError,
      fallback: 'browser_abstraction',
      requestId,
    });
  }

  try {
    const job = await store.getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found.', requestId });
    }
    const status = await processJobAbstraction(jobId, { store });
    return res.status(200).json({ status, job: status.job, requestId });
  } catch (err) {
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ error: err.message, requestId });
    }
    console.error(JSON.stringify({
      event: 'abstraction_start_error',
      requestId,
      jobId,
      reason: err?.message || String(err),
    }));
    return res.status(500).json({ error: 'Could not start server-side abstraction.', requestId });
  }
}
