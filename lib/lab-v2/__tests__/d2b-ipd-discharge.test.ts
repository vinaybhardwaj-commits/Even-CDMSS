/**
 * LAB-MCP-V2 §17.9 round D2b — the `ipd_discharge` engine behind the fence
 * (decisions 117(a), 118, 122, 123, 124, 125; and 99, 102, 87, 109 throughout).
 *
 * ⚠️ THE FIXTURE IS MANUFACTURED, AND IT MUST BE. A real discharge extract is one person's
 * admission; this repository has had PHI history rewritten once and must never carry another. So
 * the `ExtractedCase` below carries EVERY key `lib/doc-audit-core.ts:123-149` declares — including
 * `verbatimSections`, which is the field that has actually leaked before — with clinical prose
 * invented for the purpose, and the two db13 envelopes carry every key their own types declare,
 * `patientName`, `uhid`, `ageGender` and `ipUid` included. That completeness is the point: an
 * inventory over a fixture that never held the dangerous key proves nothing, which is exactly how
 * `indexDocumentId` survived the whole of D1 (decision 111).
 *
 * ⚠️ DECISION 87 THROUGHOUT. `discharge_extracted_cases` is created from the DDL at
 * `app/api/admin/migrate-extracted-cases/route.ts:26-35` and `ipd_discharge_audits` from the column
 * list `saveIpdAudit` inserts (`lib/ipd-audit/store.ts:110-117`); both inferred statements this
 * round writes run against them once.
 *
 * ⚠️ AND DECISION 102 IS ASSERTED AS A NEGATIVE. The freeze must never reach a PDF; the source's
 * own text is grepped for the two functions that could, because "we did not call it" is a claim
 * about every line of the file and not about the happy path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { embedded, type Db } from '../db';
import { freshDb } from './helpers';
import { ENGINE_STAGES, LabError, SUPPORTED_ENGINES, hash } from '../contracts';
import { identifyingKeys, isIdentifyingKey } from '../sources/requests';
import { ensureBudget, getObject, itemsOf, putObject, submitRun } from '../store';
import { tick } from '../worker';
import { callTool } from '../service';
import { DOC_EXTRACT_VERSION } from '../../discharge-extract-store';
import { IPD_ENGINE_VERSION } from '../../ipd-audit/store';
import {
  BILLING_FIELDS, ENVELOPE_FIELDS, EXTRACT_VERSIONS_SQL, IPD_AUDIT_ROW_SQL, NEVER_STORED_KEYS,
  freezeIpdDischargeDocument,
} from '../sources/ipd-discharge';
import {
  CARE_VALUE_BANDS, IPD_DISCHARGE_STAGES, STRIPPED_ROW_KEYS, makeIpdDischargeAdapter,
  stripRowIdentifiers, surrogateFor,
} from '../adapters/ipd-discharge';
import { computeIpdDischargeAudit, IpdComputeError } from '../../ipd-audit/compute';
import { PSEUDONYM_PREFIX } from '../sources/preop';

const SALT = 'd2b-test-salt';
const DOC = 'DOCX-0001';

// ─────────────────────────────────────────────────────────────────────────────────────
// The fixtures: every key of every shape the freeze touches
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * `ExtractedCase` with all nineteen keys of `lib/doc-audit-core.ts:123-149`. Clinical prose is
 * invented; `patient: {age, sex}` is the one demographic key the type carries and it stays, because
 * the analyze pass reads it and neither an age nor a sex is on §3.3's denylist.
 */
const EXTRACTED = {
  docType: 'discharge_summary',
  detectedDocType: 'discharge_summary',
  confidence: 0.92,
  patient: { age: 61, sex: 'M' },
  diagnosis: 'Community-acquired pneumonia, right lower lobe',
  indication: null,
  procedure: null,
  investigations: ['Chest X-ray', 'CBC', 'CRP', 'Blood culture'],
  treatments: ['IV ceftriaxone', 'Nebulised salbutamol', 'Oxygen by nasal cannula'],
  medications: ['Ceftriaxone 1 g IV BD', 'Azithromycin 500 mg OD', 'Paracetamol 650 mg SOS'],
  courseSummary: 'Admitted with fever and productive cough; improved on IV antibiotics and stepped down to oral therapy on day 3.',
  disposition: 'Discharged home in stable condition',
  followUp: 'Review in chest clinic after one week with a repeat chest radiograph',
  rawNotes: 'De-identified extractor notes: afebrile 24 h before discharge; saturations 96% on room air.',
  completeness: [
    { key: 'diagnosis', status: 'present', note: '' },
    { key: 'followup_date', status: 'partial', note: 'interval given, no date' },
    { key: 'signoff', status: 'absent', note: '' },
  ],
  adminFacts: { lengthOfStayDays: 4, admissionType: 'emergency', careSetting: 'ward' },
  riskFactors: ['Type 2 diabetes', 'Ex-smoker'],
  aftercare: {
    instructions: ['Complete the full oral antibiotic course', 'Rest and maintain hydration'],
    warning_signs: ['Breathlessness at rest', 'Fever above 38.5 °C for more than 48 hours'],
    follow_up_detail: 'Chest clinic in one week; sooner if breathless',
  },
  /**
   * ⚠️ THE FIELD DECISION 50 STRIPS, PRESENT IN THE FIXTURE ON PURPOSE. It is raw printed
   * discharge prose — the block that has carried identifying text before — and a test that
   * asserted its absence over a fixture that never had it would assert nothing.
   */
  verbatimSections: [
    { heading: 'COURSE IN HOSPITAL', text: 'Printed ward-round prose copied verbatim from the summary.' },
    { heading: 'TREATMENT GIVEN', text: 'Printed drug chart copied verbatim from the summary.' },
  ],
} as const;

/** `IpdAdmissionHeader` (`lib/ipd-audit/db13.ts:46-59`) — all twelve keys, PHI included. */
const HEADER = {
  ipUid: 'IP-778899',
  patientName: 'Real Patient Name',
  uhid: 'UH-4455667',
  ageGender: '61/M',
  speciality: 'Pulmonology',
  team: 'Dr Real Consultant',
  ward: 'Ward 3B',
  dischargeType: 'Discharged',
  admitDate: '2026-08-10',
  dischargeDate: '2026-08-14',
  losDays: 4,
  status: 'Final',
};

