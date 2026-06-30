import Link from 'next/link';
import type { ReactNode } from 'react';
import { sql } from '@/lib/db';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { fetchDoctorNames, fetchOpdNoteByUid } from '@/lib/metabase';
import { rowToOpdCase, type DeidOpdCase } from '@/lib/opd-ingest-core';
import { enrichOpdMeds } from '@/lib/formulary';
import { CitationChips, SourcesPanel } from '@/components/right-care/kit';
import type { Source } from '@/lib/citations-core';
import {
  bandColor, scoreColor, parseJson, doctorLabel, fmtIstTime, DOMAIN_ROWS, PDQI9_LABEL,
} from '@/lib/opd-audit-ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'OPD case audit · Admin' };

const APP = process.env.APP_SOURCE || 'standalone';
const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const n = (v: unknown): number => Number(v ?? 0);

const VERDICT_COLOR: Record<string, string> = {
  'low-value': '#dc2626', 'context-dependent': '#d97706', 'high-value': '#16a34a', uncertain: '#78715f',
};

type Finding = { subject: string; verdict: string; confidence: number; domain: string; rationale: string; evidence?: string[]; estimates?: string[]; source?: string; citation_ids?: number[] };
type Pdqi = { attr: string; label?: string; value: number };
type Sugg = { priority: number; text: string };

function LockedMsg() {
  return (
    <div>
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">OPD case audit</h1>
      <p className="mt-1.5 text-sm text-slate-500">Locked. <Link href="/admin/opd-audit" className="text-brand hover:underline">Unlock the OPD Audit surface</Link> first.</p>
    </div>
  );
}

// ── the actual de-identified note (fetched live from db13 by uid) ──────────────
function NoteRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-t border-slate-50 px-3 py-2 first:border-t-0">
      <div className="text-[10px] font-medium uppercase tracking-[0.06em] text-slate-400">{label}</div>
      <div className="mt-0.5 text-[12px] leading-snug text-slate-700">{children}</div>
    </div>
  );
}
const none = (s: string) => <span className="text-slate-400">{s}</span>;

