import type { Pool } from 'pg';
import { buildApp } from '../src/app';
import type { Config } from '../src/config';

export const TEST_TOKEN = 'test-token-123';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    apiToken: TEST_TOKEN,
    databaseUrl: 'postgres://unused',
    poolMax: 1,
    workers: 1,
    ...overrides,
  };
}

export function stubPool() {
  const stub = {
    queries: 0,
    async query() {
      stub.queries++;
      return { rows: [], rowCount: 0 };
    },
  };
  return stub;
}

export function buildTestApp() {
  const pool = stubPool();
  const app = buildApp({ config: testConfig(), pool: pool as unknown as Pool, logger: false });
  return { app, pool };
}

export const authHeader = { authorization: `Bearer ${TEST_TOKEN}` };
