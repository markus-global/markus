/**
 * A3 · 三种「状态」的词表互斥不变量。
 *
 * 判据（可执行）：**同一个字面值不得在两个不同概念下出现**。
 * 本分支上同屏出现的状态概念只有三个，各有唯一来源：
 *
 *   task-status   治理态   → `common:taskStatus.*`（落库 · FSM 唯一转移点）
 *   attention     运行时注意力 → `agent:profilePage.mind.attention.*`（内存）
 *   process       进程态   → `common:processStatus.*`（运行期）
 *
 * 历史（教训保留）：源分支上还有第四个概念「在等谁」（`threadPresentation.ts#STAGE_LABEL`，
 * 派生不落库）。那个概念在本分支不存在，因此这里**不参与比对** —— 但下面这条不变量本身
 * 仍然是「把两个文案改回同一字面值必须变红」的自动化版本，与概念个数无关。
 *
 * 为什么必须断言「字面互斥」而不是只断言「各有各的枚举」：
 * 用户看到的是**字面**，不是枚举值。历史上「进行中」曾同时是「在等谁」与治理态 `in_progress`，
 * 「空闲」曾同时是「在等谁」的 idle 与进程态 idle，而所有类型检查、所有单测都是绿的。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ATTENTION_STATES,
  BLOCKED_TONE,
  PROCESS_STATUS_KEY,
  TASK_STATUS_KEY,
  attentionStateLabel,
  blockedReasonOf,
  crossVocabularyCollisions,
  processStatusLabel,
  taskStatusLabel,
  taskStatusPresentation,
  type LabelEntry,
} from './stateVocabulary.ts';
import { TONE } from './tone.ts';

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

/** 一个 locale 的全部状态词。 */
function vocabularyOf(locale: string): LabelEntry[] {
  const agent = load(locale, 'agent');
  const common = load(locale, 'common');
  const entries: LabelEntry[] = [];

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
    it(`${locale}：三张词表之间没有相同文案`, () => {
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
});

/**
 * `blocked` 的两种实质（判别位 `blockedReason`）。
 *
 * 缺陷（Owner 2026-11-05）：「等你处理」把 `blocked` 一律当严重问题要求人做决定，
 * 但 `deps`（上游依赖没完成）根本不需要人 —— 依赖一完成引擎自己就恢复了。
 * 前端曾用「blockedBy 是否为空 / 依赖是否都已完成」反推，Work.tsx 三处、Home.tsx 一处。
 *
 * 这里的判据：**同一个状态值必须能被说成两句不同的话，且两句都不是「故障」**。
 */
describe('blocked 的原因：等待依赖 ≠ 已挂起', () => {
  it('判别位只认 hold，其余（含旧行 NULL）一律当 deps', () => {
    expect(blockedReasonOf('hold')).toBe('hold');
    expect(blockedReasonOf('deps')).toBe('deps');
    // 该列出现之前的旧行是 NULL —— 与 shared 的 BlockedReason 注释一致：退回旧行为。
    expect(blockedReasonOf(undefined)).toBe('deps');
    expect(blockedReasonOf(null)).toBe('deps');
    // 不认识的值不猜成 hold（那会把人叫醒），按 deps 处理。
    expect(blockedReasonOf('nonsense')).toBe('deps');
  });

  for (const locale of LOCALES) {
    it(`${locale}：两种原因的文案互不相同，也不等于裸枚举值`, () => {
      const t = translatorFor(locale);
      const deps = taskStatusLabel('blocked', t, 'deps');
      const hold = taskStatusLabel('blocked', t, 'hold');
      expect(deps).not.toBe(hold);
      expect(deps).not.toBe('blocked');
      expect(hold).not.toBe('blocked');
      // 缺判别位时才退回中性的「已阻塞」（例如选择状态的菜单）。
      // 字面直接读真实 locale 文件，而不是在词表外拼 `common:taskStatus.*`。
      expect(taskStatusLabel('blocked', t)).toBe(String(dig(load(locale, 'common'), 'taskStatus.blocked')));
    });
  }

  it('zh-CN 用词：deps = 等待依赖（中性），hold = 已挂起（警示），都不叫「故障」', () => {
    const t = translatorFor('zh-CN');
    expect(taskStatusLabel('blocked', t, 'deps')).toBe('等待依赖');
    expect(taskStatusLabel('blocked', t, 'hold')).toBe('已挂起');
  });

  it('语气与文案同源：deps 不带警示色，hold 用「卡住」色，两者不同', () => {
    const t = translatorFor('zh-CN');
    const deps = taskStatusPresentation('blocked', t, 'deps');
    const hold = taskStatusPresentation('blocked', t, 'hold');
    expect(deps.tone).toBe(BLOCKED_TONE.deps);
    expect(hold.tone).toBe(BLOCKED_TONE.hold);
    // 不写死具体色值（旧断言写死 'red'，一改配色就变黑）；断言的是**来源与关系**：
    // deps = 不需要人动（neutral），hold = 卡住（blocked），且两者不可能同色。
    expect(BLOCKED_TONE.deps.chip).toBe(TONE.neutral.chip);
    expect(BLOCKED_TONE.hold.chip).toBe(TONE.blocked.chip);
    expect(BLOCKED_TONE.deps.chip).not.toBe(BLOCKED_TONE.hold.chip);
    // 非 blocked 状态没有原因语气：交给各自的既有配色。
    expect(taskStatusPresentation('in_progress', t, undefined).tone).toBeNull();
  });

  it('新增的两个词条不与其他概念撞字面（同屏可读性）', () => {
    // `vocabularyOf` 已把 common:taskStatus.* 全量纳入，这里补一条显式失败信息。
    const collisions = crossVocabularyCollisions(vocabularyOf('zh-CN'));
    const labels = ['等待依赖', '已挂起'];
    for (const label of labels) {
      expect(collisions.filter((c) => c.label === label), `「${label}」不该同时属于两个概念`).toEqual([]);
    }
  });
});
