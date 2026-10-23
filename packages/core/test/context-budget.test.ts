/**
 * Context pressure signalling — the ONLY thing the platform still says about
 * context size, and the only lever it names.
 *
 * Design rule (Owner, 2026-10-23): do NOT trim history to save tokens. Inside a
 * turn, history IS the agent's working memory; dropping it makes the agent
 * re-derive state, which costs far more than it saves. The platform reports the
 * water level and the agent decides (session compact / pin).
 *
 * These tests pin that the hint is ACTIONABLE and never fires when the agent has
 * no lever — an always-lit warning with no lever trains agents to ignore banners.
 */

import { describe, it, expect } from 'vitest';
import {
  contextActionHint,
  CONTEXT_HINT_ADVISORY_PCT,
  CONTEXT_HINT_DIRECTIVE_PCT,
} from '../src/context-budget.js';

describe('contextActionHint', () => {
  it('stays silent below the advisory watermark', () => {
    expect(contextActionHint({ usedPct: 0, canCompact: true })).toBeUndefined();
    expect(contextActionHint({ usedPct: 31.1, canCompact: true })).toBeUndefined();
    expect(contextActionHint({ usedPct: CONTEXT_HINT_ADVISORY_PCT - 0.1, canCompact: true })).toBeUndefined();
  });

  it('advises at the advisory watermark and names the lever', () => {
    const hint = contextActionHint({ usedPct: CONTEXT_HINT_ADVISORY_PCT, canCompact: true });
    expect(hint).toBeDefined();
    expect(hint).toContain("operation:'compact'");
  });

  it('issues a directive at the directive watermark', () => {
    const hint = contextActionHint({ usedPct: CONTEXT_HINT_DIRECTIVE_PCT, canCompact: true });
    expect(hint).toBeDefined();
    expect(hint).toContain('ACT NOW');
    expect(hint).toContain("operation:'compact'");
    // The pin lever must be named too — compacting without an anchor loses position.
    expect(hint).toContain("operation:'pin'");
  });

  it('escalates monotonically: directive text differs from advisory text', () => {
    const advisory = contextActionHint({ usedPct: 70, canCompact: true });
    const directive = contextActionHint({ usedPct: 90, canCompact: true });
    expect(advisory).not.toBe(directive);
  });

  it('says nothing when the agent has no lever (memory_consolidation / distillation)', () => {
    // These scenarios must read everything; telling them to compact would be a lie.
    expect(contextActionHint({ usedPct: 99, canCompact: false })).toBeUndefined();
  });
});
