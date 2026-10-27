/**
 * Guards for the Workflows view's pure logic (`src/lib/workflow-view.ts`).
 *
 * These exist because the previous card shipped four lies, all of them
 * *decision* bugs rather than styling bugs:
 *   1. `depends_on` ids were printed raw (`← step-1-research`);
 *   2. the "DAG" was a linear row of chips with arrows that encoded nothing;
 *   3. raw English status strings leaked into a Chinese UI;
 *   4. a run's progress was never computed, so "9 tasks" was the only signal.
 *
 * Each block below fails if the corresponding lie comes back.
 */
import { describe, it, expect } from 'vitest';
import {
  RUN_STATUS_META,
  UNKNOWN_STATUS,
  runStatusMeta,
  buildStepIndex,
  dependsOnNames,
  layeredDag,
  matchTasksToSteps,
  computeProgress,
  stepDisplayStatus,
  readExpandedWorkflows,
  writeExpandedWorkflows,
  shouldClampPrompt,
  prepareDuplicateYaml,
  PROMPT_CLAMP_CHARS,
  EXPANDED_WORKFLOWS_STORAGE_KEY,
  isRunActive,
  type WorkflowStepLike,
} from '../src/lib/workflow-view';

const steps: WorkflowStepLike[] = [
  { id: 'research', name: '代码研究与依赖分析', role: 'manager', prompt: 'research the code' },
  { id: 'plan', name: '任务分解与分配', role: 'manager', depends_on: ['research'], prompt: 'plan' },
  { id: 'dev-a', name: '并行开发 A', role: 'engineer', depends_on: ['plan'], prompt: 'a' },
  { id: 'dev-b', name: '并行开发 B', role: 'engineer', depends_on: ['plan'], prompt: 'b' },
  { id: 'review', name: '代码审查', role: 'reviewer', depends_on: ['dev-a', 'dev-b'], prompt: 'r' },
];

describe('run status wording', () => {
  it('maps every known status to a tone and a translated key', () => {
    expect(runStatusMeta('completed')).toEqual(RUN_STATUS_META['completed']);
    // the human-facing label must not be the raw enum
    expect(runStatusMeta('failed').label).not.toBe('failed');
    expect(runStatusMeta('running').tone).toBe('info');
    expect(runStatusMeta('failed').tone).toBe('danger');
  });

  it('keeps an unknown status visible instead of silently blanking it', () => {
    const meta = runStatusMeta('weird_state');
    expect(meta.tone).toBe(UNKNOWN_STATUS.tone);
    expect(meta.label).toBe('weird_state');
    expect(runStatusMeta(undefined)).toBe(UNKNOWN_STATUS);
  });

  it('only treats running/paused as active', () => {
    expect(isRunActive('running')).toBe(true);
    expect(isRunActive('paused')).toBe(true);
    expect(isRunActive('completed')).toBe(false);
    expect(isRunActive(undefined)).toBe(false);
  });
});

describe('dependencies are shown as names', () => {
  it('resolves depends_on ids to step names', () => {
    const index = buildStepIndex(steps);
    const review = steps.find((s) => s.id === 'review')!;
    expect(dependsOnNames(review, index)).toEqual(['并行开发 A', '并行开发 B']);
  });

  it('falls back to the raw id when a dependency is missing from the template', () => {
    const index = buildStepIndex(steps);
    const orphan: WorkflowStepLike = { id: 'orphan', name: '离群步骤', role: 'x', prompt: '', depends_on: ['ghost'] };
    expect(dependsOnNames(orphan, index)).toEqual(['ghost']);
  });
});

