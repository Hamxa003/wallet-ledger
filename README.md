# Wallet Ledger API

An HTTP API that keeps a money ledger for many users and exposes `credit`, `debit` and `get_balance`.
Node.js 22 + TypeScript (Fastify) on PostgreSQL 17.

## Running it

```bash
docker compose up --build
```

The API listens on `http://localhost:8080`. Migrations run automatically on startup.

Every request needs `Authorization: Bearer <token>`. The token comes from `API_TOKEN` and defaults to
`recruitment-test-token` in `docker-compose.yml`. Override it from the shell:

```bash
API_TOKEN=something-else docker compose up --build
```

### Seeding 10M+ rows

With the stack running:

```bash
docker compose run --rm seed --verify
```

| Flag | Meaning |
|---|---|
| `--reset` | Replace existing data. Without it the seed refuses to touch a non-empty ledger. |
| `--verify` | After seeding, replay every user's history in `id` order and check that no running balance goes below zero and that `balances` matches the ledger. |
| `--scale=0.1` | Smaller dataset (~1.1M rows) for comparisons. |
| `--workers=4` | Parallel insert connections. |

### Tests

Unit tests need nothing else:

```bash
npm install
npm test
```

Integration and concurrency tests need a Postgres they can create a database in. With the compose stack up:

```bash
TEST_DATABASE_URL=postgres://ledger:ledger@localhost:5432/ledger_test npm run test:integration
```

### Load test

```bash
docker compose run --rm loadtest --scenario=mixed --duration=30
```

```bash
docker compose run --rm loadtest --scenario=hot --duration=30
```

The same script runs from the host with `npm run build && npm run loadtest -- --scenario=mixed`.

### Configuration

| Variable | Default | |
|---|---|---|
| `API_TOKEN` | required | Bearer token |
| `DATABASE_URL` | required | Postgres connection string |
| `PORT` | `8080` | |
| `WEB_CONCURRENCY` | `1` (`2` in compose) | Number of Node worker processes |
| `PG_POOL_MAX` | `20` (`10` in compose) | Connections per worker process |
| `LOG_LEVEL` | `warn` | |

## API

| Endpoint | Body | Success |
|---|---|---|
| `POST /credit` | `{"user_id": "u123", "amount": 10000}` | `200 {"user_id": "u123", "balance": 25000}` |
| `POST /debit` | `{"user_id": "u123", "amount": 4000}` | `200 {"user_id": "u123", "balance": 21000}` |
| `GET /balance/{user_id}` | | `200 {"user_id": "u123", "balance": 21000}` |
| `GET /health` | | `200 {"status": "ok"}` (also requires the token) |

Errors are `{"error": "<code>", "message": "<text>"}`:

| Status | Code | When |
|---|---|---|
| 400 | `invalid_request` | Malformed JSON, missing field, or a field breaking the input rules |
| 401 | `unauthorized` | Missing header, wrong scheme or wrong token |
| 404 | `user_not_found` | Balance or debit for a user that was never credited |
| 409 | `insufficient_funds` | Debit larger than the balance; nothing is written |

## Design

### Schema

```sql
CREATE TABLE ledger (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     varchar(64) NOT NULL,
    type        entry_type  NOT NULL,          -- enum: credit | debit
    amount      bigint      NOT NULL CHECK (amount > 0),
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_user_id_id_idx ON ledger (user_id, id);

CREATE TABLE balances (
    user_id     varchar(64) PRIMARY KEY,
    balance     bigint      NOT NULL CHECK (balance >= 0),
    updated_at  timestamptz NOT NULL DEFAULT now()
) WITH (fillfactor = 80);
```

- `ledger` is the source of truth and is append-only. Triggers reject `UPDATE`, `DELETE` and `TRUNCATE`.
- `balances` holds one row per user with the current balance. It is updated in the same statement that
  appends the ledger row, so the two can never disagree.
- `CHECK (balance >= 0)` makes a negative balance impossible at the database level, even if the
  application had a bug.
- `ledger_user_id_id_idx` serves per-user history and reconciliation queries. No request path scans it.
- `fillfactor = 80` leaves free space on each `balances` page so balance updates can stay on the same
  page (HOT updates) without touching the index.
- `type` is an enum: 4 bytes, and invalid values are rejected.
- There is no foreign key from `ledger` to `balances`. The credit statement always creates the balance
  row first, and a foreign key would add a lookup to every insert and slow the bulk seed.

### How the balance is computed

