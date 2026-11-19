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
- `balances` holds one row per user with the current balance. It is changed in the same transaction
  that appends the ledger rows, so the two can never disagree.
- `CHECK (balance >= 0)` makes a negative balance impossible at the database level, even if the
  application had a bug.
- `ledger_user_id_id_idx` serves per-user history and reconciliation queries. No request path scans it.
- `fillfactor = 80` leaves free space on each `balances` page so balance updates can stay on the same
  page (HOT updates) without touching the index.
- `type` is an enum: 4 bytes, and invalid values are rejected.
- There is no foreign key from `ledger` to `balances`. Every write path creates or locks the balance
  row first, and a foreign key would add a lookup to every insert and slow the bulk seed.

Migrations are plain SQL files applied in order under a Postgres advisory lock. The runner stores a
SHA-256 checksum of each file and refuses to start if an applied migration has been changed.

### How the balance is computed

`get_balance` is a primary-key lookup on `balances`: one index probe, 4 buffers, about 0.02 ms at
11M rows. It does not depend on ledger size or on how many rows the user has.

Summing the ledger for a user with 449k rows takes about 58 ms even fully cached (plan below). That
grows with history, which is why the balance is kept in its own table.

### Writes

Writes for a user go through a per-user batcher (`src/write-batcher.ts`):

- **No contention:** an incoming write is flushed on its own straight away, as a single SQL statement.
- **Contention:** while that flush is in flight, further writes for the same user queue in memory.
  When it finishes, everything queued (up to 100) is flushed together as one batch.

Under normal traffic, with writes spread across many users, every write takes the single-statement
path. Batching only starts when a user is busy.

**Single credit**

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
new user arrive at once.

**Single debit**

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

**Batch**

`SELECT ... FROM apply_ledger_batch($1, $types, $amounts) ORDER BY out_ord`, a PL/pgSQL function in
`migrations/002_apply_ledger_batch.sql`. In one round trip and one transaction it:

1. Locks the user's row with `SELECT ... FOR UPDATE`. If the user is new and the batch contains a
   credit, it creates the row with `ON CONFLICT DO NOTHING` first.
2. Walks the operations in request order, applying each to the running balance exactly as if it
   were a separate request. Each debit is checked against the balance at that point; a debit before
   the user's first credit is "not found".
3. Inserts the accepted operations into `ledger` with one multi-row `INSERT`, in request order, so
   ledger `id` order matches the order the balances were computed in.
4. Writes the final balance with one `UPDATE`.
5. Returns one row per operation: accepted with the balance right after it, or rejected with the
   reason.

Each HTTP request still gets its own status and its own post-operation balance. An integration test
checks that every balance returned by 1,000 concurrent requests for one user appears in that user's
running ledger balance, in `id` order.

All statements are sent as named prepared statements, so each connection plans them once.

### Concurrency and isolation level

The isolation level is **READ COMMITTED**, the Postgres default.

- **Correctness comes from the row lock on the user's `balances` row.** Single writes and batches
  for the same user run one after the other, across processes and across instances.
  - A single debit's `UPDATE` re-checks `balance >= amount` against the newly committed row once it
    gets the lock (the EvalPlanQual recheck), so it never acts on a stale balance.
  - A batch reads the balance with `FOR UPDATE`, so it always starts from the latest committed value.
- **No lost updates.** Balances are always computed from the locked row, never from a value the
  application read earlier.
- **No deadlocks.** Every write locks exactly one row, so there is no lock ordering to get wrong.
- **Retries anyway.** Writes are retried on `40001` (serialization failure) and `40P01` (deadlock)
  with exponential backoff and jitter. Postgres guarantees those transactions were rolled back, so a
  retry cannot double-apply. Connection errors are deliberately not retried, because the transaction
  may have committed.
- **Atomicity.** A single write or a whole batch is one transaction. A crash or a killed connection
  leaves either everything in it or nothing. If a batch fails, every request in it gets an error and
  none of them is written. The test suite kills a backend mid-request and checks this.
- **Read-your-writes.** There is one primary and responses are sent after commit, so a later
  `get_balance` always sees the write.

### Hot users

Writes to one user serialize on that user's row lock, so how fast a hot user can go depends on how
long each transaction holds that lock. The batcher helps in two ways:

- **Isolation.** Waiting writes queue in memory, not on a pool connection. Each process holds at most
  one connection per user, so a hot user can't drain the pool. The test suite holds a hot user's row
  lock from outside while 500 writes pile up, and checks that other users are still served. With
  the batcher bypassed, that test fails.
