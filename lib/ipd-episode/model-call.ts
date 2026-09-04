/**
 * lib/ipd-episode/model-call.ts — THE ONE PLACE THIS ENGINE CALLS A MODEL.
 *
 * ⚠️ WHY THIS FILE EXISTS: THE SAME DEFECT, THREE TIMES IN FOUR ROUNDS.
 *
 *   round 8   the day-2 checkpoint returned finish_reason `length` on every attempt of every run
 *             for five consecutive runs. The checkpoint was recorded `status: error` with zero
 *             entries and the episode scored `ok` on the remaining three quarters.
 *   round 10  the same truncation, unnoticed, was the reason a whole day of expected course was
 *             missing from every score above.
 *   round 11  IPNO-416's DIFF pass: `finish_reason=length`, content_length 22677, episode skipped.
 *
 * Every occurrence had the same shape and a separate retry loop that handled it slightly
 * differently, and each fix raised one ceiling without re-deriving the others. So there is now ONE
 * helper, used by every call site, and truncation is a FIRST-CLASS FAILURE inside it:
 *
 *   · a `length` finish is never accepted as an answer, however much content came back — a
 *     truncated JSON body is not a short answer, it is an unparseable one;
 *   · it is retried ONCE with an instruction to emit only the most consequential items, because a
 *     model asked for less usually gives less, and that is a cheaper fix than a bigger ceiling;
 *   · a second truncation FAILS THE CALL with a reason naming the call and the character count, so
 *     the next person sees which call and how big rather than a generic provider error.
 *
 * ⚠️ ROUND 13 — AND THE LADDER THAT MADE A TIMEOUT FATAL TO THE WHOLE INVOCATION.
 *
 * IP-1483's diff pass timed out three times and killed the function. The arithmetic:
 * `governedChat` on Bedrock already runs its own ladder — PROVIDER_BUDGETS.bedrock.utility, 110 s
 * per attempt × 3, which is 332,250 ms of worst case in ONE call to it. This helper then wrapped
 * that in THREE more attempts of its own. Nine provider attempts, ~996 s, inside an 800 s box: the
 * invocation died at the third, having written no audit row and no skip row.
 *
 * TWO THINGS FOLLOW, and they are items 1 and 2 of round 13.
 *
 * · ONE ATTEMPT HERE (`TRANSPORT_ATTEMPTS = 1`). The reasoning this file already applies to
 *   truncation applies unchanged to a timeout: a retry at the same size gets the same timeout.
 *   The provider ladder inside `governedChat` is the retry; a second ladder around it is not
 *   resilience, it is the same failure three times at triple the price.
 *
 * · NO ATTEMPT IS STARTED THAT THE BUDGET CANNOT FINISH. The caller passes `deadlineAt` — the
 *   wall-clock moment the invocation must be done by — and this helper refuses to begin a call
 *   when less than one worst case remains. A refusal is a returned `error`, so the episode lands
 *   as a recorded `diff_failed` skip (PRD §8) instead of a killed invocation that leaves nothing
 *   behind. The deadline and the budget remaining are recorded at every attempt.
 *
 * THE WORST CASE IS DERIVED, NEVER TYPED. `ONE_CALL_WORST_CASE_MS` comes from the same
 * PROVIDER_BUDGETS table the transport reads. A number copied by hand here would have to be
 * edited in step with a table it cannot see — which is the defect one level up, and round 12
 * already paid for that lesson once with the cast gate.
 */

import { governedChat } from '../trace';
import { totalBudgetMs } from '../lab-provider-core';

