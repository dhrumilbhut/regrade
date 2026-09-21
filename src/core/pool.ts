/**
 * Run `worker` over `items` with at most `concurrency` in flight. Items are
 * started in order; once `shouldStop()` is true no new items are started
 * (in-flight ones are left to finish or be aborted by the caller).
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (!shouldStop()) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i] as T, i);
    }
  };
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: lanes }, lane));
}