/** `BillingEnvelope` (`lib/ipd-audit/billing.ts:59-70`) — all ten keys, `ipUid` included. */
const BILLING = {
  ipUid: 'IP-778899',
  netTotal: 84250,
  saleTotal: 86000,
  refundTotal: -1750,
  lineCount: 61,
  billCount: 3,
  categories: [
    { category: 'Pharmacy', net: 21400, lines: 28, clinical: true },
    { category: 'Room Rent', net: 24000, lines: 4, clinical: false },
  ],
  wardClasses: [{ label: 'Semi-Private', net: 24000 }],
  pharmacyItems: ['CEFTRIAXONE 1G INJ', 'AZITHROMYCIN 500MG TAB'],
  pharmacyClasses: ['Antibiotics'],
};

const BILLED_TOTAL = 84250;

/** `discharge_extracted_cases`, verbatim from migrate-extracted-cases/route.ts:26-35. */
async function extractDb(): Promise<Db> {
  const db = await embedded();
  await db.exec(`CREATE TABLE discharge_extracted_cases (
    document_id         TEXT NOT NULL,
    extraction_version  TEXT NOT NULL DEFAULT 'doc-extract/1',
    ip_uid              TEXT,
    member_id           TEXT,
    extracted_json      JSONB NOT NULL,
    extracted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    trace_id            TEXT,
    PRIMARY KEY (document_id, extraction_version)
  )`);
  // `ipd_discharge_audits`, from the columns `saveIpdAudit` inserts (`store.ts:110-117`).
  await db.exec(`CREATE TABLE ipd_discharge_audits (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    document_id text NOT NULL, ip_uid text, member_id text, speciality text, discharge_type text,
    los_days int, discharged_at timestamptz, care_value_index int, band text,
    score_appropriateness int, score_efficiency int, score_safety int, score_cost int,
    score_documentation int, score_patient_centred int, completeness_pct int,
    n_findings int, n_low_value int, n_context_dependent int,
    findings jsonb, suggestions jsonb, report jsonb, billed_total numeric,
    engine_version text NOT NULL, model text, provider text, trace_id text,
    audited_at timestamptz DEFAULT NOW(),
    UNIQUE (document_id, engine_version))`);
  return db;
}

async function seedExtract(db: Db, o: { documentId?: string; version?: string; memberId?: string | null } = {}) {
  await db.query(
    `INSERT INTO discharge_extracted_cases (document_id, extraction_version, ip_uid, member_id, extracted_json, trace_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [o.documentId ?? DOC, o.version ?? DOC_EXTRACT_VERSION, HEADER.ipUid,
      o.memberId === undefined ? 'MEM-99001' : o.memberId, JSON.stringify(EXTRACTED), 'TR-EXTRACT-1'],
  );
}

async function seedAudit(db: Db, o: { documentId?: string; cvi?: number; band?: string } = {}) {
  await db.query(
    `INSERT INTO ipd_discharge_audits (document_id, ip_uid, member_id, care_value_index, band,
       engine_version, model, provider, trace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [o.documentId ?? DOC, HEADER.ipUid, 'MEM-99001', o.cvi ?? 68, o.band ?? 'C',
      IPD_ENGINE_VERSION, 'gemini-2.5-pro', 'vertex', 'TR-AUDIT-1'],
  );
}

const runner = (db: Db) => (async (statement: string, params: unknown[]) => db.query(statement, params)) as never;

/**
 * ⚠️ RULE 1a, §17.10 DECISION 134 — THE ROUND D2c SEAM, AND WHY EVERY TEST BELOW TAKES IT.
 *
 * D2c makes the freeze RECORD a replay: `freezeIpdDischargeDocument` now runs the engine once
 * against production's stored replies and refuses `SOURCE_UNAVAILABLE` when there are none, exactly
 * as D2a's readmission freeze does. Every test in this file freezes a fixture document that has no
 * audit trace, so without this seam all eight of them would fail on a fact none of them is about.
 *
 * ⚠️ AND IT IS INJECTED RATHER THAN THE FIXTURES BEING GIVEN TRACES, DELIBERATELY. These tests
 * assert D2b's behaviour — the freeze's shape, the eight stages reaching the gateway, the §35a
 * refusal — and a fixture with a trace would silently convert three of them into REPLAY tests that
 * no longer exercise the fresh path at all. D2a made the same call for the same reason
 * (`d1-engines.test.ts`'s `NO_STEPS`). The recorded path is exercised in `d2c-ipd-discharge-replay.test.ts`.
 */
const NO_STEPS = {
  recordSteps: (async () => ({ steps: {}, retrieval: {}, text_model: null })) as never,
};

/** The freeze with every read answered from the PGlite tables and the two db13 fixtures. */
function freeze(db: Db, documentId = DOC, over: Record<string, unknown> = {}) {
  return freezeIpdDischargeDocument(documentId, {
    run: runner(db),
    fetchHeader: (async () => HEADER) as never,
    fetchBilling: (async () => BILLING) as never,
    fetchTotal: (async () => BILLED_TOTAL) as never,
    salt: SALT,
    ...NO_STEPS,
    ...over,
  });
}

/**
 * The store read, answered from the PGlite table. `readExtractedCaseAcrossVersions` reaches `sql`,
 * which has no DATABASE_URL here, so this restates its CONTRACT — found / absent / fetch_failed —
 * over the same table its own statement reads. The statement itself is exercised by the decision 87
 * test below; this is the outcome shape the freeze branches on.
 */
function storeRead(db: Db) {
  return (async (documentId: string, versions: readonly string[]) => {
    const rows = await db.query<Record<string, unknown>>(
      `SELECT document_id, extraction_version, ip_uid, member_id, extracted_json,
              to_char(extracted_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS extracted_at, trace_id
         FROM discharge_extracted_cases
        WHERE document_id = $1 AND extraction_version = ANY($2::text[])`,
      [documentId, [...versions]]);
    for (const v of versions) {
      const r = rows.find((x) => String(x.extraction_version) === v);
      if (r) {
        return {
          outcome: 'found' as const, version: v,
          stored: {
            documentId: String(r.document_id), extractionVersion: v,
            ipUid: r.ip_uid == null ? null : String(r.ip_uid),
            memberId: r.member_id == null ? null : String(r.member_id),
            extracted: r.extracted_json, extractedAt: String(r.extracted_at ?? ''),
            traceId: r.trace_id == null ? null : String(r.trace_id),
          },
        };
      }
    }
    return { outcome: 'absent' as const };
  }) as never;
}

const frozenFrom = (db: Db, documentId = DOC) => freeze(db, documentId, { readExtract: storeRead(db) });

// ═════════════════════════════════════════════════════════════════════════════════════
// DECISION 87 — the two inferred statements, against real tables
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.9 decision 87: both ipd_discharge statements are bounded SELECTs that write nothing', () => {
  for (const [name, sql] of [['versions', EXTRACT_VERSIONS_SQL], ['audit', IPD_AUDIT_ROW_SQL]] as const) {
    assert.match(sql, /^SELECT/, name);
    assert.match(sql, /WHERE document_id = \$1/, `${name} binds the document id, never interpolates it`);
    assert.match(sql, /LIMIT \d+/, `${name} is bounded`);
    for (const verb of ['INSERT', 'UPDATE', 'DELETE', 'ALTER', 'DROP', 'TRUNCATE']) {
      assert.ok(!new RegExp(`\\b${verb}\\b`).test(sql), `${name} contains ${verb}`);
    }
  }
  // ⚠️ NOT `SELECT *`. `ipd_discharge_audits` carries ip_uid, member_id and the whole report jsonb.
  assert.ok(!/SELECT \*/.test(IPD_AUDIT_ROW_SQL), 'the audit read names its six columns');
  for (const k of ['ip_uid', 'member_id', 'report']) {
    assert.ok(!IPD_AUDIT_ROW_SQL.includes(k), `the audit read must not select ${k}`);
  }
});

