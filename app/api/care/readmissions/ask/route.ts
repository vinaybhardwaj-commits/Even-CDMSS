/**
 * /api/care/readmissions/ask — the case conversation.
 *
 * R4.3 (CDMSS-READMISSIONS-R4.3-PRD v1.0, R43-1..R43-8) built it: a care manager's question about ONE
 * case, answered by Opus 4.6 on Bedrock from that case's STORED material only — the evidence ledger,
 * the agent's account, the judgements, the coverage, the two bills — with every citation checked by
 * code before it is shown.
 *
 * R9 (CDMSS-READMISSIONS-R9-DUAL-CONTRACT-PRD-27-AUG-2026-GO, D10 / D12 / D13 / D14, O1 / O2, T6 / T7)
 * turns it into a stored argument. Same route, same case page, no new surface.
 *
 *   GET  ?dedup_key=…  the persisted thread + the stored clinical_review, so a reload resumes the
 *                      conversation instead of forgetting it (acceptance #5).
 *   POST { dedup_key, question }
 *        · O1 — THE SERVER IS THE THREAD'S TRUTH. The thread is read from Neon by
 *          (dedup_key, engine_version); any `history` in the body is IGNORED, so a client cannot
 *          rewrite what was said. The model window is the last ASK_HISTORY_MAX_TURNS turns then the
 *          existing token trim.
 *        · The user's turn is appended BEFORE the model call — a fault must not cost his words.
 *        · The answer path is R4.3's, unchanged: askVerdict gates it, an uncited claim is withheld,
 *          a model fault is a withheld answer and never a 500.
 *        · D13/D14/T6 — the overlay is gated by the pure `gateOverlay` and, when it passes, written to
 *          the nine `clinical_review_*` columns and NOWHERE else. Failing the gate persists the turn,
 *          skips the overlay, and still answers 200. `avoidable`, `planned`, `same_condition`,
 *          `preventable_injury` and `negligence` are never written here, and the incidence aggregator
 *          never reads what is (acceptance #6).
 *
 * FENCE, still: this route re-audits nothing, regenerates nothing, and reads exactly what the case
 * route reads (the pinned finding row + the two bill breakdowns) plus its own conversation storage.
 * T7 — the model stays `global.anthropic.claude-opus-4-6-v1` via the existing Bedrock Converse path,
 * no fallback (F11), no new catalogue row.
 *
 * PHI (R43-8, extended by D12): the material is de-identified by construction and this route passes NO
 * identity to the model — no name, no UHID, no encounter id (toFinding is called without an Identity).
 * The same rule now covers STORED turns: what is written to readmission_ask_turns is the care
 * manager's own typed words and the agent's own checked answer, and nothing else.
 *
 * ACTOR — flagged deviation. D12 says the actor is "the care-manager identity already on the cookie".
 * There is no such identity: `cat_care` carries one shared CARE_TOKEN, not a person (lib/care-cookie).
 * Rather than invent a name, the actor recorded is the ROLE the request proved — 'care' or 'admin'.
 * Attributing a clinical judgement to a person the system cannot actually identify would be worse
 * than recording honestly that a care login made it.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { isCareUnlocked } from '@/lib/care-cookie';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { fetchFindingForSurface, READMIT_ENGINE_VERSION } from '@/lib/readmission/store';
import { fetchStayBillBreakdown, type StayBillBreakdown } from '@/lib/readmission/db13';
import { asJson, toFinding } from '@/lib/readmission/surface-row';
import { probeReachable } from '@/lib/lab-override';
import { returnBillFor, toFindingClass, type FindingBlob } from '@/lib/readmission-surface-core';
import { NARRATIVE_MODEL_ID, type CaseArtefacts } from '@/lib/readmission-narrative-core';
import { askMaterialFrom, answerCaseQuestion } from '@/lib/readmission/ask';
import { appendTurn, readClinicalReview, readThread, saveClinicalReview } from '@/lib/readmission/ask-store';
import { gateOverlay, normaliseQuestion, threadToHistory, ASK_WITHHELD_COPY } from '@/lib/readmission-ask-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

function enabled(): boolean {
  return process.env.CCB_ENABLED === '1' && process.env.READMISSIONS_SURFACE_ENABLED === '1';
}
/** The role the request proved — the honest actor (see the ACTOR note above). Null = not authorised. */
async function actorRole(): Promise<'care' | 'admin' | null> {
  try { if (await isCareUnlocked()) return 'care'; } catch { /* fall through */ }
  try { return (await isAdminUnlocked()) ? 'admin' : null; } catch { return null; }
}
const isDedupKey = (s: string) => s.length >= 3 && s.length <= 200 && /^[A-Za-z0-9/_:|.-]+$/.test(s);

