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
 * Transport faults keep the existing ladder: three attempts with exponential backoff.
 */

import { governedChat } from '../trace';

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

export const TRANSPORT_ATTEMPTS = 3;

/**
 * Call the model. Never throws — every failure comes back as `error`, because an audit that dies on
 * a provider hiccup is worse than one that records the hiccup.
 */
export async function callModel(input: ModelCallInput): Promise<ModelCallResult> {
  let attempts = 0;
  let finishReason: string | null = null;
  let lastError = 'no attempt was made';
  let truncationsSeen = 0;

  // Up to one EXTRA pass beyond the transport ladder, spent only on a truncation retry.
  for (let round = 0; round < 2; round++) {
    const extra = round === 0 ? '' : `\n\n${input.truncationRetryInstruction}`;

    for (let attempt = 0; attempt < TRANSPORT_ATTEMPTS; attempt++) {
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
        return { text, finishReason, attempts, truncated: false, error: null };
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

  if (truncationsSeen > 0) {
    return {
      text: '', finishReason: 'length', attempts, truncated: true,
      error: `${lastError} — retried once asking for fewer items and it truncated again; the call's max_tokens or its output cap needs re-deriving`,
    };
  }
  return { text: '', finishReason, attempts, truncated: false, error: lastError };
}
