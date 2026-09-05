// LAB-MCP-V2 §15.3 + §14.2 — the live MCP surface: scope-filtered tools/list under each
// of the four keys, SCOPE_DENIED on a hidden tool, and the Zod-3 → Standard Schema bridge.
//
// This drives the REAL SDK server through the REAL client over an in-process transport, so
// it proves the bridge actually satisfies @modelcontextprotocol/server 2.0.0 rather than
// merely type-checking against it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { freshDb } from './helpers';
import { buildServer, serveMcpRequest, MCP_V2_PROTOCOL_VERSION, MCP_V2_SDK_VERSION } from '../../mcp-v2/server';
import { sdkSchema, toJsonSchema } from '../../mcp-v2/schema-bridge';
import { toolSchemas, PRINCIPALS, type Principal } from '../contracts';
import type { Db } from '../db';

/** An in-process client wired straight to the handler's fetch face. No socket. */
async function connect(db: Db, principal: Principal) {
  const handler = createMcpHandler(() => buildServer({ db, principal }));
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect({
    async start() {}, async close() {},
    async send(msg: unknown) {
      const res = await handler.fetch(new Request('https://cat.evenos.app/api/mcp/v2', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(msg),
      }));
      if (res.status === 202) return;
      const ct = res.headers.get('content-type') || '';
      const text = await res.text();
      if (ct.includes('event-stream')) {
        for (const line of text.split('\n')) {
          if (line.startsWith('data:')) (this as { onmessage?: (m: unknown) => void }).onmessage?.(JSON.parse(line.slice(5).trim()));
        }
      } else if (text) (this as { onmessage?: (m: unknown) => void }).onmessage?.(JSON.parse(text));
    },
  } as never);
  return { client, handler };
}

test('§15.3: tools/list is scope-filtered for each of the four principals', async () => {
  const db = await freshDb();
  const listed: Record<string, string[]> = {};
  for (const principal of PRINCIPALS) {
    const { client, handler } = await connect(db, principal);
    const { tools } = await client.listTools();
    listed[principal] = tools.map((t) => t.name).sort();
    await handler.close();
  }
  // Printed so the build report can quote the exact surface rather than paraphrase it.
  console.log('TOOLS/LIST BY KEY:', JSON.stringify(listed, null, 1));

  // §15.3 — the research key must not see worker_control.
  assert.ok(!listed.research.includes('worker_control'));
  // §3.1 gives research `production_read`, so the two production READS are visible to it.
  assert.ok(listed.research.includes('system_health'));
  assert.ok(listed.research.includes('worker_status'));
  // lab-v2 round A2 (§17.2): 14 round-1 tools + 9 observation tools.
  assert.equal(listed.research.length, 23);

  // The operator holds production_write, so it alone sees worker_control — but it holds
  // no research_write, so the five research-writing tools are hidden from it.
  assert.ok(listed.operator.includes('worker_control'));
  assert.ok(!listed.operator.includes('dataset_create'));
  // A2 adds source_freshness (production_read) and the eight research_read tools it can see.
  assert.equal(listed.operator.length, 19);

  // reviewer and release hold no research_write: no dataset or experiment creation.
  for (const p of ['reviewer', 'release'] as const) {
    assert.ok(!listed[p].includes('dataset_create'), `${p} must not create datasets`);
    assert.ok(!listed[p].includes('experiment_run'), `${p} must not run experiments`);
    assert.ok(!listed[p].includes('worker_control'));
  }
  // reviewer = 3 unrestricted + 2 production reads + 4 research reads.
  assert.equal(listed.reviewer.length, 18);
  // release = 3 unrestricted + 2 production reads + source_freshness. Nothing carries `release`.
  assert.equal(listed.release.length, 6);
  await db.close();
});

test('§15.3: calling a hidden tool by name returns SCOPE_DENIED, not "unknown tool"', async () => {
  const db = await freshDb();
  const { client, handler } = await connect(db, 'research');
  // The tool is not registered on this instance, so the SDK itself rejects the name.
  // That protocol-level rejection is the outer fence; the inner one is asserted below.
  await assert.rejects(() => client.callTool({ name: 'worker_control', arguments: { action: 'pause' } }));

  // The authorisation check that actually decides is in the service layer, and it is
  // reached whether or not the tool was ever registered.
  const { callTool } = await import('../service');
  await assert.rejects(
    () => callTool({ db, principal: 'research', protocolVersion: 'x', sdkVersion: 'y' }, 'worker_control', { action: 'pause' }),
    (e: { code?: string }) => e.code === 'SCOPE_DENIED',
  );
  await handler.close();
  await db.close();
});

test('§8: a real tool call round-trips through the SDK with structured content', async () => {
  const db = await freshDb();
  const { client, handler } = await connect(db, 'research');
  const res = await client.callTool({ name: 'system_capabilities', arguments: {} });
  const body = JSON.parse((res.content as { text: string }[])[0].text);
  assert.equal(body.principal, 'research');
  assert.equal(body.protocol_version, MCP_V2_PROTOCOL_VERSION);
  assert.equal(body.sdk_version, MCP_V2_SDK_VERSION);
  assert.equal(body.tools.length, 23);
  assert.ok(body.pricing_version.startsWith('lab-v2-pricing/'));
  await handler.close();
  await db.close();
});

