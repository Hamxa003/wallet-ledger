import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError } from '../src/errors';
import { isValidAmount, isValidUserId, parseJsonStrict, parseMutationBody } from '../src/validation';
import { authHeader, buildTestApp } from './helpers';

describe('isValidUserId', () => {
  it('accepts allowed characters and lengths', () => {
    for (const id of ['u', 'u123', 'A-z_09', 'x'.repeat(64)]) {
      assert.ok(isValidUserId(id), id);
    }
  });

  it('rejects empty, too long, bad characters and non-strings', () => {
    for (const id of ['', 'x'.repeat(65), 'a b', 'a.b', 'a/b', 'é', 'u1\n', 123, null, undefined, ['u1']]) {
      assert.ok(!isValidUserId(id), JSON.stringify(id));
    }
  });
});

describe('isValidAmount', () => {
  it('accepts integers in range', () => {
    for (const n of [1, 10000, 1_000_000_000]) assert.ok(isValidAmount(n), String(n));
  });

  it('rejects out of range, fractional and non-number values', () => {
    for (const n of [0, -1, 1_000_000_001, 1.5, Number.NaN, Infinity, '100', true, null, undefined]) {
      assert.ok(!isValidAmount(n), String(n));
    }
  });
});

describe('parseJsonStrict', () => {
  it('keeps integer literals as numbers', () => {
    assert.deepEqual(parseJsonStrict('{"amount":100}'), { amount: 100 });
  });

  it('flags decimal and exponent literals even when they equal an integer', () => {
    for (const literal of ['1.0', '100.00', '1e3', '1E3', '10.5']) {
      const parsed = parseJsonStrict(`{"amount":${literal}}`) as { amount: unknown };
      assert.equal(typeof parsed.amount, 'object', literal);
      assert.ok(!isValidAmount(parsed.amount), literal);
    }
  });
});

describe('parseMutationBody', () => {
  it('returns the parsed input and ignores unknown fields', () => {
    assert.deepEqual(parseMutationBody({ user_id: 'u1', amount: 5, note: 'x' }), { userId: 'u1', amount: 5 });
  });

  it('rejects non-object bodies and missing fields', () => {
    for (const body of [null, [], 'x', 5, {}, { user_id: 'u1' }, { amount: 5 }]) {
      assert.throws(() => parseMutationBody(body), (e) => e instanceof ApiError && e.statusCode === 400);
    }
  });
});

describe('request body handling', () => {
  function postProbe(payload: string, contentType = 'application/json') {
    const { app } = buildTestApp();
    app.post('/probe', async (req) => parseMutationBody(req.body));
    return app.inject({
      method: 'POST',
      url: '/probe',
      headers: { ...authHeader, 'content-type': contentType },
      payload,
    });
  }

  it('accepts a valid body', async () => {
    const res = await postProbe('{"user_id":"u1","amount":100,"extra":true}');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { userId: 'u1', amount: 100 });
  });

  const invalid = [
    '{"user_id":"u1","amount":1.0}',
    '{"user_id":"u1","amount":1e3}',
    '{"user_id":"u1","amount":"100"}',
    '{"user_id":"u1","amount":0}',
    '{"user_id":"u1","amount":-5}',
    '{"user_id":"u1","amount":1000000001}',
    '{"user_id":"u1","amount":99999999999999999999}',
    '{"user_id":"u1","amount":true}',
    '{"user_id":"u1","amount":null}',
    '{"user_id":"u1"}',
    '{"amount":100}',
    '{"user_id":"","amount":100}',
    '{"user_id":"bad id","amount":100}',
    '[]',
    'null',
    '{not json',
    '',
  ];

  for (const payload of invalid) {
    it(`returns 400 invalid_request for ${payload || '<empty>'}`, async () => {
      const res = await postProbe(payload);
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error, 'invalid_request');
      assert.equal(typeof res.json().message, 'string');
    });
  }

  it('returns 400 for a non-JSON content type', async () => {
    const res = await postProbe('user_id=u1&amount=1', 'application/x-www-form-urlencoded');
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'invalid_request');
  });

  it('returns 404 JSON for unknown routes when authenticated', async () => {
    const { app } = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/nope', headers: authHeader });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'not_found');
  });
});