export interface ModelCallInput {
  traceId: string | undefined;
  /** Trace label, e.g. `ipd_episode_diff`. Also names the call in a truncation failure. */
  label: string;
  system: string;
  user: string;
  model: string;
  maxTokens: number;
  temperature: number;
  promptRef: string;
  /**
   * Appended to the user message on the ONE truncation retry. Must ask for less output — a retry
   * that asks for the same thing gets the same length.
   */
  truncationRetryInstruction: string;
  /**
   * ROUND 13 ITEM 1. Epoch ms by which the INVOCATION — not this call — must be finished. No
   * attempt begins unless a whole `ONE_CALL_WORST_CASE_MS` still fits before it.
   *
   * `null` or absent means unbudgeted, and that is deliberate rather than an oversight: a unit
   * test calling a stub has no box to fit in. Every production call site passes one.
   */
  deadlineAt?: number | null;
}

/** What the budget did on this call, recorded whether it helped or refused (round 13 item 1). */
export interface ModelCallBudget {
  deadlineAt: number | null;
  /** Budget remaining at the moment each attempt was CONSIDERED, in order. */
  remainingMsAtAttempt: number[];
  /** True when an attempt was refused because less than one worst case remained. */
  refusedForBudget: boolean;
  /** The worst case one call was measured against, so a reader need not re-derive it. */
  worstCaseMs: number;
}

export interface ModelCallResult {
  text: string;
  /** The provider's finish_reason from the last attempt, recorded whether or not it succeeded. */
  finishReason: string | null;
  attempts: number;
  /** True when the call ended in a truncation that the retry did not fix. */
  truncated: boolean;
  /** Non-null when the call produced nothing usable. Names the call and, on truncation, the size. */
  error: string | null;
  budget: ModelCallBudget;
}

/**
 * Does this error mean the provider stopped because it ran out of room?
 *
 * The transport throws a ProviderResponseError whose message carries the finish_reason (see
 * lib/provider-error-core.ts). `length` is Converse's `max_tokens` mapped through
 * lib/bedrock-core.ts's mapStopReason. Matching on the message is unlovely, but the alternative is
 * reaching into a typed error the UNTOUCHED transport does not export.
 */
export function isTruncation(message: string): boolean {
  return /finish_reason=length|\(length\)/.test(message);
}

/** The character count the provider managed before being cut off, when the message reports one. */
export function truncatedAt(message: string): number | null {
  const m = /content_length=(\d+)/.exec(message);
  return m ? Number(m[1]) : null;
}

const finishReasonOf = (res: unknown): string | null =>
  String((res as { choices?: { finish_reason?: unknown }[] })?.choices?.[0]?.finish_reason ?? '') || null;

