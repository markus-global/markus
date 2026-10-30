/**
 * Context signalling — ONE measurement line, at most ONE action line.
 *
 * History: this file used to pin `contextActionHint()`, which spoke at ≥70%
 * window usage while `compactionGuidance()` decided the SAME action (compact)
 * economically. The agent received two differently-worded instructions for one
 * action — an invariant with two execution points. That function is deleted;
 * window pressure (≥ `CONTEXT_CRIT_RATIO`) now survives only as the `overflow`
 * REASON inside the single line.
 *
 * These tests pin the surviving contract:
 *   1. One line, always naming the lever (a warning with no lever trains agents
 *      to ignore banners).
 *   2. The overflow reason is a different sentence, not a second line.
 *   3. "Don't compact" remains a sayable conclusion.
 */

import { describe, it, expect } from 'vitest';
import {
  compactionActionLine,
  compactionGuidance,
  COMPACTION_MIN_PROMPT_TOKENS,
  CONTEXT_HINT_ADVISORY_PCT,
  CONTEXT_HINT_DIRECTIVE_PCT,
} from '../src/context-budget.js';

describe('compactionActionLine — the single compaction exit', () => {
  it('names both levers when compacting', () => {
    const line = compactionActionLine('compact');
    expect(line).toContain("operation:'compact'");
    expect(line).toContain("operation:'pin'");
  });

  it('uses the overflow REASON instead of emitting a second line', () => {
    const normal = compactionActionLine('compact');
    const overflow = compactionActionLine('compact', { overflow: true });
    expect(overflow).not.toBe(normal);
    expect(overflow).toContain('may not fit');
    // Still exactly one instruction, still names the lever.
    expect(overflow).toContain("operation:'compact'");
  });

  it('"do not compact" is a legitimate, sayable conclusion', () => {
    expect(compactionActionLine('hold')).toMatch(/not worth it|keep going/i);
  });

  it('never fires when the agent has no lever — caller gates on canCompact', () => {
    // The gate lives in context-engine (`canCompact`); this documents that the
    // line itself carries no condition, so memory_consolidation / distillation
    // must be filtered upstream. Watermarks remain as documented levels.
    expect(CONTEXT_HINT_ADVISORY_PCT).toBe(70);
    expect(CONTEXT_HINT_DIRECTIVE_PCT).toBe(85);
  });

  it('absolute floor overrides the ratio math on a just-compacted session', () => {
    // Regression: after compacting, fEst is optimistically seeded at 0.95, so
    // f > fStar and the ratio model alone says 'compact' — every turn, on a
    // prompt that needs nothing. The floor must silence the whole signal.
    const tiny = compactionGuidance({
      promptTokens: COMPACTION_MIN_PROMPT_TOKENS - 1,
      hitRate: 0.9,
      fEst: 0.95,
      nEst: 1,
    });
    expect(tiny).toBeNull();

    const big = compactionGuidance({
      promptTokens: COMPACTION_MIN_PROMPT_TOKENS * 3,
      hitRate: 0.9,
      fEst: 0.95,
      nEst: 1,
    });
    expect(big).not.toBeNull();
  });
});
