import Link from 'next/link';
import type { ReactNode } from 'react';
import { sql } from '@/lib/db';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { fetchDoctorNames, fetchOpdNoteByUid } from '@/lib/metabase';
import { rowToOpdCase, type DeidOpdCase } from '@/lib/opd-ingest-core';
import { enrichOpdMeds } from '@/lib/formulary';
import { type OpdDomain, documentationAdequacyFlag } from '@/lib/opd-note-score-core';
import { OPD_ENGINE_VERSION } from '@/lib/opd-note-audit-core';
import { anchorFindings, anchorsByTarget, type NoteAnchor } from '@/lib/opd-case-anchor-core';
import { CitationChips, SourcesPanel } from '@/components/right-care/kit';
import type { Source } from '@/lib/citations-core';
import FeedbackPanel, { type FeedbackEntry } from './feedback-panel';
import { FindingTriage, ReviewerBar } from './finding-triage';
import { MissedFindingCapture, type MissedEntry } from './missed-finding';
import { EscalateButton } from './escalate-button';
import {
  bandColor, scoreColor, parseJson, doctorLabel, fmtIstTime, PDQI9_LABEL, PDQI9_HELP,
} from '@/lib/opd-audit-ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'OPD case audit · Admin' };

const APP = process.env.APP_SOURCE || 'standalone';
const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const n = (v: unknown): number => Number(v ?? 0);

const VERDICT_COLOR: Record<string, string> = {
  'low-value': '#dc2626', 'context-dependent': '#d97706', 'high-value': '#16a34a', uncertain: '#78715f',
};

type Finding = { subject: string; verdict: string; confidence: number; domain: string; rationale: string; evidence?: string[]; estimates?: string[]; source?: string; citation_ids?: number[]; finding_ref?: string; signal_type?: string };
type Pdqi = { attr: string; label?: string; value: number };
type Sugg = { priority: number; text: string };

const DOMAINS: { key: OpdDomain; col: string; label: string }[] = [
  { key: 'documentation', col: 'score_documentation', label: 'Documentation' },
  { key: 'note_quality', col: 'score_note_quality', label: 'Note quality' },
  { key: 'appropriateness', col: 'score_appropriateness', label: 'Appropriateness' },
  { key: 'prescribing_safety', col: 'score_prescribing_safety', label: 'Prescribing & safety' },
  { key: 'patient_centred', col: 'score_patient_centred', label: 'Continuity' },
];
const DOMAIN_LABEL: Record<string, string> = Object.fromEntries(DOMAINS.map((d) => [d.key, d.label]));

// PRD §9.5 — assemble the portable "Escalate to Gemini" package. Input `note` is already
// de-identified (DeidOpdCase), so the string carries no PHI. The consumer is the care manager's
// own Gemini (then Claude + this repo) — free-form, no structured import.
function buildEscalationPackage({ uid, doctor, band, index, note, findings, scores, engineVersion }: {
  uid: string; doctor: string; band: string; index: number;
  note: DeidOpdCase | null; findings: Finding[]; scores: Record<OpdDomain, number>; engineVersion: string;
}): string {
  const L: string[] = [];
  L.push(`# OPD note — escalation for independent re-audit`);
  L.push(``);
  L.push(`- Encounter (de-identified): \`${uid}\``);
  L.push(`- Reviewing clinician: ${doctor}`);
  L.push(`- CDMSS grade: ${index} · Band ${band}`);
  L.push(`- Engine: \`${engineVersion}\``);
  L.push(``);
  L.push(`## The note (de-identified — exactly what the engine read)`);
  if (!note) {
    L.push(`_Source note unavailable at export time._`);
  } else {
    const line = (label: string, val: string) => L.push(`- **${label}:** ${val || '(none)'}`);
    line('Presenting complaints / history', note.presentingComplaints.join(' · '));
    if (note.reasonForConsult) line('Reason for consult', note.reasonForConsult);
    line('Examination', note.examination.join(' · '));
    line('Diagnosis (ICD-10)', [note.diagnosisCodes.join(', '), note.impressions.join('; ') || note.impressionCodes.join(', ')].filter(Boolean).join(' · '));
    L.push(`- **Medications (${note.medications.length}):**`);
    for (const m of note.medications) {
      const dosing = [m.strength, m.dose, m.frequency, m.duration, m.route].filter(Boolean).join(' · ');
      const primary = m.resolvedGeneric || m.generic || m.brand || '(unnamed)';
      L.push(`  - ${primary}${dosing ? ` — ${dosing}` : ''}${m.instruction ? ` · ${m.instruction}` : ''}`);
    }
    line('Investigations ordered', note.investigations.join(' · '));
    line('Advice / plan', note.advice.join(' · '));
    line('Follow-up', note.followUpType ? `${note.followUpType}${note.followUpDateSet ? ' · date set' : ' · no date'}` : '(none)');
  }
  L.push(``);
  L.push(`## CDMSS domain scores`);
  for (const d of DOMAINS) L.push(`- ${d.label}: ${scores[d.key] ?? '—'}`);
  L.push(``);
  L.push(`## CDMSS findings (${findings.length})`);
  if (findings.length === 0) L.push(`_No findings fired._`);
  findings.forEach((f, i) => {
    L.push(`${i + 1}. **${f.subject}** — _${f.verdict}_ (${DOMAIN_LABEL[f.domain] || f.domain})`);
    if (f.rationale) L.push(`   - ${f.rationale}`);
  });
  L.push(``);
  L.push(`## Task for you (Gemini)`);
  L.push(`Independently re-audit the OPD note above as an experienced physician. For each of the five domains`);
  L.push(`(documentation, note quality, appropriateness, prescribing & safety, continuity):`);
  L.push(`1. State whether you agree with the CDMSS grade and each finding above; flag any you consider **false** or a **nitpick**.`);
  L.push(`2. List any clinically important issue the CDMSS audit **missed** (recall / false negatives).`);
  L.push(`3. Keep it advisory and note-scoped — this is a documentation-quality proxy, not a clinician scorecard.`);
  L.push(`Return your assessment as free text; it will be reconciled against the CDMSS audit out-of-band.`);
  L.push(``);
  return L.join('\n');
}

