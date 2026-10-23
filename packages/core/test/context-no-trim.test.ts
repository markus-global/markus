/**
 * The platform must NOT trim history to make the bill smaller.
 *
 * Owner decision 2026-10-23. Evidence: tsk_5d43170472f6c0440a5666a7 ran ONE task
 * turn of 251 LLM calls / 18.7M input tokens while re-reading the same files
 * (223 shell calls) and re-stating its own position 63 times — the untrimmed
 * equivalent was ~6M. The trimming WAS the cost.
 *
 * What was deleted so it cannot come back:
 *   - per-scenario VIEW budgets (a2a 30k / task 60k / …)
 *   - the 120k ABSOLUTE history ceiling folding to 72k (it fired inside live
 *     turns; measured sawtooth 124k → 63k → 103k → 143k)
 *   - proactive compaction at 75% of the window
 *   - the double LLM summarization fallback
 *
 * What remains is ONE physical bound: the request must fit the model window.
 */

import { describe, it, expect } from 'vitest';
import { ContextEngine } from '../src/context-engine.js';
import type { LLMMessage } from '@markus/shared';

const memory = {
  serializeSlots: () => '',
  serializeSummary: () => '',
} as never;

/** ~chars/3.5 tokens; one user message of `chars` filler. */
function userMsg(marker: string, chars: number): LLMMessage {
  return { role: 'user', content: `${marker} ` + 'x'.repeat(chars) } as LLMMessage;
}

async function run(sessionMessages: LLMMessage[], modelContextWindow: number, modelMaxOutput: number) {
  const engine = new ContextEngine();
  return engine.prepareMessages({
    systemPrompt: 'sys',
    sessionMessages,
    memory,
    sessionId: 'sess_test',
    modelContextWindow,
    modelMaxOutput,
  });
}

describe('no automatic history trimming', () => {
  it('keeps a 150k-token history intact on a large window (the old 120k ceiling must NOT fire)', async () => {
    // 5 x 105k chars ≈ 150k tokens — above the deleted CONTEXT_ABS_HISTORY_TOKENS
    // (120k) but far below the window budget (~600k). Old code folded this to
    // 72k; that fold is what blinded the agent mid-turn.
    const history: LLMMessage[] = [];
    for (let i = 0; i < 5; i++) history.push(userMsg(`MARK_${i}`, 105_000));

    const out = await run(history, 1_000_000, 384_000);
    const flat = out.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');

    // Nothing was dropped: the earliest marker survives verbatim.
    expect(flat).toContain('MARK_0');
    expect(flat).toContain('MARK_4');
  });

  it('trims only when the request physically cannot fit the window', async () => {
    // ~1.75M chars ≈ 437k tokens against a ~144k budget: impossible to send.
    // Roles alternate on purpose: `sanitizeMessageSequence` merges consecutive
    // user messages, which would collapse the history into ONE message and make
    // the length guard in `trimToFitBudget` bail out (a green test that proves
    // nothing).
    const history: LLMMessage[] = [];
    for (let i = 0; i < 5; i++) {
      history.push(userMsg(`BIG_U${i}`, 175_000));
      history.push({ role: 'assistant', content: `BIG_A${i} ` + 'x'.repeat(175_000) } as LLMMessage);
    }

    const out = await run(history, 200_000, 40_000);
    const flat = out.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');

    // The newest end is what the agent needs; the physical bound drops the oldest.
    expect(flat).toContain('BIG_A4');
    expect(flat).not.toContain('BIG_U0');
  });

  it('reports compactStage "trim" only for the physical bound', async () => {
    const history: LLMMessage[] = [];
    for (let i = 0; i < 5; i++) {
      history.push(userMsg(`BIG_U${i}`, 175_000));
      history.push({ role: 'assistant', content: `BIG_A${i} ` + 'x'.repeat(175_000) } as LLMMessage);
    }

    const out = await run(history, 200_000, 40_000);
    expect(out.usage.compactStage).toBe('trim');
    expect(out.usage.compressed).toBe(false);
  });

  it('never reports proactive/over_budget/summarize stages (those mechanisms are deleted)', async () => {
    const history: LLMMessage[] = [];
    for (let i = 0; i < 5; i++) history.push(userMsg(`MARK_${i}`, 105_000));

    const out = await run(history, 1_000_000, 384_000);
    expect(['none', 'trim']).toContain(out.usage.compactStage);
    expect(out.usage.compressed).toBe(false);
  });
});
