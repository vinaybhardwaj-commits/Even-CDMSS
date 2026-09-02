/**
 * lib/__tests__/ipd-episode-contract.test.ts — the STRUCTURAL invariants of the IPD Episode Audit
 * build. These are source-read assertions, and each one guards a property that a behavioural test
 * cannot reach because the property is about what the code IS, not what it returns.
 *
 * WHAT IS PINNED HERE, AND WHY EACH ONE MATTERS:
 *  · Every pass input is a FILTER over the one assembled event list. Two assembly paths is how a
 *    blinded pass quietly stops being blinded, and it would pass every unit test on the way.
 *  · Every model call goes through governedChat with { bedrock: model }. A direct client call
 *    would be a PHI path that de-identification never gated, and an unattributable cost row.
 *  · The UNTOUCHED list is untouched. A build that reads a frozen module is fine; a build that
 *    edits one has changed something nobody reviewed.
 *  · The flag 404s the UI and does NOT gate the pipeline, and there is no cron entry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { OUTCOME_AWARE_NOTICE, NO_DIVERGENCE_COPY } from '../../app/admin/ipd-audit/episodes/ui';
import { IPD_EPISODE_ENGINE_VERSION, SKIP_REASONS, IPD_DISCHARGE_ENGINE_VERSION_FOR_JOIN } from '../ipd-episode/store';
import {
  IPD_EPISODE_CHECKPOINT_SYSTEM, IPD_EPISODE_COMMENTARY_SYSTEM, IPD_EPISODE_DIFF_SYSTEM,
  IPD_EPISODE_FIDELITY_SYSTEM,
} from '../ipd-episode/prompts';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ENGINE_FILES = [
  'lib/ipd-episode/assemble-core.ts', 'lib/ipd-episode/assemble.ts', 'lib/ipd-episode/checkpoint-core.ts',
  'lib/ipd-episode/checkpoint.ts', 'lib/ipd-episode/db13.ts', 'lib/ipd-episode/judge-core.ts',
  'lib/ipd-episode/judge.ts', 'lib/ipd-episode/prompts.ts', 'lib/ipd-episode/run.ts', 'lib/ipd-episode/store.ts',
];

// ── the blinding is structural ───────────────────────────────────────────────────────────────

test('every checkpoint and pass input is built by FILTERING the one assembled event list', () => {
  const run = code('lib/ipd-episode/run.ts');
  // the four filters, all from assemble-core, all applied in run.ts
  for (const filter of ['eventsBeforeDayStart(', 'episodeLevelEvents(', 'diffPassEvents(', 'fidelityPassEvents(']) {
    assert.ok(run.includes(filter), `run.ts must build its inputs with ${filter}`);
  }
  // assembleEpisode is called EXACTLY ONCE — one list, built once
  assert.equal((run.match(/assembleEpisode\(/g) ?? []).length, 1,
    'the episode is assembled exactly once; a second assembly path is how blinding is lost');
  // and nothing else in the engine assembles events
  for (const f of ENGINE_FILES.filter((x) => !x.endsWith('run.ts') && !x.endsWith('assemble.ts'))) {
    assert.ok(!code(f).includes('assembleEpisode('), `${f} must not assemble a second event list`);
  }
});

test('the checkpoint and judge layers are handed a list — neither reaches back for an event', () => {
  for (const f of ['lib/ipd-episode/checkpoint.ts', 'lib/ipd-episode/checkpoint-core.ts', 'lib/ipd-episode/judge.ts', 'lib/ipd-episode/judge-core.ts']) {
    const src = code(f);
    for (const reader of ['fetchProgressNotes', 'fetchBillingOrders', 'fetchDischargeSummary', 'fetchAdmission', 'fetchLabOrders', 'fetchExtractionByIpUid']) {
      assert.ok(!src.includes(`${reader}(`), `${f} must not call ${reader} — it renders what it is given`);
    }
  }
});

test('the blinded layers never name an outcome field', () => {
  // discharge_type / los_days / discharge_date_time must not be reachable from the checkpoint
  // layer at all. (judge-core legitimately names them in its fidelity and commentary builders,
  // which are the two passes allowed to see the outcome.)
  for (const f of ['lib/ipd-episode/checkpoint.ts', 'lib/ipd-episode/checkpoint-core.ts']) {
    const src = code(f);
    for (const field of ['discharge_type', 'discharge_date_time', 'dischargeType', 'extracted_case', 'extractedCase']) {
      assert.ok(!src.includes(field), `${f} must not name '${field}' — the checkpoint pass is blind to the outcome`);
    }
  }
});

test('the outcome line handed to commentary is built at the last stage, not carried through the pipeline', () => {
  const run = code('lib/ipd-episode/run.ts');
  assert.ok(/function outcomeLineFrom/.test(run));
  assert.equal((run.match(/outcomeLineFrom\(/g) ?? []).length, 2, 'defined once, called once — only for pass B');
  const call = run.slice(run.indexOf('runCommentaryPass('), run.indexOf('runCommentaryPass(') + 400);
  assert.ok(call.includes('outcomeLineFrom('), 'the outcome reaches pass B and nothing else');
});

// ── one model path ───────────────────────────────────────────────────────────────────────────

test('every model call in this engine goes through governedChat with an explicit bedrock target', () => {
  for (const f of ENGINE_FILES) {
    const src = code(f);
    const calls = (src.match(/governedChat\(/g) ?? []).length;
    if (!calls) continue;
    // one { bedrock: … } per governedChat call
    assert.equal((src.match(/bedrock:/g) ?? []).length, calls, `${f}: every governedChat call names a bedrock model`);
    // and no other client is reachable
    for (const banned of ['chatWithFallback(', 'getGeminiChatClient(', 'bedrockConverse(', 'bedrockGenerate(', '.chat.completions.create(']) {
      assert.ok(!src.includes(banned), `${f} must not call ${banned} — the governed layer is the only path`);
    }
  }
});

test('the models are validated BEFORE any work — not after three Opus calls have already been spent', () => {
  const run = code('lib/ipd-episode/run.ts');
  const assertAt = run.indexOf('assertKnownBedrockModel(');
  assert.ok(assertAt > 0, 'run.ts asserts the models');
  for (const later of ['fetchDischargeSummary(', 'assembleEpisode(', 'runCheckpoint(', 'runDiffPass(', 'startTrace(']) {
    const at = run.indexOf(later);
    if (at > 0) assert.ok(assertAt < at, `assertKnownBedrockModel must run before ${later}`);
  }
});

test('all four prompts are top-level consts in one pure file with no imports, so the registry can extract them', () => {
  const src = read('lib/ipd-episode/prompts.ts');
  assert.ok(!/^\s*import /m.test(src), 'prompts.ts imports nothing — it is pure text');
  for (const name of ['IPD_EPISODE_CHECKPOINT_SYSTEM', 'IPD_EPISODE_DIFF_SYSTEM', 'IPD_EPISODE_FIDELITY_SYSTEM', 'IPD_EPISODE_COMMENTARY_SYSTEM']) {
    assert.ok(new RegExp(`^export const ${name} = \``, 'm').test(src), `${name} is a top-level template literal`);
  }
  for (const p of [IPD_EPISODE_CHECKPOINT_SYSTEM, IPD_EPISODE_DIFF_SYSTEM, IPD_EPISODE_FIDELITY_SYSTEM, IPD_EPISODE_COMMENTARY_SYSTEM]) {
    assert.ok(p.trim().length > 400, 'every prompt carries real instruction');
  }
});

test('the registry has all four prompts, registered rather than left on the honest gap list', () => {
  const gen = JSON.parse(read('data/reasoning-registry/prompts.generated.json')) as { prompts: { id: string }[] };
  const manifest = read('lib/reasoning/manifest.ts');
  for (const name of ['IPD_EPISODE_CHECKPOINT_SYSTEM', 'IPD_EPISODE_DIFF_SYSTEM', 'IPD_EPISODE_FIDELITY_SYSTEM', 'IPD_EPISODE_COMMENTARY_SYSTEM']) {
    const id = `prompts/${name}`;
    assert.ok(gen.prompts.some((p) => p.id === id), `${id} is in the generated registry`);
    assert.ok(manifest.includes(`'${id}'`), `${id} is registered in PROMPT_MANIFESTS`);
  }
});

test('each prompt states the discipline its pass is fenced by', () => {
  // the checkpoint prompt is told it does not know the ending
  assert.match(IPD_EPISODE_CHECKPOINT_SYSTEM, /You do not know how the admission ended/);
  // the diff prompt is told the same, and told not to infer one from where the events stop
  assert.match(IPD_EPISODE_DIFF_SYSTEM, /YOU ARE NOT TOLD HOW THIS ADMISSION ENDED/);
  assert.match(IPD_EPISODE_DIFF_SYSTEM, /Do not infer an outcome from where it stops/);
  // the fidelity prompt is fenced to one domain and one finding type
  assert.match(IPD_EPISODE_FIDELITY_SYSTEM, /domain "documentation" and finding_type "commission"/);
  // the commentary prompt is forbidden every number
  assert.match(IPD_EPISODE_COMMENTARY_SYSTEM, /YOU PRODUCE NO NUMBERS/);
  assert.match(IPD_EPISODE_COMMENTARY_SYSTEM, /Do not create a finding/);
  // and all four are told the substrate's limits or told not to name a patient
  for (const p of [IPD_EPISODE_CHECKPOINT_SYSTEM, IPD_EPISODE_DIFF_SYSTEM, IPD_EPISODE_FIDELITY_SYSTEM, IPD_EPISODE_COMMENTARY_SYSTEM]) {
    assert.match(p, /Never name a patient/);
  }
});

// ── the flag ─────────────────────────────────────────────────────────────────────────────────

test('both UI routes 404 unless IPD_EPISODE_AUDIT_ENABLED is exactly "1"', () => {
  for (const f of ['app/admin/ipd-audit/episodes/page.tsx', 'app/admin/ipd-audit/episodes/[id]/page.tsx']) {
    const src = code(f);
    assert.ok(src.includes("process.env.IPD_EPISODE_AUDIT_ENABLED !== '1'"), `${f} reads the flag at request time`);
    assert.ok(src.includes('notFound()'), `${f} 404s when the flag is off`);
  }
});

test('the flag gates the UI ONLY — the worker and the pipeline never read it (§9)', () => {
  for (const f of ['app/api/ipd-episode/worker/route.ts', ...ENGINE_FILES]) {
    assert.ok(!code(f).includes('IPD_EPISODE_AUDIT_ENABLED'), `${f} must not read the UI flag — the pipeline runs regardless`);
  }
});

test('the IPD page link is flag-gated too, so there is no half-open door', () => {
  const src = code('app/admin/ipd-audit/page.tsx');
  assert.ok(src.includes("process.env.IPD_EPISODE_AUDIT_ENABLED === '1'"));
  assert.ok(src.includes('/admin/ipd-audit/episodes'));
});

// ── the UI's verbatim obligations ────────────────────────────────────────────────────────────

test('the commentary block carries PRD §10 item 5 verbatim, and the empty-findings copy is verbatim too', () => {
  assert.equal(OUTCOME_AWARE_NOTICE, 'This commentary was written with knowledge of the patient outcome. The scores above were not.');
  assert.equal(NO_DIVERGENCE_COPY, 'No divergence found against the expected course.');
  const panels = read('app/admin/ipd-audit/episodes/[id]/panels.tsx');
  assert.ok(panels.includes('OUTCOME_AWARE_NOTICE'), 'the panel renders the constant, not a retyped copy');
  assert.ok(panels.includes('Outcome-aware commentary') && panels.includes('Could not assess'));
});

test('the sibling score is read at the pinned discharge engine version and always labelled as its own', () => {
  assert.equal(IPD_DISCHARGE_ENGINE_VERSION_FOR_JOIN, 'ipd-discharge-audit/0.2');
  // comments stripped: the file's header legitimately NAMES the palette it refuses to import,
  // which is the same reason lib/__tests__/ipd-audit-billing.test.ts strips them
  const ui = code('app/admin/ipd-audit/episodes/ui.tsx');
  assert.ok(ui.includes('Discharge engine score'));
  assert.ok(ui.includes('not audited by discharge engine'), 'a missing sibling row is stated, never shown as a zero');
  // this engine's own number never borrows the discharge engine's A–E band palette
  assert.ok(!ui.includes('bandColor') && !ui.includes('opd-audit-ui'),
    'the episode surface does not colour its divergence index with another engine’s band palette');
});

// ── the file contract (PRD §11) ──────────────────────────────────────────────────────────────

test('the UNTOUCHED list is untouched: this engine READS the frozen modules and edits none of them', () => {
  // ipd-audit is imported in exactly two places, both read-only helpers, and never written to
  const assemble = code('lib/ipd-episode/assemble.ts');
  assert.ok(assemble.includes("from '../ipd-audit/db13'"), 'the render-time header reader is reused, not reimplemented');
  for (const f of ENGINE_FILES) {
    const src = code(f);
    for (const banned of ['saveIpdAudit(', 'upsertExtractedCase(', 'computeScorecard(', 'recordIpdAuditFailure(']) {
      assert.ok(!src.includes(banned), `${f} must not write through a frozen module (${banned})`);
    }
    assert.ok(!/INSERT INTO ipd_discharge_audits|UPDATE ipd_discharge_audits|INSERT INTO discharge_extracted_cases|UPDATE discharge_extracted_cases/i.test(src),
      `${f} must never write to the discharge engine's tables`);
  }
  // and the store only ever SELECTs from them
  const store = code('lib/ipd-episode/store.ts');
  assert.ok(/FROM ipd_discharge_audits/.test(store) && /FROM discharge_extracted_cases/.test(store));
});

test('no new dependency, and vercel.json is untouched — there is NO cron entry (decision 19)', () => {
  const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string>; devDependencies?: Record<string, string> };
  const all = { ...pkg.dependencies, ...(pkg.devDependencies ?? {}) };
  for (const f of ENGINE_FILES) {
    for (const imp of code(f).matchAll(/from '([^'.][^']*)'/g)) {
      const pkgName = imp[1].startsWith('@') ? imp[1].split('/').slice(0, 2).join('/') : imp[1].split('/')[0];
      if (pkgName.startsWith('node:')) continue;
      assert.ok(pkgName in all, `${f} imports '${pkgName}', which is not a declared dependency`);
    }
  }
  if (existsSync('vercel.json')) {
    const vercel = read('vercel.json');
    assert.ok(!vercel.includes('ipd-episode'), 'vercel.json must carry no cron entry for this worker (decision 19)');
  }
});

test('the migration route and the reference .sql create the same three tables', () => {
  const route = read('app/api/admin/migrate-ipd-episode-audits/route.ts');
  const sqlFiles = readdirSync('migrations').filter((n) => n.includes('ipd_episode_audits'));
  assert.equal(sqlFiles.length, 1, 'exactly one reference migration file');
  const sqlText = read(join('migrations', sqlFiles[0]));
  for (const table of ['ipd_episode_audits', 'ipd_episode_checkpoints', 'ipd_episode_skips']) {
    assert.ok(route.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `the route creates ${table}`);
    assert.ok(sqlText.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `the .sql creates ${table}`);
  }
  assert.ok(route.includes('ipd_episode_audits_encounter_engine_uq') && sqlText.includes('ipd_episode_audits_encounter_engine_uq'));
  assert.ok(sqlText.includes('PRIMARY KEY (encounter_id, engine_version)'), 'the skips table is keyed as §7.3 says');
  // every statement is idempotent, so the route can be run twice
  assert.ok(!/CREATE TABLE (?!IF NOT EXISTS)/.test(route) && !/CREATE TABLE (?!IF NOT EXISTS)/.test(sqlText));
});

test('no PHI column name appears in the migration DDL, in either copy', () => {
  const sqlFiles = readdirSync('migrations').filter((n) => n.includes('ipd_episode_audits'));
  for (const src of [code('app/api/admin/migrate-ipd-episode-audits/route.ts'), read(join('migrations', sqlFiles[0])).replace(/^--.*$/gm, '')]) {
    for (const col of ['uhid', 'patient_name', 'patient_age', 'patient_gender', 'birth_date', 'mobile', 'address', 'telecom', 'kin_']) {
      assert.ok(!new RegExp(`\\b${col}`).test(src), `the DDL must not declare a '${col}' column`);
    }
  }
});

// ── the worker ───────────────────────────────────────────────────────────────────────────────

test('the worker mirrors the IPD discharge worker: 800 s box, the same auth, ?max= default 2 cap 5', () => {
  const src = code('app/api/ipd-episode/worker/route.ts');
  assert.ok(src.includes('export const maxDuration = 800'));
  assert.ok(src.includes("export const runtime = 'nodejs'") && src.includes("export const dynamic = 'force-dynamic'"));
  assert.ok(src.includes("req.headers.get('x-vercel-cron')") && src.includes('CRON_SECRET') && src.includes('isAdminUnlocked()'));
  assert.ok(src.includes("Math.max(1, Math.min(5, Number(p.get('max') || 2)))"), '?max= defaults to 2 and caps at 5');
  assert.ok(src.includes("p.get('encounter')"), '?encounter= runs one named episode');
  // sequential by construction: no concurrency knob exists at all
  assert.ok(!src.includes("p.get('conc')") && !src.includes('mapLimit'), 'the worker has no concurrency knob');
  assert.ok(/for \(const c of candidates\)/.test(src), 'episodes are processed one after another');
});

test('the worker holds the app_settings lock key the PRD names, and releases it in finally', () => {
  const src = code('app/api/ipd-episode/worker/route.ts');
  assert.ok(src.includes("'ipd_episode_lock'"));
  assert.ok(src.includes('lockHeld(') && src.includes('locked: true'), 'a held lock returns {ok:true, locked:true} and does nothing');
  assert.ok(/} finally \{[\s\S]*setSetting\(LOCK_KEY, ''\)/.test(src), 'the lock is released in finally');
});

// ── engine identity ──────────────────────────────────────────────────────────────────────────

test('the engine version and the closed set of skip reasons are exactly what the PRD ratified', () => {
  assert.equal(IPD_EPISODE_ENGINE_VERSION, 'ipd-episode-audit/0.1');
  assert.deepEqual([...SKIP_REASONS], ['no_discharge_summary', 'no_notes', 'no_extraction', 'diff_failed', 'fidelity_failed']);
});

test('every skip reason the pipeline can write is one of the five, and each of the five is reachable', () => {
  const run = code('lib/ipd-episode/run.ts');
  const written = new Set([...run.matchAll(/reason: '([a-z_]+)'/g)].map((m) => m[1]));
  for (const r of written) assert.ok((SKIP_REASONS as readonly string[]).includes(r), `'${r}' is not a declared skip reason`);
  for (const r of SKIP_REASONS) assert.ok(written.has(r), `'${r}' is declared but never written`);
});

test('a db13 fault writes NO audit row and NO skip row — a transport failure is not a fact about an episode', () => {
  const run = code('lib/ipd-episode/run.ts');
  const tail = run.slice(run.lastIndexOf('} catch (e) {'));
  assert.ok(!tail.includes('recordSkip('), 'the top-level catch must not write a skip');
  assert.ok(!tail.includes('saveEpisodeAudit('), 'the top-level catch must not write an audit row');
  assert.ok(tail.includes('error:'), 'it returns a recorded error instead');
});

test('no route in this build can return a 500 on a failed audit (§8)', () => {
  const worker = code('app/api/ipd-episode/worker/route.ts');
  const statuses = [...worker.matchAll(/status:\s*(\d{3})/g)].map((m) => Number(m[1]));
  for (const s of statuses) assert.ok(s === 401 || s === 400, `the worker returns only 401/400, found ${s}`);
});
