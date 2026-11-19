import type { AddressInfo } from 'node:net';
import { Client, Pool } from 'pg';
import { buildApp } from '../../src/app';
import { runMigrations } from '../../src/migrate';
import { testConfig, TEST_TOKEN } from '../helpers';

export const databaseUrl = process.env.TEST_DATABASE_URL;
export const skip = databaseUrl ? false : 'TEST_DATABASE_URL is not set';

async function ensureDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.slice(1));
  const admin = new URL(url);
  admin.pathname = '/postgres';

  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
  } finally {
    await client.end();
  }
}

export interface Harness {
  baseUrl: string;
  pool: Pool;
  close(): Promise<void>;
}

export async function startHarness(poolMax = 10): Promise<Harness> {
  const url = databaseUrl!;
  await ensureDatabase(url);

  const pool = new Pool({ connectionString: url, max: poolMax, connectionTimeoutMillis: 5_000 });
  pool.on('error', () => undefined);
  await runMigrations(pool);
  await pool.query('ALTER TABLE ledger DISABLE TRIGGER ledger_no_truncate');
  await pool.query('TRUNCATE ledger, balances RESTART IDENTITY');
  await pool.query('ALTER TABLE ledger ENABLE TRIGGER ledger_no_truncate');

  const app = buildApp({ config: testConfig({ databaseUrl: url, poolMax }), pool, logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    pool,
    async close() {
      await app.close();
      await pool.end();
    },
  };
}

export interface ApiResponse {
  status: number;
  body: any;
}

// Each client behaves like a load generator with a fixed number of threads. Opening
// thousands of sockets at once overflows the OS listen backlog instead of testing the API.
function limiter(max: number) {
  let inFlight = 0;
  const waiting: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (inFlight >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    inFlight++;
    try {
      return await fn();
    } finally {
      inFlight--;
      waiting.shift()?.();
    }
  };
}

export function client(baseUrl: string, token: string | null = TEST_TOKEN, maxInFlight = 100) {
  const limited = limiter(maxInFlight);
  const call = (method: string, path: string, body?: unknown): Promise<ApiResponse> =>
    limited(async () => {
      const headers: Record<string, string> = {};
      if (token !== null) headers.authorization = `Bearer ${token}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    });

  return {
    credit: (user_id: string, amount: number) => call('POST', '/credit', { user_id, amount }),
    debit: (user_id: string, amount: number) => call('POST', '/debit', { user_id, amount }),
    balance: (user_id: string) => call('GET', `/balance/${encodeURIComponent(user_id)}`),
    raw: call,
  };
}

let counter = 0;
export function uniqueUser(prefix = 'u'): string {
  return `${prefix}_${process.pid}_${Date.now().toString(36)}_${counter++}`;
}

export async function ledgerSum(pool: Pool, userId: string): Promise<number> {
  const { rows } = await pool.query<{ total: string | null }>(
    `SELECT SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END) AS total FROM ledger WHERE user_id = $1`,
    [userId],
  );
  return Number(rows[0]!.total ?? 0);
}

export async function ledgerCount(pool: Pool, userId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM ledger WHERE user_id = $1', [userId]);
  return Number(rows[0]!.n);
}

export async function mismatchedBalances(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`
    SELECT count(*) AS n
      FROM balances b
      FULL JOIN (
        SELECT user_id, SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END) AS total
          FROM ledger GROUP BY user_id
      ) l USING (user_id)
     WHERE b.balance IS DISTINCT FROM l.total OR b.balance < 0`);
  return Number(rows[0]!.n);
}
