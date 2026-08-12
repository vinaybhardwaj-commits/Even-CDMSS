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
// ⚠️ AND THE FIRST VERSION OF THIS PIN COULD BE DEFEATED BY ONE SPACE. It compared the two copies
// as TEXT with all whitespace stripped, including whitespace inside string literals — so changing
// `'1'` to `'1 '` in next.config.mjs made the guard unable to fire ever again while all eight tests
// stayed green. It counted `&&` to forbid a fourth clause, which a fourth clause joined by `||` did
// not touch. Both holes had the same cause: a condition was being compared as characters instead of
// as a condition.
//
// WHAT REPLACES IT, IN TWO HALVES THAT PROVE DIFFERENT THINGS.
//
// (a) THE ORACLE, below. Both copies of the predicate are PARSED and compared as syntax trees.
//     String literals are compared by their exact value, so a space inside one is a difference.
//     What it does NOT count is not a short list and is not worth pretending is one: formatting,
//     line breaks, the `process.env.` / `env.` spelling, parentheses, optional chaining, and — most
//     of all — whether `env` is the process environment at all. Its subject is DRIFT BETWEEN THE
//     TWO COPIES, and that is all. ⚠️ IT INSPECTS ONE `IfStatement` AND NOTHING ELSE IN THE FILE:
//     it cannot see a line prepended above the guard, a shadowed `process`, a redefined `String`,
//     or an `uncaughtException` handler, and every one of those kills the guard while leaving the
//     pinned expression byte-identical.
//
// (b) THE EXECUTION, immediately below this comment. `next.config.mjs` is SPAWNED in a fresh child
//     process, three times, with the three guard inputs fixed explicitly. Its subject is WHETHER
//     THE GUARD STILL FIRES. Nothing about a source pin can answer that, and for one pass this file
//     passed 8 of 8 while the production deploy precondition was dead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import ts from 'typescript';
import { telemetryKeyMissingInProduction, TELEMETRY_HMAC_KEY_ENV } from '../telemetry-key-guard';

const GUARD_FILE = 'lib/telemetry-key-guard.ts';
const CONFIG_FILE = 'next.config.mjs';
const guardSrc = readFileSync(GUARD_FILE, 'utf8');
const nextConfigSrc = readFileSync(CONFIG_FILE, 'utf8');

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

// The key values this case sweeps. `undefined` is absence; the rest are every shape case 2 and case
// 3 distinguish. The title says "at any key value", so the test tries every one of them rather than
// only the absent case, which is all it used to try.
const EVERY_KEY_SHAPE = [undefined, '', '   ', '\t\n ', 'k', '  k  '];

test('57 case 4 — a Vercel build that is not production: NOT missing, at any key value', () => {
  for (const env of ['preview', 'development', undefined]) {
    for (const key of EVERY_KEY_SHAPE) {
      assert.equal(
        telemetryKeyMissingInProduction({ VERCEL: '1', VERCEL_ENV: env, [TELEMETRY_HMAC_KEY_ENV]: key }), false,
        `VERCEL_ENV=${String(env)} is not a production build (key ${JSON.stringify(key)})`,
      );
    }
  }
});

test('57 case 5 — not a Vercel build, even when the environment says production: NOT missing', () => {
  // The local case. A developer whose `.env.local` carries VERCEL_ENV=production is not deploying.
  for (const key of EVERY_KEY_SHAPE) {
    assert.equal(telemetryKeyMissingInProduction({ VERCEL_ENV: 'production', [TELEMETRY_HMAC_KEY_ENV]: key }), false);
    assert.equal(
      telemetryKeyMissingInProduction({ VERCEL: '0', VERCEL_ENV: 'production', [TELEMETRY_HMAC_KEY_ENV]: key }), false,
    );
  }
  assert.equal(telemetryKeyMissingInProduction({}), false);
});

// ── the guard, EXECUTED ─────────────────────────────────────────────────────────────────────────
//
// ⚠️ A FRESH CHILD PROCESS PER CASE, AND THAT IS NOT FASTIDIOUSNESS. Importing the config twice in
// one process runs it once: ESM caches the module record, and the second import returns the cached
// one without executing anything. A second in-process "case" would therefore assert nothing at all
// while looking like a passing test.
//
// Only the three inputs D8's condition reads are fixed. Every other build input stays ambient, so
// this is the config as it would run, not a sanitised imitation of it.

