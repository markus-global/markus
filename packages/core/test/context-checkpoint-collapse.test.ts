/**
 * State checkpoints must be COLLAPSED, not accumulated.
 *
 * Measured 2026-10-29 (~/.markus/llm-logs/2026-10-29.jsonl, GEO A2A burst):
 * 247 `[SYSTEM] [State checkpoint]` messages across 26 sessions — 3.4M chars
 * of state, and ONE session carried 26 checkpoints / 474 695 chars. They were
 * never rewritten in place (0 hash changes at a fixed index); they simply piled
 * up, and every request replayed all of them.
 *
 * Naively keeping "only the newest" is WRONG: a checkpoint writes only the
 * sections that CHANGED, so the newest one legitimately lacks sections written
 * earlier (measured: `## Team Status` and `## Notebook` existed only in older
 * checkpoints). Dropping them would lose information.
 *
 * The lossless collapse: parse every checkpoint into `## Section` bodies and
 * keep the NEWEST body per section — legal because each body is the complete
 * current body of that section (the writer's own invariant), so the newest
 * occurrence is authoritative.
 *
 * Contract locked here:
 *   1. Output carries at most ONE checkpoint message.
 *   2. It carries every section any checkpoint ever wrote, latest body wins.
 *   3. It sits at the LAST checkpoint's position (as late as possible, so the
 *      fewest replayed messages follow the change).
 *   4. The caller's stored messages are never mutated.
 *   5. Deterministic: same input ⇒ same bytes (so the prefix stays stable).
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
const CKPT = '[SYSTEM] [State checkpoint]';

async function prep(sessionMessages: LLMMessage[], sessionId = 'sess_ckpt') {
  return engine.prepareMessages({
    systemPrompt: 'SYSTEM_PROMPT',
    sessionMessages,
    memory,
    sessionId,
    modelContextWindow: WINDOW,
    volatileState: '---\nCurrent date and time: 2026-10-29 12:00',
  });
}

function checkpointsOf(msgs: LLMMessage[]): string[] {
  return msgs.filter((m) => String(m.content).startsWith(CKPT)).map((m) => String(m.content));
}

function sectionBodies(ckpt: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = ckpt.slice(CKPT.length);
  for (const part of body.split(/\n(?=## )/)) {
    const m = /^##\s+(.+?)\s*$/.exec(part.split('\n')[0] ?? '');
    if (m) out[m[1]!] = part.trim();
  }
  return out;
}

describe('prepareMessages — state checkpoint collapse', () => {
  it('collapses N accumulated checkpoints into ONE', async () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'do the work' },
      { role: 'user', content: `${CKPT}\n## Team Status\nsecretary: idle` },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: `${CKPT}\n## Notebook\nkey: value` },
      { role: 'assistant', content: 'ok again' },
      { role: 'user', content: `${CKPT}\n## Team Status\nsecretary: busy` },
      { role: 'tool', content: 'tool output', toolCallId: 't1' },
    ];

    const result = await prep(messages);
    const ckpts = checkpointsOf(result.messages);

    expect(ckpts.length).toBe(1);
  });

  it('keeps every section ever written, with the LATEST body per section', async () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'user', content: `${CKPT}\n## OnlyInOld\nOLD_SECTION_MARKER` },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: `${CKPT}\n## Team Status\nSTATUS_OLD` },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: `${CKPT}\n## Team Status\nSTATUS_NEW` },
    ];

    const result = await prep(messages);
    const ckpts = checkpointsOf(result.messages);
    expect(ckpts.length).toBe(1);

    const bodies = sectionBodies(ckpts[0]!);
    // A section written only by an OLD checkpoint must survive...
    expect(bodies['OnlyInOld']).toContain('OLD_SECTION_MARKER');
    // ...and the newest body wins where sections repeat.
    expect(bodies['Team Status']).toContain('STATUS_NEW');
    expect(bodies['Team Status']).not.toContain('STATUS_OLD');
  });

  it('places the collapsed checkpoint at the LAST checkpoint position', async () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'user', content: `${CKPT}\n## A\naaa` },
      { role: 'assistant', content: 'mid' },
      { role: 'user', content: `${CKPT}\n## B\nbbb` },
      { role: 'assistant', content: 'after' },
    ];

    const result = await prep(messages);
    const idx = result.messages.findIndex((m) => String(m.content).startsWith(CKPT));
    // The 'after' assistant message is the last real message; the checkpoint
    // must sit at/after the position the second (last) checkpoint occupied,
    // i.e. nothing but the ephemeral tail may follow it.
    const afterCkpt = result.messages.slice(idx + 1).filter((m) => m.role === 'assistant');
    expect(afterCkpt.length).toBeLessThanOrEqual(1);
  });

  it('is deterministic and does not mutate stored history', async () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'user', content: `${CKPT}\n## A\naaa` },
      { role: 'user', content: `${CKPT}\n## B\nbbb` },
    ];
    const before = JSON.stringify(messages);

    const r1 = await prep(messages);
    const r2 = await prep(messages);

    expect(JSON.stringify(messages)).toBe(before);
    expect(JSON.stringify(checkpointsOf(r1.messages))).toBe(JSON.stringify(checkpointsOf(r2.messages)));
  });

  it('leaves a single checkpoint untouched (no needless rewrite)', async () => {
    const one = `${CKPT}\n## Only\nBODY`;
    const messages: LLMMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'user', content: one },
    ];

    const result = await prep(messages);
    const ckpts = checkpointsOf(result.messages);
    expect(ckpts.length).toBe(1);
    expect(ckpts[0]).toBe(one);
  });
});
