export interface WriteOp {
  type: 'credit' | 'debit';
  amount: number;
}

export type OpResult =
  | { ok: true; balance: number }
  | { ok: false; error: 'user_not_found' | 'insufficient_funds' };

export type FlushFn = (key: string, ops: WriteOp[]) => Promise<OpResult[]>;

interface Entry {
  op: WriteOp;
  resolve: (result: OpResult) => void;
  reject: (err: unknown) => void;
}

/**
 * Serializes writes per key and groups the ones that queue up while a flush is in
 * flight into the next flush. An uncontended write is flushed on its own straight
 * away, so batching only happens when a key is busy.
 */
export class WriteBatcher {
  private readonly queues = new Map<string, Entry[]>();

  constructor(
    private readonly flush: FlushFn,
    private readonly maxBatch = 100,
  ) {}

  get activeKeys(): number {
    return this.queues.size;
  }

  submit(key: string, op: WriteOp): Promise<OpResult> {
    return new Promise((resolve, reject) => {
      const entry: Entry = { op, resolve, reject };
      const queue = this.queues.get(key);
      if (queue) {
        queue.push(entry);
        return;
      }
      this.queues.set(key, []);
      void this.run(key, [entry]);
    });
  }

  private async run(key: string, batch: Entry[]): Promise<void> {
    try {
      const results = await this.flush(key, batch.map((e) => e.op));
      batch.forEach((e, i) => e.resolve(results[i]!));
    } catch (err) {
      for (const e of batch) e.reject(err);
    }

    const queue = this.queues.get(key)!;
    if (queue.length === 0) {
      this.queues.delete(key);
      return;
    }
    void this.run(key, queue.splice(0, this.maxBatch));
  }
}
