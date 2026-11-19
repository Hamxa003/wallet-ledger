import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractBearerToken } from '../src/auth';
import { authHeader, buildTestApp, TEST_TOKEN } from './helpers';

describe('extractBearerToken', () => {
  it('accepts the Bearer scheme case-insensitively', () => {
    assert.equal(extractBearerToken(`Bearer ${TEST_TOKEN}`), TEST_TOKEN);
    assert.equal(extractBearerToken(`bearer ${TEST_TOKEN}`), TEST_TOKEN);
  });

  it('rejects missing, empty and non-bearer values', () => {
    assert.equal(extractBearerToken(undefined), null);
    assert.equal(extractBearerToken(''), null);
    assert.equal(extractBearerToken('Bearer'), null);
    assert.equal(extractBearerToken('Bearer   '), null);
    assert.equal(extractBearerToken(`Basic ${TEST_TOKEN}`), null);
    assert.equal(extractBearerToken(TEST_TOKEN), null);
  });
});

describe('auth hook', () => {
  const rejected: Array<[string, Record<string, string>]> = [
    ['no header', {}],
    ['wrong scheme', { authorization: `Basic ${TEST_TOKEN}` }],
    ['wrong token', { authorization: 'Bearer nope' }],
    ['token prefix', { authorization: `Bearer ${TEST_TOKEN.slice(0, -1)}` }],
    ['empty token', { authorization: 'Bearer ' }],
  ];

  for (const [name, headers] of rejected) {
    it(`returns 401 without touching the database: ${name}`, async () => {
      const { app, pool } = buildTestApp();
      const res = await app.inject({ method: 'GET', url: '/health', headers });
      assert.equal(res.statusCode, 401);
      assert.deepEqual(res.json(), { error: 'unauthorized', message: 'Missing or invalid bearer token' });
      assert.equal(pool.queries, 0);
    });
  }

  it('checks auth before parsing the body', async () => {
    const { app } = buildTestApp();
    app.post('/probe', async () => ({ ok: true }));
    const res = await app.inject({
      method: 'POST',
      url: '/probe',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    assert.equal(res.statusCode, 401);
  });

  it('protects unknown routes', async () => {
    const { app } = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/nope' });
    assert.equal(res.statusCode, 401);
  });

  it('lets a valid token through', async () => {
    const { app, pool } = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/health', headers: authHeader });
    assert.equal(res.statusCode, 200);
    assert.equal(pool.queries, 1);
  });

  it('never echoes the token back', async () => {
    const { app } = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/health', headers: { authorization: 'Bearer wrong' } });
    assert.ok(!res.body.includes(TEST_TOKEN));
    assert.ok(!res.body.includes('wrong'));
  });
});