test('§17.9 decision 87: both statements run against real tables and find the rows they wrote', async () => {
  const db = await extractDb();
  await seedExtract(db, { version: 'doc-extract/1' });
  await seedExtract(db, { version: DOC_EXTRACT_VERSION });
  await seedAudit(db);

  const versions = await db.query<Record<string, unknown>>(EXTRACT_VERSIONS_SQL, [DOC]);
  assert.deepEqual(versions.map((r) => r.extraction_version), [DOC_EXTRACT_VERSION, 'doc-extract/1']);
  assert.match(String(versions[0].extracted_at), /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(await db.query(EXTRACT_VERSIONS_SQL, ['NOBODY']), []);

  const audit = await db.query<Record<string, unknown>>(IPD_AUDIT_ROW_SQL, [DOC, IPD_ENGINE_VERSION]);
  assert.equal(Number(audit[0].care_value_index), 68);
  assert.equal(audit[0].band, 'C');
  assert.equal(audit[0].model, 'gemini-2.5-pro');
  assert.deepEqual(Object.keys(audit[0]).sort(),
    ['band', 'care_value_index', 'engine_version', 'model', 'provider', 'trace_id']);
  // A document audited under a different engine version is not this row.
  assert.deepEqual(await db.query(IPD_AUDIT_ROW_SQL, [DOC, 'ipd-discharge-audit/0.1']), []);
  await db.close();
});

// ═════════════════════════════════════════════════════════════════════════════════════
// DECISION 102 — the freeze never reaches a PDF, asserted over the source
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.9 decision 102: the ipd_discharge source and adapter never reach a PDF or a writer', () => {
  const root = process.cwd();
  for (const f of ['lib/lab-v2/sources/ipd-discharge.ts', 'lib/lab-v2/adapters/ipd-discharge.ts']) {
    const src = readFileSync(join(root, f), 'utf8');
    // Comments EXPLAIN which production paths these files avoid, and prose about a call is not one.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of [
      'fetchPdf', 'extractCase', 'generateFromDocument', 'upsertExtractedCase',
      'saveIpdAudit', 'recordIpdAuditFailure', 'persistEpisodeState', 'runIpdAudit',
    ]) {
      assert.ok(!code.includes(forbidden), `${f} must not reach ${forbidden}`);
    }
  }
  // And compute.ts composes the two phases without importing any of run.ts's ten I/O phases.
  const compute = readFileSync(join(root, 'lib/ipd-audit/compute.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(compute.includes('analyzeCase') && compute.includes('buildIpdAuditRow'), 'the two phases');
  for (const forbidden of ['fetchPdf', 'extractCase', 'saveIpdAudit', 'metabaseQuery', 'startTrace']) {
    assert.ok(!compute.includes(forbidden), `compute.ts must not reach ${forbidden}`);
  }
});

test('§17.9: no file under lib/lab-v2/sources or adapters WRITES a discharge or ipd table', () => {
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  const root = process.cwd();
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(join(root, 'lib/lab-v2/sources'));
  walk(join(root, 'lib/lab-v2/adapters'));
  // The same grep decision 79 built, on the tables D2b touches.
  const TABLES = /discharge_extracted_cases|ipd_discharge_audits|discharge_|ipd_/;
  const hits: string[] = [];
  for (const f of files) {
    const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const [i, line] of code.split('\n').entries()) {
      for (const verb of ['INSERT INTO', 'UPDATE ', 'DELETE FROM']) {
        if (line.includes(verb) && TABLES.test(line)) hits.push(`${f.slice(root.length + 1)}:${i + 1} — ${line.trim().slice(0, 120)}`);
      }
    }
  }
  assert.deepEqual(hits, [], `a v2 write to a D2b production table:\n${hits.join('\n')}`);
  const probe = `${'INSERT INTO '}discharge_extracted_cases (document_id) VALUES ($1)`;
  assert.ok(TABLES.test(probe), 'the pattern matches a real write');
});

