/**
 * Where the cache breakpoints sit decides whether a long turn is cached at all.
 *
 * The only breakpoint used to be the START of the current turn. On an
 * explicit-caching provider (Anthropic) that means everything the agent produces
 * inside the turn is re-billed on every later call — and a single task turn was
 * measured at 251 calls, so that is the majority of the request.
 *
 * The second breakpoint now rolls to the end of history: the cache follows the
 * turn, each call writes only the delta it appended. The volatile tail is
 * appended AFTER that point and must stay unmarked — it changes on every call,
 * so marking it would make the breakpoint useless.
 */

import { describe, it, expect } from 'vitest';
import { ContextEngine } from '../src/context-engine.js';
import type { LLMMessage } from '@markus/shared';

const memory = {
  serializeSlots: () => '',
  serializeSummary: () => '',
} as never;

function engine() {
  return new ContextEngine();
}

async function prepare(sessionMessages: LLMMessage[], volatileState?: string) {
  return engine().prepareMessages({
    systemPrompt: 'sys',
    sessionMessages,
    memory,
    sessionId: 'sess_bp',
    modelContextWindow: 1_000_000,
    modelMaxOutput: 384_000,
    volatileState,
  });
}

const marked = (m: LLMMessage) => (m as { cacheBreakpoint?: boolean }).cacheBreakpoint === true;

/** A turn that is mid-flight: user prompt, then two completed tool rounds. */
function midTurn(): LLMMessage[] {
  return [
    { role: 'user', content: 'TASK EXECUTION: do the thing' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'shell_execute', arguments: {} }],
    } as unknown as LLMMessage,
    { role: 'tool', content: 'output 1', toolCallId: 'c1' } as unknown as LLMMessage,
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c2', name: 'shell_execute', arguments: {} }],
    } as unknown as LLMMessage,
    { role: 'tool', content: 'output 2', toolCallId: 'c2' } as unknown as LLMMessage,
  ];
}

describe('cache breakpoints', () => {
  it('rolls a breakpoint to the end of history so mid-turn work is cached', async () => {
    const out = await prepare(midTurn(), 'level 22%');
    const body = out.messages.slice(1); // drop the system message

    // The last real history message (last tool result) carries the rolling point.
    const lastTool = body[body.length - 2]!; // tail is appended last
    expect(lastTool.role).toBe('tool');
    expect(marked(lastTool)).toBe(true);
    expect(body.filter(marked).length).toBeGreaterThanOrEqual(1);
  });

  it('keeps the turn-start point AND adds the rolling one when the turn has a boundary', async () => {
    // A user message in the middle makes `turnStart > 0`, so both ends of the
    // turn get a breakpoint: the cached region spans the whole turn.
    const history: LLMMessage[] = [
      { role: 'user', content: 'earlier request' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: 'TASK EXECUTION: do the thing' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'shell_execute', arguments: {} }],
      } as unknown as LLMMessage,
      { role: 'tool', content: 'output 1', toolCallId: 'c1' } as unknown as LLMMessage,
    ];
    const out = await prepare(history, 'level 22%');
    const body = out.messages.slice(1);
    const markedIdx = body.map((m, i) => (marked(m) ? i : -1)).filter(i => i >= 0);
    // `body[i]` is history[i] (the system message was sliced off). The last user
    // message is at history index 2, so the turn-start point lands on history[1]
    // and the rolling point on history[4].
    expect(markedIdx).toContain(1);
    expect(markedIdx).toContain(4);
  });

  it('never marks the volatile tail — it changes on every call', async () => {
    const out = await prepare(midTurn(), 'level 22%');
    const tail = out.messages[out.messages.length - 1]!;
    expect(String(tail.content)).toContain('[SYSTEM] [Live context]');
    expect(marked(tail)).toBe(false);
  });

  it('does not add the rolling point at the very start of a turn', async () => {
    // Nothing has been produced yet: a write costs 1.25× on Anthropic and would
    // be read by nobody.
    const out = await prepare([{ role: 'user', content: 'TASK EXECUTION: start' }], 'level 3%');
    const body = out.messages.slice(1).filter((m) => !String(m.content).includes('[SYSTEM] [Live context]'));
    expect(body.filter(marked).length).toBe(0);
  });
});
