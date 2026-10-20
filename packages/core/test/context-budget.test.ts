import { describe, it, expect } from 'vitest';
import {
  applyViewBudget,
  viewBudgetForScenario,
  viewBudgetMarkerText,
  type ViewBudgetPolicy,
} from '../src/context-budget.js';

type Msg = { role: string; content: string };

/** Flat estimator: 1 token per character. Makes budgets easy to reason about. */
const est = (m: Msg): number => m.content.length;

const msg = (role: string, content: string): Msg => ({ role, content });

describe('viewBudgetForScenario', () => {
  it('caps the high-volume scenarios and leaves whole-history scenarios uncapped', () => {
    // a2a is the measured hot spot (170k variable -> 30k view).
    expect(viewBudgetForScenario('a2a')?.viewTokens).toBe(30_000);
    expect(viewBudgetForScenario('heartbeat')?.viewTokens).toBe(8_000);
    expect(viewBudgetForScenario('task_execution')?.viewTokens).toBe(60_000);
    // Human chat keeps a much larger window: continuity matters more there.
    expect(viewBudgetForScenario('chat')?.viewTokens).toBe(120_000);

    // These MUST stay uncapped: trimming here would corrupt the memory itself.
    expect(viewBudgetForScenario('memory_consolidation')).toBeUndefined();
    expect(viewBudgetForScenario('distillation')).toBeUndefined();
    expect(viewBudgetForScenario(undefined)).toBeUndefined();
  });
});

describe('applyViewBudget', () => {
  const policy: ViewBudgetPolicy = { viewTokens: 100, minRecentMessages: 2 };

  it('is a no-op when the history already fits (backward compatibility)', () => {
    const messages = [msg('user', 'a'), msg('assistant', 'b')];
    const out = applyViewBudget(messages, policy, { estimateTokens: est });
    expect(out.dropped).toBe(0);
    expect(out.trimmed).toBe(false);
    expect(out.messages).toBe(messages);
  });

  it('is a no-op when no policy is supplied — legacy behaviour preserved', () => {
    const messages = Array.from({ length: 50 }, (_, i) => msg('user', 'x'.repeat(1000)));
    const out = applyViewBudget(messages, undefined, { estimateTokens: est });
    expect(out.dropped).toBe(0);
    expect(out.messages).toHaveLength(50);
  });

  it('keeps the tail within budget and prepends a marker', () => {
    // 10 messages x 40 tokens = 400 tokens; budget 100 -> tail only.
    const messages = Array.from({ length: 10 }, (_, i) => msg('user', `${i}`.repeat(40)));
    const out = applyViewBudget(messages, policy, {
      estimateTokens: est,
      makeMarker: (dropped) => msg('user', viewBudgetMarkerText(dropped, 100)),
    });

    expect(out.dropped).toBeGreaterThan(0);
    expect(out.trimmed).toBe(true);
    // Marker first, then only the tail.
    expect(out.messages[0].content).toContain('Earlier conversation trimmed');
    const kept = out.messages.slice(1);
    expect(kept.length).toBeLessThan(messages.length);
    // The LAST message is always the most recent one.
    expect(kept[kept.length - 1]).toBe(messages[messages.length - 1]);
  });

  it('keeps at least minRecentMessages even when they exceed the budget', () => {
    // Every message is 80 tokens, budget is 100 -> budget allows ~1, but the
    // floor says keep 3. The floor wins: recent turns must stay verbatim.
    const messages = Array.from({ length: 8 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', 'y'.repeat(80)));
    const out = applyViewBudget(messages, { viewTokens: 100, minRecentMessages: 3 }, {
      estimateTokens: est,
      makeMarker: () => msg('user', 'marker'),
    });
    // Marker + at least the 3 most recent messages.
    expect(out.messages.length).toBeGreaterThanOrEqual(4);
  });

  it('never starts the kept window with an orphaned tool result', () => {
    // assistant(tool_call) -> tool(result) -> assistant -> user(last)
    const messages: Msg[] = [
      msg('user', 'z'.repeat(200)),          // will be dropped
      msg('assistant', 'w'.repeat(200)),     // will be dropped
      msg('tool', 'result-1'),               // must NOT become the first kept message
      msg('assistant', 'ok'),
      msg('user', 'latest'),
    ];
    const out = applyViewBudget(messages, { viewTokens: 5, minRecentMessages: 1 }, { estimateTokens: est });
    const first = out.messages[0];
    expect(first?.role).not.toBe('tool');
    // It is the marker (a user message), so the next one is the real head.
    if (out.trimmed) {
      expect(out.messages[1]?.role).not.toBe('tool');
    }
  });

  it('always keeps the final message even if it alone exceeds the budget', () => {
    const messages = [msg('user', 'small'), msg('user', 'huge'.repeat(1000))];
    const out = applyViewBudget(messages, { viewTokens: 10, minRecentMessages: 1 }, { estimateTokens: est });
    const kept = out.trimmed ? out.messages.slice(1) : out.messages;
    expect(kept[kept.length - 1]).toBe(messages[1]);
  });

  it('handles an empty history without producing a marker', () => {
    const out = applyViewBudget([], policy, { estimateTokens: est });
    expect(out.messages).toEqual([]);
    expect(out.dropped).toBe(0);
  });
});