// ═════════════════════════════════════════════════════════════════════════════════════
// The freeze — decision 118's shape, decision 99's walk, decision 111's inventory
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.9 decision 118: the frozen case carries a member_key, the scalars, and no identifier', async () => {
  const db = await extractDb();
  await seedExtract(db);
  await seedAudit(db);
  const c = await frozenFrom(db);

  // ⚠️ DECISION 99, WALKED over the whole body at every depth.
  assert.deepEqual(identifyingKeys(c.frozen), [], 'the frozen body carries no denylist key');
  // ⚠️ AND BY VALUE, not only by key name — db13's three PHI fields and the four run identifiers.
  const text = JSON.stringify(c);
  for (const secret of [HEADER.patientName, HEADER.uhid, HEADER.ageGender, HEADER.ipUid, DOC, 'MEM-99001']) {
    assert.ok(!text.includes(secret), `${secret} must not survive the freeze`);
  }
  assert.deepEqual(Object.keys(c.frozen.envelope).sort(), [...ENVELOPE_FIELDS].sort());
  assert.equal(c.frozen.envelope.speciality, 'Pulmonology');
  assert.equal(c.frozen.envelope.losDays, 4);
  assert.deepEqual(Object.keys(c.frozen.billing).sort(), [...BILLING_FIELDS, 'billedTotal'].sort());
  assert.equal(c.frozen.billing.netTotal, 84250);
  assert.equal(c.frozen.billing.billedTotal, BILLED_TOTAL);
  assert.equal(c.frozen.extraction_version, DOC_EXTRACT_VERSION);

  /**
   * ⚠️ DECISION 50 — `verbatimSections` GONE, and the removal RECORDED. `stripped` names the key
   * as a value, deliberately and exactly as `sources/ipd.ts` does: a strip nobody can see happened
   * is indistinguishable from an extract that never had the field. So the assertion is that no
   * such KEY survives (the inventory below proves that at every depth) and that the printed prose
   * it carried is nowhere in the body.
   */
  assert.deepEqual(c.frozen.stripped, ['verbatimSections']);
  assert.ok(!('verbatimSections' in (c.frozen.extracted as Record<string, unknown>)));
  assert.ok(!JSON.stringify(c.frozen.extracted).includes('verbatimSections'));
  assert.ok(!JSON.stringify(c.frozen).includes('COURSE IN HOSPITAL'), 'nor its printed prose');
  assert.ok(!JSON.stringify(c.frozen).includes('copied verbatim'), 'nor any of its text');

  // The one durable link decision 99 permits: a salted hash, a SIBLING of `frozen`, never inside it.
  assert.match(c.member_key ?? '', /^[0-9a-f]{16,}$/);
  assert.ok(!('member_key' in (c.frozen as unknown as Record<string, unknown>)));
  assert.match(c.case_key, /^ipddoc:[0-9a-f]{32}$/);
  // The golden side rides BESIDE the case and is never part of its body.
  assert.equal(c.stored_audit?.care_value_index, 68);
  assert.equal(c.stored_audit?.band, 'C');
  assert.ok(!JSON.stringify(c.frozen).includes('TR-AUDIT-1'), 'decision 118: no trace_id is stored');
  await db.close();
});

/** Every key in a body, at every depth, sorted and de-duplicated. */
function keyInventory(v: unknown, out = new Set<string>(), depth = 0): string[] {
  if (depth > 12 || v === null || typeof v !== 'object') return [...out].sort();
  if (Array.isArray(v)) { for (const x of v) keyInventory(x, out, depth + 1); return [...out].sort(); }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) { out.add(k); keyInventory(val, out, depth + 1); }
  return [...out].sort();
}

/**
 * ⚠️ DECISION 111's QUESTION, NOT THE DENYLIST'S. The walk asks "does this body carry a key I
 * already know is dangerous"; this asks "IS EVERY KEY IN THIS BODY ONE SOMEBODY LOOKED AT". A field
 * added to `ExtractedCase`, to `IpdAdmissionHeader` or to `BillingEnvelope` fails this on the day
 * it appears, and the fix is to classify it and put it in the list.
 */
test('§17.9 item 7: the frozen ipd_discharge body carries exactly these keys, and no others', async () => {
  const db = await extractDb();
  await seedExtract(db);
  const c = await frozenFrom(db);
  assert.deepEqual(keyInventory(c.frozen), [
    // the body itself
    'billing', 'engine', 'extracted', 'extraction_version', 'envelope', 'stripped',
    // ⚠️ RULE 1a, §17.10 DECISION 134 — the four keys round D2c adds. `steps` and `retrieval` are
    // empty here (see NO_STEPS above), so they contribute no nested keys; `d2c-ipd-discharge-replay`
    // enumerates a recorded body, every `ChunkHitWithMeta` field included.
    'steps', 'retrieval', 'text_model', 'flags',
    // frozen.flags — the three process.env reads analyzeCase:486-488 makes, as they stood at freeze
    'DOC_AUDIT_AUDIT', 'PROGNOSIS_AUDIT', 'DOC_AUDIT_CITE_GATE',
    // frozen.extracted — ExtractedCase (doc-audit-core.ts:123-149) MINUS verbatimSections
    'adminFacts', 'aftercare', 'completeness', 'confidence', 'courseSummary', 'detectedDocType',
    'diagnosis', 'disposition', 'docType', 'followUp', 'indication', 'investigations',
    'medications', 'patient', 'procedure', 'rawNotes', 'riskFactors', 'treatments',
    // patient — the one demographic pair, and neither is on the denylist
    'age', 'sex',
    // completeness — RawStatus
    'key', 'status', 'note',
    // adminFacts
    'admissionType', 'careSetting', 'lengthOfStayDays',
    // aftercare — AftercarePlan
    'follow_up_detail', 'instructions', 'warning_signs',
    // frozen.envelope — the four scalars run.ts:195-198 passes
    'dischargeDate', 'dischargeType', 'losDays', 'speciality',
    // frozen.billing — nine BillingEnvelope scalars + the ₹ total, `ipUid` NOT among them
    'billCount', 'billedTotal', 'categories', 'lineCount', 'netTotal', 'pharmacyClasses',
    'pharmacyItems', 'refundTotal', 'saleTotal', 'wardClasses',
    // billing.categories — BillingCategory; billing.wardClasses — {label, net}
    'category', 'clinical', 'lines', 'net', 'label',
  ].sort());
  // ⚠️ THE NEVER-STORED LIST, ASSERTED BY NAME as well as by inventory.
  const inventory = keyInventory(c.frozen);
  for (const k of NEVER_STORED_KEYS) {
    assert.ok(!inventory.includes(k), `${k} must not survive the freeze`);
  }
  assert.ok(!inventory.includes('verbatimSections'), 'decision 50, by name');
  // Every key in the inventory passes the denylist — the two checks agree.
  assert.deepEqual(inventory.filter(isIdentifyingKey), []);
  await db.close();
});

