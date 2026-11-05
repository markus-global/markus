/**
 * 三种「状态」的**唯一词表入口**（A3）。
 *
 * 同一个用户屏幕上有三个都在回答「状态」、但答案完全不同的东西，它们各自也必须
 * 只有一个名字、一个来源：
 *
 * | 概念 | 回答 | 类型（唯一来源） | 落库 |
 * |---|---|---|---|
 * | 在等谁 | 这条流此刻在等谁动手 | `ThreadStage`（`deriveStage()` 纯派生） | 否 |
 * | 治理态 | 这件事走到治理流程哪一步 | `TaskStatus`（`updateTaskStatus()` + FSM） | 是 |
 * | 运行时注意力 | agent 循环此刻在干什么 | `AttentionState`（`AttentionController.getState()`） | 否（内存，重启归零） |
 *
 * 这三个概念历史上共用过字面值（`idle` / `working`），并有**两个**治理态词表
 * （`common:status.review` = 待审核 vs `agent:profilePage.taskStatus.review` = 评审中）。
 * 结果是同一屏上出现两个含义不同的「进行中」，以及同一个治理状态两个说法。
 *
 * 本文件是治理态 / 注意力 / 进程态三类词的**唯一写者**；「在等谁」的写者是
 * `threadPresentation.ts` 的 `STAGE_LABEL`（架构守卫 E2.1 已锁死不得出现第二份）。
 * 跨词表的**可见字面互斥**由 `stateVocabulary.test.ts` 断言：任两张表出现相同文案即红。
 *
 * 判据：新增一处展示状态的地方，调这里的函数，不要自己拼 i18n key —— 自己拼就是第二写者，
 * 而第二写者不会报错，只会慢慢和第一份分叉。
 */
import type { TFunction } from 'i18next';

/**
 * 治理态：枚举值（snake_case，来自 `ItemStatus`）→ 词表键（camelCase）。
 *
 * 只列 `ItemStatus` 里**真实存在**的九个值。历史上这里还挂着 `assigned` / `approved` /
 * `draft` 三个词 —— 枚举里没有它们，审批态用的是另一个命名空间
 * （`common:approvalStatus.*`）。状态词表里放不存在的状态，等于给「编造的状态」留了座位。
 */
export const TASK_STATUS_KEY: Readonly<Record<string, string>> = {
  pending: 'pending',
  in_progress: 'inProgress',
  blocked: 'blocked',
  review: 'review',
  completed: 'completed',
  failed: 'failed',
  rejected: 'rejected',
  cancelled: 'cancelled',
  archived: 'archived',
};

/** 治理态的展示。未知值原样返回（不编造一个不存在的状态名）。 */
export function taskStatusLabel(status: string | null | undefined, t: TFunction): string {
  if (!status) return '—';
  const key = TASK_STATUS_KEY[status];
  return key ? t(`common:taskStatus.${key}`) : status;
}

/** 运行时注意力：三个值一一对应一张词表。 */
export const ATTENTION_STATES = ['idle', 'focused', 'deciding'] as const;
export type AttentionStateValue = (typeof ATTENTION_STATES)[number];

export function attentionStateLabel(state: string, t: TFunction): string {
  return t(`agent:profilePage.mind.attention.${state}`);
}

/**
 * 进程态（online / offline / working / …）：**不是**上面三者之一。
 * 它回答「这个进程还在不在、忙不忙」，与「在等谁」「治理态」「注意力循环」都不同轴。
 * 单独一个命名空间，避免它再与治理态挤在同一张表里（曾经 `common:status` 同时装两者）。
 */
export const PROCESS_STATUS_KEY: Readonly<Record<string, string>> = {
  idle: 'idle',
  working: 'working',
  online: 'online',
  offline: 'offline',
  paused: 'paused',
  error: 'error',
};

export function processStatusLabel(status: string | null | undefined, t: TFunction): string {
  if (!status) return '—';
  const key = PROCESS_STATUS_KEY[status];
  return key ? t(`common:processStatus.${key}`) : status;
}

// ─────────────────────────────────────────────────────────────
// 不变量：跨词表的可见字面互斥
// ─────────────────────────────────────────────────────────────

/** 五个概念标签：三个「状态」+「在等谁」的分组头 + 进程态（同屏出现，同样受约束）。 */
export type StatusConcept = 'thread-stage' | 'thread-group' | 'task-status' | 'attention' | 'process';

export interface LabelEntry {
  concept: StatusConcept;
  value: string;
  label: string;
}

export interface LabelCollision {
  label: string;
  concepts: StatusConcept[];
  values: string[];
}

/**
 * 找出「同一个字面值被两个以上概念使用」的标签。
 *
 * 这是 A3 的可执行判据：**用户看到的是字面，不是枚举值**。只要一个字面同时挂在两个
 * 概念上，用户就一定会在某个同屏场景里把它读成另一件事。返回空数组 = 不变量成立。
 *
 * 放在源码（而不是只放在测试里）是有意的：以后任何新增状态展示的地方都能直接调用它，
 * 而不必复制一份比对逻辑。
 */
export function crossVocabularyCollisions(entries: readonly LabelEntry[]): LabelCollision[] {
  const byLabel = new Map<string, LabelEntry[]>();
  for (const entry of entries) {
    const key = entry.label.trim();
    if (!key) continue;
    const bucket = byLabel.get(key);
    if (bucket) bucket.push(entry);
    else byLabel.set(key, [entry]);
  }

  const collisions: LabelCollision[] = [];
  for (const [label, hits] of byLabel) {
    const concepts = [...new Set(hits.map((h) => h.concept))];
    if (concepts.length > 1) {
      collisions.push({ label, concepts, values: hits.map((h) => `${h.concept}:${h.value}`) });
    }
  }
  return collisions;
}