function NotePanel({ note, pdfUrl }: { note: DeidOpdCase | null; pdfUrl: string | null }) {
  const pdfLink = pdfUrl ? <a href={pdfUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] font-medium text-brand hover:underline">↓ Actual PDF</a> : null;
  if (!note) {
    return <div className="rounded-xl border border-slate-200 bg-white p-4 text-[12px] text-slate-400">Source note unavailable — it may have been edited or removed in db13 since the audit ran. {pdfLink}</div>;
  }
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/60 px-3 py-2">
        <span className="text-[11.5px] font-medium text-slate-600">Documented note <span className="font-normal text-slate-400">· de-identified · what the engine read</span></span>
        {pdfLink}
      </div>
      <NoteRow label="Presenting complaints / history">{note.presentingComplaints.length ? note.presentingComplaints.join(' · ') : none('(none documented)')}</NoteRow>
      {note.reasonForConsult ? <NoteRow label="Reason for consult">{note.reasonForConsult}</NoteRow> : null}
      <NoteRow label="Diagnosis (ICD-10)">{note.diagnosisCodes.length ? note.diagnosisCodes.join(', ') : none('(none)')}{note.impressions.length ? ` · ${note.impressions.join('; ')}` : (note.impressionCodes.length ? ` · impression ${note.impressionCodes.join(', ')}` : '')}</NoteRow>
      {note.examination.length ? <NoteRow label="Examination">{note.examination.join(' · ')}</NoteRow> : null}
      <NoteRow label={`Medications (${note.medications.length})`}>
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
      <NoteRow label="Investigations ordered">{note.investigations.length ? note.investigations.join('; ') : none('(none)')}</NoteRow>
      <NoteRow label="Advice / plan">{note.advice.length ? note.advice.join(' · ') : none('(none documented)')}</NoteRow>
      <NoteRow label="Follow-up">{note.followUpType ? `${note.followUpType}${note.followUpDateSet ? ' · date set' : ' · no date'}` : none('(none)')}</NoteRow>
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
  const findings = parseJson<Finding[]>(r.findings, []);
  const pdqi = parseJson<Pdqi[]>(r.pdqi9, []);
  const suggestions = parseJson<Sugg[]>(r.suggestions, []).sort((a, b) => a.priority - b.priority);
  const sources = parseJson<Source[]>(r.sources, []);

  const docUid = r.doctor_uid ? String(r.doctor_uid) : null;
  const uid = r.uid ? String(r.uid) : '';
  // Doctor name + the live de-identified note, both pulled from db13 (best-effort).
  const [docNames, noteRow] = await Promise.all([
    docUid ? fetchDoctorNames([docUid]).catch(() => ({} as Record<string, string>)) : Promise.resolve({} as Record<string, string>),
    uid ? fetchOpdNoteByUid(uid).catch(() => null) : Promise.resolve(null),
  ]);
  const doctor = (docUid && docNames[docUid]) || doctorLabel(docUid);
  const parsed = noteRow ? rowToOpdCase(noteRow) : null;
  const note: DeidOpdCase | null = parsed?.case ?? null;
  if (note) enrichOpdMeds(note.medications);   // brand→generic + class/safety tags (same as the audit ran)
  const prescriptionUrl = parsed?.keys.prescriptionUrl ?? null;

  const lowVal = findings.find((f) => f.verdict === 'low-value');
  const bottom = lowVal
    ? `${lowVal.subject} — ${lowVal.rationale}`
    : (n(r.completeness_pct) < 60
        ? `Thin note: ${n(r.completeness_pct)}% NABH OPD completeness (${n(r.n_missing_mandatory)} mandatory field(s) missing).`
        : `Documented at ${n(r.completeness_pct)}% completeness; note-quality index ${index}.`);

  return (
    <div>
      <Link href="/admin/opd-audit" className="text-sm text-brand hover:underline">← OPD Audit</Link>

      {/* verdict-first header */}
      <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center gap-3 border-b border-slate-100 bg-slate-50/60 px-4 py-3">
          <div className="flex h-[54px] w-[54px] shrink-0 flex-col items-center justify-center rounded-full bg-white" style={{ border: `4px solid ${bandColor(band)}` }}>
            <span className="text-[17px] font-medium" style={{ color: bandColor(band) }}>{index}</span>
            <span className="text-[8px] text-slate-400">/100</span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium" style={{ color: bandColor(band) }}>Band {band} · {fmtIstTime(String(r.note_date || ''))} · {doctor}</div>
            <div className="mt-0.5 text-[11.5px] leading-snug text-slate-600">{bottom}</div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1 text-[10px] text-slate-400">
            <span className="rounded border border-slate-200 px-2 py-0.5">{String(r.prescription_type || r.consult_type || 'OPD')}</span>
            {prescriptionUrl ? <a href={prescriptionUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-brand hover:underline">actual PDF ›</a> : null}
            {r.trace_id ? <Link href={`/admin/observability/${r.trace_id}`} className="text-brand hover:underline">trace ›</Link> : null}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-x-5 gap-y-2 px-4 py-3 sm:grid-cols-2">
          {DOMAIN_ROWS.map((d) => {
            const v = n(r[d.col]);
            return (
              <div key={d.col}>
                <div className="flex justify-between text-[11px] text-slate-600"><span>{d.label}</span><span className="font-medium" style={{ color: scoreColor(v) }}>{v}</span></div>
                <div className="mt-0.5 h-[5px] rounded bg-slate-100"><div className="h-full rounded" style={{ width: `${v}%`, background: scoreColor(v) }} /></div>
              </div>
            );
          })}
        </div>
      </div>

      {/* note (left) vs audit detail (right) */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2 lg:items-start">
        <NotePanel note={note} pdfUrl={prescriptionUrl} />

        <div className="space-y-4">
          {findings.length > 0 && (
            <div>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-400">Findings</div>
              <div className="space-y-2">
                {findings.map((f, i) => {
                  const grounded = !!(f.citation_ids && f.citation_ids.length > 0);
                  const ground = f.source === 'deterministic'
                    ? { label: 'Deterministic rule', cls: 'border-slate-200 bg-slate-50 text-slate-500' }
                    : grounded
                      ? { label: 'Grounded in CDMSS corpus', cls: 'border-teal-200 bg-teal-50 text-teal-800' }
                      : { label: 'General clinical reasoning — not corpus-cited', cls: 'border-slate-200 bg-slate-50 text-slate-500' };
                  return (
                    <div key={i} className="rounded-lg border border-slate-200 bg-white p-3">
                      <div className="flex items-start gap-2">
                        <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full" style={{ background: VERDICT_COLOR[f.verdict] || '#78715f' }} />
                        <div className="min-w-0 flex-1">
                          <div className="text-[12.5px] font-medium text-slate-800">{f.subject}
                            <span className="ml-2 align-middle text-[10px] font-normal text-slate-400">{f.verdict} · {f.domain.replace('_', ' ')}</span>
                          </div>
                          <div className={`mt-1 inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium ${ground.cls}`}>{ground.label}</div>
                          {f.rationale && <div className="mt-1 text-[11.5px] leading-snug text-slate-600">{f.rationale}</div>}
                          {grounded && sources.length > 0 && <CitationChips ids={f.citation_ids!} sources={sources} />}
                          {Array.isArray(f.evidence) && f.evidence.length > 0 && (
                            <div className="mt-1 text-[11px] text-slate-500"><span className="text-emerald-700">Evidence:</span> {f.evidence.join('; ')}</div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {pdqi.length > 0 && (
            <div>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-400">PDQI-9 — note quality</div>
              <div className="grid grid-cols-2 gap-2 rounded-xl border border-slate-200 bg-white p-3">
                {pdqi.map((p) => (
                  <div key={p.attr} className="flex items-center justify-between rounded bg-slate-50 px-2 py-1 text-[11px]">
                    <span className="truncate text-slate-600">{p.label || PDQI9_LABEL[p.attr] || p.attr}</span>
                    <span className="font-medium tabular-nums" style={{ color: scoreColor(((n(p.value) - 1) / 4) * 100) }}>{n(p.value)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {suggestions.length > 0 && (
            <div>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-400">Suggestions</div>
              <ol className="space-y-1.5">
                {suggestions.map((s, i) => (
                  <li key={i} className="flex gap-2 rounded-lg border border-slate-200 bg-white p-2.5 text-[11.5px] text-slate-700">
                    <span className="font-medium text-brand">{s.priority}</span><span>{s.text}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {sources.length > 0 && (
            <div>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-400">Sources — retrieved from the CDMSS corpus</div>
              <div className="rounded-xl border border-slate-200 bg-white p-3"><SourcesPanel sources={sources} /></div>
            </div>
          )}
        </div>
      </div>

      <p className="mt-5 text-[11px] text-slate-400">Advisory note-level quality proxy — documentation, PDQI-9, appropriateness and prescribing safety as demonstrated in the note. uid <code className="rounded bg-slate-100 px-1">{uid}</code> links back to the source encounter in db13. Not an outcomes measure; not a clinician scorecard.</p>
    </div>
  );
}
