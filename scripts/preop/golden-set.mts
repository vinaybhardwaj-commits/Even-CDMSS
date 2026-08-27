/**
 * scripts/preop/golden-set.mts — B7's measurement harness.
 *
 *   npx tsx --env-file=.env.local scripts/preop/golden-set.mts [--limit N] [--live-extract]
 *
 * READ-ONLY against production: it never opens lib/preop/store.ts, never writes a finding,
 * a version, an extraction or a narrative. Everything it measures, it measures by running
 * the SAME functions the sweep runs — fetchPacCoveredEpisodes, assembleEpisode,
 * extractOne, composeSnapshot — over an in-memory extraction cache.
 *
 * WHAT IT PRODUCES, in the order the validation pack needs it:
 *
 *   1 · board tier counts, extraction OFF vs ON;
 *   2 · THE SCORE-EQUALITY PROOF — for every case, the OFF and ON readings side by side,
 *       and for every difference, the input status changes that account for it. A score
 *       that moved without an input moving would appear here as an unexplained row, and
 *       there is no such row by construction;
 *   3 · ANTI-FLAP — three passes over the same text. Pass 1 extracts; pass 2 runs with
 *       pass 1's cache and must make ZERO calls and land on identical fingerprints; pass 3
 *       throws the cache away and re-extracts from scratch, which measures whether the
 *       model agrees with itself when nothing forces it to;
 *   4 · the extraction hit/miss table — which UNKNOWNs the rail resolved, by input;
 *   5 · ten hand-checkable cases with every extracted input's verbatim span, for V.
 *
 * The narrative arm is NOT here: it runs on Bedrock, which authenticates through Vercel's
 * OIDC and cannot be reached from a laptop. It is measured on a Preview deployment through
 * the worker's `?rails=narrative` probe, which is a dry run by construction.
 */
import { writeFileSync } from 'node:fs';
import {
  fetchCreatinine, fetchHospitalNames, fetchOpdIcd, fetchOpdNarrative, fetchPacCoveredEpisodes,
  fetchPacReports, type PacRow,
} from '../../lib/preop/db13.ts';
import { assembleEpisode, daysBetweenDays, istDay, pacForEpisode, type EpisodeSources } from '../../lib/preop/run.ts';
import { extractOne, preopExtractFields, preopExtractModel } from '../../lib/preop/extract.ts';
import { composeSnapshot, type PreopSnapshot } from '../../lib/preop-assemble-core.ts';
import { extractionObservations, aboveFloor, type PreopExtraction } from '../../lib/preop-extract-core.ts';
import { PREOP_ENGINE_VERSION } from '../../lib/preop/store.ts';

const argv = process.argv.slice(2);
const arg = (k: string, d: number) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : d;
};
const LIMIT = arg('--limit', 300);
const OUT = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'preop-golden-set.json';

const now = new Date();
const todayIst = istDay(now);
const computedAt = now.toISOString();

console.log(`golden set · engine ${PREOP_ENGINE_VERSION} · extraction model ${preopExtractModel() ?? 'NONE CONFIGURED'} · ${todayIst} IST`);

// ── the population ──────────────────────────────────────────────────────────────

const eps = await fetchPacCoveredEpisodes(LIMIT);
if (eps.error) throw new Error(eps.error);
const episodes = eps.rows;
const uids = episodes.map((e) => e.individualUid);
const uhids = episodes.map((e) => e.uhid).filter((u): u is string => !!u);
console.log(`episodes (PAC-covered cohort): ${episodes.length} · patients ${new Set(uids).size}`);

const [creat, icd, pacs, hospitals, narr] = await Promise.all([
  fetchCreatinine(uids), fetchOpdIcd(uids), fetchPacReports(uhids), fetchHospitalNames(), fetchOpdNarrative(uids),
]);
for (const f of [creat, icd, pacs, hospitals, narr]) if (f.error) console.warn(`DEGRADED: ${f.error}`);

const byUid = <T extends { individualUid: string }>(rows: T[]) => {
  const m = new Map<string, T[]>();
  for (const r of rows) { const l = m.get(r.individualUid) ?? []; l.push(r); m.set(r.individualUid, l); }
  return m;
};
const creatBy = byUid(creat.rows), icdBy = byUid(icd.rows), narrBy = byUid(narr.rows);
const hospitalName = new Map(hospitals.rows.map((h) => [h.uid, h.name]));
const pacBy = new Map<string, PacRow[]>();
for (const r of pacs.rows) { const l = pacBy.get(r.uhid) ?? []; l.push(r); pacBy.set(r.uhid, l); }

// ── one episode, both arms ──────────────────────────────────────────────────────

interface Case {
  key: string;
  procedure: string | null;
  age: number | null;
  sex: string | null;
  surgeryDate: string | null;
  pacOnFile: boolean;
  fieldChars: number;
  off: PreopSnapshot;
  on: PreopSnapshot;
  extraction: PreopExtraction | null;
  outcome: string;
  called: boolean;
}

