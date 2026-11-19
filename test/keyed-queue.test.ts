import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KeyedQueue } from '../src/keyed-queue';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('KeyedQueue', () => {
  it('runs tasks for the same key one at a time, in order', async () => {
    const queue = new KeyedQueue();
    const events: string[] = [];
    let running = 0;
    let maxRunning = 0;

    await Promise.all(
      [1, 2, 3, 4].map((i) =>
        queue.run('u1', async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          events.push(`start ${i}`);
          await tick(5);
          events.push(`end ${i}`);
          running--;
        }),
      ),
    );

    assert.equal(maxRunning, 1);
    assert.deepEqual(events, ['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3', 'start 4', 'end 4']);
  });

  it('runs different keys concurrently', async () => {
    const queue = new KeyedQueue();
    let running = 0;
    let maxRunning = 0;
    const task = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await tick(10);
      running--;
    };

    await Promise.all([queue.run('a', task), queue.run('b', task), queue.run('c', task)]);
    assert.equal(maxRunning, 3);
  });

  it('keeps going after a failed task and passes the error to its caller', async () => {
    const queue = new KeyedQueue();
    const failing = queue.run('u1', async () => {
      throw new Error('boom');
    });
    const next = queue.run('u1', async () => 'ok');

    await assert.rejects(failing, /boom/);
    assert.equal(await next, 'ok');
  });

  it('forgets keys once their queue drains', async () => {
    const queue = new KeyedQueue();
    await Promise.all([queue.run('a', async () => 1), queue.run('b', async () => 2)]);
    await tick(0);
    assert.equal(queue.size, 0);
  });
});
