import http from 'node:http';
import os from 'node:os';
import { writeFile } from 'node:fs/promises';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

type Endpoint = 'credit' | 'debit' | 'balance';
type Scenario = 'mixed' | 'hot';

interface WorkerConfig {
  baseUrl: string;
  token: string;
  scenario: Scenario;
  durationMs: number;
  warmupMs: number;
  connections: number;
  firstConnection: number;
  totalConnections: number;
  users: number;
  hotUser: string;
}

interface Sample {
  endpoint: Endpoint;
  hot: boolean;
  status: number;
  ms: number;
}

interface WorkerResult {
  latencies: Record<string, number[]>;
  statuses: Record<string, Record<number, number>>;
  errors: number;
}

const ALLOWED_STATUSES: Record<Endpoint, number[]> = {
  credit: [200],
  debit: [200, 409],
  balance: [200],
};

function parseArgs(argv: string[]) {
  const args = new Map(argv.map((a) => a.replace(/^--/, '').split('=') as [string, string]));
  return {
    baseUrl: args.get('url') ?? process.env.BASE_URL ?? 'http://localhost:8080',
    token: process.env.API_TOKEN ?? 'recruitment-test-token',
    scenario: (args.get('scenario') ?? 'mixed') as Scenario,
    durationMs: Number(args.get('duration') ?? 30) * 1000,
    warmupMs: Number(args.get('warmup') ?? 5) * 1000,
    connections: Number(args.get('connections') ?? 100),
    threads: Number(args.get('threads') ?? Math.min(4, os.cpus().length)),
    users: Number(args.get('users') ?? 100_000),
    hotUser: args.get('hot-user') ?? 'user_000001',
    out: args.get('out'),
  };
}

const userId = (n: number) => `user_${String(n).padStart(6, '0')}`;