describe('layeredDag', () => {
  it('groups steps into real depth layers and emits the edges', () => {
    const { layers, depth, edges } = layeredDag(steps);
    expect(layers).toEqual([
      ['research'],
      ['plan'],
      ['dev-a', 'dev-b'],
      ['review'],
    ]);
    expect(depth['review']).toBe(3);
    expect(edges).toContainEqual({ from: 'dev-a', to: 'review' });
    expect(edges).toContainEqual({ from: 'dev-b', to: 'review' });
    expect(edges).toHaveLength(5);
  });

  it('does not hang or mislayer on a cyclic template', () => {
    const cyclic: WorkflowStepLike[] = [
      { id: 'a', name: 'A', role: 'r', prompt: '', depends_on: ['b'] },
      { id: 'b', name: 'B', role: 'r', prompt: '', depends_on: ['a'] },
    ];
    const { layers } = layeredDag(cyclic);
    expect(layers.flat().sort()).toEqual(['a', 'b']);
  });

  it('ignores dependencies pointing outside the template', () => {
    const { edges, layers } = layeredDag([
      { id: 'solo', name: 'Solo', role: 'r', prompt: '', depends_on: ['not-in-template'] },
    ]);
    expect(edges).toEqual([]);
    expect(layers).toEqual([['solo']]);
  });
});

describe('matchTasksToSteps — structural join only', () => {
  it('joins by workflowStepId', () => {
    const mapped = matchTasksToSteps(steps, [
      { id: 't1', title: '任意标题', status: 'completed', workflowStepId: 'review' },
    ]);
    expect(mapped['review']?.id).toBe('t1');
  });

  it('ignores the old in-band hints — a renamed title must not move a task', () => {
    // title still looks like a step, notes still carry the legacy marker:
    // neither may be used any more (the backfill already moved them onto the column)
    const mapped = matchTasksToSteps(steps, [
      { id: 't2', title: '[标准功能开发流程] 代码审查', status: 'failed', notes: 'step: review' },
    ]);
    expect(Object.values(mapped).filter(Boolean)).toHaveLength(0);
  });

  it('maps a task onto exactly one step', () => {
    const mapped = matchTasksToSteps(steps, [
      { id: 'only', title: 'x', status: 'completed', workflowStepId: 'review' },
    ]);
    const ids = Object.values(mapped).filter(Boolean).map((t) => t!.id);
    expect(ids).toEqual(['only']);
  });

  it('leaves unmapped steps undefined instead of guessing positionally', () => {
    const tasks = steps.map((_, i) => ({ id: `p${i}`, title: `untitled ${i}`, status: 'pending' }));
    const mapped = matchTasksToSteps(steps, tasks);
    expect(Object.values(mapped).filter(Boolean)).toHaveLength(0);
  });

  it('keeps the first task when a step has duplicates (never silently halves progress)', () => {
    const mapped = matchTasksToSteps(steps, [
      { id: 'a', title: 'a', status: 'completed', workflowStepId: 'dev-a' },
      { id: 'b', title: 'b', status: 'failed', workflowStepId: 'dev-a' },
    ]);
    expect(mapped['dev-a']?.id).toBe('a');
  });
});

describe('computeProgress', () => {
  it('derives done/failed/active counts from mapped tasks', () => {
    const mapped = matchTasksToSteps(steps, [
      { id: 't1', title: 'x', status: 'completed', workflowStepId: 'research' },
      { id: 't2', title: 'x', status: 'completed', workflowStepId: 'plan' },
      { id: 't3', title: 'x', status: 'failed', workflowStepId: 'dev-a' },
      { id: 't4', title: 'x', status: 'in_progress', workflowStepId: 'dev-b' },
    ]);
    const progress = computeProgress(steps, mapped);
    expect(progress.total).toBe(4);
    expect(progress.done).toBe(2);
    expect(progress.failed).toBe(1);
    expect(progress.active).toBe(1);
    expect(progress.percent).toBe(50);
    expect(progress.failedSteps.map((s) => s.name)).toEqual(['并行开发 A']);
    expect(progress.activeSteps.map((s) => s.name)).toEqual(['并行开发 B']);
  });

  it('reports zero rather than a fabricated percentage when nothing is mapped', () => {
    const progress = computeProgress(steps, {});
    expect(progress).toMatchObject({ total: 0, done: 0, percent: 0 });
  });
});

