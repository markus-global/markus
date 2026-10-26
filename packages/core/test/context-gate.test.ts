/**
 * Behaviour tests for the hard context gate.
 *
 * Guards the failure of 2026-10-26: two agents sent prompts past a 1M window
 * (1,072,931 and 1,848,862 tokens) even though the `[CONTEXT]` banner had been
 * escalating at 85% ("ACT NOW") and 95% ("the next request may not fit") for
 * ages — both on a2a/mailbox-driven turns. Advisory text alone demonstrably does
 * not prevent overflow, so the platform now refuses to keep growing the prompt.
 *
 * Owner decisions encoded here:
 *   • hard gate at 90% (not 95 — the compactor itself needs room to run)
 *   • both levers allowed (`session` covers compact and pin)
 *   • the platform NEVER compacts on the agent's behalf
 */
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_GATE_ALLOWED_TOOLS,
  contextGateRefusal,
  isContextGateActive,
} from '../src/context-gate.js';

describe('isContextGateActive', () => {
  it('is off below 90%', () => {
    expect(isContextGateActive(0)).toBe(false);
    expect(isContextGateActive(70)).toBe(false);
    expect(isContextGateActive(89.9)).toBe(false);
  });

  it('is on exactly at 90% — the boundary belongs to the gate', () => {
    expect(isContextGateActive(90)).toBe(true);
    expect(isContextGateActive(99)).toBe(true);
    expect(isContextGateActive(140)).toBe(true);
  });

  it('stays off when there is no provider measurement (fail-open)', () => {
    // No reading means no water level. Estimating one is the decision the
    // platform deliberately removed; guessing would fire late (the bug we are
    // fixing) or early (blocking healthy work).
    expect(isContextGateActive(undefined)).toBe(false);
    expect(isContextGateActive(Number.NaN)).toBe(false);
  });
});

describe('contextGateRefusal', () => {
  it('allows everything below the gate', () => {
    expect(contextGateRefusal('shell_execute', 89.9)).toBeUndefined();
    expect(contextGateRefusal('task_create', 42)).toBeUndefined();
  });

  it('allows every tool when the session has no measurement', () => {
    expect(contextGateRefusal('shell_execute', undefined)).toBeUndefined();
  });

  it('blocks an ordinary tool at the gate', () => {
    const refusal = contextGateRefusal('shell_execute', 91);
    expect(refusal).toBeDefined();
    const parsed = JSON.parse(refusal as string) as Record<string, unknown>;
    expect(parsed.status).toBe('error');
    expect(parsed.code).toBe('CONTEXT_GATE');
    expect(parsed.blockedTool).toBe('shell_execute');
    expect(parsed.contextPercent).toBe(91);
  });

  it('lets the agent keep both levers — compact and pin both live in `session`', () => {
    expect(contextGateRefusal('session', 97)).toBeUndefined();
    expect(contextGateRefusal('end_turn', 97)).toBeUndefined();
  });

  it('does not block the levers even at absurd pressure', () => {
    expect(contextGateRefusal('session', 250)).toBeUndefined();
    expect(contextGateRefusal('end_turn', 250)).toBeUndefined();
  });

  it('is an allowlist: a tool nobody exempted is blocked', () => {
    expect(CONTEXT_GATE_ALLOWED_TOOLS.has('session')).toBe(true);
    expect(CONTEXT_GATE_ALLOWED_TOOLS.has('end_turn')).toBe(true);
    // A newly added platform tool must be *deliberately* exempted, not slip past.
    expect(contextGateRefusal('some_tool_added_next_year', 95)).toBeDefined();
  });

  it('tells the agent exactly how to recover, and that nothing was compacted for it', () => {
    const parsed = JSON.parse(contextGateRefusal('shell_execute', 93) as string) as {
      message: string;
      allowedTools: string[];
    };
    expect(parsed.message).toContain("operation:'compact'");
    expect(parsed.message).toContain("operation:'pin'");
    expect(parsed.message).toContain('Nothing was compacted automatically');
    expect(parsed.allowedTools.sort()).toEqual(['end_turn', 'session']);
  });
});