function LockedMsg() {
  return (
    <div>
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">OPD case audit</h1>
      <p className="mt-1.5 text-sm text-slate-500">Locked. <Link href="/admin/opd-audit" className="text-brand hover:underline">Unlock the OPD Audit surface</Link> first.</p>
    </div>
  );
}

// ── numbered anchor chips (note side) ──────────────────────────────────────────
const CHIP_CLS: Record<string, string> = {
  red: 'bg-red-50 text-red-700 ring-red-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  slate: 'bg-slate-100 text-slate-600 ring-slate-200',
};
function chipTone(f: Finding | undefined): string {
  if (!f) return 'slate';
  if (f.verdict === 'low-value') return 'red';
  if (f.verdict === 'context-dependent' || f.domain === 'prescribing_safety') return 'amber';
  return 'slate';
}
function Chips({ anchors, findings }: { anchors: NoteAnchor[] | undefined; findings: Finding[] }) {
  if (!anchors || anchors.length === 0) return null;
  return (
    <span className="inline-flex gap-1 align-middle">
      {anchors.map((a) => (
        <a key={a.num} id={`a${a.num}`} href={`#f${a.num}`}
          className={`inline-flex h-[16px] min-w-[16px] scroll-mt-24 items-center justify-center rounded-full px-1 text-[10px] font-semibold ring-1 target:ring-2 target:ring-brand ${CHIP_CLS[chipTone(findings[a.num - 1])]}`}
          title={findings[a.num - 1]?.subject || ''}>{a.num}</a>
      ))}
    </span>
  );
}

// ── the actual de-identified note (fetched live from db13 by uid) ──────────────
function NoteRow({ label, chips, children }: { label: string; chips?: ReactNode; children: ReactNode }) {
  return (
    <div className="border-t border-slate-50 px-4 py-2.5 first:border-t-0">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.06em] text-slate-400">{label}{chips}</div>
      <div className="mt-0.5 text-[12.5px] leading-relaxed text-slate-700">{children}</div>
    </div>
  );
}
const none = (s: string) => <span className="text-slate-400">{s}</span>;