test('§17.9 decision 118: a document with no extract at the current version is REFUSED, by version', async () => {
  const db = await extractDb();
  // The commonest real case: extracted under /1, never re-extracted under /2 (560 of 843 rows).
  await seedExtract(db, { version: 'doc-extract/1' });
  await assert.rejects(() => frozenFrom(db), (e: LabError) => {
    assert.equal(e.code, 'SOURCE_UNAVAILABLE');
    assert.match(e.message, /no stored extract at doc-extract\/2/);
    assert.match(e.message, /found: doc-extract\/1/, 'the version it DOES hold is named');
    assert.match(e.message, /never re-reads the discharge PDF/, 'decision 102, in the refusal');
    return true;
  });

  // A document with no row at all says so, rather than naming a version that does not exist.
  await assert.rejects(() => frozenFrom(db, 'NEVER-SEEN'),
    (e: LabError) => e.code === 'SOURCE_UNAVAILABLE' && /no extract at any version/.test(e.message));
  await db.close();
});

test('§17.9: a store FAULT is refused as a fault, never as an absence', async () => {
  const db = await extractDb();
  await assert.rejects(
    () => freeze(db, DOC, { readExtract: (async () => ({ outcome: 'fetch_failed', error: 'connection reset by peer' })) as never }),
    (e: LabError) => e.code === 'SOURCE_UNAVAILABLE'
      && /unreachable rather than absent/.test(e.message) && /connection reset/.test(e.message));
  await assert.rejects(() => freezeIpdDischargeDocument('', {}),
    (e: LabError) => e.code === 'INVALID_INPUT');
  await db.close();
});

test('§17.9: the two db13 joins DEGRADE and the case still freezes, as production does', async () => {
  const db = await extractDb();
  await seedExtract(db);
  // ~8% of audited documents have no linked bill at all (`run.ts:176-178`), and `run.ts:181-183`
  // catches both joins. A refusal here would refuse documents production audits every day.
  const c = await freeze(db, DOC, {
    readExtract: storeRead(db),
    fetchHeader: (async () => { throw new Error('db13 timeout'); }) as never,
    fetchBilling: (async () => null) as never,
    fetchTotal: (async () => null) as never,
  });
  assert.equal(c.frozen.envelope.speciality, null);
  assert.equal(c.frozen.billing.netTotal, null);
  assert.deepEqual(c.frozen.billing.categories, []);
  assert.equal(c.source_versions.envelope_present, false);
  assert.equal(c.source_versions.billing_present, false);
  // And the extract, which IS the engine's input, still had to be there.
  assert.ok(c.frozen.extracted);
  await db.close();
});

// ═════════════════════════════════════════════════════════════════════════════════════
// DECISION 124 — the eight stages
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.9 decision 124: ipd_discharge declares the eight labels its call tree emits', () => {
  const declared = (ENGINE_STAGES.ipd_discharge ?? []).map((s) => s.name);
  assert.deepEqual(declared, [...IPD_DISCHARGE_STAGES]);
  assert.equal(declared.length, 8);
  // Every label exists in the call tree it is claimed from.
  const src = ['lib/doc-audit.ts', 'lib/pathway.ts']
    .map((f) => readFileSync(join(process.cwd(), f), 'utf8')).join('\n');
  for (const name of declared) {
    assert.ok(src.includes(`'${name}'`), `label '${name}' must exist in the call tree`);
  }
  // ⚠️ AND THE A3 DEFECT IS CLOSED. `doc_audit` shares the tree and was missing three of them,
  // so every doc_audit run met MODEL_UNSUPPORTED on its second leg.
  const docAudit = (ENGINE_STAGES.doc_audit ?? []).map((s) => s.name);
  for (const name of ['doc_audit_critique_llm', 'doc_audit_revise', 'pathway_skeleton']) {
    assert.ok(docAudit.includes(name), `decision 124: doc_audit must price '${name}'`);
  }
  assert.ok(SUPPORTED_ENGINES.includes('ipd_discharge'));
});

// ═════════════════════════════════════════════════════════════════════════════════════
// compute.ts — decision 117(a)
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.9 decision 117(a): compute.ts throws a NAMED error when the report has no value score', async () => {
  await assert.rejects(
    () => computeIpdDischargeAudit({
      extracted: EXTRACTED as never,
      meta: { documentId: 'px:x' },
      deps: { generate: async () => 'not json at all', retrieveHits: async () => [], enrichHits: async () => [] },
      opts: { trace: false },
    }),
    (e: IpdComputeError) => e.code === 'ANALYZE_NO_REPORT' && /no report with a value score/.test(e.message),
  );
});

test('§17.9 decision 118: the surrogates are px:-shaped, stable per case, and stripped from the row', () => {
  const a = surrogateFor('ipddoc:abc', 'documentId');
  assert.match(a, new RegExp(`^${PSEUDONYM_PREFIX}[0-9a-f]{24}$`));
  assert.equal(a, surrogateFor('ipddoc:abc', 'documentId'), 'stable for one case');
  assert.notEqual(a, surrogateFor('ipddoc:abc', 'ipUid'), 'and distinct per field');
  assert.notEqual(a, surrogateFor('ipddoc:def', 'documentId'), 'and per case');

  const row = { documentId: a, ipUid: 'px:y', memberId: 'px:z', traceId: '', careValueIndex: 71, band: 'B' };
  const stripped = stripRowIdentifiers(row);
  assert.deepEqual(Object.keys(stripped).sort(), ['band', 'careValueIndex']);
  for (const k of STRIPPED_ROW_KEYS) assert.ok(!(k in stripped), `${k} is stripped from the result`);
  assert.deepEqual(identifyingKeys(stripped), []);
});