const contentOf = (res: unknown): string =>
  String((res as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content ?? '');

/**
 * ONE. See the round-13 note in the header: `governedChat` already runs the provider ladder, and
 * wrapping it in a second one turned a 332 s failure into a 996 s one that killed the invocation.
 *
 * A named constant rather than an inlined 1, because every reader who has looked at this file has
 * come to it asking how many times a call is retried, and the answer should be findable.
 */
export const TRANSPORT_ATTEMPTS = 1;

/**
 * The worst case ONE call to `governedChat` can cost on Bedrock, sleeps included.
 *
 * READ FROM THE TABLE THE TRANSPORT ITSELF READS. `bedrockGenerate` defaults an un-budgeted caller
 * to `PROVIDER_BUDGETS.bedrock.utility` (lib/bedrock.ts), so that is the class this engine's calls
 * belong to until someone rules otherwise, and `totalBudgetMs` is the same arithmetic the route
 * budget guard applies to every other worker: perAttemptMs × maxTries + the backoff allowance.
 *
 * It evaluates to 332,250 ms, and IP-1483 measured 332,735 ms and 331,818 ms on two consecutive
 * diff attempts — so this is the real number, not a modelled one.
 *
 * The fallback exists only so a missing table entry cannot make this NaN and disable the guard
 * silently; it is the same arithmetic on the same documented defaults.
 */
export const ONE_CALL_WORST_CASE_MS = totalBudgetMs('bedrock', 'utility') ?? 332_250;

/**
 * Call the model. Never throws — every failure comes back as `error`, because an audit that dies on
 * a provider hiccup is worse than one that records the hiccup.
 */
export async function callModel(input: ModelCallInput): Promise<ModelCallResult> {
  let attempts = 0;
  let finishReason: string | null = null;
  let lastError = 'no attempt was made';
  let truncationsSeen = 0;

  const deadlineAt = input.deadlineAt ?? null;
  const budget: ModelCallBudget = {
    deadlineAt, remainingMsAtAttempt: [], refusedForBudget: false, worstCaseMs: ONE_CALL_WORST_CASE_MS,
  };
  const done = (r: Omit<ModelCallResult, 'budget'>): ModelCallResult => ({ ...r, budget });

  // Up to one EXTRA pass beyond the transport ladder, spent only on a truncation retry.
  for (let round = 0; round < 2 && !budget.refusedForBudget; round++) {
    const extra = round === 0 ? '' : `\n\n${input.truncationRetryInstruction}`;

    for (let attempt = 0; attempt < TRANSPORT_ATTEMPTS; attempt++) {
      // ⚠️ THE BUDGET CHECK COMES BEFORE THE ATTEMPT COUNTER, so a refused attempt is not counted
      // as one that was made. `attempts` is read downstream as "how many times did we ask the
      // provider", and a call we declined to place is not an ask.
      if (deadlineAt != null) {
        const remainingMs = deadlineAt - Date.now();
        budget.remainingMsAtAttempt.push(remainingMs);
        if (remainingMs < ONE_CALL_WORST_CASE_MS) {
          budget.refusedForBudget = true;
          lastError = `${input.label}: not started — ${Math.max(0, remainingMs)} ms of the invocation budget remained and one call can cost up to ${ONE_CALL_WORST_CASE_MS} ms`;
          break;
        }
      }
      attempts++;
      if (attempt > 0) await new Promise((r) => setTimeout(r, 750 * Math.pow(2, attempt - 1)));
      try {
        const res = await governedChat(input.traceId, input.label, {
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: `${input.user}${extra}` },
          ],
          temperature: input.temperature,
          max_tokens: input.maxTokens,
        }, { bedrock: input.model, promptRef: input.promptRef });

        finishReason = finishReasonOf(res);
        const text = contentOf(res);

        // A `length` finish that did NOT throw: accept nothing from it either. The transport
        // usually throws first, but a provider that returns 200 with a truncated body and a clean
        // status would otherwise slip a half-written JSON object into the parser.
        if (finishReason === 'length') { truncationsSeen++; lastError = `${input.label}: truncated (finish_reason=length, ${text.length} chars)`; break; }
        if (!text.trim()) { lastError = `${input.label}: the response was empty`; continue; }
        return done({ text, finishReason, attempts, truncated: false, error: null });
      } catch (e) {
        const msg = String((e as Error).message);
        lastError = msg.slice(0, 400);
        if (isTruncation(msg)) {
          truncationsSeen++;
          finishReason = 'length';
          const at = truncatedAt(msg);
          lastError = `${input.label}: truncated (finish_reason=length${at ? `, ${at} chars` : ''}) on model ${input.model}`;
          break;   // leave the transport ladder; a retry at the same size gets the same length
        }
      }
    }

    // Only a truncation earns the second round. Anything else has already spent its ladder.
    if (truncationsSeen === 0) break;
    if (round === 1) break;
  }

  // A budget refusal is reported as ITSELF, never dressed up as a truncation: the two ask
  // different things of the next person. One says the prompt is too big for the ceiling; the other
  // says there was no room left in the box to try at all.
  if (budget.refusedForBudget) {
    return done({ text: '', finishReason, attempts, truncated: false, error: lastError });
  }
  if (truncationsSeen > 0) {
    return done({
      text: '', finishReason: 'length', attempts, truncated: true,
      error: `${lastError} — retried once asking for fewer items and it truncated again; the call's max_tokens or its output cap needs re-deriving`,
    });
  }
  return done({ text: '', finishReason, attempts, truncated: false, error: lastError });
}