const CONFIG_PATH = resolve(CONFIG_FILE);

function runConfig(vercel: string, vercelEnv: string, key: string | null): { status: number; output: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, VERCEL: vercel, VERCEL_ENV: vercelEnv };
  if (key === null) delete env[TELEMETRY_HMAC_KEY_ENV];
  else env[TELEMETRY_HMAC_KEY_ENV] = key;

  const r = spawnSync(process.execPath, [CONFIG_PATH], { env, encoding: 'utf8' });
  // Asserted BEFORE the exit code is read. A spawn that never started, or one killed by a signal,
  // has no exit code worth testing — and `status` is null in both cases, which `!== 0` would
  // happily accept as "the guard fired".
  assert.equal(r.error, undefined, `spawn failed: ${String(r.error)}`);
  assert.equal(r.signal, null, `killed by ${String(r.signal)}`);
  assert.equal(typeof r.status, 'number', 'no numeric exit status');
  return { status: r.status as number, output: `${r.stdout}${r.stderr}` };
}

test('57 EXECUTED — a production build with no key FAILS, and says which variable is missing', () => {
  const { status, output } = runConfig('1', 'production', null);
  assert.notEqual(status, 0, 'the production deploy precondition did not fire');
  assert.ok(output.includes(TELEMETRY_HMAC_KEY_ENV), `the failure does not name the variable:\n${output}`);
});

test('57 EXECUTED — a production build WITH a key succeeds', () => {
  // A control. Without it, a config that failed unconditionally would pass the case above.
  assert.equal(runConfig('1', 'production', 'local-test-key-not-a-secret').status, 0);
});

test('57 EXECUTED — a non-production build with no key succeeds', () => {
  // The second control, and the one that matters to every developer: the guard must not fire here.
  assert.equal(runConfig('0', 'development', null).status, 0);
});

// ── the parser, and the one normalization ───────────────────────────────────────────────────────

function parse(file: string, src: string, kind: ts.ScriptKind): ts.SourceFile {
  return ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, /* setParentNodes */ true, kind);
}
const configAst = parse(CONFIG_FILE, nextConfigSrc, ts.ScriptKind.JS);
const guardAst = parse(GUARD_FILE, guardSrc, ts.ScriptKind.TS);

/**
 * A structural rendering of an expression. Two conditions render identically when they ARE the same
 * condition, and differently otherwise.
 *
 * ⚠️ EXACTLY ONE THING IS NORMALIZED AWAY, AND IT IS NOT WHITESPACE. `process.env.X` in a build
 * script and `env.X` in a function that takes the environment as a parameter are the same clause
 * written in the only two ways each file has available; both render as `ENV.X`. Everything else is
 * preserved, and string literals are rendered from their VALUE — `'1'` and `'1 '` are two different
 * literals here, which is the whole reason this is a parser and not a `replace(/\s+/g, '')`.
 */
function ser(node: ts.Node, sf: ts.SourceFile): string {
  if (ts.isParenthesizedExpression(node)) return ser(node.expression, sf);
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return `str(${JSON.stringify(node.text)})`;
  if (ts.isNumericLiteral(node)) return `num(${node.text})`;
  if (ts.isPropertyAccessExpression(node)) {
    const obj = ser(node.expression, sf);
    return obj === 'process.env' || obj === 'env' ? `ENV.${node.name.text}` : `${obj}.${node.name.text}`;
  }
  if (ts.isCallExpression(node)) {
    return `${ser(node.expression, sf)}(${node.arguments.map((a) => ser(a, sf)).join(', ')})`;
  }
  if (ts.isBinaryExpression(node)) {
    return `(${ser(node.left, sf)} ${ts.tokenToString(node.operatorToken.kind)} ${ser(node.right, sf)})`;
  }
  if (ts.isPrefixUnaryExpression(node)) {
    return `(${ts.tokenToString(node.operator)}${ser(node.operand, sf)})`;
  }
  // Anything this renderer does not model renders as its kind AND its text, so an unmodelled node
  // can never accidentally compare equal to a different unmodelled node.
  return `<${ts.SyntaxKind[node.kind]}:${JSON.stringify(node.getText(sf))}>`;
}