function sourcesFor(ep: (typeof episodes)[number]): EpisodeSources {
  return {
    creatinine: (creatBy.get(ep.individualUid) ?? []).map((r) => ({ value: r.value, unit: r.unit, at: r.at })),
    icd: (icdBy.get(ep.individualUid) ?? []).map((r) => ({ codes: r.codes, at: r.at, ref: r.ref })),
    pac: pacForEpisode(ep.uhid ? (pacBy.get(ep.uhid) ?? []) : [], ep.surgeryDate),
    hospitalName: ep.hospitalUid ? (hospitalName.get(ep.hospitalUid) ?? null) : null,
  };
}

function compose(ep: (typeof episodes)[number], a: ReturnType<typeof assembleEpisode>, extraction: PreopExtraction | null, on: boolean): PreopSnapshot {
  return composeSnapshot({
    engineVersion: PREOP_ENGINE_VERSION,
    episode: a.facts,
    observations: [...a.observations, ...(on ? extractionObservations(extraction) : [])],
    pac: a.pac,
    daysToSurgery: daysBetweenDays(todayIst, ep.surgeryDate),
    reviewed: false,
    includeExtracted: on,
    bookingEnumerated: a.bookingEnumerated,
    notClosedBy: a.notClosedBy,
    bookingOnly: a.bookingOnly,
    computedAt,
  });
}

/** One pass over the whole set. `cache` is threaded in so a second pass can prove reuse. */
async function pass(label: string, cache: Map<string, PreopExtraction | null>): Promise<Case[]> {
  const out: Case[] = [];
  let called = 0, failed = 0;
  const t0 = Date.now();
  for (const ep of episodes) {
    const a = assembleEpisode(ep, sourcesFor(ep));
    const fields = preopExtractFields(a.parsedPac, (narrBy.get(ep.individualUid) ?? []).map((r) => r.text).join('\n') || null);
    const r = await extractOne({ episodeKey: ep.docId, fields, stored: cache.get(ep.docId) ?? null, now });
    cache.set(ep.docId, r.record);
    if (r.called) called++;
    if (r.outcome === 'failed') { failed++; console.warn(`  ${ep.docId}: ${r.error}`); }
    out.push({
      key: ep.docId, procedure: ep.procedure, age: ep.age, sex: ep.sex, surgeryDate: ep.surgeryDate,
      pacOnFile: a.pac.onFile,
      fieldChars: Object.values(fields).join('').length,
      off: compose(ep, a, r.record, false),
      on: compose(ep, a, r.record, true),
      extraction: r.record, outcome: r.outcome, called: r.called,
    });
    if (out.length % 25 === 0) console.log(`  ${label}: ${out.length}/${episodes.length} (${called} calls)`);
  }
  console.log(`${label}: ${out.length} cases · ${called} model calls · ${failed} failed · ${Math.round((Date.now() - t0) / 1000)}s`);
  return out;
}

const cache = new Map<string, PreopExtraction | null>();
const p1 = await pass('pass 1 (cold)', cache);
const p2 = await pass('pass 2 (warm — must make ZERO calls)', cache);
const p3 = await pass('pass 3 (cold again — does the model agree with itself?)', new Map());

// ── 1 · tier counts ─────────────────────────────────────────────────────────────

const tally = (cs: Case[], arm: 'off' | 'on') => {
  const t: Record<string, number> = {};
  for (const c of cs) t[c[arm].tier.tier] = (t[c[arm].tier.tier] ?? 0) + 1;
  return t;
};

// ── 2 · the score-equality proof ────────────────────────────────────────────────

const band = (s: PreopSnapshot, k: 'rcri' | 'mfi5' | 'charlson') => `${s[k].lo}-${s[k].hi}`;
const moved = p1
  .map((c) => {
    const changes = c.off.inputs
      .map((i, n) => ({ id: i.inputId, from: i.status, to: c.on.inputs[n].status, src: c.on.inputs[n].source }))
      .filter((x) => x.from !== x.to);
    const scores = (['rcri', 'mfi5', 'charlson'] as const).filter((k) => band(c.off, k) !== band(c.on, k));
    // A provenance move is not a score move — but it IS a fingerprint move, and a
    // fingerprint move mints a version. Both are counted, separately, because "flipping
    // the flag changes no score" and "flipping the flag writes nothing" are two different
    // claims and only the first one is a D4 requirement.
    const provenance = c.off.inputs
      .map((i, n) => ({ id: i.inputId, from: i.source, to: c.on.inputs[n].source }))
      .filter((x) => x.from !== x.to);
    return {
      key: c.key, changes, scores, provenance,
      fingerprintMoved: c.off.fingerprint !== c.on.fingerprint,
      tierOff: c.off.tier.tier, tierOn: c.on.tier.tier,
    };
  })
  .filter((m) => m.changes.length || m.scores.length || m.provenance.length || m.tierOff !== m.tierOn);

const unexplained = moved.filter((m) => (m.scores.length || m.tierOff !== m.tierOn) && !m.changes.length);

