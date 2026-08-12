// lib/__tests__/telemetry-key-guard.test.ts — kickoff test 57.
//
// Two halves, both required by the kickoff line: `telemetryKeyMissingInProduction` across its five
// cases, and the source pin that `next.config.mjs`'s inlined condition matches it.
//
// ⚠️ THIS PIN IS THE THING TWO FILES ALREADY CLAIM EXISTS. `next.config.mjs:8` and
// `lib/telemetry-key-guard.ts:9` each tell the next reader that a source pin holds the two copies
// of the D8 predicate together. Until this file was written neither sentence was true: the guard
// module was imported by nothing, and a deploy-blocking condition was written twice with nothing
// keeping the copies honest. A condition that is duplicated and unpinned is how a deploy check
// stops checking — it keeps passing while one copy quietly stops meaning what the other means.
//
// House style is a source-text pin (see retrieval-llm-determinism.test.ts): `next.config.mjs`
// cannot import a `.ts`, so the copies can only be compared as text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { telemetryKeyMissingInProduction, TELEMETRY_HMAC_KEY_ENV } from '../telemetry-key-guard';

const guardSrc = readFileSync('lib/telemetry-key-guard.ts', 'utf8');
const nextConfigSrc = readFileSync('next.config.mjs', 'utf8');

// ── the five cases ──────────────────────────────────────────────────────────────────────────────
//
// The kickoff says "its five cases" and does NOT enumerate them; neither does D8. These five are
// chosen so that each of the three clauses is exercised in BOTH directions, which is the only
// reading under which "five" is a property of the predicate rather than of a list someone wrote:
// one case per clause failing (3), plus the two distinct ways the key clause can hold — no key at
// all, and a key that is only whitespace. That the report names them is deliberate; a different
// five would be defensible, an unnamed five would not.

test('57 case 1 — production Vercel build with no key at all: MISSING', () => {
  assert.equal(telemetryKeyMissingInProduction({ VERCEL: '1', VERCEL_ENV: 'production' }), true);
  // An explicitly-undefined value is the same fact as an absent one; the `?? ''` says so.
  assert.equal(
    telemetryKeyMissingInProduction({ VERCEL: '1', VERCEL_ENV: 'production', [TELEMETRY_HMAC_KEY_ENV]: undefined }),
    true,
  );
});

test('57 case 2 — production Vercel build with an unusable key (empty or whitespace): MISSING', () => {
  // ⚠️ THE CLAUSE THAT `telemetryHmac` DID NOT HAVE. Both sides trim now (test 71 asserts they
  // agree). A key of three spaces was ABSENT to this guard and USABLE to the HMAC before that.
  assert.equal(
    telemetryKeyMissingInProduction({ VERCEL: '1', VERCEL_ENV: 'production', [TELEMETRY_HMAC_KEY_ENV]: '   ' }),
    true,
  );
  assert.equal(
    telemetryKeyMissingInProduction({ VERCEL: '1', VERCEL_ENV: 'production', [TELEMETRY_HMAC_KEY_ENV]: '' }),
    true,
  );
  assert.equal(
    telemetryKeyMissingInProduction({ VERCEL: '1', VERCEL_ENV: 'production', [TELEMETRY_HMAC_KEY_ENV]: '\t\n ' }),
    true,
  );
});

test('57 case 3 — production Vercel build with a usable key: NOT missing', () => {
  assert.equal(
    telemetryKeyMissingInProduction({ VERCEL: '1', VERCEL_ENV: 'production', [TELEMETRY_HMAC_KEY_ENV]: 'k' }),
    false,
  );
  // Surrounding whitespace does not make a real key unusable — trim decides emptiness, not shape.
  assert.equal(
    telemetryKeyMissingInProduction({ VERCEL: '1', VERCEL_ENV: 'production', [TELEMETRY_HMAC_KEY_ENV]: '  k  ' }),
    false,
  );
});

test('57 case 4 — a Vercel build that is not production: NOT missing, at any key value', () => {
  for (const env of ['preview', 'development', undefined]) {
    assert.equal(
      telemetryKeyMissingInProduction({ VERCEL: '1', VERCEL_ENV: env }), false,
      `VERCEL_ENV=${String(env)} is not a production build`,
    );
  }
});

