/**
 * ContextOS v2 — change-gated volatile tail + transient-prompt dedupe.
 *
 * Regression guard for the 2026-09-16 repetition incident: inside ONE user turn
 * a tool loop issued 66 LLM calls and the volatile blob (7 775 chars, 99.89%
 * identical between consecutive calls) was re-sent verbatim every single time.
 * A persistent fact inside it (another clone working on the same topic) was
 * therefore re-delivered 66× and the model — reading it as the newest user input
 * immediately before generating — re-announced it on every iteration.
 *
 * Contract locked here:
 *   1. First call of a user turn  → FULL volatile snapshot.
 *   2. Later calls, unchanged     → background omitted, replaced by a digest.
 *   3. Changed section            → that section in full; the rest still omitted.
 *   4. Every CONTEXT_VOLATILE_REARM_CALLS calls → forced full refresh (bounds
 *      staleness so nothing can stay hidden forever — completeness invariant).
 *   5. New user turn              → FULL snapshot again.
 *   6. Stacked `[Continue …]` / `[SYSTEM] Loop detected …` collapse to the latest.
 */

import { describe, it, expect } from 'vitest';
import { ContextEngine } from '../src/context-engine.js';
import type { LLMMessage } from '@markus/shared';
import { CONTEXT_VOLATILE_REARM_CALLS } from '@markus/shared';

const engine = new ContextEngine();

const memory = {
  serializeSlots: () => '',
  serializeSummary: () => '',
} as never;

const WINDOW = 1_000_000;

function volatileBlob(teamStatus = 'Secretary: idle'): string {
  return [
    '---',
    'Current date and time: 2026-09-16 15:00',
    '## Your Knowledge',
    'KNOWLEDGE_BODY_v1',
    '## Concurrency Context（并发上下文）',
    'worker 2 → conv:cs_x：正在处理同一话题',
    '## Team Status',
    teamStatus,
  ].join('\n');
}

async function prep(
  sessionMessages: LLMMessage[],
  opts: { volatileState?: string; sessionId?: string } = {},
) {
  return engine.prepareMessages({
    systemPrompt: 'SYSTEM_PROMPT',
    sessionMessages,
    memory,
    sessionId: opts.sessionId ?? 'sess_gating',
    modelContextWindow: WINDOW,
    volatileState: opts.volatileState ?? volatileBlob(),
  });
}

/** [user request] + N tool iterations inside that same user turn. */
function turnHistory(iterations: number, request = 'do the thing'): LLMMessage[] {
  const msgs: LLMMessage[] = [{ role: 'user', content: request }];
  for (let i = 0; i < iterations; i++) {
    msgs.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `c${i}`, name: 'shell_execute', arguments: '{}' }],
    } as unknown as LLMMessage);
    msgs.push({ role: 'tool', content: `result ${i}`, toolCallId: `c${i}` } as unknown as LLMMessage);
  }
  return msgs;
}

function tail(res: Awaited<ReturnType<typeof prep>>): string {
  const last = res.messages[res.messages.length - 1]!;
  return String(last.content ?? '');
}

describe('ContextOS v2 — change-gated volatile tail', () => {
  it('1. first call of a user turn delivers the full volatile snapshot', async () => {
    const t = tail(await prep(turnHistory(0), { sessionId: 'sess_first' }));
    expect(t).toContain('## Your Knowledge');
    expect(t).toContain('KNOWLEDGE_BODY_v1');
    expect(t).toContain('worker 2 → conv:cs_x');
  });

  it('2. later iterations of the SAME turn omit unchanged background', async () => {
    const sid = 'sess_omit';
    await prep(turnHistory(0), { sessionId: sid });
    const t2 = tail(await prep(turnHistory(1), { sessionId: sid }));

    // body omitted (not re-primed as news) …
    expect(t2).not.toContain('KNOWLEDGE_BODY_v1');
    expect(t2).not.toContain('worker 2 → conv:cs_x');
    // … but the agent is still told the background exists (completeness).
    expect(t2).toContain('Background state');
    expect(t2).toContain('Your Knowledge');
    expect(t2).toContain('Concurrency Context');
  });

  it('3. a changed section is delivered in full while the rest stay omitted', async () => {
    const sid = 'sess_changed';
    await prep(turnHistory(0), { sessionId: sid });
    await prep(turnHistory(1), { sessionId: sid });
    const t3 = tail(await prep(turnHistory(2), { sessionId: sid, volatileState: volatileBlob('Secretary: busy') }));

    expect(t3).toContain('Secretary: busy');
    expect(t3).not.toContain('KNOWLEDGE_BODY_v1');
  });

  it('4. re-arms a full refresh after CONTEXT_VOLATILE_REARM_CALLS calls', async () => {
    const sid = 'sess_rearm';
    const seen: string[] = [];
    for (let i = 0; i < CONTEXT_VOLATILE_REARM_CALLS + 2; i++) {
      seen.push(tail(await prep(turnHistory(i), { sessionId: sid })));
    }
    // call #2 (index 1) is the fast path …
    expect(seen[1]).not.toContain('KNOWLEDGE_BODY_v1');
    // … and a later call must re-deliver it so nothing stays hidden forever.
    expect(seen.slice(2).some((t) => t.includes('KNOWLEDGE_BODY_v1'))).toBe(true);
  });

  it('5. a NEW user turn starts from a full snapshot again', async () => {
    const sid = 'sess_newturn';
    await prep(turnHistory(0), { sessionId: sid });
    await prep(turnHistory(3), { sessionId: sid });
    const nextTurn = [...turnHistory(3), { role: 'user', content: 'next question' } as LLMMessage];
    const t = tail(await prep(nextTurn, { sessionId: sid }));
    expect(t).toContain('KNOWLEDGE_BODY_v1');
  });

  it('6. stacked transient harness prompts collapse to the latest copy', async () => {
    const history: LLMMessage[] = [{ role: 'user', content: 'original request' }];
    for (let i = 0; i < 3; i++) {
      history.push({ role: 'assistant', content: `reply ${i}` } as LLMMessage);
      history.push({
        role: 'user',
        content: '[Continue from where you left off. Do not repeat what you already said.]',
      } as LLMMessage);
    }

    const res = await prep(history, { sessionId: 'sess_dedupe' });
    const continuations = res.messages.filter(
      (m) => m.role === 'user' && String(m.content).startsWith('[Continue from where you left off'),
    );
    expect(continuations).toHaveLength(1);
  });

  it('7. loop-detection warnings collapse to the latest copy', async () => {
    const history: LLMMessage[] = [{ role: 'user', content: 'original request' }];
    for (let i = 0; i < 3; i++) {
      history.push({ role: 'assistant', content: `reply ${i}` } as LLMMessage);
      history.push({
        role: 'user',
        content: '[SYSTEM] Loop detected: "file_edit" returned identical results 5 times.',
      } as LLMMessage);
    }
    const res = await prep(history, { sessionId: 'sess_dedupe_loop' });
    const warns = res.messages.filter((m) => m.role === 'user' && String(m.content).startsWith('[SYSTEM] Loop detected:'));
    expect(warns).toHaveLength(1);
  });
});