/** The `&&` operands at the top level, flattened. A root that is not `&&` yields one clause — which
 *  is how `A && B && C || false` is caught: its root is `||`, so it has ONE clause, not three. */
function ampChain(node: ts.Expression): ts.Expression[] {
  const e = ts.isParenthesizedExpression(node) ? node.expression : node;
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return [...ampChain(e.left), ...ampChain(e.right)];
  }
  return [e];
}

function containsToken(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === kind) return true;
  let found = false;
  ts.forEachChild(node, (c) => { if (!found && containsToken(c, kind)) found = true; });
  return found;
}

// ── the two copies, located in their trees ──────────────────────────────────────────────────────

/** The top-level `if` in `next.config.mjs` — the guard itself, not a nested one. */
function inlinedGuard(): ts.IfStatement {
  const found = configAst.statements.find(ts.isIfStatement);
  assert.ok(found, `${CONFIG_FILE} still opens with a top-level \`if\` guard`);
  return found;
}

/** The typed twin: whatever `telemetryKeyMissingInProduction` returns. */
function typedCondition(): ts.Expression {
  const fn = guardAst.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'telemetryKeyMissingInProduction',
  );
  assert.ok(fn, 'the typed twin is still exported under that name');
  const ret = fn.body?.statements[0];
  assert.ok(ret && ts.isReturnStatement(ret) && ret.expression, 'its body is still a single returned expression');
  return ret.expression;
}

const COPIES: ReadonlyArray<readonly [string, ts.Expression, ts.SourceFile]> = [
  [CONFIG_FILE, inlinedGuard().expression, configAst],
  [GUARD_FILE, typedCondition(), guardAst],
];

// ── the oracle: each copy validated independently ───────────────────────────────────────────────

test('57 pin — each copy is exactly D8\'s three clauses, and there is no fourth of any kind', () => {
  for (const [where, cond, sf] of COPIES) {
    const clauses = ampChain(cond);
    assert.equal(clauses.length, 3, `${where}: D8 specifies three \`&&\` clauses, found ${clauses.length}`);
    // A fourth clause joined by `||` does not change the `&&` count, so the `&&` count is not what
    // is asserted. This is: no disjunction anywhere inside the condition.
    assert.equal(
      containsToken(cond, ts.SyntaxKind.BarBarToken), false,
      `${where}: the condition contains a \`||\` — a fourth clause is V's to add, on both sides at once`,
    );

    // Clause 1 and clause 2: the two comparison roots. `===`, the env read on the left, and a
    // string literal on the right whose VALUE is asserted, so a trailing space is a failure.
    for (const [i, name, value] of [[0, 'VERCEL', '1'], [1, 'VERCEL_ENV', 'production']] as const) {
      const c = clauses[i];
      assert.ok(ts.isBinaryExpression(c), `${where}: clause ${i + 1} is a comparison`);
      assert.equal(
        c.operatorToken.kind, ts.SyntaxKind.EqualsEqualsEqualsToken,
        `${where}: clause ${i + 1} compares with \`===\``,
      );
      assert.equal(ser(c.left, sf), `ENV.${name}`, `${where}: clause ${i + 1} reads ${name}`);
      assert.ok(ts.isStringLiteral(c.right), `${where}: clause ${i + 1} compares against a string literal`);
      assert.equal(
        c.right.text, value,
        `${where}: clause ${i + 1}'s literal is ${JSON.stringify(value)} and nothing else — `
        + `${JSON.stringify(c.right.text)} would never equal the value the platform sets`,
      );
    }

    // Clause 3: `!String(env.<KEY> ?? '').trim()`, asserted joint by joint. The env var name comes
    // from the constant, so the pin and the two copies cannot drift on spelling — a typo'd variable
    // reads as "no key" forever, in production, and nothing else would notice.
    const trimmed = clauses[2];
    assert.ok(
      ts.isPrefixUnaryExpression(trimmed) && trimmed.operator === ts.SyntaxKind.ExclamationToken,
      `${where}: clause 3 is a negation`,
    );
    const trimCall = (trimmed as ts.PrefixUnaryExpression).operand;
    assert.ok(ts.isCallExpression(trimCall), `${where}: clause 3 negates a call`);
    assert.ok(
      ts.isPropertyAccessExpression(trimCall.expression) && trimCall.expression.name.text === 'trim',
      `${where}: clause 3 calls .trim() — without it a key of three spaces is a key`,
    );
    // ⚠️ `.trim()` TAKES NO ARGUMENTS, AND UNTIL THIS ASSERTION EXISTED THAT WAS THE ONE POSITION A
    // FOURTH CLAUSE COULD HIDE IN. `.trim(x && y)` is legal JavaScript, renders identically on both
    // copies, and left every other assertion here satisfied.
    assert.equal(trimCall.arguments.length, 0, `${where}: .trim() takes no arguments`);
    const stringCall = trimCall.expression.expression;
    assert.ok(
      ts.isCallExpression(stringCall) && ser(stringCall.expression, sf) === 'String',
      `${where}: clause 3 coerces with String(...)`,
    );
    assert.equal(stringCall.arguments.length, 1, `${where}: String(...) takes one argument`);
    const coalesce = stringCall.arguments[0];
    assert.ok(
      ts.isBinaryExpression(coalesce) && coalesce.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken,
      `${where}: clause 3 defaults an absent key with \`??\``,
    );
    assert.equal(
      ser(coalesce.left, sf), `ENV.${TELEMETRY_HMAC_KEY_ENV}`,
      `${where}: clause 3 reads ${TELEMETRY_HMAC_KEY_ENV}`,
    );
    assert.ok(ts.isStringLiteral(coalesce.right), `${where}: clause 3's default is a string literal`);
    assert.equal(coalesce.right.text, '', `${where}: clause 3's default is the EMPTY string`);
  }
});

