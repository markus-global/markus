/**
 * 语义色调表 —— **全站唯一的「颜色 = 含义」映射**。
 *
 * ── 为什么必须有这一层（Owner 2026-11-08）────────────────────────────────
 * 「不同的颜色应该有不同的意义，并且在不同地方颜色的意义应该统一，不能有颜色引起的
 * 误解。」在这之前，状态→颜色的映射有 **5 个写者**，各自为政：
 *
 *   ① `pages/Work.tsx`      TASK_STATUS_BADGE_CLS / REQ_STATUS_BADGE_CLS / PRIORITY_*
 *   ② `pages/Home.tsx`      ATTENTION_TONE / STATUS_COLORS_BG（活动条）
 *   ③ `components/ExecutionTimeline.tsx`（自己一套，且同一份表复制了两遍）
 *   ④ `lib/stateVocabulary.ts` BLOCKED_TONE
 *   ⑤ `components/SearchModal.tsx` / `pages/Search.tsx`（三元表达式各写一遍）
 *
 * 结果不是「风格不统一」这么轻，是**同一个状态表达出互相矛盾的意思**：
 *   · 待验收：Work 紫 / 概览蓝 / 执行轴紫 —— 三处两色；
 *   · 阻塞：  Work 橙 / 概览琥珀 / 关注队列红 —— 三处三色；
 *   · 待审批（等你立刻回答）与「还没开始的任务」（只是排队）**同色**。
 *
 * 一个事实只能有一个写者。所以这里有且只有这一份映射，其余文件只能 import 结果，
 * 不许再写 `bg-xxx-500/15`。
 *
 * ── 六个色调，一个含义（不允许一色两义）──────────────────────────────────
 * | tone        | 含义                                       | 你的动作 |
 * |-------------|--------------------------------------------|----------|
 * | `attention` | **在等你**：等你回答 / 批准 / 验收 / 审需求   | 现在去做 |
 * | `active`    | 正在推进（agent 在干活）                     | 不用管   |
 * | `blocked`   | 卡住了（等依赖 / 等外部）                     | 看情况解 |
 * | `success`   | 完成 / 通过 / 已批准                         | 不用管   |
 * | `danger`    | 失败 / 被拒 / 出错                           | 去处理   |
 * | `neutral`   | 排队中 / 已取消 / 已归档 / 普通消息           | 不用管   |
 *
 * ── 两条纪律 ─────────────────────────────────────────────────────────────
 * 1. **同名不同义必须不同色**：`task.pending`（还没开始）≠ `requirement.pending`
 *    （等你批）。所以映射函数按 **(实体, 状态)** 收键，绝不按状态字符串收键 ——
 *    `taskTone('pending')` 与 `requirementTone('pending')` 结果必须不同。
 * 2. **优先级不占状态色**：优先级是另一个轴，除了 `urgent` 用 `danger`（真正的紧急
 *    才配红），其余一律中性、靠字重区分。否则「高优先级」「阻塞」两个橙并排放着，
 *    读的人只能靠猜。
 */

export type Tone = 'neutral' | 'active' | 'blocked' | 'attention' | 'success' | 'danger';

export interface ToneClasses {
  /** 小徽标：浅底 + 深字（`bg-x-500/15 text-x-600`） */
  chip: string;
  /** 圆点 / 竖条（实心小元素） */
  dot: string;
  /** 实心块（图例、进度条、面积） */
  solid: string;
  /** 纯文字 */
  text: string;
  /** 描边 / 左边框（卡片、优先级条） */
  border: string;
  /** 极浅底色（整块卡片的底） */
  surface: string;
  /** 轻按钮（关注行的主行动） */
  btn: string;
  /** 图表用的十六进制（与 chip 同一个色调，SVG/Canvas 里用） */
  hex: string;
}

/**
 * 六个色调的实际取值。
 *
 * 只在这里出现颜色名。`/15` + `-500/-600` 是既有视觉语言（深色底上仍可读），
 * 换主题时只改这一张表。
 */
export const TONE: Readonly<Record<Tone, ToneClasses>> = {
  // 紫 = 在等你。刻意不用琥珀：琥珀在深色底上偏棕，且与「卡住」太近。
  attention: {
    chip: 'bg-violet-500/15 text-violet-500',
    dot: 'bg-violet-500',
    solid: 'bg-violet-500',
    text: 'text-violet-500',
    border: 'border-violet-500/40',
    surface: 'bg-violet-500/[0.06]',
    btn: 'bg-violet-500/10 text-violet-500 hover:bg-violet-500/20',
    hex: '#8b5cf6',
  },
  // 蓝 = 正在推进。最常见的「正常运转」。
  active: {
    chip: 'bg-blue-500/15 text-blue-500',
    dot: 'bg-blue-500',
    solid: 'bg-blue-500',
    text: 'text-blue-500',
    border: 'border-blue-500/40',
    surface: 'bg-blue-500/[0.06]',
    btn: 'bg-blue-500/10 text-blue-500 hover:bg-blue-500/20',
    hex: '#3b82f6',
  },
  // 橙 = 卡住。与紫（等你）、红（出错）都留出明显间距。
  blocked: {
    chip: 'bg-orange-500/15 text-orange-500',
    dot: 'bg-orange-500',
    solid: 'bg-orange-500',
    text: 'text-orange-500',
    border: 'border-orange-500/40',
    surface: 'bg-orange-500/[0.06]',
    btn: 'bg-orange-500/10 text-orange-500 hover:bg-orange-500/20',
    hex: '#f97316',
  },
  // 绿 = 成了。
  success: {
    chip: 'bg-green-500/15 text-green-600',
    dot: 'bg-green-500',
    solid: 'bg-green-500',
    text: 'text-green-600',
    border: 'border-green-500/30',
    surface: 'bg-green-500/[0.06]',
    btn: 'bg-green-500/10 text-green-600 hover:bg-green-500/20',
    hex: '#22c55e',
  },
  // 红 = 出错 / 被拒 / 紧急。
  danger: {
    chip: 'bg-red-500/15 text-red-500',
    dot: 'bg-red-500',
    solid: 'bg-red-500',
    text: 'text-red-500',
    border: 'border-red-500/40',
    surface: 'bg-red-500/[0.06]',
    btn: 'bg-red-500/10 text-red-500 hover:bg-red-500/20',
    hex: '#ef4444',
  },
  // 灰 = 没有情绪：排队、取消、归档、普通消息。
  neutral: {
    chip: 'bg-gray-500/15 text-fg-tertiary',
    dot: 'bg-gray-400',
    solid: 'bg-gray-500',
    text: 'text-fg-tertiary',
    border: 'border-border-default/60',
    surface: 'bg-surface-elevated/60',
    btn: 'bg-surface-overlay text-fg-secondary hover:bg-surface-overlay/70',
    hex: '#6b7280',
  },
};