- **Throughput.** N queued writes become one transaction holding the lock once, with one round trip
  and one commit, instead of N.

At 10M rows, with 50 threads hammering one user, three versions compared:

| Hot-user writes | One statement per write | Batch as a Node transaction (5 round trips) | Batch in one function call |
|---|---:|---:|---:|
| p50 | 25.8 ms | 11.8 ms | **4.4 ms** |
| p99 | 56.7 ms | 24.8 ms | **11.5 ms** |
| Writes/s for that user | ~1,800 | ~3,800 | **~8,900** |

The Node-side transaction held the row lock across five round trips. On a busy server, each one
also waits its turn in the event loop. Moving the batch into a single function call keeps the lock
hold time down to the database work alone, about 0.25 ms for a 10-operation batch.

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
- Each worker has its own connection pool and its own batcher. The database row lock serializes
  batches from different workers.
- The primary restarts workers that die and forwards `SIGTERM` for a graceful shutdown.

On the 8-core laptop, with the load generator on the same machine, two workers gave the best balance
of p50 and p99. Four lowered p50 further but raised p99, because they competed with the client for CPU.

## Alternatives considered

| Option | Why not |
|---|---|
| Compute the balance from the ledger on read | 58 ms for a 449k-row user even cached (plan below), and it grows with history. The brief rules it out. |
| `SERIALIZABLE` isolation | Same correctness here, but conflicting writes abort and must be retried. Under a hot user that becomes a retry storm. The row lock with READ COMMITTED queues them instead. |
| `SELECT ... FOR UPDATE`, then `UPDATE`, then `INSERT` per request | Correct, but several round trips while holding the lock instead of one. The lock hold time is what limits hot-user throughput. |
| Batching in a Node-side transaction | Implemented and measured (table above). Same semantics, but the lock is held across five round trips: hot-user p50 11.8 ms against 4.4 ms for the function. |
| Doing every write through the PL/pgSQL function | Fewer code paths, but single writes would lose readable `EXPLAIN` plans and pay function overhead on the common, uncontended path. |
| Optimistic locking with a version column | Every conflict costs a full retry. It works when contention is low and gets worse exactly in the hot-user case. |
| Advisory locks per user | An extra lock to manage that duplicates what the row lock already does. |
| A trigger on `ledger` that maintains `balances` | Same locking cost, but the logic is hidden in the database and the API still needs a second read to return the balance. |
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

Later runs on the same machine took 26 to 40 s, depending on what else was running. The 1.1M-row
seed (`--scale=0.1`) takes about 2 s. Expect Docker Desktop on macOS to be slower because of its VM
and volume overhead.

## Tests

`npm test` runs 49 unit tests:
- validation, including `1.0`, `1e3`, strings, booleans and boundary values
- auth, including a check that a rejected request never reaches the database
- the retry helper
- the write batcher: flushes immediately when idle, groups queued writes, never runs two flushes for
  one user at once, runs different users in parallel, and keeps going after a failed flush

`npm run test:integration` runs 28 tests against a real Postgres through the real HTTP server.

**API contract**
- the status codes and response bodies from the brief
- 409 and 404 write nothing
- ledger rows are immutable and carry server timestamps
- read-your-writes over 50 sequential operations
- 401 on every endpoint
- 400 for each input rule

**Batch function**, called directly:
- operations apply in order against the running balance
- accepted entries are written in request order
- an unknown user is "not found" until the first credit, and nothing is created if every
  operation is a debit
- nothing is written when every debit is rejected
- 20 racing batches for the same new user stay consistent

**Concurrency**

| Test | Checks |
|---|---|
| Two debits of 60 against 100, repeated 50 times | Exactly one 200 and one 409 every round |
| 1,000 concurrent credits of 100 | Balance rises by exactly 100,000, and all 1,000 responses saw distinct post-operation balances |
| 100 concurrent first credits for a new user | All succeed |
| 200 concurrent debits of 1 against 50 | Exactly 50 succeed and 150 get 409 |
| 2,000 random concurrent credits and debits across 20 users | Each balance equals the client's tally of accepted operations and the ledger sum |
| 1,000 concurrent mixed writes on one user (batched) | Running balance in `id` order never goes negative, and every 200 response's balance appears in that history |
| 100 concurrent credits and debits on a never-credited user | Only 200, 404 or 409, and the final balance matches the ledger |
| Blocked hot user | With the hot user's row locked from outside and 500 writes queued, other users' writes and all reads still succeed, and not one hot write completes until the lock is released |
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
| balance | 4.24 ms | 10.37 ms | 4.37 ms | 11.96 ms | 10,384 |
| credit | 4.32 ms | 10.45 ms | 4.48 ms | 12.17 ms | 6,228 |
| debit | 4.33 ms | 10.60 ms | 4.49 ms | 12.19 ms | 4,149 |

