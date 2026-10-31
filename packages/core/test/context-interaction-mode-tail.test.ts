/**
 * `## Current Interaction Mode` must live in the VOLATILE TAIL, not in the
 * byte-stable system message — and it must be sent in FULL on every call.
 *
 * Why: a session can be used for BOTH a human chat turn and an A2A turn (an A2A
 * reply delivered `in_session` lands in the session that started it). The mode
 * section differs between them, so while it sits in `system`, every alternation
 * invalidates the ENTIRE cached prefix.
 *
 * Measured 2026-10-29 13:35–14:00 (/api/usage window, 29 calls / 11.07M prompt
 * tokens): 14 calls — 58.2% of all prompt tokens — had ZERO prefix reuse, all of
 * them `div@0` on this one section. Session cs_51d3f2b304a74142 alternated
 * human_chat(38817 chars) ⇄ a2a(36230 chars) 8:5 times; common prefix collapsed
 * to 34,550 of 38,817.
 *
 * The trap this test guards: the volatile tail is CHANGE-GATED (a section is
 * omitted after its first delivery within a turn). Dropping behavioural
 * instructions to a digest mid-tool-loop would be a real regression, so the mode
 * section must be exempt from gating — always fresh.
 */

import { describe, it, expect } from 'vitest';
import { ContextEngine } from '../src/context-engine.js';
import type { LLMMessage, RoleTemplate } from '@markus/shared';

const engine = new ContextEngine();

const memory = {
  serializeSlots: () => '',
  serializeSummary: () => '',
  // `buildSystemPrompt` reads the long-term memory for the knowledge section.
  getLongTermMemory: () => '',
  getEntries: () => [],
  search: () => [],
  getObservations: () => [],
  getMemoryHealth: () => ({ percent: 0, curatedChars: 0, curatedCap: 15000, curatedSections: 0, lastConsolidatedAt: null }),
} as never;

const WINDOW = 1_000_000;
const MODE = '## Current Interaction Mode';

const role = {
  id: 'r1',
  name: 'R1',
  description: 'd',
  category: 'engineering',
  systemPrompt: 'PERSONA_MARKER',
  defaultSkills: [],
  heartbeatChecklist: '- x',
  defaultPolicies: [],
} as unknown as RoleTemplate;

function sys(scenario: string) {
  return engine.buildSystemPrompt({
    agentId: 'agt_1',
    agentName: 'A',
    role,
    memory,
    scenario,
  } as never);
}

async function prep(sessionMessages: LLMMessage[], volatileState?: string) {
  return engine.prepareMessages({
    systemPrompt: 'SYSTEM_PROMPT',
    sessionMessages,
    memory,
    sessionId: 'sess_mode',
    modelContextWindow: WINDOW,
    volatileState,
  });
}

describe('Current Interaction Mode → volatile tail', () => {
  it('is NOT in the byte-stable system message', async () => {
    const { text } = await sys('chat');
    expect(text).not.toContain(MODE);
  });

  it('does not change system bytes when the scenario switches', async () => {
    const chat = await sys('chat');
    const a2a = await sys('a2a');

    // The whole point: same agent, different scenario ⇒ IDENTICAL system bytes,
    // so a session that alternates modes keeps its cached prefix.
    expect(chat.text).toBe(a2a.text);
  });

  it('reaches the model through the volatile tail', async () => {
    const { volatile } = await sys('chat');
    expect(volatile).toContain(MODE);
  });

  it('is re-sent IN FULL on every call — never change-gated to a digest', async () => {
    const { volatile } = await sys('chat');
    const messages: LLMMessage[] = [{ role: 'user', content: 'do the thing' }];

    // First call of the turn: full delivery.
    const first = await prep([...messages], volatile);
    const firstTail = first.messages[first.messages.length - 1];
    expect(String(firstTail?.content)).toContain(MODE);

    // Later calls in the same turn: state is unchanged, so ordinary sections
    // get omitted — the mode section must survive anyway.
    const r2 = await prep([...messages], volatile);
    const r2Tail = r2.messages[r2.messages.length - 1];
    expect(String(r2Tail?.content)).toContain(MODE);

    const r3 = await prep([...messages], volatile);
    const r3Tail = r3.messages[r3.messages.length - 1];
    expect(String(r3Tail?.content)).toContain(MODE);
  });

  it('keeps the durable checkpoint free of the (always-resend) instructions', async () => {
    const { volatile } = await sys('chat');
    const stored: LLMMessage[] = [{ role: 'user', content: 'go' }];
    const stubs = {
      serializeSlots: () => '',
      serializeSummary: () => '',
      appendMessage: (_id: string, m: LLMMessage) => { stored.push(m); },
    } as never;

    await engine.prepareMessages({
      systemPrompt: 'SYSTEM_PROMPT',
      sessionMessages: stored.slice(),
      memory: stubs,
      sessionId: 'sess_mode_ckpt',
      modelContextWindow: WINDOW,
      volatileState: volatile,
    });

    // The mode section is re-sent every call, so persisting it into history
    // would be pure duplication (and would bloat the replayed prefix).
    const ckpt = stored.find((m) => String(m.content).startsWith('[SYSTEM] [State checkpoint]'));
    expect(String(ckpt?.content ?? '')).not.toContain(MODE);
  });
});
