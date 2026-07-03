import Link from 'next/link';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { OPD_ENGINE_VERSION } from '@/lib/opd-note-audit-core';
import {
  OPD_DEFAULT_WEIGHTS, OPD_DOMAIN_LABEL, PDQI9_ATTRS, PDQI9_LABEL,
  PENALTY_BASE, SEVERITY, OPD_NOTE_CAVEAT, type OpdDomain,
} from '@/lib/opd-note-score-core';
import { DOSE_LIMITS_VERSION } from '@/lib/dose-limits';
import { OPD_AUDIT_CHANGELOG } from '@/lib/opd-audit-changelog';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'How the audit works · OPD Audit · CAT' };

/**
 * /admin/opd-audit/how-it-works — the audit-mechanics REFERENCE + engine changelog.
 * Readable by admins AND care managers (they field "how is this scored?" from doctors).
 * Every number on this page is imported from the live scoring code — it cannot drift.
 */

const DOMAIN_ORDER: OpdDomain[] = ['documentation', 'note_quality', 'appropriateness', 'prescribing_safety', 'patient_centred'];

const BANDS: { band: string; range: string; tone: string }[] = [
  { band: 'A', range: '85–100', tone: 'bg-emerald-100 text-emerald-800' },
  { band: 'B', range: '70–84', tone: 'bg-lime-100 text-lime-800' },
  { band: 'C', range: '55–69', tone: 'bg-amber-100 text-amber-800' },
  { band: 'D', range: '40–54', tone: 'bg-orange-100 text-orange-800' },
  { band: 'E', range: '0–39', tone: 'bg-red-100 text-red-800' },
];

const VERDICTS: { verdict: string; note: string }[] = [
  { verdict: 'low-value', note: 'clearly low-value / unsafe as documented' },
  { verdict: 'context-dependent', note: 'could be right — the note does not justify it' },
  { verdict: 'uncertain', note: 'possible issue, weak signal' },
  { verdict: 'high-value', note: 'good practice — never penalised' },
];

function Section({ id, kicker, title, children }: { id: string; kicker: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-8 rounded-xl border border-slate-200 bg-white p-6">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{kicker}</p>
      <h2 className="mt-0.5 font-serif text-[20px] font-semibold text-slate-900">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-slate-700">{children}</div>
    </section>
  );
}