Total: about 22.1k requests/s at 1M rows and 20.8k requests/s at 10M. There were no 5xx responses
and no network errors. The only non-200s were a handful of expected 409s.

Latency barely changes with a 10× larger table: every request is a primary-key operation on
`balances` plus an append to `ledger`. With a closed-loop client the latency is mostly queueing
(100 in flight ÷ ~21k requests/s ≈ 5 ms). The database work is about 0.02 ms to 0.2 ms per statement
(plans below).

### Hot user at 10.5M rows

| Endpoint | p50 | p90 | p99 | req/s |
|---|---:|---:|---:|---:|
| balance (hot user) | 3.15 ms | 4.59 ms | 8.59 ms | 2,228 |
| credit (hot user) | 4.40 ms | 6.66 ms | 11.48 ms | 5,571 |
| debit (hot user) | 4.39 ms | 6.64 ms | 11.51 ms | 3,353 |
| balance (other users) | 3.16 ms | 4.59 ms | 8.72 ms | 7,124 |
| credit (other users) | 3.34 ms | 4.95 ms | 9.23 ms | 4,277 |
| debit (other users) | 3.35 ms | 4.95 ms | 9.33 ms | 2,842 |

Total: 25.4k requests/s, with no 5xx responses.

- The hot user took about 8,900 writes/s. Those were written in 33,754 transactions, averaging 8.9
  writes per batch with a maximum of 42.
- Hot-user writes cost about 1 ms more than other users' writes, at both p50 and p99.
- Hot-user reads never wait for writes, because reads don't take the row lock (MVCC).

At 1.1M rows the hot run looked the same: hot writes p50 4.26 ms and p99 10.0 ms; other users p50
3.2 ms.

## Query plans

`EXPLAIN (ANALYZE, BUFFERS)` at 11.0M ledger rows for `user_000001`, which had 449k ledger rows by
then. Writes ran inside `BEGIN ... ROLLBACK`.

**get_balance**

```
Index Scan using balances_pkey on balances (actual time=0.012..0.012 rows=1 loops=1)
  Index Cond: ((user_id)::text = 'user_000001'::text)
  Buffers: shared hit=4
Execution Time: 0.020 ms
```

**credit (single)**

```
CTE Scan on bal (actual time=0.062..0.062 rows=1 loops=1)
  CTE bal
    ->  Insert on balances (actual time=0.061..0.062 rows=1 loops=1)
          Conflict Resolution: UPDATE
          Conflict Arbiter Indexes: balances_pkey
          Tuples Inserted: 0
          Conflicting Tuples: 1
          Buffers: shared hit=12
  CTE entry
    ->  Insert on ledger (actual time=0.148..0.148 rows=0 loops=1)
          Buffers: shared hit=22
          ->  CTE Scan on bal bal_1 (actual time=0.039..0.039 rows=1 loops=1)
Execution Time: 0.223 ms
```

**debit (single)**

```
Result (actual time=0.076..0.076 rows=1 loops=1)
  CTE bal
    ->  Update on balances (actual time=0.022..0.022 rows=1 loops=1)
          ->  Index Scan using balances_pkey on balances (actual time=0.008..0.008 rows=1 loops=1)
                Index Cond: ((user_id)::text = 'user_000001'::text)
                Filter: (balance >= 500)
                Buffers: shared hit=4
  CTE entry
    ->  Insert on ledger (actual time=0.009..0.009 rows=0 loops=1)
          ->  CTE Scan on bal (actual time=0.002..0.002 rows=1 loops=1)
  InitPlan 4 (returns $5)
    ->  Index Only Scan using balances_pkey on balances balances_1 (actual time=0.053..0.053 rows=1 loops=1)
          Index Cond: (user_id = 'user_000001'::text)
Execution Time: 0.097 ms
```

**batch of 10 operations: the statements inside `apply_ledger_batch`**, captured with
`auto_explain.log_nested_statements`:

