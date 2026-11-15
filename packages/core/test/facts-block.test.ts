/**
 * C9-A · `[FACTS:<subject>]` 注入构造器 —— 纯函数契约（无 mock repo）
 *
 * 四条验收判据各一组用例：
 *   1. 同一输入两次调用**字节完全相同**（无时间戳 / 无随机 / 无 id）；
 *   2. 超 20 条或超 2000 字符时截断，且显式写 `+N more (use fact_query)`；
 *   3. 空集合输出**稳定空形态**（禁止「为 0 就省略整段」—— 两种前缀 = 两个缓存条目）；
 *   4. 换一个 subject 不泄漏别的 subject 的事实。
 */
import { describe, it, expect } from 'vitest';
import {
  renderFactsBlock,
  factsSubjectLabel,
  toFactView,
  FACTS_BLOCK_MAX_CHARS,
  type FactView,
} from '../src/facts/facts-block.js';
import { stableJson, type FactRecord } from '../src/facts/fact-service.js';

const subject = { kind: 'task' as const, id: 'tsk_a208c5c7' };

function view(predicate: string, value: unknown, refs = 1): FactView {
  return { predicate, value, sourceRefCount: refs };
}

describe('byte stability', () => {
  it('renders the same bytes for two calls with the same facts', () => {
    const facts = [
      view('task.completion_evidence', { summary: 'landed', evidence_refs: ['dlv_1'] }),
      view('work.defect_class', { class: 'R1', instances: ['x'] }),
    ];
    const a = renderFactsBlock(subject.kind, subject.id, facts);
    const b = renderFactsBlock(subject.kind, subject.id, facts);
    expect(a).toBe(b);
  });

  it('is independent of the caller array order (sorted by predicate)', () => {
    const one = view('task.completion_evidence', { summary: 's', evidence_refs: ['d'] });
    const two = view('work.defect_class', { class: 'R1', instances: [] });
    const a = renderFactsBlock(subject.kind, subject.id, [one, two]);
    const b = renderFactsBlock(subject.kind, subject.id, [two, one]);
    expect(a).toBe(b);
    expect(a.split('\n').slice(1)).toEqual([
      `· task.completion_evidence ${stableJson(one.value)} (refs: 1)`,
      `· work.defect_class ${stableJson(two.value)} (refs: 1)`,
    ]);
  });

  it('contains no clock, no random and no row id', () => {
    const out = renderFactsBlock(subject.kind, subject.id, [
      view('work.defect_class', { class: 'R1', instances: [] }),
    ]);
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(out).not.toMatch(/fact_[a-z0-9]{5,}/);
    expect(out).toBe(`[FACTS:task_tsk_a208c5c7]\n· work.defect_class {"class":"R1","instances":[]} (refs: 1)`);
  });

  it('stableJson sorts keys so a stored key order cannot change the bytes', () => {
    expect(stableJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });
});

describe('subject isolation', () => {
  it('labels the header with exactly the given subject', () => {
    const out = renderFactsBlock('task', 'tsk_a208c5c7', []);
    expect(out.split('\n')[0]).toBe(`[FACTS:${factsSubjectLabel('task', 'tsk_a208c5c7')}]`);
    expect(out).not.toContain('tsk_other');
  });

  it('a fact set of subject A never appears under subject B', () => {
    const aFacts = [view('task.completion_evidence', { summary: 'A only', evidence_refs: ['d'] })];
    const bBlock = renderFactsBlock('task', 'tsk_b', []);
    expect(bBlock).not.toContain('A only');
    const aBlock = renderFactsBlock('task', 'tsk_a', aFacts);
    expect(aBlock).toContain('A only');
    expect(aBlock).toContain('[FACTS:task_tsk_a]');
  });
});

describe('budget: 20 facts / 2000 chars, with an explicit +N more', () => {
  it('truncates above 20 facts and says how many are missing', () => {
    const facts: FactView[] = [];
    for (let i = 0; i < 25; i += 1) {
      facts.push(view(`agent.capability_claim`, { capability: `cap-${i}`, evidence_refs: [] }));
    }
    const out = renderFactsBlock(subject.kind, subject.id, facts);
    const lines = out.split('\n');
    expect(lines.filter(l => l.startsWith('· '))).toHaveLength(20);
    expect(lines[lines.length - 1]).toBe('+5 more (use fact_query)');
  });

  it('keeps the highest-priority facts when the cut happens (completion_evidence wins)', () => {
    const facts: FactView[] = [];
    for (let i = 0; i < 30; i += 1) {
      facts.push(view('agent.capability_claim', { capability: `cap-${i}`, evidence_refs: [] }));
    }
    facts.push(view('task.completion_evidence', { summary: 'critical', evidence_refs: ['d'] }));
    const out = renderFactsBlock(subject.kind, subject.id, facts);
    expect(out).toContain('task.completion_evidence');
    expect(out).toContain('+11 more (use fact_query)');
    // 选中后按字典序输出：completion_evidence 排在 capability_claim 之后。
    const rendered = out.split('\n').filter(l => l.startsWith('· '));
    expect(rendered[rendered.length - 1]).toContain('task.completion_evidence');
  });

  it('honours the character budget instead of the fact count', () => {
    const big = 'x'.repeat(300);
    const facts: FactView[] = [];
    for (let i = 0; i < 20; i += 1) {
      facts.push(view('agent.capability_claim', { capability: `${i}-${big}`, evidence_refs: [] }));
    }
    const out = renderFactsBlock(subject.kind, subject.id, facts);
    expect(out.length).toBeLessThanOrEqual(FACTS_BLOCK_MAX_CHARS);
    expect(out).toMatch(/\+\d+ more \(use fact_query\)$/);
  });

  it('does not print +N more when everything fits', () => {
    const out = renderFactsBlock(subject.kind, subject.id, [view('work.defect_class', { class: 'R2', instances: [] })]);
    expect(out).not.toContain('more');
  });
});

describe('empty set — a stable empty form, never omission', () => {
  it('still emits the header plus one fixed line', () => {
    const out = renderFactsBlock(subject.kind, subject.id, []);
    expect(out).toBe('[FACTS:task_tsk_a208c5c7]\n(no facts yet)');
  });

  it('is byte-identical across calls (both would be one cache entry)', () => {
    const a = renderFactsBlock(subject.kind, subject.id, []);
    const b = renderFactsBlock(subject.kind, subject.id, []);
    expect(a).toBe(b);
  });
});

describe('toFactView — the adapter keeps records out of the renderer', () => {
  it('passes only predicate / value / verification.result and a ref count', () => {
    const record: FactRecord = {
      id: 'fact_abc',
      subjectKind: 'task',
      subjectId: 'tsk_a208c5c7',
      predicate: 'task.completion_evidence',
      value: { summary: 's', evidence_refs: ['d1', 'd2'] },
      workUnitRef: 'task:tsk_a208c5c7:r1',
      assertedBy: 'agt_x',
      sourceRefs: ['d1', 'd2'],
      verification: { result: 'pass', verified_by: 'agt_y' },
      confidence: 1,
      createdAt: '2026-11-15T00:00:00.000Z',
    };
    const v = toFactView(record);
    expect(v).toEqual({
      predicate: 'task.completion_evidence',
      value: { summary: 's', evidence_refs: ['d1', 'd2'] },
      verification: { result: 'pass' },
      sourceRefCount: 2,
    });
    const out = renderFactsBlock(subject.kind, subject.id, [v]);
    expect(out).not.toContain('agt_x');
    expect(out).not.toContain('fact_abc');
  });
});