`get_balance` is a primary-key lookup on `balances`: one index probe, 4 buffers, about 0.02 ms at
10M+ rows. It does not depend on ledger size or on how many rows the user has.

Summing the ledger for a user with 210k rows takes about 128 ms (plan below). That gets slower as
history grows, which is why the balance is kept in its own table.

### Writes

Each write is a single SQL statement using data-modifying CTEs, so it is one round trip and one
implicit transaction.

**Credit**

```sql
WITH bal AS (
  INSERT INTO balances (user_id, balance) VALUES ($1, $2)
  ON CONFLICT (user_id) DO UPDATE
    SET balance = balances.balance + EXCLUDED.balance, updated_at = now()
  RETURNING balance
), entry AS (
  INSERT INTO ledger (user_id, type, amount) SELECT $1, 'credit', $2 FROM bal
)
SELECT balance FROM bal;
```

`ON CONFLICT` creates the user on first credit. It is also safe when many first credits for the same
new user arrive at once; the test suite fires 100 of them in parallel.

**Debit**

```sql
WITH bal AS (
  UPDATE balances SET balance = balance - $2, updated_at = now()
   WHERE user_id = $1 AND balance >= $2
  RETURNING balance
), entry AS (
  INSERT INTO ledger (user_id, type, amount) SELECT $1, 'debit', $2 FROM bal
)
SELECT (SELECT balance FROM bal) AS balance,
       EXISTS (SELECT 1 FROM balances WHERE user_id = $1) AS user_exists;
```

- The ledger row is inserted `FROM bal`, so it is only written when the balance update matched.
- If the update matched nothing, `user_exists` tells 404 apart from 409 in the same round trip.

Statements are sent as named prepared statements, so each connection plans them once.

### Concurrency and isolation level

The isolation level is **READ COMMITTED**, the Postgres default.

- **Correctness comes from the row lock on the user's `balances` row.** Two writes to the same user
  run one after the other. When the second `UPDATE` gets the lock, Postgres re-checks its `WHERE`
  clause against the newly committed row (the EvalPlanQual recheck). For a debit, that means
  `balance >= amount` is evaluated against the latest balance, never a stale one.
- **No lost updates.** `balance = balance + $2` is computed from the locked row, not from a value the
  application read earlier.
- **No deadlocks.** Every write locks exactly one row, so there is no lock ordering to get wrong.
- **Retries anyway.** Writes are retried on `40001` (serialization failure) and `40P01` (deadlock)
  with exponential backoff and jitter. Postgres guarantees those transactions were rolled back, so a
  retry cannot double-apply. Connection errors are deliberately not retried, because the statement
  may have committed.
- **Atomicity.** Each statement is one transaction. A crash or a killed connection leaves either
  both the balance change and the ledger row, or neither. The test suite kills a backend mid-request
  and checks this.
- **Read-your-writes.** There is one primary and responses are sent after commit, so a later
  `get_balance` always sees the write.

### Hot users

Writes for one user serialize on that user's row lock no matter what. On its own, that is a problem
for everyone else: 50 requests for the same user would each check out a pool connection and sit
waiting on the lock, draining the pool for other users.

`KeyedQueue` (`src/keyed-queue.ts`) queues writes per user inside each worker process before they take
a connection. Each process has at most one connection per user waiting on the database, and
everything else waits in memory. Correctness does not depend on the queue: it only protects the pool,
so several processes or instances stay correct because the database still does the locking.

In the hot-user load test, other users keep a p50 of about 2.4 ms while 50 threads hammer one user.

### Authentication and validation

- **Auth runs first.** It is an `onRequest` hook, so it runs before body parsing, routing and any
  database access.
- **Constant-time comparison.** Both tokens are hashed with SHA-256 and compared with
  `crypto.timingSafeEqual`. Hashing first gives equal-length inputs, so the comparison doesn't leak
  the token's length.
- **The token is never exposed.** It is read only from the environment, is redacted from logs, and
  never appears in a response.
- **Integer check.** `JSON.parse("1.0")` yields the integer `1`, which would let `{"amount": 1.0}`
  through. The JSON body parser uses a reviver with access to the source text and rejects any number
  that wasn't written as an integer literal. This needs Node 22, so the app refuses to start on older
  runtimes instead of silently accepting decimals.

### Worker processes

A single Node process saturates one core at about 15k requests/s on the test laptop, while Postgres
had headroom. The server can run as a cluster (`WEB_CONCURRENCY`):

- The primary process runs migrations once, then forks workers that share the port.
- Each worker has its own connection pool and its own `KeyedQueue`.
- The primary restarts workers that die and forwards `SIGTERM` for a graceful shutdown.