// ── 3 · anti-flap ───────────────────────────────────────────────────────────────

const warmCalls = p2.filter((c) => c.called).length;
const warmFingerprintDrift = p1.filter((c, i) => c.on.fingerprint !== p2[i].on.fingerprint).map((c) => c.key);
const selfDisagreement = p1
  .map((c, i) => {
    const a = new Map((c.extraction?.inputs ?? []).map((x) => [x.inputId, x.status]));
    const b = new Map((p3[i].extraction?.inputs ?? []).map((x) => [x.inputId, x.status]));
    const ids = [...new Set([...a.keys(), ...b.keys()])].filter((id) => a.get(id) !== b.get(id));
    return { key: c.key, ids, p1: [...a.entries()], p3: [...b.entries()] };
  })
  .filter((x) => x.ids.length);

// ── 4 · the hit/miss table ──────────────────────────────────────────────────────

const resolvedByInput: Record<string, number> = {};
for (const m of moved) for (const ch of m.changes) if (ch.from === 'unknown') resolvedByInput[ch.id] = (resolvedByInput[ch.id] ?? 0) + 1;
const overturnedByInput: Record<string, number> = {};
for (const c of p1) for (const i of c.on.inputs) if (i.overturnedFormNegative) overturnedByInput[i.inputId] = (overturnedByInput[i.inputId] ?? 0) + 1;

const gates: Record<string, number> = {};
for (const c of p1) for (const r of c.extraction?.rejected ?? []) gates[r.reason] = (gates[r.reason] ?? 0) + 1;
const polarity = p1.flatMap((c) => (c.extraction?.polarityMarked ?? []).map((x) => ({ key: c.key, ...x })));

const withText = p1.filter((c) => c.fieldChars > 0);
const withReading = p1.filter((c) => (c.extraction?.inputs.length ?? 0) > 0);
const withAboveFloor = p1.filter((c) => aboveFloor(c.extraction) > 0);

// ── 5 · the hand-check sample ───────────────────────────────────────────────────

const sample = [...p1]
  .filter((c) => (c.extraction?.inputs.length ?? 0) > 0)
  .sort((a, b) => (b.extraction!.inputs.length - a.extraction!.inputs.length))
  .slice(0, 10)
  .map((c) => ({
    key: c.key,
    who: `${c.age ?? '?'} ${c.sex ?? '?'}`,
    procedure: c.procedure,
    surgeryDate: c.surgeryDate,
    tier: { off: c.off.tier.tier, on: c.on.tier.tier },
    rcri: { off: band(c.off, 'rcri'), on: band(c.on, 'rcri') },
    mfi5: { off: band(c.off, 'mfi5'), on: band(c.on, 'mfi5') },
    charlson: { off: band(c.off, 'charlson'), on: band(c.on, 'charlson') },
    model: c.extraction?.model ?? null,
    provider: c.extraction?.provider ?? null,
    reads: (c.extraction?.inputs ?? []).map((i) => ({
      input: i.inputId, status: i.status, confidence: i.confidence, field: i.field,
      span: i.rawText, polaritySuspect: i.polaritySuspect ?? false,
      scored: c.on.inputs.find((x) => x.inputId === i.inputId)?.source === 'EXTRACTED',
    })),
    rejected: c.extraction?.rejected ?? [],
  }));

const report = {
  generatedAt: computedAt,
  engine: PREOP_ENGINE_VERSION,
  extractionModel: preopExtractModel() ?? null,
  population: { episodes: episodes.length, patients: new Set(uids).size, pacOnFile: p1.filter((c) => c.pacOnFile).length },
  tiers: { off: tally(p1, 'off'), on: tally(p1, 'on') },
  equality: {
    casesWithAnyChange: moved.length,
    casesWithScoreChange: moved.filter((m) => m.scores.length).length,
    casesWithTierChange: moved.filter((m) => m.tierOff !== m.tierOn).length,
    casesWithProvenanceOnlyChange: moved.filter((m) => m.provenance.length && !m.changes.length).length,
    casesWithFingerprintChange: moved.filter((m) => m.fingerprintMoved).length,
    unexplainedScoreChanges: unexplained,
    moved,
  },
  antiFlap: {
    coldCalls: p1.filter((c) => c.called).length,
    warmCalls,
    warmFingerprintDrift,
    selfDisagreement,
  },
  coverage: {
    casesWithExtractableText: withText.length,
    casesWithAnyReading: withReading.length,
    casesWithAnAboveFloorReading: withAboveFloor.length,
    resolvedUnknownsByInput: resolvedByInput,
    overturnedFormNegativesByInput: overturnedByInput,
    rejectionsByGate: gates,
    polarityMarked: polarity,
  },
  sample,
};

writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('\n' + JSON.stringify({ ...report, sample: `${sample.length} cases`, equality: { ...report.equality, moved: `${moved.length} rows` } }, null, 2).slice(0, 4000));
console.log(`\nwrote ${OUT}`);
