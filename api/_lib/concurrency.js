
export async function runWithConcurrency(items, concurrency, worker) {
  if (!items.length) return [];
  const queue = items.slice();
  const results = [];
  const workers = [];
  // A concurrency of 0 or NaN would start no worker and silently drop every item.
  const limit = Math.max(1, Math.floor(Number(concurrency)) || 1);
  for (let i = 0; i < Math.min(limit, queue.length); i++) {
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