function NotePanel({ note, pdfUrl, grouped, findings }: { note: DeidOpdCase | null; pdfUrl: string | null; grouped: Record<string, NoteAnchor[]>; findings: Finding[] }) {
  const pdfLink = pdfUrl ? <a href={pdfUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] font-medium text-brand hover:underline">↓ Actual PDF</a> : null;
  const chips = (key: string) => <Chips anchors={grouped[key]} findings={findings} />;
  if (!note) {
    return <div className="rounded-xl border border-slate-200 bg-white p-4 text-[12px] text-slate-400">Source note unavailable — it may have been edited or removed in db13 since the audit ran. {pdfLink}</div>;
  }
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/60 px-4 py-2">
        <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-slate-600">The note <span className="font-normal text-slate-400">· de-identified · what the engine read</span>{chips('note')}</span>
        {pdfLink}
      </div>
      <NoteRow label="Presenting complaints / history" chips={chips('complaints')}>{note.presentingComplaints.length ? note.presentingComplaints.join(' · ') : none('(none documented)')}</NoteRow>
      {note.reasonForConsult ? <NoteRow label="Reason for consult" chips={chips('reason')}>{note.reasonForConsult}</NoteRow> : null}
      <NoteRow label="Examination" chips={chips('examination')}>{note.examination.length ? note.examination.join(' · ') : none('(none recorded)')}</NoteRow>
      <NoteRow label="Diagnosis (ICD-10)" chips={chips('diagnosis')}>{note.diagnosisCodes.length ? note.diagnosisCodes.join(', ') : none('(none)')}{note.impressions.length ? ` · ${note.impressions.join('; ')}` : (note.impressionCodes.length ? ` · impression ${note.impressionCodes.join(', ')}` : '')}</NoteRow>
      <NoteRow label={`Medications (${note.medications.length})`} chips={chips('medications')}>
        {note.medications.length === 0 ? none('(none)') : (
          <ul className="space-y-1">
            {note.medications.map((m, i) => {
              const dosing = [m.strength, m.dose, m.frequency, m.duration, m.route].filter(Boolean).join(' · ');
              const primary = m.resolvedGeneric || m.generic || m.brand;
              const showBrand = m.brand && (m.resolvedGeneric || m.generic) && m.brand.toLowerCase() !== String(primary).toLowerCase();
              const tags: string[] = [];
              if (m.therapeuticClass) tags.push(m.therapeuticClass);
              if (m.schedule && m.schedule !== '—') tags.push(`Sch ${m.schedule}`);
              if (m.formularyMatch === 'brand-prefix') tags.push('≈approx');
              if (m.nonFormulary === 'nutraceutical-cosmetic') tags.push('nutraceutical/cosmetic');
              else if (m.nonFormulary === 'non-formulary') tags.push('off-formulary');
              return (
                <li key={i}>
                  <Chips anchors={grouped[`medications:${i}`]} findings={findings} />{grouped[`medications:${i}`] ? ' ' : ''}
                  <span className="font-medium text-slate-800">{primary}</span>
                  {showBrand ? <span className="text-slate-400"> ({m.brand})</span> : null}
                  {m.highAlert ? <span className="ml-1 rounded bg-red-50 px-1 text-[9px] font-medium text-red-600">HIGH-ALERT</span> : null}
                  {dosing ? <span className="text-slate-500"> — {dosing}</span> : <span className="text-amber-600"> — dosing incomplete</span>}
                  {m.instruction ? <span className="text-slate-400"> · {m.instruction}</span> : null}
                  {tags.length ? <span className="text-slate-400"> · {tags.join(' · ')}</span> : null}
                </li>
              );
            })}
          </ul>
        )}
      </NoteRow>
      <NoteRow label="Investigations ordered" chips={chips('investigations')}>
        {note.investigations.length === 0 ? none('(none)') : (
          <ul className="space-y-0.5">
            {note.investigations.map((inv, i) => (
              <li key={i}><Chips anchors={grouped[`investigations:${i}`]} findings={findings} />{grouped[`investigations:${i}`] ? ' ' : ''}{inv}</li>
            ))}
          </ul>
        )}
      </NoteRow>
      <NoteRow label="Advice / plan" chips={chips('advice')}>{note.advice.length ? note.advice.join(' · ') : none('(none documented)')}</NoteRow>
      <NoteRow label="Follow-up" chips={chips('followup')}>{note.followUpType ? `${note.followUpType}${note.followUpDateSet ? ' · date set' : ' · no date'}` : none('(none)')}</NoteRow>
    </div>
  );
}

