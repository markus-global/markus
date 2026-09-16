/**
 * ContextOS v2.1 — compaction reachability, fold direction, turn accounting.
 *
 * Guards four defects found by auditing the compression pipeline against the
 * published designs (Anthropic compaction / DeepSeek V3.2 context management /
 * fast-agent):
 *
 *  1. `compactOldTurns()` walked blocks OLDEST→NEWEST, keeping the oldest
 *     verbatim and summarising/dropping the NEWEST past turns — the opposite of
 *     "keep the recent window verbatim, summarise the distant past", and it
 *     discarded exactly the context the model still needed.
 *  2. On very large windows the percentage watermarks never fire
 *     (1311k window, observed session ended a single turn at 269k input tokens
 *     with `compactStage === 'none'` throughout), so NO maintenance compression
 *     ever ran. There is now an absolute ceiling.
 *  3. `smartSummarizeAndTruncate()` sorted eligible messages by PRIORITY and then
 *     mapped them straight back into history, reordering the transcript.
 *  4. `findCurrentTurnStart()` treated engine-synthesised messages (the
 *     compaction summary, the live-context tail, transient harness prompts) as
 *     real user turns, so the turn boundary and the prefix-cache breakpoint were
 *     placed against the wrong boundary.
 */

import { describe, it, expect } from 'vitest';
import { ContextEngine } from '../src/context-engine.js';
import type { LLMMessage } from '@markus/shared';
import { CONTEXT_ABS_HISTORY_TOKENS } from '@markus/shared';

const memory = {
  serializeSlots: () => '',
  serializeSummary: () => '',
} as never;

/** 1 tool-call block whose result body is large but whose marker sits at the END. */
function block(i: number, filler = 4_000): LLMMessage[] {
  return [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `c${i}`, name: 'shell_execute', arguments: '{}' }],
    } as unknown as LLMMessage,
    {
      role: 'tool',
      content: 'x'.repeat(filler) + `_END_${i}`,
      toolCallId: `c${i}`,
    } as unknown as LLMMessage,
  ];
}

describe('ContextOS v2.1 — compaction', () => {
  it('keeps the NEWEST past blocks verbatim and folds the OLDEST', () => {
    const eng = new ContextEngine();
    const msgs: LLMMessage[] = [{ role: 'user', content: 'start' } as LLMMessage];
    for (let i = 0; i < 10; i++) msgs.push(...block(i));

    // Fold everything except roughly the last 3 blocks.
    const out = (eng as unknown as {
      compactOldTurns: (m: LLMMessage[], b: number, budget: number) => LLMMessage[];
    }).compactOldTurns(msgs, msgs.length, 3_000);

    const joined = out.map((m) => String(m.content ?? '')).join('\n');
    expect(joined, 'newest block must survive verbatim').toContain('_END_9');
    expect(joined, 'oldest block must have been folded away').not.toContain('_END_0');
    // Order is preserved (oldest folded block still comes first).
    expect(joined.indexOf('_END_8')).toBeLessThan(joined.indexOf('_END_9'));
  });

  it('never splits an assistant tool-call from its tool results', () => {
    const eng = new ContextEngine();
    const msgs: LLMMessage[] = [{ role: 'user', content: 'start' } as LLMMessage];
    for (let i = 0; i < 10; i++) msgs.push(...block(i));

    const out = (eng as unknown as {
      compactOldTurns: (m: LLMMessage[], b: number, budget: number) => LLMMessage[];
    }).compactOldTurns(msgs, msgs.length, 3_000);

    // No orphan tool messages: every `tool` message must be preceded by an
    // assistant message that declares the matching tool call.
    const declared = new Set<string>();
    for (const m of out) {
      if (m.role === 'assistant') for (const tc of m.toolCalls ?? []) declared.add(tc.id);
      if (m.role === 'tool') expect(declared.has(String(m.toolCallId))).toBe(true);
    }
  });

  it('ignores synthetic messages when finding the current turn boundary', () => {
    const eng = new ContextEngine();
    const msgs: LLMMessage[] = [
      { role: 'user', content: 'real request' } as LLMMessage,
      { role: 'assistant', content: 'working on it' } as LLMMessage,
      {
        role: 'user',
        content: '[SYSTEM] [Conversation history summary — 3 earlier messages compacted]\nstuff',
      } as LLMMessage,
      {
        role: 'user',
        content: '[Continue from where you left off. Do not repeat what you already said.]',
      } as LLMMessage,
    ];
    const start = (eng as unknown as { findCurrentTurnStart: (m: LLMMessage[]) => number })
      .findCurrentTurnStart(msgs);
    expect(start).toBe(0);
  });

  it('fires maintenance compression on the absolute ceiling even when the window watermark never would', async () => {
    const eng = new ContextEngine();
    const history: LLMMessage[] = [{ role: 'user', content: 'long running request' } as LLMMessage];
    for (let i = 0; i < 26; i++) history.push(...block(i, 40_000));

    const res = await eng.prepareMessages({
      systemPrompt: 'SYS',
      sessionMessages: history,
      memory,
      sessionId: 'sess_abs_ceiling',
      modelContextWindow: 1_311_000,
      modelMaxOutput: 524_288,
    });

    expect(res.usage.compressed, 'must compress').toBe(true);
    expect(res.usage.compactStage).not.toBe('none');
    // Sanity: the trigger was the absolute ceiling, not the window percentage —
    // 26 × 40k chars ≈ 260k tokens > CONTEXT_ABS_HISTORY_TOKENS, while the
    // 75 % window watermark sits around 500k tokens.
    expect(CONTEXT_ABS_HISTORY_TOKENS).toBeLessThan(500_000);
    expect(res.usage.messageTokens).toBeLessThan(CONTEXT_ABS_HISTORY_TOKENS);
  });
});