test('57 case 5 — not a Vercel build, even when the environment says production: NOT missing', () => {
  // The local case. A developer whose `.env.local` carries VERCEL_ENV=production is not deploying.
  assert.equal(telemetryKeyMissingInProduction({ VERCEL_ENV: 'production' }), false);
  assert.equal(telemetryKeyMissingInProduction({ VERCEL: '0', VERCEL_ENV: 'production' }), false);
  assert.equal(telemetryKeyMissingInProduction({}), false);
});

// ── the source pin ──────────────────────────────────────────────────────────────────────────────

/** The substring between a `(` at `open` and its matching `)`. Depth-counted, not first-`)`. */
function balanced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced parentheses from index ' + open);
}

/** `next.config.mjs`'s inlined condition: the `if (…)` at the start of a line. */
function inlinedCondition(): string {
  const m = /^if \(/m.exec(nextConfigSrc);
  assert.ok(m, 'next.config.mjs still opens the guard with a top-level `if (`');
  return balanced(nextConfigSrc, m.index + 'if '.length);
}

/** The typed twin: whatever `telemetryKeyMissingInProduction` returns. */
function typedCondition(): string {
  const fn = guardSrc.indexOf('export function telemetryKeyMissingInProduction');
  assert.ok(fn > 0, 'the typed twin is still exported under that name');
  const ret = guardSrc.indexOf('return ', fn);
  const end = guardSrc.indexOf(';', ret);
  assert.ok(ret > fn && end > ret, 'its body is still a single returned expression');
  return guardSrc.slice(ret + 'return '.length, end);
}

/**
 * One spelling for two files. `process.env.X` and `env.X` are the same clause written in the only
 * two ways available to a `.mjs` build script and a typed function; nothing else is normalized, so
 * a changed operator, a changed literal or a dropped `.trim()` still fails.
 */
function normalize(raw: string): string {
  return raw
    .replace(/\s+/g, '')
    .replace(/process\.env\./g, 'ENV.')
    .replace(/(?<![A-Za-z0-9_$.])env\./g, 'ENV.');
}

test('57 pin — next.config.mjs and telemetry-key-guard.ts express the SAME condition', () => {
  const inlined = normalize(inlinedCondition());
  const typed = normalize(typedCondition());

  // Neither may pass vacuously: an extractor that silently returned '' would satisfy equality.
  assert.ok(inlined.length > 40, `inlined condition looks truncated: ${JSON.stringify(inlined)}`);
  assert.ok(typed.length > 40, `typed condition looks truncated: ${JSON.stringify(typed)}`);

  assert.equal(
    inlined, typed,
    'the D8 predicate is written twice and the copies have drifted — change both or neither',
  );
});

test('57 pin — both copies are the SAME THREE CLAUSES, and there is no fourth', () => {
  for (const [where, cond] of [['next.config.mjs', inlinedCondition()], ['telemetry-key-guard.ts', typedCondition()]] as const) {
    const c = normalize(cond);
    assert.ok(c.includes("ENV.VERCEL==='1'"), `${where}: clause 1, a Vercel build`);
    assert.ok(c.includes("ENV.VERCEL_ENV==='production'"), `${where}: clause 2, the production environment`);
    // The env var is named from the constant so the pin and the inline copy cannot drift on
    // spelling — a typo'd variable name would otherwise read as "no key" forever, in production.
    assert.ok(
      c.includes(`!String(ENV.${TELEMETRY_HMAC_KEY_ENV}??'').trim()`),
      `${where}: clause 3, a TRIMMED ${TELEMETRY_HMAC_KEY_ENV}`,
    );
    // D8 specifies three clauses. A fourth (a VERCEL_URL discriminator, say) is V's to add, and
    // adding it silently on one side is exactly the drift this file exists to catch.
    assert.equal((c.match(/&&/g) || []).length, 2, `${where}: three clauses, no fourth`);
  }
});

test('57 pin — the inlined copy still THROWS, and says which variable is missing', () => {
  const after = nextConfigSrc.slice(nextConfigSrc.indexOf(inlinedCondition()) + inlinedCondition().length);
  assert.ok(/^\)\s*\{\s*throw new Error\(/.test(after), 'the condition guards a throw, not a warning');
  assert.ok(after.includes(TELEMETRY_HMAC_KEY_ENV), 'the error names the env var a reader has to set');
  // A build-time throw, not a runtime degradation: nothing here may be caught and logged.
  assert.ok(!/catch\s*[({]/.test(nextConfigSrc), 'next.config.mjs does not swallow its own guard');
});
