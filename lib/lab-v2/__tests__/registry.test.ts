// LAB-MCP-V2 §15.1–15.3 — the registry's metadata, the four keys, and scope visibility.
// Pure: no database, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCOPES, EFFECTS, PRINCIPALS, SCOPES_BY_PRINCIPAL, KEY_ENV_BY_PRINCIPAL, COST_CLASSES, CLASSIFICATIONS } from '../contracts';
import { REGISTRY, annotationsFor, visibleTools } from '../registry';
import { principalFor, labV2KeysConfigured, scopesFor } from '../../mcp-v2/auth';

// ── §15.1 registry ───────────────────────────────────────────────────────────────────
test('§15.1: round 1 registers exactly the fifteen named tools', () => {
  assert.equal(REGISTRY.length, 15);
  assert.deepEqual(REGISTRY.map((t) => t.name).sort(), [
    'dataset_create', 'dataset_preview', 'dataset_validate', 'engine_describe',
    'experiment_create', 'experiment_run', 'model_capabilities', 'run_cancel',
    'run_result', 'run_retry', 'run_status', 'system_capabilities', 'system_health',
    'worker_control', 'worker_status',
  ]);
});

test('§15.1: every tool carries every field §8 declares', () => {
  // §8 names nine: name, description, inputSchema, outputSchema, scopes, effect,
  // classification, cost_class, slice. (§15.1 says "eight"; the list in §8 is the
  // authority and is what is asserted here. The discrepancy is flagged in the report.)
  for (const t of REGISTRY) {
    for (const field of ['name', 'description', 'inputSchema', 'outputSchema', 'scopes', 'effect', 'classification', 'cost_class', 'slice'] as const) {
      assert.ok(t[field] !== undefined && t[field] !== null, `${t.name} is missing ${field}`);
    }
    assert.ok(t.description.length > 20, `${t.name} needs a real description`);
  }
});

test('§15.1: every scope in the registry is one of the six', () => {
  for (const t of REGISTRY) {
    for (const s of t.scopes) assert.ok((SCOPES as readonly string[]).includes(s), `${t.name}: unknown scope ${s}`);
    assert.ok((EFFECTS as readonly string[]).includes(t.effect), `${t.name}: unknown effect ${t.effect}`);
    assert.ok((COST_CLASSES as readonly string[]).includes(t.cost_class));
    assert.ok((CLASSIFICATIONS as readonly string[]).includes(t.classification));
  }
});

test("§15.1: every tool's effect matches its annotations", () => {
  for (const t of REGISTRY) {
    const a = annotationsFor(t.effect);
    assert.equal(a.readOnlyHint, t.effect === 'read', `${t.name}: readOnlyHint disagrees with effect`);
    // Annotations describe; they never authorise. A read tool must never be marked destructive.
    if (t.effect === 'read') assert.equal(a.destructiveHint, false);
  }
});

test('§3.3: Slice A stores and returns only de-identified objects', () => {
  for (const t of REGISTRY) assert.equal(t.classification, 'deidentified', `${t.name} must not be identifying in Slice A`);
});

test('§8.1: only the two metered tools are metered', () => {
  assert.deepEqual(REGISTRY.filter((t) => t.cost_class === 'metered').map((t) => t.name).sort(), ['experiment_run', 'run_retry']);
});

// ── §15.2 auth ───────────────────────────────────────────────────────────────────────
const KEYS: Record<string, string> = {
  LAB_API_KEY_RESEARCH: 'research-secret-0000000000000000',
  LAB_API_KEY_OPERATOR: 'operator-secret-0000000000000000',
  LAB_API_KEY_REVIEWER: 'reviewer-secret-0000000000000000',
  LAB_API_KEY_RELEASE: 'release-secret-00000000000000000',
};
function withKeys<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(KEYS)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return fn(); } finally { for (const k of Object.keys(KEYS)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('§15.2: each of the four keys maps to its principal and its scopes', () => {
  withKeys(() => {
    assert.equal(principalFor(KEYS.LAB_API_KEY_RESEARCH), 'research');
    assert.equal(principalFor(KEYS.LAB_API_KEY_OPERATOR), 'operator');
    assert.equal(principalFor(KEYS.LAB_API_KEY_REVIEWER), 'reviewer');
    assert.equal(principalFor(KEYS.LAB_API_KEY_RELEASE), 'release');
    assert.deepEqual([...scopesFor('research')], ['research_read', 'research_write', 'production_read']);
    assert.deepEqual([...scopesFor('operator')], ['production_read', 'production_write', 'research_read']);
    assert.deepEqual([...scopesFor('reviewer')], ['review', 'research_read', 'production_read']);
    assert.deepEqual([...scopesFor('release')], ['release', 'production_read']);
  });
});

test('§15.2: a wrong key resolves to no principal (→ 401)', () => {
  withKeys(() => {
    assert.equal(principalFor('not-a-key'), null);
    assert.equal(principalFor(''), null);
    assert.equal(principalFor(null), null);
    // A v1 key is not a v2 key (§3.1) — the surfaces share no secret.
    process.env.LAB_API_KEY = 'v1-shared-secret';
    assert.equal(principalFor('v1-shared-secret'), null);
    delete process.env.LAB_API_KEY;
  });
});

test('§15.2: with none of the four set the endpoint is unconfigured (→ 503)', () => {
  const saved = PRINCIPALS.map((p) => [KEY_ENV_BY_PRINCIPAL[p], process.env[KEY_ENV_BY_PRINCIPAL[p]]] as const);
  for (const p of PRINCIPALS) delete process.env[KEY_ENV_BY_PRINCIPAL[p]];
  try {
    assert.equal(labV2KeysConfigured(), false);
    assert.equal(principalFor('anything'), null);
  } finally { for (const [k, v] of saved) { if (v !== undefined) process.env[k] = v; } }
});

test('§15.2: an empty env var cannot be authenticated with the empty string', () => {
  const saved = process.env.LAB_API_KEY_RESEARCH;
  process.env.LAB_API_KEY_RESEARCH = '';
  try { assert.equal(principalFor(''), null); }
  finally { if (saved === undefined) delete process.env.LAB_API_KEY_RESEARCH; else process.env.LAB_API_KEY_RESEARCH = saved; }
});

// ── §15.3 visibility ─────────────────────────────────────────────────────────────────
test('§15.3: tools/list under the research key does NOT include worker_control', () => {
  const names = visibleTools(SCOPES_BY_PRINCIPAL.research).map((t) => t.name);
  assert.ok(!names.includes('worker_control'), 'research must not see worker_control');
  assert.ok(names.includes('dataset_create'));
});

test('§3.1 + §8.1: the operator key sees worker_control; the release key sees neither research write nor it', () => {
  assert.ok(visibleTools(SCOPES_BY_PRINCIPAL.operator).map((t) => t.name).includes('worker_control'));
  const release = visibleTools(SCOPES_BY_PRINCIPAL.release).map((t) => t.name);
  assert.ok(!release.includes('worker_control'));
  assert.ok(!release.includes('dataset_create'));
  assert.ok(release.includes('system_health'), 'release holds production_read');
});