On the 8-core laptop, with the load generator on the same machine, two workers gave the best balance
of p50 and p99. Four lowered p50 further but raised p99, because they competed with the client for CPU.

## Alternatives considered

| Option | Why not |
|---|---|
| Compute the balance from the ledger on read | 128 ms for a 210k-row user even with the index (plan below), and it grows with history. The brief rules it out. |
| `SERIALIZABLE` isolation | Same correctness here, but conflicting writes abort and must be retried. Under a hot user that becomes a retry storm. The row lock with READ COMMITTED queues them instead. |
| `SELECT ... FOR UPDATE`, then `UPDATE`, then `INSERT` in an explicit transaction | Correct, but three or four round trips while holding the lock instead of one. The lock hold time is what limits hot-user throughput. |
| Optimistic locking with a version column | Every conflict costs a full retry. It works when contention is low and gets worse exactly in the hot-user case. |
| Advisory locks per user | An extra lock to manage that duplicates what the row lock already does. |
| A trigger on `ledger` that maintains `balances` | Same locking cost, but the logic is hidden in the database and the API still needs a second read to return the balance. |
| A `balance_after` column on each ledger row | Still has to read or lock the user's latest state, so it needs the same lock plus a lookup. It would be a nice audit field and could be added. |
| A materialized view of balances | Stale between refreshes, and refreshing at 10M rows is expensive. |
| Partitioning `ledger` | Not needed at 10M. No request path reads the ledger, and inserts go to the right edge of the indexes. It is worth doing at hundreds of millions of rows, mainly for maintenance and archival. |

## Seed data

`src/seed.ts` generates rows inside Postgres with `generate_series`, so no data crosses the network.

| Users | Rows each | Rows |
|---|---|---|
| `user_000001`..`user_000010` | 150,000 | 1.5M |
| `user_000011`..`user_001000` | 3,000 | 3.0M |
| `user_001001`..`user_100000` | 1 to 121 | 6.0M |
| **Total** | | **10,509,022 rows, 100,000 users** |

**Why no balance goes negative.** Every 4th entry for a user is a debit of at most 1,000, and every
other entry is a credit of at least 1,000. In any prefix of a user's history credits outnumber
debits, so the running balance never goes below zero. `--verify` checks this with SQL.

**How it loads quickly:**
- Four connections insert user ranges in parallel.
- The `(user_id, id)` index is dropped during the load and rebuilt afterwards with parallel workers.
- `balances` is built from the ledger with one `GROUP BY`, so it matches by construction.
- It finishes with `VACUUM ANALYZE`.

**Seed time** on an Apple M1 (8 cores, 8 GB RAM), Postgres 14 running natively:

| Step | Time |
|---|---|
| Insert 10.5M ledger rows | 15.4 s |
| Build `(user_id, id)` index | 8.6 s |
| Rebuild `balances` | 5.6 s |
| Vacuum and analyze | 1.4 s |
| **Total** | **31.0 s** |

The 1.1M-row seed (`--scale=0.1`) takes about 2 s. Expect Docker Desktop on macOS to be slower
because of its VM and volume overhead.

## Tests

`npm test` runs 47 unit tests:
- validation, including `1.0`, `1e3`, strings, booleans and boundary values
- auth, including a check that a rejected request never reaches the database
- the retry helper
- the per-user queue

`npm run test:integration` runs 20 tests against a real Postgres through the real HTTP server.

**API contract**
- the status codes and response bodies from the brief
- 409 and 404 write nothing
- ledger rows are immutable and carry server timestamps
- read-your-writes over 50 sequential operations
- 401 on every endpoint
- 400 for each input rule

**Concurrency**

| Test | Checks |
|---|---|
| Two debits of 60 against 100, repeated 50 times | Exactly one 200 and one 409 every round |
| 1,000 concurrent credits of 100 | Balance rises by exactly 100,000, and all 1,000 responses saw distinct post-operation balances |
| 100 concurrent first credits for a new user | All succeed |
| 200 concurrent debits of 1 against 50 | Exactly 50 succeed and 150 get 409 |
| 2,000 random concurrent credits and debits across 20 users | Each balance equals the client's tally of accepted operations and the ledger sum |
| Hot-user isolation | Cold-user requests complete while a 1,500-request hot backlog is still draining |
| Crash mid-request | Kill the database backend of a credit that is waiting on the row lock: no ledger row, balance unchanged, the next request works |