// ── PDQI-9 radar ────────────────────────────────────────────────────────────────
const PDQI_ORDER = ['up_to_date', 'accurate', 'thorough', 'useful', 'organized', 'comprehensible', 'succinct', 'synthesized', 'internally_consistent'];
const PDQI_SHORT: Record<string, string> = {
  up_to_date: 'Up-to-date', accurate: 'Accurate', thorough: 'Thorough', useful: 'Useful', organized: 'Organized',
  comprehensible: 'Compreh.', succinct: 'Succinct', synthesized: 'Synth.', internally_consistent: 'Consist.',
};
function PdqiRadar({ pdqi }: { pdqi: Pdqi[] }) {
  const vals = new Map(pdqi.map((p) => [p.attr, Math.max(0, Math.min(5, n(p.value)))]));
  const axes = PDQI_ORDER.filter((a) => vals.has(a));
  if (axes.length < 3) return null;
  const CX = 92, CY = 78, R = 52;
  const pt = (i: number, r: number): [number, number] => {
    const ang = (-90 + (i * 360) / axes.length) * (Math.PI / 180);
    return [CX + r * Math.cos(ang), CY + r * Math.sin(ang)];
  };
  const ring = (r: number) => axes.map((_, i) => pt(i, r).map((v) => v.toFixed(1)).join(',')).join(' ');
  const poly = axes.map((a, i) => pt(i, (vals.get(a)! / 5) * R).map((v) => v.toFixed(1)).join(',')).join(' ');
  const mean = axes.reduce((s, a) => s + vals.get(a)!, 0) / axes.length;
  const weakest = axes.slice().sort((a, b) => vals.get(a)! - vals.get(b)!)[0];
  const weakLabel = PDQI9_LABEL[weakest] || weakest;
  const help = PDQI9_HELP[weakLabel];
  return (
    <div className="flex flex-wrap items-center gap-4">
      <svg width="184" height="156" viewBox="0 0 184 156" className="shrink-0">
        <polygon points={ring(R)} fill="none" stroke="#e2e8f0" strokeWidth="1" />
        <polygon points={ring(R / 2)} fill="none" stroke="#e2e8f0" strokeWidth="0.75" />
        {axes.map((_, i) => { const [x, y] = pt(i, R); return <line key={i} x1={CX} y1={CY} x2={x} y2={y} stroke="#f1f5f9" strokeWidth="0.75" />; })}
        <polygon points={poly} fill="#0f766e" fillOpacity="0.16" stroke="#0f766e" strokeWidth="1.5" />
        {axes.map((a, i) => {
          const v = vals.get(a)!;
          const [x, y] = pt(i, (v / 5) * R);
          const label = PDQI9_LABEL[a] || a;
          const h = PDQI9_HELP[label];
          return (
            <circle key={a} cx={x} cy={y} r="3" fill={scoreColor(((v - 1) / 4) * 100)}>
              <title>{`${label} · ${v}/5\n${h?.def || ''}`}</title>
            </circle>
          );
        })}
        {axes.map((a, i) => {
          const [x, y] = pt(i, R + 11);
          const anchor = Math.abs(x - CX) < 8 ? 'middle' : x > CX ? 'start' : 'end';
          return <text key={a} x={x} y={y + 3} fontSize="8.5" fill="#94a3b8" textAnchor={anchor}>{PDQI_SHORT[a] || a}</text>;
        })}
      </svg>
      <div className="min-w-[180px] flex-1 text-[11.5px] leading-relaxed text-slate-600">
        <div className="text-[12.5px] font-medium text-slate-800">PDQI-9 · {(Math.round(mean * 10) / 10).toFixed(1)}/5</div>
        <div className="mt-0.5">Weakest: <span className="font-medium" style={{ color: scoreColor(((vals.get(weakest)! - 1) / 4) * 100) }}>{weakLabel} {vals.get(weakest)}/5</span>{help ? ` — ${help.def.split('—')[0].trim().toLowerCase()}` : ''}</div>
        <div className="mt-1 text-[10px] text-slate-400">hover a vertex for the definition</div>
      </div>
    </div>
  );
}

// ── the single finding card ─────────────────────────────────────────────────────
function FindingCard({ f, num, sources, auditId, triage }: { f: Finding; num: number; sources: Source[]; auditId: string; triage: Record<string, string> }) {
  const grounded = !!(f.citation_ids && f.citation_ids.length > 0);
  const ground = f.source === 'deterministic'
    ? { label: 'Deterministic rule', cls: 'border-slate-200 bg-slate-50 text-slate-500' }
    : grounded
      ? { label: 'Grounded in CDMSS corpus', cls: 'border-teal-200 bg-teal-50 text-teal-800' }
      : { label: 'General clinical reasoning — not corpus-cited', cls: 'border-slate-200 bg-slate-50 text-slate-500' };
  const tone = chipTone(f);
  const cardCls = tone === 'red' ? 'border-red-200 bg-red-50/50' : tone === 'amber' ? 'border-amber-200 bg-amber-50/40' : 'border-slate-200 bg-white';
  return (
    <div id={`f${num}`} className={`scroll-mt-24 rounded-lg border p-3 target:ring-2 target:ring-brand/50 ${cardCls}`}>
      <div className="flex items-start gap-2">
        <a href={`#a${num}`} title="Show in the note"
          className={`mt-[1px] inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full px-1 text-[10.5px] font-semibold ring-1 hover:ring-2 ${CHIP_CLS[tone]}`}>{num}</a>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-slate-800">{f.subject}
            <span className="ml-2 align-middle text-[10px] font-normal" style={{ color: VERDICT_COLOR[f.verdict] || '#78715f' }}>{f.verdict}</span>
            <span className={`ml-2 inline-block rounded border px-1.5 py-0.5 align-middle text-[10px] font-medium ${ground.cls}`}>{ground.label}</span>
          </div>
          {f.rationale && <div className="mt-1 text-[11.5px] leading-snug text-slate-600">{f.rationale}</div>}
          {grounded && sources.length > 0 && <CitationChips ids={f.citation_ids!} sources={sources} />}
          {Array.isArray(f.evidence) && f.evidence.length > 0 && (
            <div className="mt-1 text-[11px] text-slate-500"><span className="text-emerald-700">Evidence:</span> {f.evidence.join('; ')}</div>
          )}
          <FindingTriage auditId={auditId} findingRef={f.finding_ref} signalType={f.signal_type} current={f.finding_ref ? triage[f.finding_ref] : undefined} />
        </div>
      </div>
    </div>
  );
}

