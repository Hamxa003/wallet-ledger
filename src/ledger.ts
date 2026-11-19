import type { Pool } from 'pg';
import { ApiError } from './errors';
import { KeyedQueue } from './keyed-queue';
import { withRetry } from './retry';

const CREDIT_SQL = `
  WITH bal AS (
    INSERT INTO balances (user_id, balance)
    VALUES ($1, $2)
    ON CONFLICT (user_id) DO UPDATE
      SET balance = balances.balance + EXCLUDED.balance,
          updated_at = now()
    RETURNING balance
  ), entry AS (
    INSERT INTO ledger (user_id, type, amount)
    SELECT $1, 'credit', $2 FROM bal
  )
  SELECT balance FROM bal`;

const DEBIT_SQL = `
  WITH bal AS (
    UPDATE balances
       SET balance = balance - $2,
           updated_at = now()
     WHERE user_id = $1
       AND balance >= $2
    RETURNING balance
  ), entry AS (
    INSERT INTO ledger (user_id, type, amount)
    SELECT $1, 'debit', $2 FROM bal
  )
  SELECT (SELECT balance FROM bal) AS balance,
         EXISTS (SELECT 1 FROM balances WHERE user_id = $1) AS user_exists`;

const BALANCE_SQL = 'SELECT balance FROM balances WHERE user_id = $1';

function toNumber(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error('Balance exceeds safe integer range');
  return n;
}

export class LedgerService {
  private readonly writes = new KeyedQueue();

  constructor(private readonly pool: Pool) {}

  credit(userId: string, amount: number): Promise<number> {
    return this.writes.run(userId, () =>
      withRetry(async () => {
        const { rows } = await this.pool.query<{ balance: string }>({
          name: 'credit',
          text: CREDIT_SQL,
          values: [userId, amount],
        });
        return toNumber(rows[0]!.balance);
      }),
    );
  }

  debit(userId: string, amount: number): Promise<number> {
    return this.writes.run(userId, () =>
      withRetry(async () => {
        const { rows } = await this.pool.query<{ balance: string | null; user_exists: boolean }>({
          name: 'debit',
          text: DEBIT_SQL,
          values: [userId, amount],
        });
        const row = rows[0]!;
        if (row.balance !== null) return toNumber(row.balance);
        if (!row.user_exists) throw new ApiError(404, 'user_not_found', `User ${userId} not found`);
        throw new ApiError(409, 'insufficient_funds', 'Insufficient funds');
      }),
    );
  }

  async getBalance(userId: string): Promise<number> {
    const { rows } = await withRetry(() =>
      this.pool.query<{ balance: string }>({ name: 'balance', text: BALANCE_SQL, values: [userId] }),
    );
    if (rows.length === 0) throw new ApiError(404, 'user_not_found', `User ${userId} not found`);
    return toNumber(rows[0]!.balance);
  }
}
