import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Harness, ledgerCount, ledgerSum, mismatchedBalances, skip, startHarness, uniqueUser } from './harness';

type Op = ['credit' | 'debit', number];

interface Row {
  out_ok: boolean;
  out_balance: string | null;
  out_user_found: boolean;
}

describe('apply_ledger_batch', { skip }, () => {
  let h: Harness;

  before(async () => {
    h = await startHarness(4);
  });

  after(async () => {
    await h?.close();
  });

  async function apply(userId: string, ops: Op[]) {
    const { rows } = await h.pool.query<Row>(
      `SELECT out_ok, out_balance, out_user_found
         FROM apply_ledger_batch($1, $2::entry_type[], $3::bigint[])
        ORDER BY out_ord`,
      [userId, ops.map((o) => o[0]), ops.map((o) => o[1])],
    );
    return rows.map((r) => (r.out_ok ? Number(r.out_balance) : r.out_user_found ? 'insufficient' : 'not_found'));
  }

  async function seed(userId: string, amount: number) {
    await apply(userId, [['credit', amount]]);
  }

  it('applies operations in order, each against the running balance', async () => {
    const u = uniqueUser('fn');
    await seed(u, 100);
    assert.deepEqual(
      await apply(u, [
        ['debit', 60],
        ['debit', 60],
        ['credit', 30],
        ['debit', 60],
      ]),
      [40, 'insufficient', 70, 10],
    );
    assert.equal(await ledgerSum(h.pool, u), 10);
    assert.equal(await ledgerCount(h.pool, u), 4);
  });

  it('writes accepted entries in request order', async () => {
    const u = uniqueUser('fn');
    await seed(u, 10);
    await apply(u, [
      ['credit', 1],
      ['debit', 999],
      ['credit', 2],
      ['debit', 3],
    ]);
    const { rows } = await h.pool.query('SELECT type, amount FROM ledger WHERE user_id = $1 ORDER BY id', [u]);
    assert.deepEqual(
      rows.map((r) => `${r.type}:${r.amount}`),
      ['credit:10', 'credit:1', 'credit:2', 'debit:3'],
    );
  });

  it('treats an unknown user as not found until the first credit, then creates them', async () => {
    const u = uniqueUser('fn');
    assert.deepEqual(
      await apply(u, [
        ['debit', 1],
        ['credit', 5],
        ['debit', 3],
        ['debit', 3],
      ]),
      ['not_found', 5, 2, 'insufficient'],
    );
    const { rows } = await h.pool.query('SELECT balance FROM balances WHERE user_id = $1', [u]);
    assert.equal(Number(rows[0].balance), 2);
  });

  it('creates nothing for an unknown user when every operation is a debit', async () => {
    const u = uniqueUser('fn');
    assert.deepEqual(await apply(u, [['debit', 1], ['debit', 2]]), ['not_found', 'not_found']);
    const { rowCount } = await h.pool.query('SELECT 1 FROM balances WHERE user_id = $1', [u]);
    assert.equal(rowCount, 0);
    assert.equal(await ledgerCount(h.pool, u), 0);
  });

  it('writes nothing when every debit is rejected', async () => {
    const u = uniqueUser('fn');
    await seed(u, 10);
    assert.deepEqual(await apply(u, [['debit', 11], ['debit', 20]]), ['insufficient', 'insufficient']);
    assert.equal(await ledgerCount(h.pool, u), 1);
    assert.equal(await ledgerSum(h.pool, u), 10);
  });

  it('stays consistent when batches for the same new user race', async () => {
    const u = uniqueUser('fn');
    const batches = Array.from({ length: 20 }, () =>
      apply(u, [
        ['credit', 5],
        ['debit', 3],
        ['credit', 1],
      ]),
    );
    const results = await Promise.all(batches);
    for (const r of results) assert.ok(r.every((v) => typeof v === 'number' && v >= 0));
    assert.equal(await ledgerSum(h.pool, u), 20 * 3);
    assert.equal(await mismatchedBalances(h.pool), 0);
  });
});
