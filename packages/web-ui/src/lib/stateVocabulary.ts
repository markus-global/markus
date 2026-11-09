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
 * 这三个概念历史上共用过字面值（`idle` / `working`），并曾有过**两个**治理态词表
 * （旧扁平的 `common:status.review` = 待审核 vs 已删除的 `agent:profilePage.taskStatus.review`
 * = 评审中）。结果是同一屏上出现两个含义不同的「进行中」，以及同一个治理状态两个说法。
 * 后一张表连同它夹带的 `assigned` / `approved` / `draft` 三个**枚举里不存在的状态**一起删除，
 * 现在本文件是治理态的唯一写者。
 *
 * 本文件是治理态 / 注意力 / 进程态三类词的**唯一写者**；「在等谁」的写者是
 * `threadPresentation.ts` 的 `STAGE_LABEL`（架构守卫 E2.1 已锁死不得出现第二份）。
 * 跨词表的**可见字面互斥**由 `stateVocabulary.test.ts` 断言：任两张表出现相同文案即红。
 *
 * 判据：新增一处展示状态的地方，调这里的函数，不要自己拼 i18n key —— 自己拼就是第二写者，
 * 而第二写者不会报错，只会慢慢和第一份分叉。
 */
import type { TFunction } from 'i18next';
import { TONE } from './tone.ts';

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

/**
 * `blocked` 的**原因**（判别位，落库列为 `tasks.blocked_reason`）。
 *
 * 一个状态值同时表示两件性质完全不同的事，用户就只能靠猜：
 *  - `deps`：上游依赖没完成。**可计算的派生事实**，依赖一解除引擎自动恢复，人无事可做；
 *  - `hold`：人/agent **主动声明的挂起**（点暂停、明确说「停在这里」）。这是意图，要人决定。
 *
 * 把它俩都渲染成红色的「阻塞」＝ 让人为一件他无法处理的事做决定（Owner 2026-11-05 提的问题）。
 * 判定**只读这个字段**：从 `blockedBy` 是否为空、依赖是否已完成反推，是同一事实的第二个写者
 * （Work.tsx 曾有三份、Home.tsx 有一份，各自漂移）。
 *
 * 缺省（`undefined` / `null` / 未知值）= `deps`，与 `packages/shared/src/types/task.ts` 的
 * `BlockedReason` 注释一致：该列出现之前的旧行按旧行为处理。
 */
export type BlockedReason = 'deps' | 'hold' | 'workflow';

/** 把 API 上的原始值收敛成闭集：不认识的一律当 `deps`（旧行语义）。 */
export function blockedReasonOf(reason: string | null | undefined): BlockedReason {
  if (reason === 'hold') return 'hold';
  if (reason === 'workflow') return 'workflow';
  return 'deps';
}

/**
 * 两类原因的词表键（`common:taskStatus.*` 下的同一命名空间）。
 *
 * 为什么不另开一张表：它们回答的仍是「这件事走到哪一步了」，只是 `blocked` 这一步有两种实质。
 * 另开一张表就会有人只更新其中一张。
 */
export const BLOCKED_REASON_KEY: Readonly<Record<BlockedReason, string>> = {
  deps: 'waitingDeps',
  hold: 'onHold',
  workflow: 'workflowPaused',
};

/**
 * 两类原因的视觉语气：`deps` 中性（灰，不是警告）、`hold` 警示（红）。
 *
 * 与文案同处一个文件是刻意的：颜色和字是同一句话的两个部分，
 * 拆到两个模块里就会出现「灰色已挂起」这种自相矛盾的组合。
 */
export const BLOCKED_TONE: Readonly<
  Record<BlockedReason, { chip: string; dot: string; bar: string; card: string }>
> = {
  // 等依赖：引擎自己会恢复，**没有任何人需要动手** → 中性灰。
  deps: {
    chip: TONE.neutral.chip,
    dot: TONE.neutral.dot,
    bar: TONE.neutral.dot,
    card: `${TONE.neutral.surface} border-border-default/60`,
  },
  // 被人工挂起：卡住了、需要人推 → blocked 橙（与「等你」的紫、「出错」的红分开）。
  hold: {
    chip: TONE.blocked.chip,
    dot: TONE.blocked.dot,
    bar: TONE.blocked.dot,
    card: `${TONE.blocked.surface} border-orange-500/30 ring-1 ring-orange-500/15`,
  },
  // 工作流自动暂停：引擎会自己恢复（无人需动手）→ 与 deps 同中性灰，绝不冒充「等你」。
  workflow: {
    chip: TONE.neutral.chip,
    dot: TONE.neutral.dot,
    bar: TONE.neutral.dot,
    card: `${TONE.neutral.surface} border-border-default/60`,
  },
};

/**
 * 治理态的展示。未知值原样返回（不编造一个不存在的状态名）。
 *
 * `blocked` 可以带原因：调用方手里通常有 task，传 `task.blockedReason`。
 * 不传 = 只知道「它是 blocked」而不知道原因，退回中性的 `common:taskStatus.blocked`
 * （历史含义「已阻塞」），**不猜**是 deps 还是 hold。选择状态的菜单属于这种场景
 * （此刻还没有原因，原因由服务端在进入 blocked 时判定）。
 */
export function taskStatusLabel(
  status: string | null | undefined,
  t: TFunction,
  blockedReason?: string | null,
): string {
  if (!status) return '—';
  if (status === 'blocked' && blockedReason !== undefined && blockedReason !== null) {
    return t(`common:taskStatus.${BLOCKED_REASON_KEY[blockedReasonOf(blockedReason)]}`);
  }
  const key = TASK_STATUS_KEY[status];
  return key ? t(`common:taskStatus.${key}`) : status;
}

/**
 * 一行状态展示的全部信息：**字 + 语气**，一起给出。
 *
 * 渲染方只拿 label 再自己写颜色，就是「同一事实两个写者」：迟早出现灰底「已挂起」。
 * `tone` 为 null = 不是 blocked（按状态本身的既有配色渲染）。
 */
export function taskStatusPresentation(
  status: string | null | undefined,
  t: TFunction,
  blockedReason?: string | null,
): { label: string; tone: (typeof BLOCKED_TONE)[BlockedReason] | null } {
  const label = taskStatusLabel(status, t, blockedReason);
  if (status === 'blocked' && blockedReason !== undefined && blockedReason !== null) {
    return { label, tone: BLOCKED_TONE[blockedReasonOf(blockedReason)] };
  }
  return { label, tone: null };
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

/** 四个概念标签：三个「状态」+ 进程态（同屏出现，同样受约束）。 */
export type StatusConcept = 'thread-stage' | 'task-status' | 'attention' | 'process';

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