// ═════════════════════════════════════════════════════════════════════════════════════
// ITEM 8 — through service dispatch (decision 109)
// ═════════════════════════════════════════════════════════════════════════════════════

const deps = (db: Db, principal: 'research' | 'operator' = 'operator') =>
  ({ db, principal, protocolVersion: 'test', sdkVersion: 'test' }) as never;

async function asIdentifyingOperator<T>(fn: () => Promise<T>): Promise<T> {
  const { IDENTIFYING_PRINCIPALS_ENV } = await import('../contracts');
  const before = process.env[IDENTIFYING_PRINCIPALS_ENV];
  const salt = process.env.LAB_V2_MEMBER_SALT;
  process.env[IDENTIFYING_PRINCIPALS_ENV] = 'operator';
  process.env.LAB_V2_MEMBER_SALT = salt ?? SALT;
  try { return await fn(); } finally {
    if (before === undefined) delete process.env[IDENTIFYING_PRINCIPALS_ENV];
    else process.env[IDENTIFYING_PRINCIPALS_ENV] = before;
    if (salt === undefined) delete process.env.LAB_V2_MEMBER_SALT;
    else process.env.LAB_V2_MEMBER_SALT = salt;
  }
}

test('§17.9 decision 109: engine_describe ipd_discharge is supported, with eight stages', async () => {
  const db = await freshDb();
  const out = await callTool(deps(db), 'engine_describe', { engine: 'ipd_discharge' }) as {
    supported: boolean; identifying_input: boolean; stages: { name: string; conditional: boolean }[];
    frozen_inputs: string[]; replay_exactness_available: string[]; engine_version: string | null;
    request_fields: { name: string; identifying: boolean }[];
  };
  assert.equal(out.supported, true);
  assert.equal(out.identifying_input, true, 'decision 118: keyed by documentId');
  assert.deepEqual(out.stages.map((s) => s.name), [...IPD_DISCHARGE_STAGES]);
  // ⚠️ RULE 1a, §17.10 DECISION 134 / item 6 — `steps` and `retrieval` join the frozen inputs.
  assert.deepEqual(out.frozen_inputs,
    ['extracted', 'envelope', 'billing', 'extraction_version', 'steps', 'retrieval']);
  // DECISION 125 — the three retrievals are live, so no frozen replay is offered.
  assert.deepEqual(out.replay_exactness_available, ['mutable_source']);
  assert.equal(out.engine_version, IPD_ENGINE_VERSION);
  // The REQUEST_FIELDS entry that already existed (`sources/requests.ts:217-222`) needed no change.
  assert.ok(out.request_fields.some((f) => f.name === 'documentId' && f.identifying));
  await db.close();
});

test('§17.9 decision 109: dataset_create ipd_discharge is REACHABLE from the operator key', async () => {
  const db = await freshDb();
  await asIdentifyingOperator(async () => {
    /**
     * ⚠️ RULE 1a, §17.11 DECISION 144 — THE CALL NO LONGER REFUSES; IT QUEUES.
     *
     * This test asserted a `SOURCE_UNAVAILABLE`, because until D3 the freeze ran INSIDE the tool
     * call and this sandbox has no production database. Decision 144 makes `dataset_create
     * ipd_discharge` submit a run and return `{freeze_run_id, state: 'freezing'}` before anything
     * is read, so the refusal moved to the item and the call now succeeds.
     *
     * ⚠️ WHAT THE TEST WAS PROTECTING IS KEPT AND IS NOW PROVED MORE DIRECTLY. Its subject is
     * REACHABILITY — that the call is neither the unsupported-engine refusal decision 34 used to
     * give nor the decision 105 data-scope gate. A run id is a stronger answer to that than a
     * SOURCE_UNAVAILABLE was, and decision 99's check on the error path becomes the same check on
     * the success path: the documentId appears nowhere in what comes back, and `items.case_key` is
     * a content hash rather than the key.
     *
     * This is not a mechanical pin, and the round report says so rather than filing it as one.
     */
    const out = await callTool(deps(db), 'dataset_create', {
      engine: 'ipd_discharge', body: { documentId: DOC }, idempotency_key: 'd2b-1',
    }) as { freeze_run_id: string; state: string; requested: number };
    assert.equal(out.state, 'freezing');
    assert.equal(out.requested, 1);
    assert.ok(out.freeze_run_id, 'the run exists before any production read');
    assert.ok(!JSON.stringify(out).includes(DOC), 'the identifier is not echoed back');
    const items = await itemsOf(db, out.freeze_run_id);
    assert.equal(items.length, 1);
    assert.ok(!items[0].case_key.includes(DOC), 'items.case_key is a content hash, never the key');
  });
  // The cohort form, and the named INVALID_INPUT when neither shape is supplied.
  await asIdentifyingOperator(async () => {
    await assert.rejects(
      () => callTool(deps(db), 'dataset_create', { engine: 'ipd_discharge', idempotency_key: 'd2b-2' }),
      (e: LabError) => e.code === 'INVALID_INPUT' && /documentId/.test(e.message));
    // RULE 1a, §17.11 decision 144, as above: the cohort form queues one item per key rather than
    // freezing them in the call. Two keys, two items, and neither key is a case_key.
    const many = await callTool(deps(db), 'dataset_create', {
      engine: 'ipd_discharge', cohort: { case_keys: [DOC, 'DOCX-0002'] }, idempotency_key: 'd2b-3',
    }) as { freeze_run_id: string; state: string; requested: number };
    assert.equal(many.state, 'freezing', 'the cohort form reaches the freeze queue too');
    assert.equal(many.requested, 2);
    const manyItems = await itemsOf(db, many.freeze_run_id);
    assert.equal(manyItems.length, 2);
    for (const it of manyItems) {
      assert.ok(!it.case_key.includes(DOC) && !it.case_key.includes('DOCX-0002'),
        'no document id reaches items.case_key');
    }
  });
  await db.close();
});

