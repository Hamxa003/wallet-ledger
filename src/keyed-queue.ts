/**
 * Runs tasks for the same key one at a time, in arrival order.
 *
 * Writes for one user serialize on that user's row lock in Postgres anyway. Queuing
 * them here means waiting requests hold no pool connection, so a hot user cannot
 * drain the pool and stall requests for everyone else.
 */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();

  get size(): number {
    return this.tails.size;
  }

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