test('57 pin — next.config.mjs and telemetry-key-guard.ts express the SAME condition', () => {
  const [[whereA, condA, sfA], [whereB, condB, sfB]] = COPIES;
  const a = ser(condA, sfA);
  const b = ser(condB, sfB);

  // Neither may pass vacuously: a locator that silently produced an empty rendering would satisfy
  // equality. The real rendering is over 100 characters.
  assert.ok(a.length > 80, `${whereA} rendered suspiciously short: ${JSON.stringify(a)}`);
  assert.ok(b.length > 80, `${whereB} rendered suspiciously short: ${JSON.stringify(b)}`);

  assert.equal(
    a, b,
    'the D8 predicate is written twice and the copies have drifted — change both or neither',
  );
});

test('57 pin — the inlined copy still THROWS, and says which variable is missing', () => {
  const guard = inlinedGuard();
  assert.equal(guard.elseStatement, undefined, 'the guard has no else arm to fall into');
  const body = guard.thenStatement;
  assert.ok(ts.isBlock(body), `${CONFIG_FILE}: the guard's consequent is a block`);
  const first = body.statements[0];
  assert.ok(
    first && ts.isThrowStatement(first),
    'the condition guards a THROW, not a warning — a production build must fail, not degrade',
  );
  assert.ok(
    first.expression && ts.isNewExpression(first.expression) && ser(first.expression.expression, configAst) === 'Error',
    'it throws an Error',
  );
  assert.ok(
    first.getText(configAst).includes(TELEMETRY_HMAC_KEY_ENV),
    'the error names the env var a reader has to set',
  );
  // ⚠️ THIS ASSERTION CHECKS FOR A `try` STATEMENT AND NOTHING ELSE. It used to be introduced as
  // "nothing here may be caught and logged", which claimed far more than it checks: a
  // `process.on('uncaughtException', …)` handler swallows the throw with no `try` anywhere in the
  // file. What actually proves the build fails is the EXECUTED case above, which reads the child's
  // exit status. This is the narrow, structural half.
  let hasTry = false;
  const walk = (n: ts.Node): void => { if (ts.isTryStatement(n)) hasTry = true; ts.forEachChild(n, walk); };
  walk(configAst);
  assert.equal(hasTry, false, `${CONFIG_FILE} has no try statement around its guard`);
});