function runWorker(cfg: WorkerConfig): Promise<WorkerResult> {
  const agent = new http.Agent({ keepAlive: true, maxSockets: cfg.connections });
  const url = new URL(cfg.baseUrl);
  const samples: Sample[] = [];
  let errors = 0;

  const send = (method: string, path: string, body?: string) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          agent,
          host: url.hostname,
          port: url.port,
          method,
          path,
          headers: {
            authorization: `Bearer ${cfg.token}`,
            ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });

  const pickOp = (hot: boolean): { endpoint: Endpoint; user: string } => {
    const user = hot ? cfg.hotUser : userId(1 + Math.floor(Math.random() * cfg.users));
    const r = Math.random();
    if (hot) return { endpoint: r < 0.5 ? 'credit' : r < 0.8 ? 'debit' : 'balance', user };
    return { endpoint: r < 0.5 ? 'balance' : r < 0.8 ? 'credit' : 'debit', user };
  };

  const loop = async (connectionIndex: number) => {
    const hot = cfg.scenario === 'hot' && connectionIndex < cfg.totalConnections / 2;
    const recordFrom = performance.now() + cfg.warmupMs;
    const deadline = recordFrom + cfg.durationMs;
    while (performance.now() < deadline) {
      const { endpoint, user } = pickOp(hot);
      const started = performance.now();
      const record = started >= recordFrom;
      try {
        const status =
          endpoint === 'balance'
            ? await send('GET', `/balance/${user}`)
            : await send(
                'POST',
                `/${endpoint}`,
                JSON.stringify({
                  user_id: user,
                  amount: endpoint === 'credit' ? 1 + Math.floor(Math.random() * 10_000) : 1 + Math.floor(Math.random() * 1_000),
                }),
              );
        if (record) samples.push({ endpoint, hot, status, ms: performance.now() - started });
      } catch {
        if (record) errors++;
      }
    }
  };

  return Promise.all(Array.from({ length: cfg.connections }, (_, i) => loop(cfg.firstConnection + i))).then(() => {
    agent.destroy();
    const latencies: Record<string, number[]> = {};
    const statuses: Record<string, Record<number, number>> = {};
    for (const s of samples) {
      const key = cfg.scenario === 'hot' ? `${s.endpoint} (${s.hot ? 'hot user' : 'other users'})` : s.endpoint;
      (latencies[key] ??= []).push(s.ms);
      const counts = (statuses[key] ??= {});
      counts[s.status] = (counts[s.status] ?? 0) + 1;
    }
    return { latencies, statuses, errors };
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const perThread = Math.ceil(opts.connections / opts.threads);

  console.log(
    `Scenario ${opts.scenario}: ${opts.connections} connections over ${opts.threads} threads, ` +
      `${opts.warmupMs / 1000}s warmup then ${opts.durationMs / 1000}s measured, against ${opts.baseUrl}`,
  );

  const results = await Promise.all(
    Array.from({ length: opts.threads }, (_, t) => {
      const connections = Math.max(0, Math.min(perThread, opts.connections - t * perThread));
      const cfg: WorkerConfig = {
        baseUrl: opts.baseUrl,
        token: opts.token,
        scenario: opts.scenario,
        durationMs: opts.durationMs,
        warmupMs: opts.warmupMs,
        connections,
        firstConnection: t * perThread,
        totalConnections: opts.connections,
        users: opts.users,
        hotUser: opts.hotUser,
      };
      return new Promise<WorkerResult>((resolve, reject) => {
        const worker = new Worker(__filename, { workerData: cfg });
        worker.once('message', resolve);
        worker.once('error', reject);
      });
    }),
  );

  const latencies: Record<string, number[]> = {};
  const statuses: Record<string, Record<number, number>> = {};
  let errors = 0;
  for (const r of results) {
    errors += r.errors;
    for (const [k, v] of Object.entries(r.latencies)) latencies[k] = (latencies[k] ?? []).concat(v);
    for (const [k, counts] of Object.entries(r.statuses)) {
      const merged = (statuses[k] ??= {});
      for (const [code, n] of Object.entries(counts)) merged[Number(code)] = (merged[Number(code)] ?? 0) + n;
    }
  }

  const seconds = opts.durationMs / 1000;
  const rows = Object.keys(latencies)
    .sort()
    .map((key) => {
      const sorted = latencies[key]!.sort((a, b) => a - b);
      const endpoint = key.split(' ')[0] as Endpoint;
      const unexpected = Object.entries(statuses[key]!)
        .filter(([code]) => !ALLOWED_STATUSES[endpoint].includes(Number(code)))
        .reduce((n, [, c]) => n + c, 0);
      return {
        endpoint: key,
        requests: sorted.length,
        rps: Math.round(sorted.length / seconds),
        p50: percentile(sorted, 50),
        p90: percentile(sorted, 90),
        p99: percentile(sorted, 99),
        max: sorted[sorted.length - 1] ?? 0,
        statuses: statuses[key]!,
        unexpected,
      };
    });

  const fmt = (n: number) => n.toFixed(2);
  console.log('\n| Endpoint | Requests | Req/s | p50 ms | p90 ms | p99 ms | max ms | Statuses |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---|');
  for (const r of rows) {
    const codes = Object.entries(r.statuses).map(([c, n]) => `${c}: ${n}`).join(', ');
    console.log(`| ${r.endpoint} | ${r.requests} | ${r.rps} | ${fmt(r.p50)} | ${fmt(r.p90)} | ${fmt(r.p99)} | ${fmt(r.max)} | ${codes} |`);
  }
  const total = rows.reduce((n, r) => n + r.requests, 0);
  const unexpected = rows.reduce((n, r) => n + r.unexpected, 0);
  console.log(`\nTotal ${total} requests (${Math.round(total / seconds)} req/s), unexpected statuses: ${unexpected}, network errors: ${errors}`);

  if (opts.out) {
    await writeFile(opts.out, JSON.stringify({ options: { ...opts, token: undefined }, rows, errors }, null, 2));
  }
  if (unexpected > 0 || errors > 0) process.exitCode = 1;
}

if (isMainThread) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  runWorker(workerData as WorkerConfig).then((result) => parentPort!.postMessage(result));
}
