/**
 * C9-C · 阶段词表的前端契约。
 *
 * 三件事各一组断言：
 *   1. 闭集齐全 —— 7 个 stage 每一个都有文案键与语气（少一个 = 页面上出现空白徽章）；
 *   2. **跨词表字面互斥** —— 阶段词与治理态/进程态的词不能共用同一个字面（同一个字
 *      出现在两个概念上，用户一定会在某个同屏场景里把它读成另一件事）；
 *   3. 守卫与指针分类 —— 非法值不编造状态；`dlv_` 指针能跳到交付物。
 */
import { describe, it, expect } from 'vitest';
import {
  THREAD_STAGES,
  THREAD_STAGE_KEY,
  THREAD_STAGE_TONE,
  asThreadStage,
  threadStageLabel,
  sourceRefKind,
  evidenceSummary,
  type ThreadStage,
} from './threadStage.ts';
import { crossVocabularyCollisions, TASK_STATUS_KEY, PROCESS_STATUS_KEY } from './stateVocabulary.ts';
import enCommon from '../locales/en/common.json';
import zhCommon from '../locales/zh-CN/common.json';

const LOCALES = [
  { name: 'en', common: enCommon },
  { name: 'zh-CN', common: zhCommon },
] as const;

type Dict = Record<string, unknown>;

function lookup(dict: Dict, key: string): string | undefined {
  const parts = key.split('.');
  let cur: unknown = dict;
  for (const part of parts) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Dict)[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

describe('closed set — every stage has a label and a tone in every locale', () => {
  it('declares exactly the seven frozen stages', () => {
    expect([...THREAD_STAGES]).toEqual([
      'waiting_human',
      'running',
      'needs_evidence',
      'in_verification',
      'done',
      'blocked_deps',
      'failed',
    ]);
  });

  for (const locale of LOCALES) {
    it(`${locale.name}: all seven have copy`, () => {
      for (const stage of THREAD_STAGES) {
        const key = `threadStage.${THREAD_STAGE_KEY[stage]}`;
        const label = lookup(locale.common as Dict, key);
        expect(label, `${locale.name} missing ${key}`).toBeTruthy();
        expect(typeof label).toBe('string');
      }
    });
  }

  it('every stage maps onto an existing semantic tone', () => {
    const tones = new Set(Object.values(THREAD_STAGE_TONE));
    expect([...tones].sort()).toEqual(['active', 'attention', 'blocked', 'danger', 'neutral', 'success']);
  });
});

describe('cross-vocabulary literal exclusivity', () => {
  for (const locale of LOCALES) {
    it(`${locale.name}: no stage label collides with a governance/process label`, () => {
      const entries = [];
      for (const stage of THREAD_STAGES) {
        const label = lookup(locale.common as Dict, `threadStage.${THREAD_STAGE_KEY[stage]}`);
        if (label) entries.push({ concept: 'thread-stage' as const, value: stage, label });
      }
      for (const [value, key] of Object.entries(TASK_STATUS_KEY)) {
        const label = lookup(locale.common as Dict, `taskStatus.${key}`);
        if (label) entries.push({ concept: 'task-status' as const, value, label });
      }
      for (const [value, key] of Object.entries(PROCESS_STATUS_KEY)) {
        const label = lookup(locale.common as Dict, `processStatus.${key}`);
        if (label) entries.push({ concept: 'process' as const, value, label });
      }
      expect(entries.length).toBeGreaterThan(THREAD_STAGES.length);
      expect(crossVocabularyCollisions(entries)).toEqual([]);
    });
  }
});

describe('guards and pointers', () => {
  it('never invents a stage for a value it does not know', () => {
    expect(asThreadStage('done')).toBe('done');
    expect(asThreadStage('已完成')).toBeUndefined();
    expect(asThreadStage(null)).toBeUndefined();
    expect(asThreadStage(42)).toBeUndefined();
  });

  it('renders a label through the single vocabulary', () => {
    const t = (key: string) => `k:${key}`;
    const stage: ThreadStage = 'needs_evidence';
    expect(threadStageLabel(stage, t)).toBe(`k:common:threadStage.${THREAD_STAGE_KEY[stage]}`);
    expect(threadStageLabel(undefined, t)).toBeUndefined();
  });

  it('classifies evidence pointers so each one can be opened', () => {
    expect(sourceRefKind('dlv_123')).toBe('deliverable');
    expect(sourceRefKind('cmt_9')).toBe('comment');
    expect(sourceRefKind('fact_7')).toBe('in-place');
  });

  it('summarises a fact value without dumping JSON at the reader', () => {
    expect(evidenceSummary({ summary: '  landed  ', evidence_refs: ['dlv_1'] })).toBe('landed');
    expect(evidenceSummary({ evidence_refs: ['dlv_1'] })).toBeUndefined();
    expect(evidenceSummary('raw string')).toBeUndefined();
  });
});