```
SELECT b.balance FROM balances b WHERE b.user_id = p_user_id FOR UPDATE      -- 0.060 ms
LockRows (actual time=0.057..0.058 rows=1 loops=1)
  ->  Index Scan using balances_pkey on balances b (actual time=0.044..0.044 rows=1 loops=1)
        Index Cond: ((user_id)::text = 'user_000001'::text)

INSERT INTO ledger ... FROM unnest(v_types, v_amounts) WITH ORDINALITY ...    -- 0.152 ms
Insert on ledger (actual time=0.151..0.151 rows=0 loops=1)
  ->  Subquery Scan on "*SELECT*" (actual time=0.021..0.032 rows=10 loops=1)
        ->  Function Scan on e (actual time=0.012..0.016 rows=10 loops=1)

UPDATE balances SET balance = v_balance ... WHERE user_id = p_user_id         -- 0.034 ms
Update on balances (actual time=0.033..0.034 rows=0 loops=1)
  ->  Index Scan using balances_pkey on balances (actual time=0.011..0.012 rows=1 loops=1)
        Index Cond: ((user_id)::text = 'user_000001'::text)
```

That's about 0.25 ms of database work for 10 operations. The outer call measured 2.9 ms in this
session because the first call in a session includes compiling the function. Pooled connections pay
that once.

**For comparison: summing the ledger instead (rejected)**

```
Finalize Aggregate (actual time=55.742..57.964 rows=1 loops=1)
  ->  Gather (Workers Launched: 2)
        ->  Parallel Bitmap Heap Scan on ledger (rows=149700 loops=3)
              ->  Bitmap Index Scan on ledger_user_id_id_idx (rows=449112 loops=1)
Execution Time: 57.994 ms
```

The complete output is in `loadtest-results/explain-10m.txt`.

## Known limits

### At 10× the load

1. **Postgres commit throughput breaks first.** Every uncontended write is its own commit with
   `synchronous_commit=on`, so the WAL flush rate caps write throughput across users. Batching only
   helps within a single user. Group commit (`commit_delay`) and faster storage are the next steps.
2. **API CPU.** On this laptop the Node processes and the load generator were already competing for
   cores. More workers or more instances is the fix, since the database guarantees correctness
   either way.
3. **The connection count grows with workers × pool size.** Past a few hundred connections Postgres
   itself slows down, so PgBouncer in transaction mode would go in front. Named prepared statements
   would then need PgBouncer 1.21+ protocol-level prepared statement support.
4. **Ledger growth.** At a billion rows the table and its index are a storage and vacuum problem
   rather than a latency one, because no request reads the ledger. Partitioning by time with
   archival of old partitions would handle it.

### Running several API instances

- **Correctness is unchanged.** All safety comes from the database: the row lock, the conditional
  update and the `CHECK` constraint.
- **Batching becomes per instance.** Each instance batches its own queued writes for a user, and the
  row lock serializes the batches. A hot user then holds at most one waiting connection per instance,
  and batches get smaller as instances are added.
- **Migrations are safe to run concurrently.** They take a Postgres advisory lock.
- **Read-your-writes holds while all instances use the primary.** Moving reads to replicas would
  break it unless reads are routed to the primary after a write, or wait for the replica to catch up.

### Other limits

- Balances are `bigint` and returned as JSON numbers, which are exact up to 2^53. The app raises an
  error rather than return a rounded value.
- No idempotency keys: a client that retries after a timeout can apply a credit twice.
- If a batch fails, for example because its connection is killed, every request in that batch gets a
  500, even though none of them caused the failure. Nothing is partially written.
- No `statement_timeout`. A stuck query would hold a connection until the pool timeout.
- The benchmark ran client, API and database on one laptop, with Postgres 14 natively rather than
  17 in Docker.

## With more time

- **`Idempotency-Key` support** on credit and debit, stored in a table with a unique key and written
  in the same transaction as the ledger rows.
- **Observability:** Prometheus metrics for latency per endpoint, batch sizes, queue depth per
  process, pool wait time and retry counts.
- **Database tuning:** PgBouncer, `statement_timeout`, and autovacuum settings for `balances`, which
  receives a high rate of updates.
- **Benchmark on separate machines** for the client and the server, against the exact compose setup.

## Project layout

```
src/
  server.ts          startup, cluster mode, graceful shutdown
  app.ts             Fastify instance, JSON parser, route wiring
  auth.ts            bearer token hook
  validation.ts      strict JSON parsing and input rules
  errors.ts          error shape and handlers
  ledger.ts          credit / debit / balance SQL, single and batched
  write-batcher.ts   per-user write queue that groups contended writes
  retry.ts           retry on serialization failures and deadlocks
  migrate.ts         migration runner (advisory lock, checksums)
  seed.ts            10M-row seed
  loadtest.ts        load generator
migrations/
  001_init.sql                 schema
  002_apply_ledger_batch.sql   batch function
test/                unit tests
test/integration/    API contract, batch function and concurrency tests (real Postgres)
loadtest-results/    raw load test output and query plans
```
