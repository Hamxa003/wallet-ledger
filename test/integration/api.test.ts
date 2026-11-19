import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { client, Harness, ledgerCount, ledgerSum, skip, startHarness, uniqueUser } from './harness';

describe('API contract', { skip }, () => {
  let h: Harness;
  let api: ReturnType<typeof client>;

  before(async () => {
    h = await startHarness();
    api = client(h.baseUrl);
  });

  after(async () => {
    await h?.close();
  });

  it('creates a user on first credit and accumulates later credits', async () => {
    const u = uniqueUser();
    assert.deepEqual(await api.credit(u, 10000), { status: 200, body: { user_id: u, balance: 10000 } });
    assert.deepEqual(await api.credit(u, 15000), { status: 200, body: { user_id: u, balance: 25000 } });
  });

  it('debits and returns the balance after the operation', async () => {
    const u = uniqueUser();
    await api.credit(u, 25000);
    assert.deepEqual(await api.debit(u, 4000), { status: 200, body: { user_id: u, balance: 21000 } });
    assert.deepEqual(await api.balance(u), { status: 200, body: { user_id: u, balance: 21000 } });
  });

  it('allows a debit that brings the balance to exactly zero', async () => {
    const u = uniqueUser();
    await api.credit(u, 500);
    assert.deepEqual((await api.debit(u, 500)).body, { user_id: u, balance: 0 });
  });

  it('rejects an overdraft with 409 and writes nothing', async () => {
    const u = uniqueUser();
    await api.credit(u, 100);
    const res = await api.debit(u, 101);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'insufficient_funds');
    assert.equal(await ledgerCount(h.pool, u), 1);
    assert.equal((await api.balance(u)).body.balance, 100);
  });

  it('returns 404 for balance and debit on a user that was never credited', async () => {
    const u = uniqueUser();
    const balance = await api.balance(u);
    const debit = await api.debit(u, 1);
    assert.equal(balance.status, 404);
    assert.equal(balance.body.error, 'user_not_found');
    assert.equal(debit.status, 404);
    assert.equal(debit.body.error, 'user_not_found');

    const { rowCount } = await h.pool.query('SELECT 1 FROM balances WHERE user_id = $1', [u]);
    assert.equal(rowCount, 0);
    assert.equal(await ledgerCount(h.pool, u), 0);
  });

  it('stores one immutable ledger row per operation with a server timestamp', async () => {
    const u = uniqueUser();
    const before = Date.now();
    await api.credit(u, 700);
    await api.debit(u, 200);

    const { rows } = await h.pool.query(
      'SELECT id, type, amount, created_at FROM ledger WHERE user_id = $1 ORDER BY id',
      [u],
    );
    assert.deepEqual(
      rows.map((r) => [r.type, Number(r.amount)]),
      [
        ['credit', 700],
        ['debit', 200],
      ],
    );
    for (const r of rows) assert.ok(r.created_at.getTime() >= before - 1000);

    await assert.rejects(h.pool.query('UPDATE ledger SET amount = 1 WHERE id = $1', [rows[0].id]), /immutable/);
    await assert.rejects(h.pool.query('DELETE FROM ledger WHERE id = $1', [rows[0].id]), /immutable/);
  });

  it('reflects every write in the next balance read', async () => {
    const u = uniqueUser();
    let expected = 0;
    for (let i = 1; i <= 50; i++) {
      const res = i % 3 === 0 ? await api.debit(u, 1) : await api.credit(u, 2);
      expected += i % 3 === 0 ? -1 : 2;
      assert.equal(res.body.balance, expected);
      assert.equal((await api.balance(u)).body.balance, expected);
    }
    assert.equal(await ledgerSum(h.pool, u), expected);
  });

  describe('authentication', () => {
    const cases: Array<[string, string | null]> = [
      ['no token', null],
      ['wrong token', 'not-the-token'],
    ];

    for (const [name, token] of cases) {
      it(`rejects every endpoint with ${name} and writes nothing`, async () => {
        const u = uniqueUser();
        const anon = client(h.baseUrl, token);
        for (const res of [await anon.credit(u, 10), await anon.debit(u, 10), await anon.balance(u)]) {
          assert.equal(res.status, 401);
          assert.equal(res.body.error, 'unauthorized');
        }
        assert.equal(await ledgerCount(h.pool, u), 0);
      });
    }
  });

  describe('validation', () => {
    const badBodies: unknown[] = [
      { user_id: 'ok', amount: 1.5 },
      '{"user_id":"ok","amount":1.0}',
      { user_id: 'ok', amount: '10' },
      { user_id: 'ok', amount: 0 },
      { user_id: 'ok', amount: -10 },
      { user_id: 'ok', amount: 1_000_000_001 },
      { user_id: 'ok' },
      { amount: 10 },
      { user_id: 'has space', amount: 10 },
      { user_id: 'x'.repeat(65), amount: 10 },
      '{"user_id":',
    ];

    for (const path of ['/credit', '/debit']) {
      it(`returns 400 for invalid ${path} bodies and writes nothing`, async () => {
        for (const body of badBodies) {
          const res = await api.raw('POST', path, body);
          assert.equal(res.status, 400, `${path} ${JSON.stringify(body)}`);
          assert.equal(res.body.error, 'invalid_request');
        }
        assert.equal(await ledgerCount(h.pool, 'ok'), 0);
      });
    }

    it('accepts the maximum amount and ignores unknown fields', async () => {
      const u = uniqueUser();
      const res = await api.raw('POST', '/credit', { user_id: u, amount: 1_000_000_000, memo: 'x' });
      assert.deepEqual(res, { status: 200, body: { user_id: u, balance: 1_000_000_000 } });
    });

    it('returns 400 for an invalid user_id on balance', async () => {
      assert.equal((await api.raw('GET', '/balance/bad%20id')).status, 400);
      assert.equal((await api.raw('GET', `/balance/${'x'.repeat(65)}`)).status, 400);
    });
  });
});
