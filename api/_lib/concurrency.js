// Shared bounded-concurrency helper for workflow batches.

export async function runWithConcurrency(items, concurrency, worker) {
  if (!items.length) return [];
  const queue = items.slice();
  const results = [];
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
    workers.push((async () => {
      while (queue.length) {
        const item = queue.shift();
        try {
          results.push(await worker(item));
        } catch (err) {
          results.push({ status: 'error', error: err });
        }
      }
    })());
  }
  await Promise.all(workers);
  return results;
}
