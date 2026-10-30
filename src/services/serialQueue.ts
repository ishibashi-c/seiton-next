/**
 * 同一ファイルへの書き込みをプロセス内で直列化する。
 * これは端末内の競合対策であり、Remotely Save/Dropbox のリモート競合を解決しない。
 */
export class SerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(
      () => undefined,
      () => undefined
    );

    this.tails.set(key, tail);
    void tail.finally(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });

    return result;
  }
}
