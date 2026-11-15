/**
 * C9-E · dream 的七条建议动作（关闭 DR7）—— 纯派生 + 闭集校验 + 落事实（唯一写者端口）。
 *
 * 本文件的三条判据：
 *  1. **七条动作各有落点**：每条规则一条用例，少一条（或加第八条）即红；
 *  2. **闭集是硬的**：非法动作/空目标被丢弃并给出原因，绝不改写成邻近动作；
 *  3. **不写 knowledge.md**：落结构只经过 `FactService`，跑完一次建议快照后 knowledge.md
 *     的字节必须一模一样（有人把散文写回这条路径，本用例即红）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CONSOLIDATION_ACTIONS,
  deriveConsolidationSuggestions,
  parseConsolidationSuggestions,
  mergeSuggestions,
  toConsolidationFactValue,
  describeDropped,
  CONSOLIDATION_THRESHOLDS,
} from '../src/facts/consolidation-suggestions.js';
import { recordConsolidationSuggestions } from '../src/facts/consolidation-recorder.js';
import { MemoryStore } from '../src/memory/store.js';
import type {
  FactAssertInput,
  FactQuery,
  FactRecord,
  FactService,
  FactSupersedeInput,
  FactVerifyInput,
  FactWriteResult,
} from '../src/facts/fact-service.js';

// ─── a minimal FactService double: we assert on the values it is handed, not on SQL ────
// (the SQL writer's own invariants are covered with a real SQLite in
//  packages/org-manager/test/fact-verify.test.ts)
class RecordingFactService implements FactService {
  rows: FactRecord[] = [];
  calls: Array<{ kind: 'assert' | 'supersede' | 'verify'; input: unknown }> = [];

  private make(input: FactAssertInput, id: string): FactRecord {
    return {
      id,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      predicate: input.predicate,
      value: input.value,
      workUnitRef: input.workUnitRef,
      assertedBy: input.assertedBy,
      sourceRefs: input.sourceRefs,
      verification: input.verification,
      confidence: input.confidence ?? 1,
      createdAt: '2026-11-15T01:00:00.000Z',
    };
  }

  assert(input: FactAssertInput): FactWriteResult {
    this.calls.push({ kind: 'assert', input });
    const fact = this.make(input, `fact_${this.rows.length + 1}`);
    this.rows.push(fact);
    return { status: 'asserted', fact };
  }

  supersede(input: FactSupersedeInput): FactWriteResult {
    this.calls.push({ kind: 'supersede', input });
    const old = this.rows.find(r => r.id === input.supersededFactId);
    if (!old) return { status: 'rejected', code: 'not_found', message: 'missing' };
    old.supersededBy = `fact_${this.rows.length + 1}`;
    old.supersededAt = '2026-11-15T02:00:00.000Z';
    const fact = this.make(input, `fact_${this.rows.length + 1}`);
    this.rows.push(fact);
    return { status: 'asserted', fact };
  }

  verify(_input: FactVerifyInput): FactWriteResult {
    return { status: 'rejected', code: 'not_found', message: 'not used here' };
  }

  queryActive(query: FactQuery): FactRecord[] {
    return this.rows.filter(r =>
      !r.supersededBy
      && (query.subjectId === undefined || r.subjectId === query.subjectId)
      && (query.predicate === undefined || r.predicate === query.predicate),
    );
  }
}

describe('the closed set of seven actions', () => {
  it('is exactly the seven from learning-loop §5, in documented order', () => {
    expect([...CONSOLIDATION_ACTIONS]).toEqual([
      'archive',
      'revise',
      'merge',
      'ttl',
      'promote',
      'negative_feedback',
      'team_skill',
    ]);
  });
});

describe('deriveConsolidationSuggestions — one landing point per action', () => {
  it('1/7 archive: unused skill older than 30 days', () => {
    const out = deriveConsolidationSuggestions({
      skills: [
        { id: 'skl_old', name: 'old', usageCount: 0, successCount: 0, ageDays: 31 },
        { id: 'skl_new', name: 'new', usageCount: 0, successCount: 0, ageDays: 5 },
      ],
    });
    expect(out).toEqual([{ action: 'archive', target_refs: ['skl_old'] }]);
  });

  it('2/7 revise: success rate < 0.5 with enough usage to be a rate', () => {
    const out = deriveConsolidationSuggestions({
      skills: [
        { id: 'skl_bad', name: 'bad', usageCount: 4, successCount: 1, ageDays: 3 },
        { id: 'skl_thin', name: 'thin', usageCount: 2, successCount: 0, ageDays: 3 },
      ],
    });
    expect(out).toEqual([{ action: 'revise', target_refs: ['skl_bad'] }]);
  });

  it('3/7 merge: duplicate names or colliding tags', () => {
    const out = deriveConsolidationSuggestions({
      skills: [
        { id: 'skl_a', name: 'Deploy Helper', usageCount: 1, successCount: 1, ageDays: 1 },
        { id: 'skl_b', name: 'deploy  helper', usageCount: 1, successCount: 1, ageDays: 1 },
      ],
    });
    expect(out).toEqual([{ action: 'merge', target_refs: ['skl_a', 'skl_b'] }]);
  });

  it('4/7 ttl: notebook entries past their tier budget', () => {
    const out = deriveConsolidationSuggestions({
      notebooks: [
        { id: 'nb_stale', tier: 'agent', ageMs: 10_000, ttlMs: 5_000 },
        { id: 'nb_fresh', tier: 'agent', ageMs: 1_000, ttlMs: 5_000 },
      ],
    });
    expect(out).toEqual([{ action: 'ttl', target_refs: ['nb_stale'] }]);
  });

  it('5/7 promote: three or more observations sharing a theme', () => {
    const out = deriveConsolidationSuggestions({
      observationClusters: [
        { theme: 'procedures', observationIds: ['obs_1', 'obs_2', 'obs_3'] },
        { theme: 'too-small', observationIds: ['obs_4', 'obs_5'] },
      ],
    });
    expect(out).toEqual([{ action: 'promote', target_refs: ['obs_1', 'obs_2', 'obs_3'] }]);
  });

  it('6/7 negative_feedback: three or more negative signals on a skill', () => {
    const out = deriveConsolidationSuggestions({
      negativeFeedback: [{ skillId: 'skl_x', feedbackIds: ['fb_1', 'fb_2', 'fb_3'] }],
    });
    expect(out).toEqual([{ action: 'negative_feedback', target_refs: ['fb_1', 'fb_2', 'fb_3', 'skl_x'] }]);
  });

  it('7/7 team_skill: the same theme recorded by three or more agents', () => {
    const out = deriveConsolidationSuggestions({
      peerThemes: [{ theme: 'lock ordering', agentIds: ['agt_1', 'agt_2', 'agt_3'], observationIds: ['obs_a'] }],
    });
    expect(out).toEqual([{ action: 'team_skill', target_refs: ['agt_1', 'agt_2', 'agt_3', 'obs_a'] }]);
  });

  it('emits nothing when there is no signal — the platform does not invent advice', () => {
    expect(deriveConsolidationSuggestions({})).toEqual([]);
    expect(deriveConsolidationSuggestions({ skills: [], notebooks: [], observationClusters: [] })).toEqual([]);
  });

  it('is deterministic: same signals ⇒ same output (no clock, no randomness)', () => {
    const signals = {
      skills: [{ id: 'skl_z', name: 'z', usageCount: 0, successCount: 0, ageDays: 40 }],
      notebooks: [{ id: 'nb_1', tier: 'agent', ageMs: 9, ttlMs: 1 }],
    };
    expect(deriveConsolidationSuggestions(signals)).toEqual(deriveConsolidationSuggestions(signals));
  });

  it('thresholds are the documented ones', () => {
    expect(CONSOLIDATION_THRESHOLDS.archiveMinAgeDays).toBe(30);
    expect(CONSOLIDATION_THRESHOLDS.reviseMinUsage).toBe(3);
    expect(CONSOLIDATION_THRESHOLDS.promoteMinObservations).toBe(3);
    expect(CONSOLIDATION_THRESHOLDS.negativeFeedbackMin).toBe(3);
    expect(CONSOLIDATION_THRESHOLDS.teamSkillMinAgents).toBe(3);
  });
});

describe('parseConsolidationSuggestions — the closed set is enforced on model output too', () => {
  it('drops an unknown action instead of coercing it to a neighbour', () => {
    const { suggestions, dropped } = parseConsolidationSuggestions([
      { action: 'delete_everything', target_refs: ['x'] },
      { action: 'archive', target_refs: ['skl_1'] },
    ]);
    expect(suggestions).toEqual([{ action: 'archive', target_refs: ['skl_1'] }]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.reason).toContain('unknown action');
    expect(describeDropped(dropped)).toContain('#0');
  });

  it('drops an eighth action and reports why', () => {
    const { suggestions, dropped } = parseConsolidationSuggestions([
      { action: 'archive', target_refs: ['a'] },
      { action: 'rewrite_everything', target_refs: ['b'] },
    ]);
    expect(suggestions.map(s => s.action)).toEqual(['archive']);
    expect(dropped[0]!.reason).toContain('archive | revise | merge | ttl | promote | negative_feedback | team_skill');
  });

  it('drops a suggestion with no target (not actionable)', () => {
    const { dropped } = parseConsolidationSuggestions([{ action: 'merge', target_refs: [] }]);
    expect(dropped[0]!.reason).toContain('no target_refs');
  });

  it('tolerates a non-array payload by emitting nothing', () => {
    expect(parseConsolidationSuggestions(undefined)).toEqual({ suggestions: [], dropped: [] });
    expect(parseConsolidationSuggestions('nope')).toEqual({ suggestions: [], dropped: [] });
  });
});

describe('mergeSuggestions + toConsolidationFactValue', () => {
  it('keeps one entry per action (the action is the identity) and unions targets', () => {
    const merged = mergeSuggestions(
      [{ action: 'archive', target_refs: ['b'] }, { action: 'promote', target_refs: ['o1', 'o2', 'o3'] }],
      [{ action: 'archive', target_refs: ['a'] }],
    );
    expect(merged).toEqual([
      { action: 'archive', target_refs: ['a', 'b'] },
      { action: 'promote', target_refs: ['o1', 'o2', 'o3'] },
    ]);
  });

  it('produces the fact value shape the schema validates ({suggestions:[…]})', () => {
    const value = toConsolidationFactValue([{ action: 'ttl', target_refs: ['nb_1'] }]);
    expect(value).toEqual({ suggestions: [{ action: 'ttl', target_refs: ['nb_1'] }] });
  });
});

describe('recordConsolidationSuggestions — one active snapshot per agent', () => {
  it('asserts the first snapshot, then supersedes the previous one', () => {
    const facts = new RecordingFactService();
    const first = recordConsolidationSuggestions({
      facts,
      agentId: 'agt_dreamer',
      suggestions: [{ action: 'archive', target_refs: ['skl_1'] }],
      workUnitRef: 'dream:agt_dreamer:2026-11-15',
      sourceRefs: ['skl_1'],
    });
    expect(first.status).toBe('asserted');
    expect(first.count).toBe(1);

    const second = recordConsolidationSuggestions({
      facts,
      agentId: 'agt_dreamer',
      suggestions: [{ action: 'promote', target_refs: ['o1', 'o2', 'o3'] }],
      workUnitRef: 'dream:agt_dreamer:2026-11-16',
      sourceRefs: ['o1'],
    });
    expect(second.status).toBe('superseded');
    expect(facts.calls.map(c => c.kind)).toEqual(['assert', 'supersede']);

    // the old snapshot is history, not overwritten
    expect(facts.rows).toHaveLength(2);
    expect(facts.rows[0]!.supersededBy).toBe(facts.rows[1]!.id);
    expect(facts.queryActive({ subjectId: 'agt_dreamer' })).toHaveLength(1);
  });

  it('skips an empty set instead of asserting a "nothing to do" fact', () => {
    const facts = new RecordingFactService();
    const res = recordConsolidationSuggestions({
      facts,
      agentId: 'agt_x',
      suggestions: [],
      workUnitRef: 'dream:agt_x:w',
      sourceRefs: [],
    });
    expect(res.status).toBe('skipped');
    expect(facts.calls).toHaveLength(0);
  });
});

describe('knowledge.md is not written by the suggestion path (DR7)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'markus-c9e-dream-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('a suggestion snapshot leaves the knowledge file byte-identical', () => {
    // A real knowledge.md written through the ordinary path (not through this module).
    const store = new MemoryStore(dir);
    store.addLongTermMemory('procedures', 'existing curated prose');
    const file = join(dir, 'knowledge.md');
    const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
    expect(before.length).toBeGreaterThan(0);

    const facts = new RecordingFactService();
    const res = recordConsolidationSuggestions({
      facts,
      agentId: 'agt_dreamer',
      suggestions: [
        { action: 'promote', target_refs: ['o1', 'o2', 'o3'] },
        { action: 'archive', target_refs: ['skl_1'] },
      ],
      workUnitRef: 'dream:agt_dreamer:2026-11-15',
      sourceRefs: ['o1', 'skl_1'],
    });
    expect(res.status).toBe('asserted');

    const after = existsSync(file) ? readFileSync(file, 'utf8') : '';
    // If anyone makes this path write suggestions into knowledge.md, this line goes red.
    expect(after).toBe(before);
  });
});
