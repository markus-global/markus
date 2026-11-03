/**
 * A3 · 三种「状态」的词表互斥不变量。
 *
 * 判据（可执行）：**同一个字面值不得在两个不同概念下出现**。
 * 概念只有五个，各有唯一来源：
 *
 *   thread-stage  「在等谁」→ threadPresentation.ts `STAGE_LABEL`（派生 · 不落库）
 *   thread-group  「在等谁」的分组头 → 同上 `THREAD_GROUP_LABEL`
 *   task-status   治理态   → `common:taskStatus.*`（落库 · FSM 唯一转移点）
 *   attention     运行时注意力 → `agent:profilePage.mind.attention.*`（内存）
 *   process       进程态   → `common:processStatus.*`（运行期）
 *
 * 为什么必须断言「字面互斥」而不是只断言「各有各的枚举」：
 * 用户看到的是**字面**，不是枚举值。历史上 `STAGE_LABEL.working` = 「进行中」、
 * 治理态 `in_progress` = 「进行中」、`STAGE_LABEL.idle` = 「空闲」、进程态 `idle` = 「空闲」，
 * 于是同一屏出现两个含义不同的「进行中」，而所有类型检查、所有单测都是绿的。
 *
 * 这条不变量就是「把两个文案改回同一字面值必须变红」的自动化版本：
 * 见本文件最后一个 describe —— 故意造一份撞词的表，断言检查器能抓到。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGE_LABEL, THREAD_GROUP_LABEL } from './threadPresentation.ts';
import {
  ATTENTION_STATES,
  PROCESS_STATUS_KEY,
  TASK_STATUS_KEY,
  attentionStateLabel,
  crossVocabularyCollisions,
  processStatusLabel,
  taskStatusLabel,
  type LabelEntry,
} from './stateVocabulary.ts';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'locales');

const LOCALES = ['zh-CN', 'en', 'es'] as const;

type Json = Record<string, unknown>;

function load(locale: string, ns: 'agent' | 'common'): Json {
  return JSON.parse(readFileSync(join(localesDir, locale, `${ns}.json`), 'utf8')) as Json;
}

function dig(obj: Json, path: string): Json {
  return path.split('.').reduce<unknown>((acc, key) => (acc as Json | undefined)?.[key], obj) as Json;
}

/** 一个 locale 的全部状态词。stage 是硬编码中文（见残余说明），只在 zh 下参与比对。 */
function vocabularyOf(locale: string): LabelEntry[] {
  const agent = load(locale, 'agent');
  const common = load(locale, 'common');
  const entries: LabelEntry[] = [];

  if (locale === 'zh-CN') {
    for (const [value, p] of Object.entries(STAGE_LABEL)) {
      entries.push({ concept: 'thread-stage', value, label: p.label });
    }
    for (const [value, label] of Object.entries(THREAD_GROUP_LABEL)) {
      entries.push({ concept: 'thread-group', value, label });
    }
  }

  for (const [value, label] of Object.entries(dig(common, 'taskStatus'))) {
    entries.push({ concept: 'task-status', value, label: String(label) });
  }
  for (const [value, label] of Object.entries(dig(agent, 'profilePage.mind.attention'))) {
    entries.push({ concept: 'attention', value, label: String(label) });
  }
  for (const [value, label] of Object.entries(dig(common, 'processStatus'))) {
    entries.push({ concept: 'process', value, label: String(label) });
  }
  return entries;
}

/** 只读 `common:taskStatus.*` / `common:processStatus.*` / `agent:…attention.*` 的 t 替身。 */
function translatorFor(locale: string) {
  const agent = load(locale, 'agent');
  const common = load(locale, 'common');
  return ((key: string) => {
    const [ns, ...rest] = key.split(':');
    const path = rest.join(':');
    const bucket = ns === 'agent' ? dig(agent, path) : dig(common, path);
    if (typeof bucket === 'string') return bucket;
    throw new Error(`词表缺键：${key}（${locale}）`);
  }) as unknown as Parameters<typeof taskStatusLabel>[1];
}