The test client sends at most 100 requests at a time, like a load generator with 100 threads. Opening
1,000 sockets at once overflows the macOS listen backlog (`somaxconn` 128) and tests the OS rather
than the API.

## Load test results

`src/loadtest.ts` is a closed-loop load generator:
- 100 keep-alive connections split across 4 worker threads
- 5 s of warm-up that isn't recorded, then 30 s measured
- reports latency percentiles per endpoint and the full status-code breakdown
- exits non-zero on any unexpected status or network error

**Scenarios**
- **mixed:** 50% balance reads, 30% credits, 20% debits. Users are picked uniformly from all 100k
  seeded users.
- **hot:** 50 connections on `user_000001` (50% credit, 30% debit, 20% balance) and 50 connections
  on random users with the mixed profile. Results are split into hot user and other users.

**Environment:** an Apple M1 (8 cores, 8 GB RAM) running the load generator, the API
(`WEB_CONCURRENCY=2`, `PG_POOL_MAX=10`) and Postgres 14 natively. All three share the same 8 cores, so
these numbers are a lower bound. The data was reseeded before each run. After each run, all balances
were reconciled against the ledger: 0 mismatches and 0 negative balances. Raw output is in
`loadtest-results/`.

### Mixed traffic: 1.1M rows vs 10.5M rows

| Endpoint | p50 @1M | p99 @1M | p50 @10M | p99 @10M | req/s @10M |
|---|---:|---:|---:|---:|---:|
| balance | 4.08 ms | 12.20 ms | 4.39 ms | 13.64 ms | 9,947 |
| credit | 4.16 ms | 12.59 ms | 4.51 ms | 14.56 ms | 5,981 |
| debit | 4.18 ms | 12.59 ms | 4.51 ms | 14.38 ms | 3,987 |

Total: about 21.7k requests/s at 1M rows and 19.9k requests/s at 10M. There were no 5xx responses
and no network errors. The only non-200s were a handful of expected 409s.

Latency barely changes with a 10× larger table: every request is a primary-key operation on
`balances` plus an append to `ledger`. With a closed-loop client the latency is mostly queueing
(100 in flight ÷ ~20k requests/s ≈ 5 ms). The database work is about 0.1 ms to 1 ms per statement
(plans below).

### Hot user at 10.5M rows

| Endpoint | p50 | p90 | p99 | req/s |
|---|---:|---:|---:|---:|
| balance (hot user) | 2.23 ms | 3.31 ms | 6.11 ms | 434 |
| credit (hot user) | 25.83 ms | 36.74 ms | 56.71 ms | 1,112 |
| debit (hot user) | 25.83 ms | 36.61 ms | 56.30 ms | 665 |
| balance (other users) | 2.31 ms | 3.42 ms | 6.33 ms | 9,506 |
| credit (other users) | 2.44 ms | 3.66 ms | 6.66 ms | 5,718 |
| debit (other users) | 2.45 ms | 3.67 ms | 6.60 ms | 3,794 |

- **Other users are unaffected.** Their latency is lower than in the mixed run, because half the
  connections are parked on the hot user.
- **Hot-user writes serialize by design** at about 1,800 writes/s for that one user. Their latency is
  the queue depth: 50 threads ÷ 1,800/s ≈ 28 ms.
- **Hot-user reads are not blocked.** Reads never take the row lock (MVCC).

The 1M-row hot run looked the same (hot writes p50 25.6 ms; other users p50 2.3 ms).

## Query plans

`EXPLAIN (ANALYZE, BUFFERS)` at 10.9M ledger rows for `user_000001`, which had about 210k ledger rows
by then. Writes ran inside `BEGIN ... ROLLBACK`.

**get_balance**

```
Index Scan using balances_pkey on balances (actual time=0.020..0.020 rows=1 loops=1)
  Index Cond: ((user_id)::text = 'user_000001'::text)
  Buffers: shared hit=4
Execution Time: 0.161 ms
```

**credit**

```
CTE Scan on bal (actual time=0.523..0.524 rows=1 loops=1)
  CTE bal
    ->  Insert on balances (actual time=0.523..0.523 rows=1 loops=1)
          Conflict Resolution: UPDATE
          Conflict Arbiter Indexes: balances_pkey
          Tuples Inserted: 0
          Conflicting Tuples: 1
          Buffers: shared hit=12
  CTE entry
    ->  Insert on ledger (actual time=0.354..0.354 rows=0 loops=1)
          Buffers: shared hit=22
          ->  CTE Scan on bal bal_1 (actual time=0.194..0.194 rows=1 loops=1)
Execution Time: 1.035 ms
```

