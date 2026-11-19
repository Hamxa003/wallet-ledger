import type { Pool } from 'pg';
import { ApiError } from './errors';
import { withRetry } from './retry';
import { OpResult, WriteBatcher, WriteOp } from './write-batcher';

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

const BATCH_SQL = `
  SELECT out_ok, out_balance, out_user_found
    FROM apply_ledger_batch($1, $2::entry_type[], $3::bigint[])
   ORDER BY out_ord`;

function toNumber(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error('Balance exceeds safe integer range');
  return n;
}

function unwrap(userId: string, result: OpResult): number {
  if (result.ok) return result.balance;
  if (result.error === 'user_not_found') throw new ApiError(404, 'user_not_found', `User ${userId} not found`);
  throw new ApiError(409, 'insufficient_funds', 'Insufficient funds');
}

export class LedgerService {
  private readonly writes: WriteBatcher;

  constructor(
    private readonly pool: Pool,
    maxBatch = 100,
  ) {
    this.writes = new WriteBatcher((userId, ops) => withRetry(() => this.flush(userId, ops)), maxBatch);
  }

  async credit(userId: string, amount: number): Promise<number> {
    return unwrap(userId, await this.writes.submit(userId, { type: 'credit', amount }));
  }

  async debit(userId: string, amount: number): Promise<number> {
    return unwrap(userId, await this.writes.submit(userId, { type: 'debit', amount }));
  }

  async getBalance(userId: string): Promise<number> {
    const { rows } = await withRetry(() =>
      this.pool.query<{ balance: string }>({ name: 'balance', text: BALANCE_SQL, values: [userId] }),
    );
    if (rows.length === 0) throw new ApiError(404, 'user_not_found', `User ${userId} not found`);
    return toNumber(rows[0]!.balance);
  }

  private flush(userId: string, ops: WriteOp[]): Promise<OpResult[]> {
    if (ops.length === 1) {
      const op = ops[0]!;
      return (op.type === 'credit' ? this.creditOne(userId, op.amount) : this.debitOne(userId, op.amount)).then((r) => [r]);
    }
    return this.applyBatch(userId, ops);
  }

  private async creditOne(userId: string, amount: number): Promise<OpResult> {
    const { rows } = await this.pool.query<{ balance: string }>({
      name: 'credit',
      text: CREDIT_SQL,
      values: [userId, amount],
    });
    return { ok: true, balance: toNumber(rows[0]!.balance) };
  }

  private async debitOne(userId: string, amount: number): Promise<OpResult> {
    const { rows } = await this.pool.query<{ balance: string | null; user_exists: boolean }>({
      name: 'debit',
      text: DEBIT_SQL,
      values: [userId, amount],
    });
    const row = rows[0]!;
    if (row.balance !== null) return { ok: true, balance: toNumber(row.balance) };
    return { ok: false, error: row.user_exists ? 'insufficient_funds' : 'user_not_found' };
  }

  private async applyBatch(userId: string, ops: WriteOp[]): Promise<OpResult[]> {
    const { rows } = await this.pool.query<{ out_ok: boolean; out_balance: string | null; out_user_found: boolean }>({
      name: 'apply_batch',
      text: BATCH_SQL,
      values: [userId, ops.map((op) => op.type), ops.map((op) => op.amount)],
    });
    return rows.map((row) => {
      if (row.out_ok) return { ok: true, balance: toNumber(row.out_balance!) };
      return { ok: false, error: row.out_user_found ? 'insufficient_funds' : 'user_not_found' };
    });
  }
}
