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
