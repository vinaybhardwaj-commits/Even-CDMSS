/**
 *   node --test --import tsx lib/__tests__/bedrock-live.test.ts
 * READMIT-OBSERVABILITY — bedrockLive. No network: the probe and clock are injected.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bedrockLive, __resetBedrockLiveCache, __resetBedrockCredentialCache, BEDROCK_LIVE_FAILURE_TTL_MS, BEDROCK_LIVE_ERROR_MAX } from '../bedrock';

beforeEach(() => __resetBedrockLiveCache());

test('success: ok true, no error, and not cached', async () => {
  let calls = 0;
  const probe = async () => { calls++; return {}; };
  const a = await bedrockLive(probe, () => 1_000);
  assert.equal(a.ok, true);
  assert.equal(a.error, null);
  assert.equal(a.checkedAt, new Date(1_000).toISOString());
  await bedrockLive(probe, () => 2_000);
  assert.equal(calls, 2);
});

test('failure is cached for 5 min, then probed again', async () => {
  assert.equal(BEDROCK_LIVE_FAILURE_TTL_MS, 5 * 60 * 1000);
  let calls = 0;
  const probe = async () => { calls++; throw new Error('sts refused'); };
  const a = await bedrockLive(probe, () => 10_000);
  assert.equal(a.ok, false);
  assert.equal(a.error, 'sts refused');
  const b = await bedrockLive(probe, () => 10_000 + BEDROCK_LIVE_FAILURE_TTL_MS - 1);
  assert.equal(calls, 1);
  assert.deepEqual(b, a);
  await bedrockLive(probe, () => 10_000 + BEDROCK_LIVE_FAILURE_TTL_MS);
  assert.equal(calls, 2);
});

test('a success after the cache window clears the failure', async () => {
  await bedrockLive(async () => { throw new Error('boom'); }, () => 0);
  const r = await bedrockLive(async () => ({}), () => BEDROCK_LIVE_FAILURE_TTL_MS + 1);
  assert.equal(r.ok, true);
  const again = await bedrockLive(async () => { throw new Error('boom2'); }, () => BEDROCK_LIVE_FAILURE_TTL_MS + 2);
  assert.equal(again.error, 'boom2');
});

test('error text is truncated to 200 chars', async () => {
  const r = await bedrockLive(async () => { throw new Error('word '.repeat(200)); }, () => 0);
  assert.equal(r.error?.length, BEDROCK_LIVE_ERROR_MAX);
});

test('no secret-shaped text reaches the output', async () => {
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl';
  const akia = 'AKIAABCDEFGHIJKLMNOP';
  const long = 'A'.repeat(60);
  const r = await bedrockLive(async () => { throw new Error(`bad ${jwt} ${akia} ${long}`); }, () => 0);
  assert.ok(r.error);
  assert.ok(!r.error.includes('eyJ'));
  assert.ok(!r.error.includes('AKIA'));
  assert.ok(!r.error.includes(long));
});

test('default probe with no BEDROCK_* env fails without network', async () => {
  const saved = { r: process.env.BEDROCK_REGION, a: process.env.BEDROCK_ROLE_ARN, o: process.env.BEDROCK_OIDC_AUDIENCE };
  delete process.env.BEDROCK_REGION; delete process.env.BEDROCK_ROLE_ARN; delete process.env.BEDROCK_OIDC_AUDIENCE;
  __resetBedrockCredentialCache();
  try {
    const r = await bedrockLive();
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /not configured/);
  } finally {
    if (saved.r) process.env.BEDROCK_REGION = saved.r;
    if (saved.a) process.env.BEDROCK_ROLE_ARN = saved.a;
    if (saved.o) process.env.BEDROCK_OIDC_AUDIENCE = saved.o;
  }
});
