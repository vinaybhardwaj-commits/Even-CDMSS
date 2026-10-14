import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hasCronBearer } from '../cron-auth';

const mkReq = (h: Record<string, string>) => new Request('https://x.test/api/cron/harvest', { headers: h });

test('a request with only x-vercel-cron is refused', () => {
  process.env.CRON_SECRET = 's3cret';
  assert.equal(hasCronBearer(mkReq({ 'x-vercel-cron': '1' })), false);
});

test('Bearer CRON_SECRET is accepted', () => {
  process.env.CRON_SECRET = 's3cret';
  assert.equal(hasCronBearer(mkReq({ authorization: 'Bearer s3cret' })), true);
});

test('wrong bearer, bare secret and empty bearer are refused', () => {
  process.env.CRON_SECRET = 's3cret';
  assert.equal(hasCronBearer(mkReq({ authorization: 'Bearer nope' })), false);
  assert.equal(hasCronBearer(mkReq({ authorization: 's3cret' })), false);
  assert.equal(hasCronBearer(mkReq({ authorization: 'Bearer ' })), false);
});

test('with CRON_SECRET unset, nothing is accepted (even "Bearer undefined" or "Bearer ")', () => {
  delete process.env.CRON_SECRET;
  assert.equal(hasCronBearer(mkReq({ authorization: 'Bearer undefined' })), false);
  assert.equal(hasCronBearer(mkReq({ authorization: 'Bearer ' })), false);
  assert.equal(hasCronBearer(mkReq({ 'x-vercel-cron': '1' })), false);
});

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === '__tests__' || n === 'node_modules') continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(p)) out.push(p);
  }
  return out;
}

test('guard: no code under app/ or lib/ reads x-vercel-cron (it is spoofable)', () => {
  const bad: string[] = [];
  for (const f of [...walk('app'), ...walk('lib')]) {
    const src = readFileSync(f, 'utf8');
    // strip comments so documentation may still mention the header
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    if (/x-vercel-cron/i.test(code)) bad.push(f);
  }
  assert.deepEqual(bad, [], 'x-vercel-cron must not be read in code; use hasCronBearer from lib/cron-auth');
});

test('guard: every route that defines isCron derives it from hasCronBearer', () => {
  const bad: string[] = [];
  for (const f of walk('app')) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/const isCron\s*=\s*([^;]+);/g)) if (!/^hasCronBearer\(req\)$/.test(m[1].trim())) bad.push(f);
  }
  assert.deepEqual(bad, []);
});

test('admin path unchanged: routes still fall through to isAdminUnlocked after the cron arm', () => {
  for (const f of [
    'app/api/learning/mine/route.ts',
    'app/api/admin/sync-doctor-directory/route.ts',
    'app/api/readmission/worker/route.ts',
    'app/api/preop/worker/route.ts',
  ]) {
    const src = readFileSync(f, 'utf8');
    assert.ok(src.includes('isAdminUnlocked'), f);
    assert.ok(src.includes('hasCronBearer'), f);
  }
});

test('guard: no plain === / !== compare of a request value to CRON_SECRET or ADMIN_TOKEN in app/ or lib/ (use safeEqual)', () => {
  const bad: string[] = [];
  const re = /(?:[!=]==\s*(?:process\.env\.(?:CRON_SECRET|ADMIN_TOKEN)\b|`Bearer \$\{(?:process\.env\.CRON_SECRET|secret)\}`))|(?:(?:process\.env\.(?:CRON_SECRET|ADMIN_TOKEN)|`Bearer \$\{(?:process\.env\.CRON_SECRET|secret)\}`)\s*[!=]==)/;
  for (const f of [...walk('app'), ...walk('lib')]) {
    const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    if (re.test(code)) bad.push(f);
  }
  assert.deepEqual(bad, [], 'compare secrets with safeEqual from lib/safe-equal');
});

test('guard: the secret guard regex catches the old forms', () => {
  const re = /(?:[!=]==\s*(?:process\.env\.(?:CRON_SECRET|ADMIN_TOKEN)\b|`Bearer \$\{(?:process\.env\.CRON_SECRET|secret)\}`))|(?:(?:process\.env\.(?:CRON_SECRET|ADMIN_TOKEN)|`Bearer \$\{(?:process\.env\.CRON_SECRET|secret)\}`)\s*[!=]==)/;
  assert.ok(re.test('secret === process.env.CRON_SECRET'));
  assert.ok(re.test('token === process.env.ADMIN_TOKEN'));
  assert.ok(re.test('auth === `Bearer ${process.env.CRON_SECRET}`'));
  assert.ok(re.test('process.env.ADMIN_TOKEN === token'));
  assert.ok(!re.test('safeEqual(secret, process.env.CRON_SECRET)'));
});
