import test from 'node:test';
import assert from 'node:assert/strict';
import { hasEngineBearer } from '../engine-auth';

const mkReq = (h: Record<string, string>) => new Request('https://x.test/api/engines/member-state', { headers: h });

test('correct bearer is accepted', () => {
  process.env.NEWCAT_ENGINE_TOKEN = 'tok-abc-123';
  assert.equal(hasEngineBearer(mkReq({ authorization: 'Bearer tok-abc-123' })), true);
});

test('header absent is refused', () => {
  process.env.NEWCAT_ENGINE_TOKEN = 'tok-abc-123';
  assert.equal(hasEngineBearer(mkReq({})), false);
});

test('wrong token of the same length is refused', () => {
  process.env.NEWCAT_ENGINE_TOKEN = 'tok-abc-123';
  assert.equal(hasEngineBearer(mkReq({ authorization: 'Bearer tok-abc-124' })), false);
});

test('prefix-only and longer-than-secret are refused (different length)', () => {
  process.env.NEWCAT_ENGINE_TOKEN = 'tok-abc-123';
  assert.equal(hasEngineBearer(mkReq({ authorization: 'Bearer tok-abc' })), false);
  assert.equal(hasEngineBearer(mkReq({ authorization: 'Bearer tok-abc-123-extra' })), false);
  assert.equal(hasEngineBearer(mkReq({ authorization: 'Bearer ' })), false);
  assert.equal(hasEngineBearer(mkReq({ authorization: 'Bearer' })), false);
});

test('bare token without the Bearer scheme is refused', () => {
  process.env.NEWCAT_ENGINE_TOKEN = 'tok-abc-123';
  assert.equal(hasEngineBearer(mkReq({ authorization: 'tok-abc-123' })), false);
});

test('env unset or empty refuses everything, including "Bearer undefined"', () => {
  delete process.env.NEWCAT_ENGINE_TOKEN;
  assert.equal(hasEngineBearer(mkReq({ authorization: 'Bearer undefined' })), false);
  assert.equal(hasEngineBearer(mkReq({ authorization: 'Bearer ' })), false);
  process.env.NEWCAT_ENGINE_TOKEN = '';
  assert.equal(hasEngineBearer(mkReq({ authorization: 'Bearer ' })), false);
});

test('x-vercel-cron and CRON_SECRET are not credentials', () => {
  process.env.NEWCAT_ENGINE_TOKEN = 'tok-abc-123';
  process.env.CRON_SECRET = 'cron-s';
  assert.equal(hasEngineBearer(mkReq({ 'x-vercel-cron': '1' })), false);
  assert.equal(hasEngineBearer(mkReq({ authorization: 'Bearer cron-s' })), false);
  delete process.env.CRON_SECRET;
});