test('§17.9 decision 105: the research key may not send a documentId at all', async () => {
  const db = await freshDb();
  await assert.rejects(
    () => callTool(deps(db, 'research'), 'dataset_create', {
      engine: 'ipd_discharge', body: { documentId: DOC }, idempotency_key: 'd2b-4',
    }),
    (e: LabError) => {
      assert.equal(e.code, 'CLASSIFICATION_REQUIRED');
      assert.ok(!e.message.includes(DOC), 'the refusal names the principal, never the identifier');
      return true;
    });
  await db.close();
});

/**
 * ⚠️ WHAT THIS TEST CAN AND CANNOT REACH, SAID PLAINLY. `sliceDDataset` calls
 * `freezeIpdDischargeDocument(key)` with NO deps (`service.ts`), and this round's file contract
 * does not permit adding an injection seam to `service.ts`. So the freeze runs on the REAL case
 * above and the ASSEMBLY — the decision 99 re-walk, the schema parse, `putObject`, `member_key`
 * beside `frozen` — is exercised here on the body a real freeze produced, which is the half
 * decision 109 exists to stop anyone skipping.
 */
test('§17.9 decision 109: the stored dataset carries member_key beside frozen, and no denylist key', async () => {
  const extract = await extractDb();
  await seedExtract(extract);
  const c = await frozenFrom(extract);
  await extract.close();

  const db = await freshDb();
  const { datasetBodySchema } = await import('../contracts');
  const body = datasetBodySchema.parse({
    engine: 'ipd_discharge',
    cases: [{ case_key: c.case_key, member_key: c.member_key, frozen: c.frozen as unknown as Record<string, unknown> }],
    snapshot_policy: 'episode_at_creation',
    exclusions: [],
    classification: 'deidentified',
    source_versions: { frozen_at: new Date().toISOString(), origin: 'discharge_extracted_cases + db13', cases: 1 },
    replay_exactness: 'frozen',
  });
  const { object } = await putObject(db, 'operator', 'dataset', body, 'deidentified', 'd2b-stored');
  const stored = (await getObject(db, object.id))!.body as { cases: { member_key: string; frozen: unknown }[] };
  assert.deepEqual(identifyingKeys(stored), [], 'the STORED object carries no denylist key');
  assert.match(stored.cases[0].member_key, /^[0-9a-f]{16,}$/);
  assert.ok(!('member_key' in (stored.cases[0].frozen as Record<string, unknown>)));
  assert.ok(!JSON.stringify(stored).includes(HEADER.uhid));
  assert.ok(!JSON.stringify(stored).includes(DOC));
  await db.close();
});

// ═════════════════════════════════════════════════════════════════════════════════════
// The run — through tick, with all eight labels priced
// ═════════════════════════════════════════════════════════════════════════════════════

/** A completion the analyze chain's parser accepts, for whichever stage asked. */
const ANALYSIS = JSON.stringify({
  findings: [
    { subject: 'Repeat CRP on day 3', verdict: 'low-value', domain: 'efficiency', confidence: 'moderate',
      rationale: 'No documented change in management followed the repeat.', citation_ids: [], order: 'CRP' },
    { subject: 'IV to oral switch at 72 h', verdict: 'appropriate', domain: 'appropriateness', confidence: 'high',
      rationale: 'Consistent with the cited guidance.', citation_ids: [] },
  ],
  idealisedSummary: 'Antibiotic stewardship with an early IV-to-oral switch.',
  diff: ['No documented review of the repeat inflammatory marker.'],
  suggestions: ['Record the indication for each repeat inflammatory marker.'],
});

const armStages = (labels: readonly string[]) => Object.fromEntries(
  labels.map((s) => [s, { provider: 'ollama', model: 'local-model', max_cost_microusd: 20_000 }]),
);

async function runFrozen(db: Db, frozen: Record<string, unknown>, labels: readonly string[], key: string) {
  const budget = await ensureBudget(db, 'research', 'default', 50_000_000);
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, key, 'armhash', 86_400_000, [
    {
      case_key: 'ipddoc:d2b', arm_hash: 'armhash', repetition: 1,
      payload: { engine: 'ipd_discharge', frozen, arm: { stages: armStages(labels) }, budget_id: budget.id },
    },
  ]);
  await tick({
    db,
    transport: (async () => ({
      completion: { choices: [{ message: { content: ANALYSIS } }] },
      text: ANALYSIS,
      served: { provider: 'ollama', model: 'local-model' },
      usage: { input_tokens: 900, output_tokens: 300 },
    })) as never,
    // The retrieve edge is LIVE (decision 125) and there is no corpus here, so it is injected.
    adapters: { ipd_discharge: makeIpdDischargeAdapter({ retrieve: (async () => ({ hits: [], expandedQuery: '', meta: {} })) as never }) },
  });
  const [item] = await itemsOf(db, run.id);
  return { item, budget };
}