describe('A3 · 跨词表字面互斥（同屏不得出现两个字面相同、含义不同的状态词）', () => {
  for (const locale of LOCALES) {
    it(`${locale}：五个词表之间没有相同文案`, () => {
      const collisions = crossVocabularyCollisions(vocabularyOf(locale));
      // 失败信息要能直接指出撞了哪两个概念——否则读报的人还得自己 diff 一遍。
      expect(
        collisions.map((c) => `「${c.label}」同时表示 ${c.values.join(' / ')}`),
      ).toEqual([]);
    });
  }

  it('检查器本身会咬人：把注意力文案改成治理态文案，必须被抓到', () => {
    const entries = vocabularyOf('zh-CN').map((e) =>
      e.concept === 'attention' && e.value === 'idle' ? { ...e, label: '评审中' } : e,
    );
    const collisions = crossVocabularyCollisions(entries);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]!.label).toBe('评审中');
    expect(collisions[0]!.concepts.sort()).toEqual(['attention', 'task-status']);
  });
});

describe('A3 · 词表完整性（枚举里每个值都得有词，词表里不得有枚举外的值）', () => {
  /** `ItemStatus` 的九个值（packages/shared/src/types/task.ts）。 */
  const ITEM_STATUSES = [
    'pending', 'in_progress', 'blocked', 'review', 'completed',
    'failed', 'rejected', 'cancelled', 'archived',
  ];

  it('治理态：九个真实状态一个不少，且不夹带枚举外的状态', () => {
    expect(Object.keys(TASK_STATUS_KEY).sort()).toEqual([...ITEM_STATUSES].sort());
    // 审批态是另一个命名空间（common:approvalStatus）。状态表里再放 approved/draft/assigned，
    // 就等于给「编造出来的状态」留座位——它们曾经真的在那里。
    for (const ghost of ['approved', 'draft', 'assigned']) {
      expect(Object.keys(TASK_STATUS_KEY)).not.toContain(ghost);
    }
  });

  it('注意力：三个状态一个不少', () => {
    expect([...ATTENTION_STATES].sort()).toEqual(['deciding', 'focused', 'idle']);
  });

  it('进程态：六个状态一个不少', () => {
    expect(Object.keys(PROCESS_STATUS_KEY).sort()).toEqual(
      ['error', 'idle', 'offline', 'online', 'paused', 'working'],
    );
  });

  for (const locale of LOCALES) {
    it(`${locale}：三张 i18n 词表覆盖所有枚举值（缺键会静默回落成英文枚举）`, () => {
      const t = translatorFor(locale);
      for (const status of ITEM_STATUSES) {
        expect(taskStatusLabel(status, t), `taskStatus.${status}`).not.toBe(status);
      }
      for (const state of ATTENTION_STATES) {
        expect(attentionStateLabel(state, t).length).toBeGreaterThan(0);
      }
      for (const status of Object.keys(PROCESS_STATUS_KEY)) {
        expect(processStatusLabel(status, t), `processStatus.${status}`).not.toBe(status);
      }
    });
  }
});

describe('A3 · 同屏两个位置：「任务在 review」+「agent 处于 idle」文案必须不同且语义正确', () => {
  it('zh-CN：任务说「评审中」，agent 说「Agent 待命」——不是同一个词', () => {
    const t = translatorFor('zh-CN');
    const taskWord = taskStatusLabel('review', t);
    const attentionWord = attentionStateLabel('idle', t);
    expect(taskWord).toBe('评审中');
    expect(attentionWord).toBe('Agent 待命');
    expect(taskWord).not.toBe(attentionWord);
  });

  it('en：In Review ≠ AGENT STANDBY', () => {
    const t = translatorFor('en');
    expect(taskStatusLabel('review', t)).toBe('In Review');
    expect(attentionStateLabel('idle', t)).toBe('AGENT STANDBY');
  });

  it('「在等谁」的 idle 不再说「空闲」——那是进程态的词', () => {
    // 曾用名：STAGE_LABEL.idle.label === '空闲'，与进程态 common:status.idle 同字。
    expect(STAGE_LABEL['none:idle']!.label).toBe('无待办');
    expect(STAGE_LABEL['none:idle']!.label).not.toBe(processStatusLabel('idle', translatorFor('zh-CN')));
  });
});
