const RETRYABLE_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
]);

export function isRetryable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && RETRYABLE_SQLSTATES.has(code);
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
}

export async function withRetry<T>(fn: () => Promise<T>, { attempts = 5, baseDelayMs = 5 }: RetryOptions = {}): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt >= attempts) throw err;
      const delay = baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