describe('stepDisplayStatus', () => {
  it('classifies task statuses into the four dot states', () => {
    expect(stepDisplayStatus({ id: 'a', title: '', status: 'completed' })).toBe('done');
    expect(stepDisplayStatus({ id: 'a', title: '', status: 'archived' })).toBe('done');
    expect(stepDisplayStatus({ id: 'a', title: '', status: 'rejected' })).toBe('failed');
    expect(stepDisplayStatus({ id: 'a', title: '', status: 'review' })).toBe('active');
    expect(stepDisplayStatus({ id: 'a', title: '', status: 'pending' })).toBe('pending');
    expect(stepDisplayStatus(undefined)).toBe('unknown');
  });
});

describe('expanded-card persistence', () => {
  it('round-trips a set of workflow names', () => {
    const store = new Map<string, string>();
    writeExpandedWorkflows(new Set(['a', 'b']), (k, v) => store.set(k, v));
    expect(store.get(EXPANDED_WORKFLOWS_STORAGE_KEY)).toBe('["a","b"]');
    expect(readExpandedWorkflows((k) => store.get(k) ?? null)).toEqual(new Set(['a', 'b']));
  });

  it('survives malformed or non-array payloads', () => {
    expect(readExpandedWorkflows(() => 'not json')).toEqual(new Set());
    expect(readExpandedWorkflows(() => '{"a":1}')).toEqual(new Set());
    expect(readExpandedWorkflows(() => '["ok",3,null]')).toEqual(new Set(['ok']));
    expect(readExpandedWorkflows(() => null)).toEqual(new Set());
  });

  it('does not throw when storage refuses to write', () => {
    expect(() =>
      writeExpandedWorkflows(new Set(['a']), () => {
        throw new Error('quota');
      }),
    ).not.toThrow();
  });
});

describe('prompt clamping', () => {
  it('only offers show-more for prompts above the clamp budget', () => {
    expect(shouldClampPrompt('x'.repeat(PROMPT_CLAMP_CHARS))).toBe(false);
    expect(shouldClampPrompt('x'.repeat(PROMPT_CLAMP_CHARS + 1))).toBe(true);
    expect(shouldClampPrompt(undefined)).toBe(false);
  });
});

describe('prepareDuplicateYaml', () => {
  // tiny stand-ins for the `yaml` package: enough structure to prove the fields
  // we rewrite, without depending on formatting in a unit test.
  const parse = (text: string) => JSON.parse(text) as Record<string, unknown>;
  const stringify = (doc: unknown) => JSON.stringify(doc);

  it('rewrites the template name so a copy cannot claim to be the original', () => {
    const src = JSON.stringify({ name: 'feature-dev', displayName: '功能开发', steps: [{ id: 's1' }] });
    const out = parse(prepareDuplicateYaml(src, 'feature-dev-copy', parse, stringify));

    expect(out['name']).toBe('feature-dev-copy');
    // the rest of the template is preserved
    expect(out['steps']).toEqual([{ id: 's1' }]);
  });

  it('marks the copy in the display name so the list is not two identical cards', () => {
    const src = JSON.stringify({ name: 'feature-dev', displayName: '功能开发' });
    const out = parse(prepareDuplicateYaml(src, 'feature-dev-copy', parse, stringify));
    expect(out['displayName']).toBe('功能开发（副本）');
  });

  it('tolerates a template without a display name', () => {
    const src = JSON.stringify({ name: 'feature-dev' });
    const out = parse(prepareDuplicateYaml(src, 'feature-dev-copy', parse, stringify));
    expect(out['name']).toBe('feature-dev-copy');
    expect(out['displayName']).toBeUndefined();
  });

  it('refuses to build a copy from unparsable YAML', () => {
    expect(() => prepareDuplicateYaml('not json', 'x', parse, stringify)).toThrow();
  });
});
