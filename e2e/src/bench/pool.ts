/** Maps `items` through `task` with at most `concurrency` tasks in flight; results keep the order of `items`. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  // One iterator shared by the workers: each takes the next item when it is free.
  const queue = items.entries();
  const worker = async () => {
    for (const [index, item] of queue) results[index] = await task(item);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