/** 未知状态一律 `neutral` —— 宁可无色，不可编造一个含义。 */
function has(map: Readonly<Record<string, Tone>>, key: string | null | undefined): Tone {
  return (key && map[key]) || 'neutral';
}

/**
 * 任务状态 → 色调。
 *
 * 关键判据：**这件事现在需不需要人动手**。
 * `review` 是紫（等你验收），`revision` 是蓝（返工是 agent 的活，不是你的）。
 */
const TASK_TONE: Readonly<Record<string, Tone>> = {
  pending: 'neutral',      // 排队中 —— 曾经用琥珀，与「待审批」撞色
  in_progress: 'active',
  blocked: 'blocked',
  review: 'attention',     // 等你验收
  revision: 'active',      // 打回返工：agent 的活
  completed: 'success',
  failed: 'danger',
  rejected: 'danger',
  cancelled: 'neutral',
  archived: 'neutral',
};

/**
 * 需求状态 → 色调。
 *
 * 注意 `pending`：需求的「待定」= **等你批准**，所以是紫，不是灰。
 * 这与 `task.pending`（还没开始）是两个含义 —— 见测试里的同名不同义守卫。
 */
const REQUIREMENT_TONE: Readonly<Record<string, Tone>> = {
  pending: 'attention',
  in_progress: 'active',
  completed: 'success',
  rejected: 'danger',
  cancelled: 'neutral',
  archived: 'neutral',
};

/** 项目状态 → 色调。 */
const PROJECT_TONE: Readonly<Record<string, Tone>> = {
  active: 'active',
  in_progress: 'active',
  planning: 'neutral',
  paused: 'blocked',
  blocked: 'blocked',
  completed: 'success',
  archived: 'neutral',
  cancelled: 'neutral',
};

/** 交付物状态 → 色调。 */
const DELIVERABLE_TONE: Readonly<Record<string, Tone>> = {
  draft: 'neutral',
  pending: 'neutral',
  submitted: 'attention',
  in_review: 'attention',
  review: 'attention',
  approved: 'success',
  published: 'success',
  rejected: 'danger',
  archived: 'neutral',
};

export function taskTone(status: string | null | undefined): Tone {
  return has(TASK_TONE, status);
}

export function requirementTone(status: string | null | undefined): Tone {
  return has(REQUIREMENT_TONE, status);
}

export function projectTone(status: string | null | undefined): Tone {
  return has(PROJECT_TONE, status);
}

export function deliverableTone(status: string | null | undefined): Tone {
  return has(DELIVERABLE_TONE, status);
}

/**
 * 实体 + 状态 → 色调。渲染方只有 (type, status) 时用这个，不要自己 switch。
 * 未知实体类型退回 `neutral`（不猜）。
 */
export function entityTone(
  type: string | null | undefined,
  status: string | null | undefined,
): Tone {
  switch (type) {
    case 'task': return taskTone(status);
    case 'requirement': return requirementTone(status);
    case 'project': return projectTone(status);
    case 'deliverable': return deliverableTone(status);
    default: return 'neutral';
  }
}

/**
 * 优先级 → 色调。**只有 `urgent` 占用颜色**（红 = 真紧急），其余一律中性。
 *
 * 理由：优先级与状态是两个正交的轴，如果各配一色，屏幕上会出现「橙色阻塞 + 橙色高优」
 * 这种只能靠猜的组合。高/中/低靠字重与文案区分就够了。
 */
export function priorityTone(priority: string | null | undefined): Tone {
  return (priority ?? '').toLowerCase() === 'urgent' ? 'danger' : 'neutral';
}

/** `formatWaiting` 的等待时长 → 色调：等越久越刺眼，但只借用 danger / attention / neutral 三档。 */
export function waitTone(waitingMs: number): Tone {
  if (!Number.isFinite(waitingMs) || waitingMs < 0) return 'neutral';
  const hour = 3_600_000;
  if (waitingMs >= 24 * hour) return 'danger';
  if (waitingMs >= hour) return 'attention';
  return 'neutral';
}
