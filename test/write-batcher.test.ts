import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OpResult, WriteBatcher, WriteOp } from '../src/write-batcher';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeStore(delayMs = 5) {
  const balances = new Map<string, number>();
  const batches: Array<{ key: string; size: number }> = [];
  const runningPerKey = new Map<string, number>();
  let maxRunningPerKey = 0;

  const flush = async (key: string, ops: WriteOp[]): Promise<OpResult[]> => {
    runningPerKey.set(key, (runningPerKey.get(key) ?? 0) + 1);
    maxRunningPerKey = Math.max(maxRunningPerKey, runningPerKey.get(key)!);
    batches.push({ key, size: ops.length });
    await tick(delayMs);
    let balance = balances.get(key) ?? 0;
    const results: OpResult[] = ops.map((op) => {
      balance += op.type === 'credit' ? op.amount : -op.amount;
      return { ok: true, balance };
    });
    balances.set(key, balance);
    runningPerKey.set(key, runningPerKey.get(key)! - 1);
    return results;
  };

  return { flush, balances, batches, maxRunning: () => maxRunningPerKey };
}

describe('WriteBatcher', () => {
  it('flushes an uncontended write on its own', async () => {
    const store = fakeStore();
    const batcher = new WriteBatcher(store.flush);
    assert.deepEqual(await batcher.submit('u1', { type: 'credit', amount: 10 }), { ok: true, balance: 10 });
    assert.deepEqual(store.batches, [{ key: 'u1', size: 1 }]);
  });

  it('groups writes that queue up behind an in-flight flush', async () => {
    const store = fakeStore();
    const batcher = new WriteBatcher(store.flush);
    const results = await Promise.all(Array.from({ length: 50 }, () => batcher.submit('u1', { type: 'credit', amount: 1 })));

    assert.deepEqual(store.batches.map((b) => b.size), [1, 49]);
    assert.deepEqual(results.map((r) => (r.ok ? r.balance : -1)), Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('never runs two flushes for the same key at once', async () => {
    const store = fakeStore(2);
    const batcher = new WriteBatcher(store.flush, 5);
    const pending: Promise<OpResult>[] = [];
    for (let i = 0; i < 40; i++) {
      pending.push(batcher.submit('u1', { type: 'credit', amount: 1 }));
      if (i % 7 === 0) await tick(1);
    }
    await Promise.all(pending);
    assert.equal(store.maxRunning(), 1);
    assert.equal(store.balances.get('u1'), 40);
    assert.ok(store.batches.every((b) => b.size <= 5));
  });

  it('runs different keys in parallel', async () => {
    const store = fakeStore(10);
    const batcher = new WriteBatcher(store.flush);
    const started = performance.now();
    await Promise.all(['a', 'b', 'c', 'd'].map((k) => batcher.submit(k, { type: 'credit', amount: 1 })));
    assert.ok(performance.now() - started < 35);
  });

  it('rejects every write in a failed flush and keeps serving the key', async () => {
    let fail = true;
    const batcher = new WriteBatcher(async (_key, ops) => {
      await tick(2);
      if (fail) {
        fail = false;
        throw new Error('boom');
      }
      return ops.map(() => ({ ok: true as const, balance: 1 }));
    });

    const first = batcher.submit('u1', { type: 'credit', amount: 1 });
    const second = batcher.submit('u1', { type: 'credit', amount: 1 });
    await assert.rejects(first, /boom/);
    assert.deepEqual(await second, { ok: true, balance: 1 });
  });

  it('forgets keys once their queue drains', async () => {
    const store = fakeStore(1);
    const batcher = new WriteBatcher(store.flush);
    await Promise.all([batcher.submit('a', { type: 'credit', amount: 1 }), batcher.submit('b', { type: 'credit', amount: 1 })]);
    assert.equal(batcher.activeKeys, 0);
  });
});
