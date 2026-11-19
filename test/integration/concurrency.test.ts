import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';
import {
  client,
  databaseUrl,
  Harness,
  ledgerCount,
  ledgerSum,
  mismatchedBalances,
  skip,
  startHarness,
  uniqueUser,
} from './harness';

const countBy = (statuses: number[]) =>
  statuses.reduce<Record<number, number>>((acc, s) => ((acc[s] = (acc[s] ?? 0) + 1), acc), {});

describe('concurrency and consistency', { skip }, () => {
  let h: Harness;
  let api: ReturnType<typeof client>;

  before(async () => {
    h = await startHarness(8);
    api = client(h.baseUrl);
  });

  after(async () => {
    await h?.close();
  });

  it('two concurrent debits of 60 against 100 give exactly one 200 and one 409', async () => {
    for (let round = 0; round < 50; round++) {
      const u = uniqueUser('race');
      await api.credit(u, 100);
      const results = await Promise.all([api.debit(u, 60), api.debit(u, 60)]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
      assert.equal(results.find((r) => r.status === 200)!.body.balance, 40);
      assert.equal((await api.balance(u)).body.balance, 40);
      assert.equal(await ledgerCount(h.pool, u), 2);
    }
  });

  it('1,000 concurrent credits of 100 raise the balance by exactly 100,000', async () => {
    const u = uniqueUser('hot');
    await api.credit(u, 1);
    const results = await Promise.all(Array.from({ length: 1000 }, () => api.credit(u, 100)));

    assert.deepEqual(countBy(results.map((r) => r.status)), { 200: 1000 });
    assert.equal((await api.balance(u)).body.balance, 100_001);
    assert.equal(await ledgerSum(h.pool, u), 100_001);

    const seen = new Set(results.map((r) => r.body.balance));
    assert.equal(seen.size, 1000, 'every credit should observe a distinct post-operation balance');
  });

  it('concurrent first credits for a brand new user all succeed', async () => {
    const u = uniqueUser('fresh');
    const results = await Promise.all(Array.from({ length: 100 }, () => api.credit(u, 7)));
    assert.deepEqual(countBy(results.map((r) => r.status)), { 200: 100 });
    assert.equal((await api.balance(u)).body.balance, 700);
  });

  it('many concurrent debits never overdraw: exactly balance/amount succeed', async () => {
    const u = uniqueUser('drain');
    await api.credit(u, 50);
    const results = await Promise.all(Array.from({ length: 200 }, () => api.debit(u, 1)));

    assert.deepEqual(countBy(results.map((r) => r.status)), { 200: 50, 409: 150 });
    assert.equal((await api.balance(u)).body.balance, 0);
    assert.equal(await ledgerCount(h.pool, u), 51);
  });

  it('a random mix of credits and debits across users matches the ledger exactly', async () => {
    const users = Array.from({ length: 20 }, () => uniqueUser('mix'));
    const expected = new Map<string, number>();
    for (const u of users) {
      await api.credit(u, 1000);
      expected.set(u, 1000);
    }

    const ops = Array.from({ length: 2000 }, () => {
      const u = users[Math.floor(Math.random() * users.length)]!;
      const isCredit = Math.random() < 0.5;
      const amount = 1 + Math.floor(Math.random() * (isCredit ? 100 : 300));
      return { u, isCredit, amount };
    });

    const results = await Promise.all(
      ops.map(async (op) => ({ op, res: op.isCredit ? await api.credit(op.u, op.amount) : await api.debit(op.u, op.amount) })),
    );

    for (const { op, res } of results) {
      assert.ok(res.status === 200 || (res.status === 409 && !op.isCredit), `unexpected ${res.status}`);
      assert.ok(res.status !== 200 || res.body.balance >= 0);
      if (res.status === 200) expected.set(op.u, expected.get(op.u)! + (op.isCredit ? op.amount : -op.amount));
    }

    for (const u of users) {
      assert.equal((await api.balance(u)).body.balance, expected.get(u), u);
      assert.equal(await ledgerSum(h.pool, u), expected.get(u), u);
    }
    assert.equal(await mismatchedBalances(h.pool), 0);
  });

  it('a hot user does not block requests for other users', async () => {
    const hot = uniqueUser('hot');
    const cold = Array.from({ length: 10 }, () => uniqueUser('cold'));
    await api.credit(hot, 1);
    for (const u of cold) await api.credit(u, 1000);

    const burst = 1500;
    let hotDone = 0;
    const hotRequests = Array.from({ length: burst }, () =>
      api.credit(hot, 1).then((r) => {
        hotDone++;
        return r;
      }),
    );

    const coldApi = client(h.baseUrl);
    for (const u of cold) {
      assert.equal((await coldApi.debit(u, 1)).status, 200);
      assert.equal((await coldApi.balance(u)).status, 200);
    }
    const hotDoneWhenColdFinished = hotDone;

    const hotResults = await Promise.all(hotRequests);
    assert.deepEqual(countBy(hotResults.map((r) => r.status)), { 200: burst });
    assert.equal((await api.balance(hot)).body.balance, 1 + burst);
    assert.ok(
      hotDoneWhenColdFinished < burst,
      `cold requests should finish while the hot backlog is still draining (${hotDoneWhenColdFinished}/${burst})`,
    );
  });

  it('a connection killed mid-request leaves no partial write', async () => {
    const u = uniqueUser('crash');
    await api.credit(u, 100);

    const locker = new Client({ connectionString: databaseUrl });
    await locker.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT 1 FROM balances WHERE user_id = $1 FOR UPDATE', [u]);

      const pending = api.credit(u, 50);

      let pid: number | undefined;
      for (let i = 0; i < 100 && pid === undefined; i++) {
        const { rows } = await locker.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%INSERT INTO balances%'`,
        );
        pid = rows[0]?.pid;
        if (pid === undefined) await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(pid, 'credit should be waiting on the row lock');

      await locker.query('SELECT pg_terminate_backend($1)', [pid]);
      const res = await pending;
      assert.equal(res.status, 500);
      assert.equal(res.body.error, 'internal_error');
      await locker.query('ROLLBACK');
    } finally {
      await locker.end();
    }

    assert.equal((await api.balance(u)).body.balance, 100);
    assert.equal(await ledgerCount(h.pool, u), 1);
    assert.equal((await api.credit(u, 5)).body.balance, 105);
  });
});