test('§17.9 items 4 and 8: a run with all eight labels priced is assessed, with the headline and the legs', async () => {
  const extract = await extractDb();
  await seedExtract(extract);
  const c = await frozenFrom(extract);
  await extract.close();

  const db = await freshDb();
  const { item } = await runFrozen(db, c.frozen as unknown as Record<string, unknown>, IPD_DISCHARGE_STAGES, 'd2b-run');
  assert.equal(item.state, 'succeeded', `the item failed: ${JSON.stringify(item.error)}`);
  const summary = (item.result as { summary: Record<string, unknown> }).summary;

  assert.equal(summary.engine, 'ipd_discharge');
  assert.equal(summary.engine_version, IPD_ENGINE_VERSION);
  assert.equal(typeof summary.care_value_index, 'number');
  assert.ok((CARE_VALUE_BANDS as readonly string[]).includes(String(summary.band)), `band ${summary.band}`);
  assert.equal(item.assessment_status, 'assessed');

  // ⚠️ DECISION 123 — WHAT ACTUALLY FIRED, per label, and the three env values that decided it.
  const legs = summary.legs as Record<string, number>;
  assert.ok(legs.doc_audit_analyze >= 1, 'the analyze leg always fires');
  for (const label of Object.keys(legs)) {
    assert.ok((IPD_DISCHARGE_STAGES as readonly string[]).includes(label), `'${label}' is a declared stage`);
  }
  assert.deepEqual(Object.keys(summary.flags as object).sort(),
    ['DOC_AUDIT_AUDIT', 'DOC_AUDIT_CITE_GATE', 'PROGNOSIS_AUDIT']);
  console.log('D2b LABELS SEEN', JSON.stringify(legs));

  // DECISION 125 — retrieval is live and every read is recorded.
  assert.ok(Number(summary.retrieval_reads) >= 1, 'the pooled retrieval at least');

  // ⚠️ DECISION 118 — NO IDENTIFIER IN THE RESULT, including inside the row the adapter returns.
  const artifactId = (item.result as { artifact_id: string }).artifact_id;
  const row = (await getObject(db, artifactId))!.body as Record<string, unknown>;
  for (const k of STRIPPED_ROW_KEYS) assert.ok(!(k in row), `${k} must not be on the stored row`);
  assert.deepEqual(identifyingKeys(row), []);
  assert.deepEqual(identifyingKeys(summary), []);
  assert.ok(!JSON.stringify(item.result).includes(PSEUDONYM_PREFIX), 'not even the surrogates');
  // The headline the adapter reports IS the row's, `assemble.ts:73`'s arithmetic and no other.
  assert.equal(summary.care_value_index, row.careValueIndex);
  assert.equal(summary.band, row.band);

  // §115/§121 — real calls were made, so the gateway's own verdict stands.
  assert.equal(item.attribution_status, 'verified');
  await db.close();
});

test('§17.9 §35a: an arm that prices seven of the eight labels FAILS, naming the label', async () => {
  const extract = await extractDb();
  await seedExtract(extract);
  const c = await frozenFrom(extract);
  await extract.close();

  const db = await freshDb();
  // Everything but the one leg that always fires.
  const short = IPD_DISCHARGE_STAGES.filter((s) => s !== 'doc_audit_analyze');
  const { item } = await runFrozen(db, c.frozen as unknown as Record<string, unknown>, short, 'd2b-unpriced');

  /**
   * ⚠️ AND THIS IS WHY THE ADAPTER HOLDS THE ERROR. `analyzeCase` catches EVERYTHING — its outer
   * catch (`:718`), the audit loop (`:610`), the cite gate (`:625`), enrichment (`:581`) and
   * `verifyCitation` (`:316`) — so without the hold this item would have landed as an ordinary
   * `report: null` and an operator would have had no way to learn WHICH label was unpriced.
   */
  assert.equal(item.state, 'failed');
  assert.equal((item.error as { code?: string }).code, 'MODEL_UNSUPPORTED');
  assert.match(String((item.error as { message?: string }).message), /doc_audit_analyze/, 'the label is named');
  assert.equal((item.error as { category?: string }).category, 'model');
  await db.close();
});

// ═════════════════════════════════════════════════════════════════════════════════════
// ITEM 6 — run_diff carries the headline
// ═════════════════════════════════════════════════════════════════════════════════════

async function seedSummaries(db: Db, budgetId: string, key: string, summaries: Record<string, unknown>[]) {
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budgetId, key, 'h', 86_400_000,
    summaries.map((_s, i) => ({ case_key: `c${i + 1}`, arm_hash: 'armA', repetition: 1, payload: {} })));
  const items = await itemsOf(db, run.id);
  for (const [i, item] of items.entries()) {
    await db.query(
      `UPDATE lab_v2.items SET state = 'succeeded', execution_status = 'succeeded',
         assessment_status = 'assessed', attribution_status = 'verified', result = $2::jsonb WHERE id = $1`,
      [item.id, JSON.stringify({ result_hash: `h${i}`, summary: summaries[i] })]);
  }
  return run;
}

test('§17.9 item 6: run_diff carries care_value_index, and null for an engine without one', async () => {
  const db = await freshDb();
  const budget = await ensureBudget(db, 'research', 'default', 1_000_000);
  const a = await seedSummaries(db, budget.id, 'd2b-diff-a', [
    { engine: 'ipd_discharge', care_value_index: 68, band: 'C' },
    { engine: 'opd_note_audit', note_quality_index: 70, band: 'C', finding_subjects: [] },
  ]);
  const b = await seedSummaries(db, budget.id, 'd2b-diff-b', [
    { engine: 'ipd_discharge', care_value_index: 74, band: 'B' },
    { engine: 'opd_note_audit', note_quality_index: 74, band: 'B', finding_subjects: [] },
  ]);
  const out = await callTool(deps(db, 'operator'), 'run_diff', { run_a: a.id, run_b: b.id }) as {
    cases: {
      case_key: string; care_value_index_before: number | null; care_value_index_after: number | null;
      band_before: string | null; band_after: string | null; note_quality_index_before: number | null;
    }[];
  };
  const by = Object.fromEntries(out.cases.map((c) => [c.case_key, c]));
  // ⚠️ THE QUESTION run_diff COULD NOT ANSWER BEFORE THIS ROUND: the headline moved, and by how much.
  assert.equal(by.c1.care_value_index_before, 68);
  assert.equal(by.c1.care_value_index_after, 74);
  assert.equal(by.c1.band_before, 'C');
  assert.equal(by.c1.band_after, 'B');
  assert.equal(by.c1.note_quality_index_before, null, 'ipd_discharge has no note-quality index');
  // ⚠️ AND AN OPD RUN IS NULL, WHICH IS NOT "UNCHANGED". It has no care-value index at all.
  assert.equal(by.c2.care_value_index_before, null);
  assert.equal(by.c2.care_value_index_after, null);
  assert.equal(by.c2.note_quality_index_before, 70);
  await db.close();
});

test('§17.9: the frozen case hashes stably, so two freezes of one document are one dataset', async () => {
  const db = await extractDb();
  await seedExtract(db);
  const a = await frozenFrom(db);
  const b = await frozenFrom(db);
  assert.equal(a.case_key, b.case_key, 'the case key is a salted hash of the document id');
  assert.equal(hash(a.frozen), hash(b.frozen), 'and the body is deterministic');
  await db.close();
});
