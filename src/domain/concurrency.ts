/**
 * 配列を上限つきの並列数で処理し、入力順の結果を返す。
 * 1件の失敗で全体を止めたい場合は worker 内で投げる。
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: size }, async () => {
    while (true) {
      const index = next;
      next += 1;
      const item = items[index];
      if (index >= items.length || item === undefined) {
        return;
      }
      results[index] = await worker(item, index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** 連続リクエストの間隔を空けるための待機。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