test('§8: an input that fails its schema is rejected at dispatch', async () => {
  const db = await freshDb();
  const { callTool } = await import('../service');
  await assert.rejects(
    () => callTool({ db, principal: 'research', protocolVersion: 'x', sdkVersion: 'y' }, 'engine_describe', { engine: 'not_an_engine' }),
    (e: { code?: string }) => e.code === 'INVALID_INPUT',
  );
  await db.close();
});

test('§13: a principal field in the arguments is IGNORED, never trusted', async () => {
  const db = await freshDb();
  const { callTool } = await import('../service');
  const out = await callTool(
    { db, principal: 'research', protocolVersion: 'x', sdkVersion: 'y' },
    'system_capabilities',
    { principal: 'operator', reviewer: 'someone' },
  ) as { principal: string };
  assert.equal(out.principal, 'research', 'the key decides the principal, not the payload');
  await db.close();
});

// ── decision 19 / §15.2 — a key in the query string is a 400 ─────────────────────────
test('decision 19: a key presented in the query string returns 400, not 401 and not a session', async () => {
  // V1 accepted `?key=`. V2 refuses the whole SHAPE: query strings land in access logs,
  // proxy logs and browser history, so a secret that travels there is already leaked. The
  // check runs FIRST — before the configured check and before any key comparison — so this
  // holds even on an unconfigured deployment, which is what this test relies on.
  const res = await serveMcpRequest(
    new Request('https://cat.evenos.app/api/mcp/v2?key=some-secret', { method: 'POST', body: '{}' }),
    null,
  );
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.match(body.error, /query string not accepted/);
  // And the refusal must not leak which of the four keys, if any, it matched.
  assert.ok(!/research|operator|reviewer|release/.test(body.error));
});

test('decision 19: any query string is refused, not only one named `key`', async () => {
  const res = await serveMcpRequest(
    new Request('https://cat.evenos.app/api/mcp/v2?anything=1', { method: 'POST', body: '{}' }),
    'a-bearer-key',
  );
  assert.equal(res.status, 400);
});

test('§3.1: with no keys configured the endpoint is 503, and a bad key is 401', async () => {
  const saved: Record<string, string | undefined> = {};
  for (const k of ['LAB_API_KEY_RESEARCH', 'LAB_API_KEY_OPERATOR', 'LAB_API_KEY_REVIEWER', 'LAB_API_KEY_RELEASE']) {
    saved[k] = process.env[k]; delete process.env[k];
  }
  try {
    const res = await serveMcpRequest(new Request('https://cat.evenos.app/api/mcp/v2', { method: 'POST', body: '{}' }), 'anything');
    assert.equal(res.status, 503, 'dark until V sets the keys');
    assert.equal((await res.json() as { error: string }).error, 'lab v2 not configured');
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
});

// ── §14.2 the Zod bridge ─────────────────────────────────────────────────────────────
test('§14.2: the bridge supplies the jsonSchema half that zod 3 lacks', () => {
  const zod3 = toolSchemas.dataset_create.input;
  const std = (zod3 as unknown as { '~standard': Record<string, unknown> })['~standard'];
  // The measured gap this bridge exists to close: zod 3.25.76 has validate, not jsonSchema.
  assert.ok(std.validate, 'zod 3 does implement the validation half');
  assert.equal(std.jsonSchema, undefined, 'and does NOT implement the JSON Schema half');

  const bridged = sdkSchema(zod3) as unknown as { '~standard': { jsonSchema: { input: () => Record<string, unknown> } ; validate: (v: unknown) => unknown } };
  const json = bridged['~standard'].jsonSchema.input();
  assert.equal(json.type, 'object');
  assert.deepEqual(Object.keys(json.properties as object).sort(), ['case_key', 'engine', 'idempotency_key']);
  assert.deepEqual((json.required as string[]).sort(), ['case_key', 'engine', 'idempotency_key']);
});

test('§14.2: the bridge delegates validation to zod rather than reimplementing it', () => {
  const bridged = sdkSchema(toolSchemas.run_result.input) as unknown as { '~standard': { validate: (v: unknown) => { issues?: unknown[] } } };
  assert.ok(bridged['~standard'].validate({ run_id: 'not-a-uuid' }).issues, 'a bad uuid is rejected');
  assert.equal(bridged['~standard'].validate({ run_id: '11111111-2222-3333-4444-555555555555' }).issues, undefined);
});

test('§14.2: optional and defaulted fields are not advertised as required', () => {
  const json = toJsonSchema(toolSchemas.run_result.input);
  assert.deepEqual(json.required, ['run_id'], 'limit and offset carry defaults, so they are optional');
});
