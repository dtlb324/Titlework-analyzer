import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { processChunkAbstraction } from '../api/_lib/abstraction.js';
import { applyAbstractionClaim } from '../api/_lib/jobs.js';

for (const failurePoint of ['second-upload', 'second-insert', 'supersede']) {
  test(`abandoned PDF split ${failurePoint === 'supersede' ? 'leaves children of a reclaimed parent alone' : 'cleans pending children'} after ${failurePoint}`, async () => {
    const pdf = await PDFDocument.create();
    for (let i = 0; i < 4; i++) pdf.addPage([200, 200]);
    const bytes = Buffer.from(await pdf.save());
    const parent = { id: 'parent', jobId: 'job_fixture', documentId: 'doc_fixture', chunkOrder: 0,
      originalFilename: 'fixture.pdf', mediaType: 'application/pdf', uploadStatus: 'uploaded',
      abstractionStatus: 'pending', pageStart: 1, pageEnd: 4, sizeBytes: bytes.length, fingerprint: 'fixture' };
    const chunks = new Map([[parent.id, parent]]);
    let inserts = 0, uploads = 0;
    const store = {
      async claimChunkForAbstraction(_jobId, id, options) {
        const row = applyAbstractionClaim(chunks.get(id), options); chunks.set(id, row); return row;
      },
      async createSplitChunk(jobId, documentId, input) {
        if (++inserts === 2 && failurePoint === 'second-insert') throw new Error('fixture storage unavailable');
        const row = { ...input, id: `child${inserts}`, jobId, documentId, abstractionStatus: 'pending' };
        chunks.set(row.id, row); return row;
      },
      async markChunkAbstractionSplitSuperseded(_jobId, id) {
        if (failurePoint === 'supersede') {
          // Real SQL only returns null when this worker no longer holds the parent lease (reclaimed by another worker).
          chunks.get(id).abstractionWorkerId = 'worker_reclaimed';
          return null;
        }
        chunks.get(id).abstractionStatus = 'split_superseded'; return chunks.get(id);
      },
      async markChunkAbstractionFailed(_jobId, id, failure) {
        const row = chunks.get(id);
        if (failure.splitParentChunkId) {
          const owner = chunks.get(failure.splitParentChunkId);
          if (row.splitParentChunkId !== owner.id || row.abstractionStatus !== 'pending' || owner.abstractionWorkerId !== failure.workerId) return null;
        } else if (row.abstractionStatus !== 'processing' || row.abstractionWorkerId !== failure.workerId) return null;
        Object.assign(row, { abstractionStatus: 'failed', abstractionErrorType: failure.errorType });
        return row;
      },
    };
    await processChunkAbstraction(parent, { store, workerId: 'worker_fixture', maxAttempts: 1,
      blobLoader: async () => ({ bytes, mediaType: 'application/pdf' }),
      blobWriter: async () => {
        if (++uploads === 2 && failurePoint === 'second-upload') throw new Error('fixture write failed');
        return { blobKey: 'fixture', blobUrl: 'gs://fixture/child' };
      },
      modelClient: async () => { const error = new Error('timeout'); error.status = 504; throw error; },
    });
    const children = [...chunks.values()].filter(row => row.splitParentChunkId);
    assert(children.length > 0);
    if (failurePoint === 'supersede') {
      // Known limit: with the lease gone the cleanup guard must NOT fail children the new lease holder may own.
      assert(children.every(row => row.abstractionStatus === 'pending'), JSON.stringify(children));
      return;
    }
    assert(children.every(row => row.abstractionStatus === 'failed'), JSON.stringify(children));
  });
}
