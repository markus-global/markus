/**
 * What may leave a turn.
 *
 * A turn produces two very different kinds of text and they are the same kind of
 * token, so no payload inspection can tell them apart:
 *  - the ANSWER — the message the sender is waiting for;
 *  - the NARRATION — "继续施工。先看…" — process talk emitted between tool calls.
 *
 * The only reliable discriminator is structural: narration is always emitted *around
 * work* (tool calls), and the answer is the text that follows the work's end. So the
 * judgement uses two structural facts only:
 *   1. did a final response exist (a response that requested no tools)?
 *   2. did the close-out continuation actually do work?
 *
 * 2026-10-18 (DM → Anteum 技术主管): a runaway continuation executed 24 tool iterations
 * and then concatenated 15 narration fragments (`reply + contParts.join('')`); the blob
 * was posted as the reply and the peer burned an entire turn processing it. This module
 * is the single execution point for that judgement — callers must not re-derive it.
 */

export interface TurnReplyInput {
  /** Text of the turn's last response, when that response requested no tools. */
  finalText?: string;
  /** What the turn itself produced. May be narration if the turn was cut short. */
  reply: string;
  /** The turn closed itself via the typed `end_turn` signal. */
  endTurnRequested: boolean;
  /** Answer composed deliberately by a tools-disabled closing call. */
  composedAnswer?: string;
  /**
   * The close-out continuation executed at least one tool call — i.e. the turn was
   * still in the middle of work when it ran out. When false, nothing happened after
   * `reply`, so `reply` really is the last word of the turn.
   */
  continuationDidWork?: boolean;
}

export interface TurnReply {
  /** The only text allowed to cross the turn boundary. Empty = nothing to deliver. */
  text: string;
  /** True when the text is a real answer and is safe to deliver. */
  completed: boolean;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? value : undefined;
}

/**
 * The turn still owes an answer: no final response, no explicit end, and the
 * continuation had work left to do (so what it said last was narration, not a reply).
 */
export function shouldComposeAnswer(input: {
  finalText?: string;
  endTurnRequested: boolean;
  continuationDidWork?: boolean;
}): boolean {
  const answered = nonEmpty(input.finalText) !== undefined;
  return !answered && !input.endTurnRequested && input.continuationDidWork === true;
}

/**
 * Decide the single string that may be delivered for a finished turn.
 *
 * Precedence — and the reason for it:
 *  1. `finalText`      — a response that requested no tools is a finished message;
 *  2. `endTurnRequested` — the turn declared itself done; `reply` is its answer;
 *  3. continuation was idle — nothing happened after `reply`, so it stands;
 *  4. composed answer  — a deliberate answer produced with tools disabled;
 *  5. otherwise        — deliver nothing and report the turn as incomplete, so the
 *                        caller's retry/visibility path deals with it instead of
 *                        shipping narration as if it were an answer.
 */
export function decideTurnReply(input: TurnReplyInput): TurnReply {
  const finalText = nonEmpty(input.finalText);
  if (finalText !== undefined) return { text: finalText, completed: true };

  if (input.endTurnRequested) {
    const reply = nonEmpty(input.reply);
    return reply !== undefined
      ? { text: reply, completed: true }
      : { text: '', completed: true };
  }

  if (input.continuationDidWork !== true) {
    // The safety net ran and changed nothing: the turn had simply stopped.
    const reply = nonEmpty(input.reply);
    if (reply !== undefined) return { text: reply, completed: true };
  }

  const composed = nonEmpty(input.composedAnswer);
  if (composed !== undefined) return { text: composed, completed: true };

  return { text: '', completed: false };
}