**debit**

```
Result (actual time=0.089..0.089 rows=1 loops=1)
  CTE bal
    ->  Update on balances (actual time=0.020..0.021 rows=1 loops=1)
          ->  Index Scan using balances_pkey on balances (actual time=0.005..0.006 rows=1 loops=1)
                Index Cond: ((user_id)::text = 'user_000001'::text)
                Filter: (balance >= 500)
                Buffers: shared hit=4
  CTE entry
    ->  Insert on ledger (actual time=0.011..0.011 rows=0 loops=1)
          ->  CTE Scan on bal (actual time=0.002..0.002 rows=1 loops=1)
  InitPlan 4 (returns $5)
    ->  Index Only Scan using balances_pkey on balances balances_1 (actual time=0.067..0.067 rows=1 loops=1)
          Index Cond: (user_id = 'user_000001'::text)
Execution Time: 0.114 ms
```

**For comparison: summing the ledger instead (rejected)**

```
Finalize Aggregate (actual time=126.898..128.532 rows=1 loops=1)
  ->  Gather (Workers Launched: 2)
        ->  Parallel Bitmap Heap Scan on ledger (rows=70170 loops=3)
              ->  Bitmap Index Scan on ledger_user_id_id_idx (rows=210512 loops=1)
Execution Time: 128.692 ms
```

The complete output is in `loadtest-results/explain-10m.txt`.

## Known limits

### At 10× the load

1. **Postgres commit throughput breaks first.** Every write is a commit with `synchronous_commit=on`,
   so the WAL flush rate caps write throughput. The next steps are group commit (`commit_delay`), faster
   storage, or batching writes for the same user into one transaction.
2. **A single hot user is capped** at roughly 1 / (lock hold time), about 1,800 writes/s here. Batching
   that user's queued writes into one statement is the fix (see below).
3. **The connection count grows with workers × pool size.** Past a few hundred connections Postgres
   itself slows down, so PgBouncer in transaction mode would go in front.
4. **Ledger growth.** At a billion rows the table and its index are a storage and vacuum problem
   rather than a latency one, because no request reads the ledger. Partitioning by time with
   archival of old partitions would handle it.

### Running several API instances

- **Correctness is unchanged.** All safety comes from the database: the row lock, the conditional
  update and the `CHECK` constraint.
- **The per-user queue becomes per instance.** A hot user then holds at most one waiting connection
  per instance instead of one in total. That's still bounded, but the protection is weaker.
- **Migrations are safe to run concurrently.** They take a Postgres advisory lock.
- **Read-your-writes holds while all instances use the primary.** Moving reads to replicas would
  break it unless reads are routed to the primary after a write, or wait for the replica to catch up.

### Other limits

- Balances are `bigint` and returned as JSON numbers, which are exact up to 2^53. The app raises an
  error rather than return a rounded value.
- No idempotency keys: a client that retries after a timeout can apply a credit twice.
- No `statement_timeout`. A stuck query would hold a connection until the pool timeout.
- The benchmark ran client, API and database on one laptop, with Postgres 14 natively rather than
  17 in Docker.

## With more time

- **Batch hot-user writes.** When writes are queued for a user, apply them all in one transaction:
  lock the row once, apply each operation in order (each debit still checked against the running
  balance), and insert all the ledger rows together. That turns N commits into one and should raise
  hot-user throughput several times over.
- **`Idempotency-Key` support** on credit and debit, stored in a table with a unique key in the same
  statement as the write.
- **Observability:** Prometheus metrics for latency per endpoint, queue depth per process, pool wait
  time and retry counts.
- **Database tuning:** PgBouncer, `statement_timeout`, and autovacuum settings for `balances`, which
  receives a high rate of updates.
- **Benchmark on separate machines** for the client and the server, against the exact compose setup.

## Project layout

```
src/
  server.ts         startup, cluster mode, graceful shutdown
  app.ts            Fastify instance, JSON parser, route wiring
  auth.ts           bearer token hook
  validation.ts     strict JSON parsing and input rules
  errors.ts         error shape and handlers
  ledger.ts         credit / debit / balance SQL
  keyed-queue.ts    per-user write queue
  retry.ts          retry on serialization failures and deadlocks
  migrate.ts        migration runner (advisory lock)
  seed.ts           10M-row seed
  loadtest.ts       load generator
migrations/         schema
test/               unit tests
test/integration/   API contract and concurrency tests (real Postgres)
loadtest-results/   raw load test output and query plans
```