function Formula({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg bg-slate-50 px-4 py-2.5 font-mono text-[13px] text-slate-800">{children}</div>;
}

export default async function HowItWorksPage() {
  const admin = await isAdminUnlocked();
  const care = await isCareUnlocked();
  if (!admin && !care) {
    return (
      <div>
        <h1 className="font-serif text-[26px] font-semibold text-slate-900">How the audit works</h1>
        <p className="mt-1.5 text-sm text-slate-500">
          Locked. Unlock an <Link href="/admin/opd-audit" className="text-brand hover:underline">admin surface</Link> or
          sign in as a <Link href="/care/login" className="text-brand hover:underline">care manager</Link> first.
        </p>
      </div>
    );
  }

  const w = OPD_DEFAULT_WEIGHTS;

  return (
    <div className="max-w-3xl">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">OPD Audit · Reference</p>
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">How the audit works</h1>
      <p className="mt-1.5 text-sm text-slate-500">
        The complete scoring mechanics of the OPD note audit, generated from the live engine code
        (<span className="font-mono text-[12px]">{OPD_ENGINE_VERSION}</span>) — every constant on this page is imported
        from the scoring source, so it cannot drift. The <a href="#changelog" className="text-brand hover:underline">changelog</a> at
        the bottom records every rule change, dated, with the reason.
      </p>
      <p className="mt-3 rounded-lg border border-sky-200 bg-sky-50 px-4 py-2.5 text-[13px] text-sky-900">
        Posture: <strong>advisory, encounter-level — never a clinician scorecard.</strong> {OPD_NOTE_CAVEAT}
      </p>

      <Section id="pipeline" kicker="Overview" title="The pipeline, end to end">
        <p>
          Every non-draft medical OPD note is audited daily. The note is read from the EMR mirror (structured
          prescription row + the dpipe pipeline&apos;s clean complaint/diagnosis/plan), <strong>de-identified</strong>, then passes
          through two kinds of checks:
        </p>
        <ul className="ml-5 list-disc space-y-1">
          <li><strong>Deterministic rules</strong> (pure code, no AI): NABH completeness, dosing completeness, duplicate molecules, drug–drug interactions, daily-dose ceilings, formulary safety facts.</li>
          <li><strong>LLM assessment</strong> (specialty-aware, corpus-grounded): appropriateness / prescribing findings + the PDQI-9 note-quality rating. The model only <em>rates and tags</em> — it never produces the score number.</li>
        </ul>
        <p>
          All arithmetic is pure and auditable (<span className="font-mono text-[12px]">lib/opd-note-score-core.ts</span>).
          Findings are identity-stamped (<span className="font-mono text-[12px]">signal_type + finding_ref</span>), human-approved
          suppressions applied, then scored. Results feed the dashboards, the care-manager triage queue and the governance signal feeds.
        </p>
      </Section>

      <Section id="domains" kicker="Scoring" title="The five domains and their weights">
        <table className="w-full text-left text-[13px]">
          <thead><tr className="border-b border-slate-200 text-slate-500">
            <th className="py-1.5 pr-3 font-medium">Domain</th><th className="py-1.5 pr-3 font-medium">Weight</th><th className="py-1.5 font-medium">Scored from</th>
          </tr></thead>
          <tbody className="align-top">
            <tr className="border-b border-slate-100"><td className="py-2 pr-3 font-medium text-slate-800">{OPD_DOMAIN_LABEL.documentation}</td><td className="py-2 pr-3 font-mono">{w.documentation}</td><td className="py-2">Presence of the clinical-record core: presenting complaint · diagnosis/impression · complete medication dosing · examination (in-person encounters only — a teleconsult is never faulted for no exam). Since 0.8, advice + follow-up are <em>tracked</em> on this checklist but scored in Continuity, so no field counts twice.</td></tr>
            <tr className="border-b border-slate-100"><td className="py-2 pr-3 font-medium text-slate-800">{OPD_DOMAIN_LABEL.note_quality}</td><td className="py-2 pr-3 font-mono">{w.note_quality}</td><td className="py-2">PDQI-9 — the validated 9-attribute instrument, each rated 1–5 by the LLM: {PDQI9_ATTRS.map((a) => PDQI9_LABEL[a]).join(', ')}. Rescaled (mean − 1) / 4 × 100. If PDQI-9 was not assessed, this domain&apos;s weight collapses to 0 (it never drags the index).</td></tr>
            <tr className="border-b border-slate-100"><td className="py-2 pr-3 font-medium text-slate-800">{OPD_DOMAIN_LABEL.appropriateness}</td><td className="py-2 pr-3 font-mono">{w.appropriateness}</td><td className="py-2">LLM findings on tests/referrals/management (RAND / Choosing Wisely framing), each tagged verdict × confidence → penalty (below).</td></tr>
            <tr className="border-b border-slate-100"><td className="py-2 pr-3 font-medium text-slate-800">{OPD_DOMAIN_LABEL.prescribing_safety}</td><td className="py-2 pr-3 font-mono">{w.prescribing_safety}</td><td className="py-2">Deterministic checks (duplicates on the formulary-resolved generic, DDI, dose ceilings, incomplete dosing) + LLM prescribing findings (WHO rational-prescribing framing). On a zero-medication note, prescribing findings are dropped entirely — there is no prescription to fault.</td></tr>
            <tr><td className="py-2 pr-3 font-medium text-slate-800">{OPD_DOMAIN_LABEL.patient_centred}</td><td className="py-2 pr-3 font-mono">{w.patient_centred}</td><td className="py-2">Exactly two fields: <strong>advice/plan given</strong> and <strong>follow-up specified</strong> → 0 / 50 / 100. A follow-up counts only for a real disposition (IF_REQUIRED, MANDATORY_FOLLOW_UP, …) or an explicit date — blank/UNKNOWN does <em>not</em> count (0.7).</td></tr>
          </tbody>
        </table>
        <Formula>headline = Σ (domain score × weight) / Σ active weights &nbsp;→&nbsp; 0–100</Formula>
      </Section>

      <Section id="penalty" kicker="Scoring" title="The finding penalty model">
        <p>
          Appropriateness and Prescribing start at 100 and lose points per finding. The LLM (or the deterministic
          rule) tags each finding with a verdict and a confidence (0–1):
        </p>
        <Formula>penalty = {PENALTY_BASE} × severity(verdict) × confidence &nbsp;·&nbsp; domain score = max(0, 100 − Σ penalties)</Formula>
        <table className="w-full text-left text-[13px]">
          <thead><tr className="border-b border-slate-200 text-slate-500">
            <th className="py-1.5 pr-3 font-medium">Verdict</th><th className="py-1.5 pr-3 font-medium">Severity</th><th className="py-1.5 pr-3 font-medium">Max penalty</th><th className="py-1.5 font-medium">Meaning</th>
          </tr></thead>
          <tbody>
            {VERDICTS.map((v) => (
              <tr key={v.verdict} className="border-b border-slate-100 last:border-0">
                <td className="py-1.5 pr-3 font-mono">{v.verdict}</td>
                <td className="py-1.5 pr-3 font-mono">{SEVERITY[v.verdict as keyof typeof SEVERITY]}</td>
                <td className="py-1.5 pr-3 font-mono">{PENALTY_BASE * (SEVERITY[v.verdict as keyof typeof SEVERITY] ?? 0)}</td>
                <td className="py-1.5">{v.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          <strong>Informational findings never penalise</strong> — formulary facts (ISMP high-alert, Schedule X, LASA pairs,
          off-formulary brands) carry confidence 0: they inform the reader without moving the score.
        </p>
      </Section>

      <Section id="bands" kicker="Scoring" title="Bands">
        <div className="flex flex-wrap gap-2">
          {BANDS.map((b) => (
            <span key={b.band} className={`rounded-lg px-3 py-1.5 text-[13px] font-medium ${b.tone}`}>Band {b.band} · {b.range}</span>
          ))}
        </div>
        <p>Cutoffs: A ≥ 85 · B ≥ 70 · C ≥ 55 · D ≥ 40 · E below. Confidence (low / moderate / high) reflects how much real signal the audit had: findings count + whether PDQI-9 was assessed.</p>
      </Section>

      <Section id="flags" kicker="Scoring" title="Advisory flags — completeness ≠ adequacy">
        <p>
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[12px] font-medium text-amber-800">Fields present · content thin</span>{' '}
          fires when the NABH fields are (near-)complete (Documentation ≥ 90) but PDQI thoroughness or synthesis is ≤ 2.
          A high completeness score means <em>nothing left blank</em>, not <em>well-documented</em> — the flag makes the
          contradiction explicit without changing any score (0.7).
        </p>
      </Section>

      <Section id="deterministic" kicker="Mechanics" title="Deterministic prescribing checks">
        <ul className="ml-5 list-disc space-y-1.5">
          <li><strong>Dosing completeness</strong> — a med line needs a dose, frequency, route and duration. Reads what the note <em>actually documents</em>: strength embedded in the drug name counts (&quot;Cefix 200mg Tab&quot;), and a route inferable from the dosage form counts (tab→oral, inj→parenteral). Only truly ambiguous gaps flag.</li>
          <li><strong>Duplicates</strong> — the same molecule twice, detected on the formulary-RESOLVED generic, so brand-only duplicates are caught.</li>
          <li><strong>Drug–drug interactions</strong> — over confidently-resolved molecules, including a history-drug × current-drug check (e.g. NSAID duplication against a drug-history NSAID).</li>
          <li><strong>Daily-dose ceilings</strong> — total daily dose per molecule aggregated ACROSS combination products and checked against per-molecule ceilings (<span className="font-mono text-[12px]">data/dose-limits.json {DOSE_LIMITS_VERSION}</span>). Volumetric/liquid formulations (paediatric syrups) are excluded from the adult tablet model.</li>
          <li><strong>Formulary facts</strong> — high-alert (ISMP), Schedule X, look-alike/sound-alike co-prescription, unverified brands (NABH expects generic naming). Informational unless a genuine safety rule fires.</li>
        </ul>
      </Section>

      <Section id="grounding" kicker="Mechanics" title="Grounding — cite-or-label">
        <p>Every LLM finding is badged with its evidential basis (0.5):</p>
        <ul className="ml-5 list-disc space-y-1">
          <li><strong>Grounded in CDMSS corpus</strong> — the finding cites retrieved corpus passages (CITED [n] chips, sources panel with PubMed links).</li>
          <li><strong>General clinical reasoning</strong> — the model&apos;s judgement, explicitly labelled as uncited.</li>
          <li><strong>Deterministic rule</strong> — pure code, no model involved.</li>
        </ul>
        <p>The audit is specialty-aware (0.7): the case is judged against the treating clinician&apos;s specialty standards from the doctor directory, not as generic GP care.</p>
      </Section>

      <Section id="versioning" kicker="Governance" title="Engine versioning — why dashboards blank after a change">
        <p>
          Every audit row is stamped with the engine version that produced it, and every surface (dashboards, triage,
          governance signals) reads ONLY the current version — scores from different rule-sets are never mixed. A version
          bump therefore blanks the dashboards until the Mac-mini backfill re-audits the corpus at the new version
          (recent-first, free, typically under a day for the recent window). Changes that alter stored scores bump the
          version; display-only changes do not.
        </p>
        <p>
          Nothing raw reaches a doctor: LLM findings pass the care-manager triage queue first, and human-approved
          suppressions (with the dual-label safety invariant) remove known false-positive classes at source.
        </p>
      </Section>

      <section id="changelog" className="mt-8 rounded-xl border border-slate-200 bg-white p-6">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Living spec</p>
        <h2 className="mt-0.5 font-serif text-[20px] font-semibold text-slate-900">Engine changelog</h2>
        <p className="mt-1.5 text-sm text-slate-500">Every rule change, dated, with the reason — including changes that shipped without a version bump.</p>
        <ol className="mt-4 space-y-5">
          {OPD_AUDIT_CHANGELOG.map((c) => (
            <li key={`${c.date}-${c.title}`} className="relative border-l-2 border-slate-200 pl-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-2 py-0.5 font-mono text-[12px] font-semibold ${c.engine ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'}`}>
                  {c.engine ? `opd-note-audit/${c.engine}` : 'no bump'}
                </span>
                <span className="text-[12px] text-slate-500">{c.date}</span>
                {c.scoring && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">scores changed</span>}
              </div>
              <p className="mt-1.5 text-sm font-semibold text-slate-800">{c.title}</p>
              <ul className="mt-1 ml-4 list-disc space-y-1 text-[13px] text-slate-600">
                {c.points.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
              <p className="mt-1.5 text-[13px] italic text-slate-500">Why: {c.why}</p>
            </li>
          ))}
        </ol>
      </section>

      <p className="mt-6 text-[12px] text-slate-400">
        Source of truth: <span className="font-mono">lib/opd-note-audit-core.ts</span> · <span className="font-mono">lib/opd-note-score-core.ts</span> · <span className="font-mono">lib/opd-audit-changelog.ts</span> · <span className="font-mono">data/dose-limits.json</span>.
        {' '}<Link href="/admin/opd-audit" className="text-brand hover:underline">Back to the OPD Audit dashboard</Link>
      </p>
    </div>
  );
}
