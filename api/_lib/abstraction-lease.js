export const LEASE_LOST_CODE = 'lease_lost';

export function callLeaseMs(leaseMs, upstreamTimeoutMs) {
  return Math.max(Number(leaseMs) || 0, (Number(upstreamTimeoutMs) || 0) + 60_000);
}

export function chunkLeaseLostError(chunkId) {
  const error = new Error('Abstraction chunk lease was taken by another worker.');
  error.code = LEASE_LOST_CODE;
  error.chunkId = chunkId ?? null;
  return error;
}

export function isChunkLeaseLostError(err) {
  return err?.code === LEASE_LOST_CODE;
}

// Best effort on infrastructure errors: a DB blip must not abort or re-bill work that is already paid for, and
// the owner-checked save still rejects a stale write. Only a definitive "not yours any more" answer is 'lost'.
// Store errors can carry connection strings, so the warning logs the error class and code, never the message.
export async function renewChunkLease(store, chunk, { workerId, leaseMs }) {
  if (typeof store?.renewChunkAbstractionLease !== 'function') return 'unavailable';
  let renewed;
  try {
    renewed = await store.renewChunkAbstractionLease(chunk.jobId, chunk.id, { workerId, leaseMs });
  } catch (err) {
    try {
      console.warn(JSON.stringify({
        event: 'abstraction_chunk_lease_renew_failed',
        jobId: chunk.jobId ?? null,
        chunkId: chunk.id ?? null,
        errorType: String(err?.code || err?.name || 'Error').slice(0, 64),
      }));
    } catch {
    }
    return 'unavailable';
  }
  return renewed ? 'renewed' : 'lost';
}

export async function renewChunkLeases(store, chunks, { workerId, leaseMs }) {
  const outcomes = new Map();
  const unique = [];
  const seen = new Set();
  for (const chunk of chunks || []) {
    if (!chunk?.id || seen.has(chunk.id)) continue;
    seen.add(chunk.id);
    unique.push(chunk);
  }
  if (!unique.length) return outcomes;

  if (typeof store?.renewChunkAbstractionLeases === 'function') {
    const byJob = new Map();
    for (const chunk of unique) {
      const jobId = chunk.jobId ?? null;
      if (!byJob.has(jobId)) byJob.set(jobId, []);
      byJob.get(jobId).push(chunk);
    }
    for (const [jobId, group] of byJob) {
      const ids = group.map(chunk => chunk.id);
      try {
        const rows = await store.renewChunkAbstractionLeases(jobId, ids, { workerId, leaseMs });
        const renewedIds = new Set(Array.isArray(rows) ? rows.map(row => row?.id).filter(Boolean) : []);
        for (const id of ids) {
          outcomes.set(id, renewedIds.has(id) ? 'renewed' : 'lost');
        }
      } catch (err) {
        try {
          console.warn(JSON.stringify({
            event: 'abstraction_chunk_lease_renew_failed',
            jobId,
            chunkId: ids[0] ?? null,
            chunkIds: ids,
            errorType: String(err?.code || err?.name || 'Error').slice(0, 64),
          }));
        } catch {
        }
        for (const id of ids) {
          outcomes.set(id, 'unavailable');
        }
      }
    }
    return outcomes;
  }

  if (typeof store?.renewChunkAbstractionLease === 'function') {
    for (const chunk of unique) {
      outcomes.set(chunk.id, await renewChunkLease(store, chunk, { workerId, leaseMs }));
    }
    return outcomes;
  }

  for (const chunk of unique) {
    outcomes.set(chunk.id, 'unavailable');
  }
  return outcomes;
}
