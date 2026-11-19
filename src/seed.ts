import { Pool, PoolClient } from 'pg';
import { waitForDatabase } from './db';
import { runMigrations } from './migrate';

/*
 * Data shape (scale = 1):
 *   users 1..10        150,000 rows each   (1.5M)
 *   users 11..1,000      3,000 rows each   (~3.0M)
 *   users 1,001..100k    1..121 rows each  (~6.0M)
 *
 * Every 4th entry of a user is a debit of at most 1,000; every other entry is a
 * credit of at least 1,000. Credits always outnumber debits in any prefix of a
 * user's history, so the running balance never drops below zero.
 */

const TOTAL_USERS = 100_000;
const WHALE_USERS = 10;
const MID_USERS = 1_000;
const WHALE_ROWS = 150_000;
const MID_ROWS = 3_000;
const TAIL_SPREAD = 121;

const INSERT_CHUNK_SQL = `
  INSERT INTO ledger (user_id, type, amount, created_at)
  SELECT u.user_id,
         CASE WHEN k % 4 = 0 THEN 'debit' ELSE 'credit' END::entry_type,
         CASE WHEN k % 4 = 0
              THEN 1 + (k::bigint * 7919 + u.n) % 1000
              ELSE 1000 + (k::bigint * 104729 + u.n) % 9000
         END,
         $6::timestamptz - make_interval(secs => u.cnt - k)
    FROM (
      SELECT n,
             'user_' || lpad(n::text, 6, '0') AS user_id,
             CASE WHEN n <= ${WHALE_USERS} THEN $3::int
                  WHEN n <= ${MID_USERS} THEN $4::int
                  ELSE 1 + floor(((n::bigint * 2654435761) % ${TAIL_SPREAD}) * $5::float8)::int
             END AS cnt
        FROM generate_series($1::int, $2::int) AS n
    ) u
    CROSS JOIN LATERAL generate_series(1, u.cnt) AS k
   ORDER BY u.n, k`;

const REBUILD_BALANCES_SQL = `
  INSERT INTO balances (user_id, balance, updated_at)
  SELECT user_id,
         SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END),
         MAX(created_at)
    FROM ledger
   GROUP BY user_id`;

const VERIFY_SQL = `
  WITH running AS (
    SELECT user_id,
           SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END)
             OVER (PARTITION BY user_id ORDER BY id) AS balance
      FROM ledger
  ), lowest AS (
    SELECT user_id, MIN(balance) AS min_balance FROM running GROUP BY user_id
  )
  SELECT
    (SELECT count(*) FROM lowest WHERE min_balance < 0) AS users_dipping_negative,
    (SELECT count(*)
       FROM balances b
       FULL JOIN (
         SELECT user_id, SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END) AS total
           FROM ledger GROUP BY user_id
       ) l USING (user_id)
      WHERE b.balance IS DISTINCT FROM l.total) AS balance_mismatches`;

interface Options {
  scale: number;
  workers: number;
  reset: boolean;
  verify: boolean;
}

interface Chunk {
  from: number;
  to: number;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { scale: 1, workers: 4, reset: false, verify: false };
  for (const arg of argv) {
    const [key, value] = arg.split('=');
    if (key === '--reset') opts.reset = true;
    else if (key === '--verify') opts.verify = true;
    else if (key === '--scale') opts.scale = Number(value);
    else if (key === '--workers') opts.workers = Number(value);
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!(opts.scale > 0 && opts.scale <= 10)) throw new Error('--scale must be in (0, 10]');
  if (!Number.isInteger(opts.workers) || opts.workers < 1) throw new Error('--workers must be a positive integer');
  return opts;
}

function buildChunks(): Chunk[] {
  const chunks: Chunk[] = [];
  const push = (start: number, end: number, size: number) => {
    for (let from = start; from <= end; from += size) chunks.push({ from, to: Math.min(from + size - 1, end) });
  };
  push(1, WHALE_USERS, 1);
  push(WHALE_USERS + 1, MID_USERS, 100);
  push(MID_USERS + 1, TOTAL_USERS, 5_000);
  return chunks;
}

const elapsed = (start: number) => `${((performance.now() - start) / 1000).toFixed(1)}s`;

async function prepare(client: PoolClient, reset: boolean): Promise<void> {
  const { rows } = await client.query<{ has_rows: boolean }>('SELECT EXISTS (SELECT 1 FROM ledger) AS has_rows');
  if (rows[0]!.has_rows) {
    if (!reset) throw new Error('Ledger already has data; rerun with --reset to replace it');
    await client.query('BEGIN');
    await client.query('ALTER TABLE ledger DISABLE TRIGGER ledger_no_truncate');
    await client.query('TRUNCATE ledger, balances RESTART IDENTITY');
    await client.query('ALTER TABLE ledger ENABLE TRIGGER ledger_no_truncate');
    await client.query('COMMIT');
  } else {
    await client.query('TRUNCATE balances');
  }
  await client.query('DROP INDEX IF EXISTS ledger_user_id_id_idx');
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Missing required environment variable DATABASE_URL');
  const opts = parseArgs(process.argv.slice(2));

  const pool = new Pool({
    connectionString: databaseUrl,
    max: opts.workers,
    options: '-c synchronous_commit=off -c maintenance_work_mem=512MB -c max_parallel_maintenance_workers=4',
  });

  const started = performance.now();
  try {
    await waitForDatabase(pool);
    await runMigrations(pool);

    const admin = await pool.connect();
    try {
      await prepare(admin, opts.reset);
    } finally {
      admin.release();
    }

    const whaleRows = Math.max(1, Math.round(WHALE_ROWS * opts.scale));
    const midRows = Math.max(1, Math.round(MID_ROWS * opts.scale));
    const base = new Date().toISOString();
    const chunks = buildChunks();
    let next = 0;
    let done = 0;
    let inserted = 0;

    const phase = performance.now();
    const worker = async () => {
      while (next < chunks.length) {
        const chunk = chunks[next++]!;
        const res = await pool.query(INSERT_CHUNK_SQL, [chunk.from, chunk.to, whaleRows, midRows, opts.scale, base]);
        inserted += res.rowCount ?? 0;
        done++;
        if (done % 5 === 0 || done === chunks.length) {
          console.log(`  ${done}/${chunks.length} chunks, ${inserted.toLocaleString()} rows (${elapsed(phase)})`);
        }
      }
    };
    console.log(`Inserting ledger rows with ${opts.workers} workers (scale ${opts.scale})`);
    await Promise.all(Array.from({ length: opts.workers }, worker));
    console.log(`Ledger loaded: ${inserted.toLocaleString()} rows in ${elapsed(phase)}`);

    let step = performance.now();
    await pool.query('CREATE INDEX ledger_user_id_id_idx ON ledger (user_id, id)');
    console.log(`Index built in ${elapsed(step)}`);

    step = performance.now();
    const balances = await pool.query(REBUILD_BALANCES_SQL);
    console.log(`Balances rebuilt for ${balances.rowCount?.toLocaleString()} users in ${elapsed(step)}`);

    step = performance.now();
    await pool.query('VACUUM (ANALYZE) ledger');
    await pool.query('VACUUM (ANALYZE) balances');
    console.log(`Vacuum and analyze in ${elapsed(step)}`);

    console.log(`Seed finished in ${elapsed(started)}`);

    if (opts.verify) {
      step = performance.now();
      const { rows } = await pool.query(VERIFY_SQL);
      console.log(`Verification (${elapsed(step)}):`, rows[0]);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
