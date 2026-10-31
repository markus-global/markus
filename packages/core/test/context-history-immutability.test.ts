/**
 * History immutability — `prepareMessages` must never mutate the caller's
 * messages.
 *
 * Measured incident (2026-10-29, ~/.markus/llm-logs/2026-10-29.jsonl):
 * session `cs_315368b6c6c54bb3` carried a user message whose content grew
 * 556 → 587 → 618 → … → 1145 chars, +31 chars on EVERY LLM call, 37 times in
 * a row. `sanitizeMessageSequence` merged consecutive user messages with
 *
 *     prev.content = prev.content + '\n\n' + msg.content;
 *
 * where `prev` is the *stored* message object. The merge was persisted by
 * side effect, but the mergee was never removed (the filtered array is only
 * returned, not written back). So every subsequent call merged the same pair
 * again — the sentence was appended once per call, forever.
 *
 * Cost: the message sits in the MIDDLE of history, so every one of the ~45
 * messages after it stopped being a cacheable prefix. ~1.46M chars of prompt
 * were re-billed across the window.
 *
 * Contract locked here: the assembled result may differ from the input, but
 * the input objects must come back byte-identical.
 */

import { describe, it, expect } from 'vitest';
import { ContextEngine } from '../src/context-engine.js';
import type { LLMMessage } from '@markus/shared';

const engine = new ContextEngine();

const memory = {
  serializeSlots: () => '',
  serializeSummary: () => '',
} as never;

const WINDOW = 1_000_000;

async function prep(sessionMessages: LLMMessage[], sessionId = 'sess_immut') {
  return engine.prepareMessages({
    systemPrompt: 'SYSTEM_PROMPT',
    sessionMessages,
    memory,
    sessionId,
    modelContextWindow: WINDOW,
    volatileState: '---\nCurrent date and time: 2026-10-29 12:00',
  });
}

function snapshot(msgs: LLMMessage[]): string {
  return JSON.stringify(msgs.map((m) => ({ role: m.role, content: m.content, toolCallId: m.toolCallId })));
}

describe('prepareMessages — history immutability', () => {
  it('does not mutate consecutive user messages that it merges', async () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: '你的角色定义还有心跳文件，是不是不太合理' },
      { role: 'user', content: '看看如何更新一下' },
    ];
    const before = snapshot(messages);

    const result = await prep(messages);

    expect(snapshot(messages)).toBe(before);
    // The merge itself is still performed in the RETURNED messages.
    const merged = result.messages.filter((m) => m.role === 'user' && m.content.includes('你的角色定义'));
    expect(merged.length).toBe(1);
    expect(String(merged[0].content)).toContain('看看如何更新一下');
  });

  it('is idempotent across repeated calls — content must not grow per call', async () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'HEAD_MESSAGE_MARKER' },
      { role: 'user', content: 'TAIL_APPEND_MARKER' },
      { role: 'assistant', content: 'ack' },
    ];

    // Simulate a tool loop: the SAME stored history is replayed N times.
    const lengths: number[] = [];
    for (let i = 0; i < 5; i++) {
      const result = await prep(messages);
      const head = result.messages.find((m) => m.role === 'user' && String(m.content).includes('HEAD_MESSAGE_MARKER'));
      lengths.push(String(head?.content ?? '').length);
    }

    // Every replay must produce the same prefix length — no per-call growth.
    expect(new Set(lengths).size).toBe(1);
  });

  it('leaves tool/assistant history untouched (no accidental rewrite)', async () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'shell_execute', arguments: { command: 'ls' } }] },
      { role: 'tool', content: 'file-a\nfile-b', toolCallId: 'c1' },
      { role: 'assistant', content: 'done' },
    ];
    const before = snapshot(messages);

    await prep(messages);

    expect(snapshot(messages)).toBe(before);
  });
});