export async function GET(req: NextRequest) {
  if (!enabled()) return NextResponse.json({ ok: false, error: 'disabled' }, { status: 404 });
  if (!(await actorRole())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const key = String(req.nextUrl.searchParams.get('dedup_key') ?? '').trim();
  if (!key || !isDedupKey(key)) return NextResponse.json({ ok: false, error: 'bad key' }, { status: 400 });
  // Both reads fail safe: before the migration has run this is an empty thread and no overlay, which
  // renders exactly as a case nobody has argued about yet.
  const [thread, review] = await Promise.all([readThread(key), readClinicalReview(key)]);
  return NextResponse.json({ ok: true, turns: thread.turns, threadError: thread.error, clinicalReview: review });
}

export async function POST(req: NextRequest) {
  if (!enabled()) return NextResponse.json({ ok: false, error: 'disabled' }, { status: 404 });
  const actor = await actorRole();
  if (!actor) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { return NextResponse.json({ ok: false, error: 'bad body' }, { status: 400 }); }
  const key = String(body.dedup_key ?? '').trim();
  if (!key || !isDedupKey(key)) return NextResponse.json({ ok: false, error: 'bad key' }, { status: 400 });
  const q = normaliseQuestion(body.question);
  if (!q.ok) return NextResponse.json({ ok: false, error: q.error }, { status: 400 });
  if (!probeReachable('bedrock')) return NextResponse.json({ ok: false, error: 'the agent is not reachable in this deployment' }, { status: 503 });

  // O1 — the thread comes from the DB. No history field is read off the request at all.
  const thread = await readThread(key);
  const history = threadToHistory(thread.turns);

  // The SAME reads the case route makes: the pinned finding row, then the two bills. Nothing else.
  const r = await fetchFindingForSurface(key, READMIT_ENGINE_VERSION);
  if (!r) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  const blob = asJson<FindingBlob & CaseArtefacts>(r.finding);
  const findingClass = toFindingClass(r.finding_class);
  const indexId = String(r.index_encounter_id);
  const readmitId = r.readmit_encounter_id == null ? null : String(r.readmit_encounter_id);
  const [indexBill, readmitBill] = await Promise.all([
    fetchStayBillBreakdown(indexId),
    findingClass === 'out_of_network' || readmitId == null ? Promise.resolve<StayBillBreakdown | null>(null) : fetchStayBillBreakdown(readmitId),
  ]);
  const returnBill = returnBillFor({
    findingClass, readmitEncounterId: readmitBill == null ? null : readmitId, ok: readmitBill == null ? true : readmitBill.ok,
    total: readmitBill && readmitBill.ok && readmitBill.lines > 0 ? { netRs: readmitBill.totalRs, lines: readmitBill.lines } : null,
  });
  const surfaceRow = toFinding(r, undefined, null, returnBill);   // no Identity: the model never sees a name
  const material = askMaterialFrom(surfaceRow, blob, indexBill, readmitBill);

  // His words are stored FIRST. A model fault after this point loses the answer, never the question.
  const userTurn = await appendTurn({ dedupKey: key, role: 'user', content: q.question, actor });

  const a = await answerCaseQuestion({ dedupKey: key, material, history, question: q.question });

  // T6 / §12.4 — the pure gate is the only door. A refused overlay is not an error: the raw report is
  // still kept on the user's turn, so what the gate refused is as auditable as what it let in.
  const gate = gateOverlay(a.overlayRaw, q.question);
  let overlayWritten = false;
  if (gate.ok) {
    overlayWritten = await saveClinicalReview({
      dedupKey: key, review: gate.overlay, actor, turnId: userTurn?.id ?? null, model: NARRATIVE_MODEL_ID,
    });
  }

  if (a.outcome === 'withheld') {
    const agentTurn = await appendTurn({ dedupKey: key, role: 'agent', content: ASK_WITHHELD_COPY, withheld: true, overlay: a.overlayRaw ?? null });
    const review = overlayWritten ? await readClinicalReview(key) : null;
    return NextResponse.json({
      ok: true, withheld: true, reason: a.reason ?? 'unresolved', invalidIds: a.verdict?.invalidIds ?? [],
      copy: ASK_WITHHELD_COPY, cost: a.cost, answerable: false,
      overlay: overlayWritten && gate.ok ? gate.overlay : null, overlayReason: gate.ok ? null : gate.reason,
      clinicalReview: review, persisted: !!(userTurn && agentTurn),
    });
  }
  const agentTurn = await appendTurn({ dedupKey: key, role: 'agent', content: a.verdict!.answer, overlay: a.overlayRaw ?? null });
  const review = overlayWritten ? await readClinicalReview(key) : null;
  return NextResponse.json({
    ok: true, answer: a.verdict!.answer, citedIds: a.verdict!.citedIds, answerable: a.answerable !== false, cost: a.cost,
    overlay: overlayWritten && gate.ok ? gate.overlay : null, overlayReason: gate.ok ? null : gate.reason,
    clinicalReview: review, persisted: !!(userTurn && agentTurn),
  });
}