export default async function OpdCaseAudit({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await isAdminUnlocked())) { adminTokenConfigured(); return <LockedMsg />; }

  const rows = (await run(
    `SELECT id, uid, doctor_uid, consult_type, prescription_type, note_date, trace_id,
            note_quality_index, band, completeness_pct, n_missing_mandatory,
            score_documentation, score_note_quality, score_appropriateness, score_prescribing_safety, score_patient_centred,
            pdqi9, findings, suggestions, sources
     FROM opd_note_audits WHERE id = $1 AND app_source = $2 LIMIT 1`,
    [id, APP],
  ).catch(() => [])) as Record<string, unknown>[];

  const r = rows[0];
  if (!r) {
    return (
      <div>
        <Link href="/admin/opd-audit" className="text-sm text-brand hover:underline">← OPD Audit</Link>
        <p className="mt-6 text-sm text-slate-500">Audit not found.</p>
      </div>
    );
  }

  const index = n(r.note_quality_index);
  const band = String(r.band || '');
  const rawFindings = parseJson<Finding[]>(r.findings, []);
  const pdqi = parseJson<Pdqi[]>(r.pdqi9, []);
  const suggestions = parseJson<Sugg[]>(r.suggestions, []).sort((a, b) => a.priority - b.priority);
  const sources = parseJson<Source[]>(r.sources, []);

  // Neon may hand timestamptz back as a JS Date; normalise to ISO so the ::timestamptz casts below always parse.
  const noteDateRaw = r.note_date instanceof Date ? r.note_date.toISOString() : String(r.note_date || '');
  const noteDateMs = new Date(noteDateRaw).getTime();
  const noteDate = Number.isFinite(noteDateMs) ? new Date(noteDateMs).toISOString() : noteDateRaw;

  // Feedback (PRD §4.4): the audit-scope panel shows only whole-audit rows (legacy rows have a null
  // scope and read as 'audit'); per-finding current state is the latest row per finding_ref; missed
  // flags are their own list. All wrapped in .catch — before the migrate route adds the columns the
  // scope-filtered reads return empty rather than 500 (the documented migrate-first sequence).
  const [feedback, findingStateRows, missedRows, prevR, nextR] = await Promise.all([
    run(`SELECT id, created_at, verdict, comment, author FROM opd_audit_feedback WHERE audit_id = $1 AND app_source = $2 AND (scope = 'audit' OR scope IS NULL) ORDER BY created_at DESC`, [id, APP]).catch(() => []),
    run(`SELECT DISTINCT ON (finding_ref) finding_ref, verdict FROM opd_audit_feedback WHERE audit_id = $1 AND app_source = $2 AND scope = 'finding' AND finding_ref IS NOT NULL ORDER BY finding_ref, created_at DESC`, [id, APP]).catch(() => []),
    run(`SELECT id, created_at, comment, author FROM opd_audit_feedback WHERE audit_id = $1 AND app_source = $2 AND scope = 'missed' ORDER BY created_at DESC`, [id, APP]).catch(() => []),
    run(
      `SELECT id FROM opd_note_audits
       WHERE app_source = $1 AND engine_version = '${OPD_ENGINE_VERSION}'
         AND (note_date AT TIME ZONE 'Asia/Kolkata')::date = ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date
         AND (note_date < $2::timestamptz OR (note_date = $2::timestamptz AND id::text < $3))
       ORDER BY note_date DESC, id DESC LIMIT 1`, [APP, noteDate, id]).catch(() => []),
    run(
      `SELECT id FROM opd_note_audits
       WHERE app_source = $1 AND engine_version = '${OPD_ENGINE_VERSION}'
         AND (note_date AT TIME ZONE 'Asia/Kolkata')::date = ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date
         AND (note_date > $2::timestamptz OR (note_date = $2::timestamptz AND id::text > $3))
       ORDER BY note_date ASC, id ASC LIMIT 1`, [APP, noteDate, id]).catch(() => []),
  ]);
  const prevId = prevR[0]?.id ? String(prevR[0].id) : null;
  const nextId = nextR[0]?.id ? String(nextR[0].id) : null;

  const docUid = r.doctor_uid ? String(r.doctor_uid) : null;
  const uid = r.uid ? String(r.uid) : '';
  const [docNames, noteRow, specRows] = await Promise.all([
    docUid ? fetchDoctorNames([docUid]).catch(() => ({} as Record<string, string>)) : Promise.resolve({} as Record<string, string>),
    uid ? fetchOpdNoteByUid(uid).catch(() => null) : Promise.resolve(null),
    docUid ? run(`SELECT speciality FROM doctor_directory WHERE doctor_uid = $1 LIMIT 1`, [docUid]).catch(() => []) : Promise.resolve([]),
  ]);
  const doctor = (docUid && docNames[docUid]) || doctorLabel(docUid);
  // B4 — show the clinician's real specialty (doctor directory) rather than the raw prescription type,
  // which mislabels every specialist as a GP.
  const specialty = (specRows as Record<string, unknown>[])[0]?.speciality ? String((specRows as Record<string, unknown>[])[0].speciality) : null;
  const parsed = noteRow ? rowToOpdCase(noteRow) : null;
  const note: DeidOpdCase | null = parsed?.case ?? null;
  if (note) enrichOpdMeds(note.medications);
  const prescriptionUrl = parsed?.keys.prescriptionUrl ?? null;

  // ── domain scores + findings grouped by domain (worst domain first) ───────────
  const scores = Object.fromEntries(DOMAINS.map((d) => [d.key, n(r[d.col])])) as Record<OpdDomain, number>;
  // B3 — the "fields present but content thin" flag, derived from stored doc score + PDQI (no re-audit).
  const docFlag = documentationAdequacyFlag(scores.documentation, pdqi);
  const pdqiAssessed = pdqi.length > 0;
  const domainOrder = DOMAINS.filter((d) => !(d.key === 'note_quality' && !pdqiAssessed))
    .slice().sort((a, b) => scores[a.key] - scores[b.key]).map((d) => d.key as string);
  const groupRank = (dom: string) => { const i = domainOrder.indexOf(dom); return i === -1 ? 99 : i; };
  const findings = rawFindings.slice().sort((a, b) => groupRank(a.domain) - groupRank(b.domain));
  const findingDomains = domainOrder.filter((d) => findings.some((f) => f.domain === d));
  const otherFindings = findings.filter((f) => !domainOrder.includes(f.domain));
  const countByDomain: Record<string, number> = {};
  for (const f of rawFindings) countByDomain[f.domain] = (countByDomain[f.domain] || 0) + 1;

  // Anchors computed on the DISPLAY order so chip numbers match the cards.
  const anchors = anchorFindings(
    findings.map((f) => ({ subject: f.subject, domain: f.domain, verdict: f.verdict })),
    {
      medications: note ? note.medications.map((m) => String(m.resolvedGeneric || m.generic || m.brand || '')) : [],
      investigations: note ? note.investigations : [],
    },
  );
  const grouped = anchorsByTarget(anchors);

  // ── feedback read-back state (PRD §4.4 / §9) ──────────────────────────────────
  const triage: Record<string, string> = {};
  for (const row of findingStateRows as Record<string, unknown>[]) {
    if (row.finding_ref && row.verdict) triage[String(row.finding_ref)] = String(row.verdict);
  }
  const missed = missedRows as unknown as MissedEntry[];

  // Escalation package (PRD §9.5): de-identified note + CDMSS findings + domain scores +
  // engine_version + a fixed re-audit prompt. Built here (server), handed to EscalateButton for
  // client-side Copy / Download. No PHI: `note` is already de-identified (DeidOpdCase).
  const escalationPackage = buildEscalationPackage({ uid, doctor, band, index, note, findings, scores, engineVersion: OPD_ENGINE_VERSION });

  // ── the grade story ───────────────────────────────────────────────────────────
  const ranked = DOMAINS.filter((d) => !(d.key === 'note_quality' && !pdqiAssessed))
    .map((d) => ({ ...d, score: scores[d.key] })).sort((a, b) => a.score - b.score);
  const worst = ranked[0], second = ranked[1], best = ranked[ranked.length - 1];
  const lowVal = findings.find((f) => f.verdict === 'low-value');
  const story = index >= 70
    ? `A solid Band ${band} note — ${best.label.toLowerCase()} leads (${best.score}); the main headroom is ${worst.label.toLowerCase()} (${worst.score}).`
    : `Graded ${band} mainly on ${worst.label.toLowerCase()} (${worst.score})${lowVal ? ` — ${lowVal.subject.toLowerCase()}` : ''}${second && second.score < 55 ? `, with ${second.label.toLowerCase()} (${second.score}) close behind` : ''}; ${best.label.toLowerCase()} held up (${best.score}).`;
  const statusWord = index >= 70 ? 'on track' : index >= 55 ? 'watch' : 'needs attention';

  // TOC sections that actually exist on this page.
  const toc: { href: string; label: string }[] = [
    { href: '#note', label: 'The note' },
    ...(findings.length ? [{ href: '#findings', label: `Findings · ${findings.length}` }] : []),
    ...(pdqiAssessed ? [{ href: '#pdqi', label: 'PDQI-9 radar' }] : []),
    ...(suggestions.length ? [{ href: '#suggestions', label: `Suggestions · ${suggestions.length}` }] : []),
    ...(sources.length ? [{ href: '#sources', label: `Sources · ${sources.length}` }] : []),
    { href: '#verdict', label: 'Your verdict' },
  ];

  return (
    <div>
      <Link href="/admin/opd-audit" className="text-sm text-brand hover:underline">← OPD Audit</Link>

      <div className="mt-3 items-start gap-4 lg:grid lg:grid-cols-[224px,minmax(0,1fr)]">

        {/* ── persistent audit sidebar ── */}
        <aside className="self-start rounded-xl border border-slate-200 bg-white p-3.5 lg:sticky lg:top-4">
          <div className="text-center">
            <div className="mx-auto flex h-[66px] w-[66px] flex-col items-center justify-center rounded-full bg-white" style={{ border: `5px solid ${bandColor(band)}` }}>
              <span className="text-[21px] font-medium leading-none" style={{ color: bandColor(band) }}>{index}</span>
            </div>
            <div className="mt-1.5 text-[12px] font-medium" style={{ color: bandColor(band) }}>Band {band} · {statusWord}</div>
            <div className="mt-1 text-[11px] leading-snug text-slate-500">{fmtIstTime(noteDate)} · {doctor}<br /><span className="text-[10px] text-slate-400">{specialty || String(r.prescription_type || r.consult_type || 'OPD')}</span></div>
          </div>

          <div className="mt-3 border-t border-slate-100 pt-2.5">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-400">Domains{findings.length ? ' · click to jump' : ''}</div>
            {DOMAINS.map((d) => {
              const na = d.key === 'note_quality' && !pdqiAssessed;
              const v = scores[d.key];
              const c = scoreColor(v);
              const cnt = countByDomain[d.key] || 0;
              const isWorst = !na && d.key === worst.key && v < 55;
              const bar = (
                <div key={d.key} className={`mb-2.5 ${cnt > 0 ? 'cursor-pointer' : ''}`}>
                  <div className="flex items-baseline justify-between text-[11px]">
                    <span className={isWorst ? 'font-medium' : 'text-slate-600'} style={isWorst ? { color: c } : undefined}>{d.label}</span>
                    {na ? <span className="text-slate-300">—</span> : <span className="font-medium tabular-nums" style={{ color: c }}>{v}</span>}
                  </div>
                  <div className="mt-[3px] h-[7px] rounded bg-slate-100">
                    {!na && <div className="h-full rounded" style={{ width: `${Math.max(2, v)}%`, background: c }} />}
                  </div>
                  {(cnt > 0 || isWorst) && (
                    <div className="mt-[2px] text-[9.5px]" style={{ color: isWorst ? c : '#94a3b8' }}>
                      {na ? 'not assessed' : `${cnt > 0 ? `${cnt} finding${cnt > 1 ? 's' : ''}` : ''}${isWorst ? `${cnt > 0 ? ' · ' : ''}main drag ↓` : ''}`}
                    </div>
                  )}
                  {d.key === 'documentation' && docFlag && (
                    <div className="mt-[3px] rounded bg-amber-50 px-1.5 py-1 text-[9.5px] leading-snug text-amber-700" title={docFlag.detail}>
                      ⚠ {docFlag.label} — completeness ≠ adequacy
                    </div>
                  )}
                </div>
              );
              return cnt > 0 ? <a key={d.key} href={`#fd-${d.key}`} className="block no-underline">{bar}</a> : bar;
            })}
          </div>

          <nav className="border-t border-slate-100 pt-2 text-[11.5px] leading-[2.05]">
            {toc.map((t) => <a key={t.href} href={t.href} className="block text-slate-500 hover:text-brand">{t.label}</a>)}
          </nav>

          <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2.5 text-[11px]">
            {prevId ? <Link href={`/admin/opd-audit/${prevId}`} className="text-brand hover:underline">‹ prev</Link> : <span className="text-slate-300">‹ prev</span>}
            <span className="flex flex-col items-center gap-0.5 text-[10px]">
              {prescriptionUrl ? <a href={prescriptionUrl} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">actual PDF</a> : null}
              {r.trace_id ? <Link href={`/admin/observability/${r.trace_id}`} className="text-slate-400 hover:text-brand">trace</Link> : null}
            </span>
            {nextId ? <Link href={`/admin/opd-audit/${nextId}`} className="text-brand hover:underline">next ›</Link> : <span className="text-slate-300">next ›</span>}
          </div>
        </aside>

        {/* ── main column: story → note → findings → radar → suggestions → sources → verdict ── */}
        <div className="mt-4 min-w-0 lg:mt-0">
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-[12.5px] leading-relaxed text-slate-700">{story}</div>

          <div id="note" className="mt-3 scroll-mt-4">
            <NotePanel note={note} pdfUrl={prescriptionUrl} grouped={grouped} findings={findings} />
          </div>

          {findings.length > 0 && (
            <div id="findings" className="mt-4 scroll-mt-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-400">Findings · grouped by domain, worst first · numbered where they sit in the note</div>
                <EscalateButton pkg={escalationPackage} uid={uid} />
              </div>
              <ReviewerBar />
              {findingDomains.map((dom) => {
                const list = findings.map((f, i) => ({ f, num: i + 1 })).filter((x) => x.f.domain === dom);
                const v = scores[dom as OpdDomain];
                return (
                  <div key={dom} id={`fd-${dom}`} className="mb-3 scroll-mt-4">
                    <div className="mb-1.5 flex items-baseline gap-2 text-[10.5px] font-semibold uppercase tracking-[0.06em]" style={{ color: scoreColor(v) }}>
                      {DOMAIN_LABEL[dom] || dom.replace('_', ' ')} <span className="font-normal normal-case tracking-normal text-slate-400">score {v} · {list.length} finding{list.length > 1 ? 's' : ''}</span>
                    </div>
                    <div className="space-y-2">{list.map(({ f, num }) => <FindingCard key={num} f={f} num={num} sources={sources} auditId={id} triage={triage} />)}</div>
                  </div>
                );
              })}
              {otherFindings.length > 0 && (
                <div className="space-y-2">{findings.map((f, i) => ({ f, num: i + 1 })).filter((x) => !domainOrder.includes(x.f.domain)).map(({ f, num }) => <FindingCard key={num} f={f} num={num} sources={sources} auditId={id} triage={triage} />)}</div>
              )}
              <MissedFindingCapture auditId={id} initial={missed} />
            </div>
          )}

          {pdqiAssessed && (
            <div id="pdqi" className="mt-4 scroll-mt-4 rounded-xl border border-slate-200 bg-white p-3.5">
              <PdqiRadar pdqi={pdqi} />
            </div>
          )}

          {suggestions.length > 0 && (
            <details id="suggestions" className="group mt-4 scroll-mt-4 rounded-xl border border-slate-200 bg-white" open>
              <summary className="cursor-pointer select-none px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-400 hover:text-slate-600">Suggestions · {suggestions.length}</summary>
              <ol className="space-y-1.5 px-4 pb-3">
                {suggestions.map((s, i) => (
                  <li key={i} className="flex gap-2 rounded-lg border border-slate-100 bg-slate-50/50 p-2.5 text-[11.5px] text-slate-700">
                    <span className="font-medium text-brand">{s.priority}</span><span>{s.text}</span>
                  </li>
                ))}
              </ol>
            </details>
          )}

          {sources.length > 0 && (
            <details id="sources" className="group mt-4 scroll-mt-4 rounded-xl border border-slate-200 bg-white">
              <summary className="cursor-pointer select-none px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-400 hover:text-slate-600">Sources · retrieved from the CDMSS corpus · {sources.length}</summary>
              <div className="px-4 pb-3"><SourcesPanel sources={sources} /></div>
            </details>
          )}

          <div id="verdict" className="mt-4 scroll-mt-4"><FeedbackPanel auditId={id} uid={uid || null} initial={feedback as unknown as FeedbackEntry[]} /></div>

          <p className="mt-5 text-[11px] text-slate-400">Advisory note-level quality proxy — documentation, PDQI-9, appropriateness and prescribing safety as demonstrated in the note. uid <code className="rounded bg-slate-100 px-1">{uid}</code> links back to the source encounter in db13. Not an outcomes measure; not a clinician scorecard.</p>
        </div>
      </div>
    </div>
  );
}
