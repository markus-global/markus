/**
 * Facts predicates — the closed set is the contract (C9-A).
 *
 * Each case below fails if the corresponding validation is deleted: that is the
 * point of testing the *rejection* rather than the happy path only.
 */
import { describe, it, expect } from 'vitest';
import {
  FACT_PREDICATES,
  FACT_PREDICATE_NAMES,
  findFactPredicate,
  nearestFactPredicates,
  validateFactValue,
} from '../src/facts/predicates.js';

describe('predicate closed set', () => {
  it('ships exactly the six agreed predicates, in dictionary order', () => {
    expect([...FACT_PREDICATE_NAMES].sort()).toEqual([
      'agent.capability_claim',
      'memory.consolidation_suggestion',
      'requirement.acceptance_met',
      'task.completion_evidence',
      'task.rejection_reason',
      'work.defect_class',
    ]);
    expect(FACT_PREDICATE_NAMES).toEqual([...FACT_PREDICATE_NAMES].sort());
  });

  it('has no custom.* escape hatch and every spec validates its own shape', () => {
    expect(FACT_PREDICATE_NAMES.some(n => n.startsWith('custom.'))).toBe(false);
    for (const spec of FACT_PREDICATES) {
      expect(typeof spec.validate).toBe('function');
      expect(spec.subjectKinds.length).toBeGreaterThan(0);
    }
  });

  it('findFactPredicate is exact — an unknown name is undefined, never a fuzzy hit', () => {
    expect(findFactPredicate('task.completion_evidence')).toBeDefined();
    expect(findFactPredicate('task.completion')).toBeUndefined();
  });

  it('validateFactValue flags unknown predicates with a reason the service can map', () => {
    const res = validateFactValue('nope.nope', {});
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('unknown_predicate');
    }
  });
});

describe('value schemas — rejection paths', () => {
  it('rejects a non-object value', () => {
    const res = validateFactValue('task.completion_evidence', 'done!');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issue.path).toBe('');
  });

  it('rejects a missing required field, naming the path', () => {
    const res = validateFactValue('task.completion_evidence', { summary: 'shipped' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issue.path).toBe('/evidence_refs');
  });

  it('rejects an empty-string element inside an array, naming the index', () => {
    const res = validateFactValue('task.completion_evidence', {
      summary: 'shipped',
      evidence_refs: ['dlv_1', ''],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issue.path).toBe('/evidence_refs/1');
  });

  it('rejects a whitespace-only string', () => {
    const res = validateFactValue('task.rejection_reason', { reason: '   ', blocking_refs: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issue.path).toBe('/reason');
  });

  it('rejects unknown fields (structure is the schema, not whatever the caller sent)', () => {
    const res = validateFactValue('work.defect_class', {
      class: 'R1',
      instances: [],
      severity: 'high',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issue.path).toBe('/severity');
  });

  it('rejects a defect class outside R1–R4', () => {
    const res = validateFactValue('work.defect_class', { class: 'R9', instances: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issue.path).toBe('/class');
  });

  it('rejects a non-boolean `met`', () => {
    const res = validateFactValue('requirement.acceptance_met', {
      criteria_id: 'AC1',
      met: 'yes',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issue.path).toBe('/met');
  });
});

describe('value schemas — acceptance', () => {
  it('accepts the six documented shapes', () => {
    expect(validateFactValue('task.completion_evidence', {
      summary: 'facts layer landed',
      evidence_refs: ['dlv_1', 'task:tsk_1'],
    }).ok).toBe(true);
    expect(validateFactValue('task.rejection_reason', {
      reason: 'gate G6 red',
      blocking_refs: [],
    }).ok).toBe(true);
    expect(validateFactValue('requirement.acceptance_met', {
      criteria_id: 'AC7',
      met: true,
      note: 'self-test bites',
    }).ok).toBe(true);
    expect(validateFactValue('work.defect_class', {
      class: 'R1',
      instances: ['two writers on facts'],
    }).ok).toBe(true);
    expect(validateFactValue('agent.capability_claim', {
      capability: 'sqlite triggers',
      evidence_refs: [],
    }).ok).toBe(true);
    // C9-E: the suggestion payload is now the snapshot that actually lands in the fact
    // layer — a closed set of exactly seven actions, each pointing at something.
    expect(validateFactValue('memory.consolidation_suggestion', {
      suggestions: [{ action: 'merge', target_refs: ['knowledge.md#procedures'] }],
    }).ok).toBe(true);
  });

  it('rejects an eighth consolidation action and an action-less suggestion', () => {
    const eighth = validateFactValue('memory.consolidation_suggestion', {
      suggestions: [{ action: 'delete_everything', target_refs: ['x'] }],
    });
    expect(eighth.ok).toBe(false);
    if (!eighth.ok) expect(eighth.issue.path).toBe('/suggestions/0/action');

    const empty = validateFactValue('memory.consolidation_suggestion', { suggestions: [] });
    expect(empty.ok).toBe(false);

    const noTargets = validateFactValue('memory.consolidation_suggestion', {
      suggestions: [{ action: 'archive', target_refs: [] }],
    });
    expect(noTargets.ok).toBe(false);
    if (!noTargets.ok) expect(noTargets.issue.path).toBe('/suggestions/0/target_refs');
  });
});

describe('nearestFactPredicates', () => {
  it('suggests the same trailing segment first, deterministically', () => {
    expect(nearestFactPredicates('task.completion_evidenc', 1)).toEqual(['task.completion_evidence']);
    expect(nearestFactPredicates('req.acceptance_met', 1)).toEqual(['requirement.acceptance_met']);
  });

  it('is stable for the same input (no randomness in an actionable error)', () => {
    const a = nearestFactPredicates('whatever.thing', 3);
    const b = nearestFactPredicates('whatever.thing', 3);
    expect(a).toEqual(b);
    expect(a).toHaveLength(3);
  });
});

