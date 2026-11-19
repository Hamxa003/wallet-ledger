import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isRetryable, withRetry } from '../src/retry';

const pgError = (code: string) => Object.assign(new Error(code), { code });

describe('withRetry', () => {
  it('retries serialization failures and deadlocks until success', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw pgError('40001');
        if (calls === 2) throw pgError('40P01');
        return 'done';
      },
      { baseDelayMs: 1 },
    );
    assert.equal(result, 'done');
    assert.equal(calls, 3);
  });

  it('does not retry other errors', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => {
        calls++;
        throw pgError('23514');
      }),
    );
    assert.equal(calls, 1);
  });

  it('gives up after the attempt limit', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw pgError('40001');
        },
        { attempts: 3, baseDelayMs: 1 },
      ),
    );
    assert.equal(calls, 3);
  });

  it('only treats transaction conflicts as retryable', () => {
    assert.ok(isRetryable(pgError('40001')));
    assert.ok(isRetryable(pgError('40P01')));
    assert.ok(!isRetryable(pgError('57014')));
    assert.ok(!isRetryable(new Error('connection terminated')));
    assert.ok(!isRetryable(null));
  });
});
