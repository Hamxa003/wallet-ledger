export interface Config {
  port: number;
  host: string;
  apiToken: string;
  databaseUrl: string;
  poolMax: number;
  workers: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }
  return parsed;
}

export function loadConfig(): Config {
  return {
    port: intFromEnv('PORT', 8080),
    host: process.env.HOST || '0.0.0.0',
    apiToken: required('API_TOKEN'),
    databaseUrl: required('DATABASE_URL'),
    poolMax: intFromEnv('PG_POOL_MAX', 20),
    workers: intFromEnv('WEB_CONCURRENCY', 1),
  };
}
