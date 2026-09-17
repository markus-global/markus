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

// ─────────────────────────────────────────────────────────────────────────────
// Change 1 (2026-09-13) — durable `[SYSTEM] [State checkpoint]` on volatile change.
//
// The volatile tail is EPHEMERAL (never written back to the session store), so
// plain change-gating would be lossy. Whenever the state actually CHANGES the
// engine now ALSO appends the full state to durable history, markered
// `[SYSTEM] [State checkpoint]`, so the newest copy is replayed while unchanged
// calls stop re-billing it. Unchanged state must NOT append (no unbounded pile-up).
// ─────────────────────────────────────────────────────────────────────────────

interface RecordedAppend {
  sessionId: string;
  msg: LLMMessage;
}

/** Memory stub that ALSO records `appendMessage` (the checkpoint sink). */
function recordingMemory() {
  const appended: RecordedAppend[] = [];
  return {
    appended,
    serializeSlots: () => '',
    serializeSummary: () => '',
    appendMessage: (sessionId: string, msg: LLMMessage) => {
      appended.push({ sessionId, msg });
    },
  };
}

type RecMemory = ReturnType<typeof recordingMemory>;

async function prepWith(
  mem: RecMemory,
  sessionMessages: LLMMessage[],
  opts: { sessionId: string; volatileState?: string },
) {
  return engine.prepareMessages({
    systemPrompt: 'SYSTEM_PROMPT',
    sessionMessages,
    memory: mem as never,
    sessionId: opts.sessionId,
    modelContextWindow: WINDOW,
    volatileState: opts.volatileState ?? volatileBlob(),
  });
}

describe('ContextOS v2 — durable [State checkpoint] on volatile change', () => {
  it('checkpoints the full volatile state on the first call (no snapshot)', async () => {
    const mem = recordingMemory();
    await prepWith(mem, turnHistory(0), { sessionId: 'sess_ckpt_first' });

    expect(mem.appended).toHaveLength(1);
    const content = String(mem.appended[0]!.msg.content);
    expect(content.startsWith('[SYSTEM] [State checkpoint]')).toBe(true);
    // …and it carries the full body of every section, so the ephemeral tail is
    // not the only carrier of the state.
    expect(content).toContain('KNOWLEDGE_BODY_v1');
    expect(content).toContain('worker 2 → conv:cs_x');
    expect(content).toContain('Secretary: idle');
  });

  it('does NOT append again while the volatile state is unchanged', async () => {
    const mem = recordingMemory();
    const sid = 'sess_ckpt_stable';
    await prepWith(mem, turnHistory(0), { sessionId: sid });
    await prepWith(mem, turnHistory(1), { sessionId: sid });
    // Still exactly one checkpoint despite two calls.
    expect(mem.appended).toHaveLength(1);
  });

  it('appends a fresh checkpoint carrying the new content when a section changes', async () => {
    const mem = recordingMemory();
    const sid = 'sess_ckpt_change';
    await prepWith(mem, turnHistory(0), { sessionId: sid });
    await prepWith(mem, turnHistory(1), { sessionId: sid });
    await prepWith(mem, turnHistory(2), {
      sessionId: sid,
      volatileState: volatileBlob('Secretary: busy'),
    });

    expect(mem.appended).toHaveLength(2);
    const second = String(mem.appended[1]!.msg.content);
    expect(second.startsWith('[SYSTEM] [State checkpoint]')).toBe(true);
    expect(second).toContain('Secretary: busy');
    expect(second).not.toContain('Secretary: idle');
  });

  it('the checkpoint is synthetic: it never counts as a new user turn', async () => {
    const mem = recordingMemory();
    const sid = 'sess_ckpt_synthetic';
    // Establish a snapshot for this session.
    await prepWith(mem, turnHistory(1), { sessionId: sid });

    // Replay a history that ENDS with a checkpoint user-message (as the session
    // store would after the checkpoint above), with the volatile state unchanged.
    // If `findCurrentTurnStart` counted the checkpoint as a user turn it would sit
    // at the turn boundary with nothing after it → isFirstCallOfTurn → forceFull
    // → the full body would be re-sent. Treated as synthetic, it is not.
    const historyWithCheckpoint: LLMMessage[] = [
      { role: 'user', content: 'real request' } as LLMMessage,
      { role: 'assistant', content: 'a reply' } as LLMMessage,
      { role: 'user', content: '[SYSTEM] [State checkpoint]\n(state snapshot)' } as LLMMessage,
    ];
    const t = tail(await prepWith(mem, historyWithCheckpoint, { sessionId: sid }));

    expect(t).not.toContain('KNOWLEDGE_BODY_v1');
    expect(t).toContain('Background state');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Change 2 (2026-09-13) — `hashSection` normalises relative-time labels first.
//
// `## Notebook` renders entries as `### key (7h ago)`; those labels flip on their
// own hourly schedule, so hashing the raw body made the change gate fire and
// persist a checkpoint even when nothing actionable had changed. Normalising
// `(7h ago)` / `(23m ago)` / `(just started)` → `(age)` prevents that, while a real
// content edit still fires.
// ─────────────────────────────────────────────────────────────────────────────

function notebookBlob(age: string, word: string): string {
  return [
    '---',
    'Current date and time: 2026-09-16 15:00',
    '## Notebook',
    `### note (${age})`,
    `NOTE_BODY_${word.toUpperCase()}`,
  ].join('\n');
}

describe('ContextOS v2 — relative-time labels are normalised before hashing', () => {
  it('treats a bare age bump (7h ago → 8h ago) as UNCHANGED', async () => {
    const mem = recordingMemory();
    const sid = 'sess_age_norm';
    await prepWith(mem, turnHistory(0), {
      sessionId: sid,
      volatileState: notebookBlob('7h ago', 'alpha'),
    });
    const t2 = tail(
      await prepWith(mem, turnHistory(1), {
        sessionId: sid,
        volatileState: notebookBlob('8h ago', 'alpha'),
      }),
    );

    // No new checkpoint was persisted…
    expect(mem.appended).toHaveLength(1);
    // …and the unchanged section is omitted from the fresh-tail bodies.
    expect(t2).not.toContain('NOTE_BODY_ALPHA');
    expect(t2).toContain('Background state');
  });

  it('normalises other relative-time forms (just started / 23m ago)', async () => {
    const mem = recordingMemory();
    const sid = 'sess_age_forms';
    await prepWith(mem, turnHistory(0), {
      sessionId: sid,
      volatileState: notebookBlob('just started', 'alpha'),
    });
    await prepWith(mem, turnHistory(1), {
      sessionId: sid,
      volatileState: notebookBlob('23m ago', 'alpha'),
    });
    expect(mem.appended).toHaveLength(1);
  });

  it('still fires when a substantive word changes (alpha → beta)', async () => {
    const mem = recordingMemory();
    const sid = 'sess_word_change';
    await prepWith(mem, turnHistory(0), {
      sessionId: sid,
      volatileState: notebookBlob('7h ago', 'alpha'),
    });
    const t2 = tail(
      await prepWith(mem, turnHistory(1), {
        sessionId: sid,
        volatileState: notebookBlob('7h ago', 'beta'),
      }),
    );

    // A real edit is still treated as a change: a new checkpoint + the section
    // is delivered in full in this call's tail.
    expect(mem.appended).toHaveLength(2);
    expect(String(mem.appended[1]!.msg.content)).toContain('NOTE_BODY_BETA');
    expect(t2).toContain('NOTE_BODY_BETA');
  });
});
