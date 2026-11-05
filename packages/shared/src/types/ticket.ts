/**
 * Ticket —— **执行侧的工作单位**（纯类型 + 纯函数，零 IO）。
 *
 * 设计依据：《Markus × Super-agent 分析与目标设计》§7.3 五个一等对象、
 * §7.8 自主档位；Owner 2026-11-03 裁定：「Task 是更上层的治理对象；
 * **任何东西都可能有 Ticket**（一条评论、一封消息、一个 webhook）」。
 *
 * ## 与 Task 的边界（本文件存在的理由）
 *
 * | 问题 | Task（治理对象） | Ticket（执行侧单位） |
 * |---|---|---|
 * | 回答什么 | 这件事**该不该做**、谁批、谁验收 | 这一件外部来的东西**现在归谁处理**、结束了没有 |
 * | 状态 | `TaskStatus` 9 个治理态 + 审批闸门 | 本文件的 `TicketStatus` 3 个态 |
 * | 能否独立存在 | 必须挂 requirement、必须有人批准 | **可以什么都不挂**（无 task、无 requirement） |
 * | 谁创建 | 人 / requirement 审批流 | 任何入口（事件、评论、webhook、人手动） |
 * | 驱动执行吗 | 是（assignee 会被叫醒干活） | **否**——票没有执行通道，它只是「这件事归谁、办完没有」 |
 *
 * 最后一行是「Ticket 会不会变成第二个 Task」的唯一判据：**票不驱动任何执行**。
 * 一旦有人给 ticket 接上「ticket → agent 投递」的通道，它就成了第二个任务系统，
 * 那时必须停下来重新裁定（契约 H1：不得新增一个「系统」）。
 */

/**
 * 票的状态。**只三态**，且刻意不含 TaskStatus 的任何治理词
 * （pending / review / approved …）。
 *
 * 为什么不是五个态（design 01 原文只说 open→ended）：多出来的每一态都要有人维护、
 * 有人对账；三态已能回答票唯一要回答的问题——「这件事还没完 ⇄ 完了 ⇄ 人喊停了」。
 *
 * - `open`      还没办完
 * - `ended`     办完了（**人再发消息可恢复**成 open —— 原文「open→ended，人发消息可恢复」）
 * - `cancelled` 人喊停（终态，不可恢复）
 */
export type TicketStatus = 'open' | 'ended' | 'cancelled';

/**
 * 状态机 —— **唯一事实源**。`SqliteTicketRepo.transition()` 是它唯一的执行点，
 * 任何第二个「能不能转」的判断都算新增写者（契约 H7）。
 */
export const TICKET_TRANSITIONS: Readonly<Record<TicketStatus, ReadonlySet<TicketStatus>>> = {
  open: new Set<TicketStatus>(['ended', 'cancelled']),
  // ended → open：人在这条流上又发了消息，票被恢复（设计原文明确允许）
  ended: new Set<TicketStatus>(['open', 'cancelled']),
  // cancelled → ∅：人喊停是终态。允许「复活」等于让人对自己喊过的停失去信心。
  cancelled: new Set<TicketStatus>(),
};

/** 闭集，供 UI / 校验穷举。顺序即展示顺序。 */
export const TICKET_STATUSES: readonly TicketStatus[] = ['open', 'ended', 'cancelled'];

/** 判断一次状态转移是否合法。仓储只调它，不自己写 if 链。 */
export function isValidTicketTransition(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_TRANSITIONS[from]?.has(to) ?? false;
}

/** 某个状态允许转到哪些状态（拒绝时给可行动提示用）。 */
export function allowedTicketTransitions(from: TicketStatus): TicketStatus[] {
  return [...(TICKET_TRANSITIONS[from] ?? [])];
}

/** 类型守卫：字符串是不是合法票状态。 */
export function isTicketStatus(v: unknown): v is TicketStatus {
  return typeof v === 'string' && (TICKET_STATUSES as readonly string[]).includes(v);
}

/**
 * 票绑在什么东西上。
 *
 * **刻意是开放字符串，不是闭集**：Ticket 的卖点就是「任何事件都可挂票」，
 * 把它枚举死等于每来一个新来源都要改一次核心类型 + 前端穷举
 * （这正是 `mailbox_items.type` 那条 R1 的老路）。文档里列出当前已知取值，
 * 新来源只需要写一个新的 kind 字符串。
 *
 * 已知取值（非白名单，仅备忘）：`message` | `comment` | `webhook` | `task` |
 * `resource` | `approval` | `manual`
 */
export type TicketKind = string;

/** 一条票。时间列一律 epoch ms（与 `thread-store.ts` 的新表约定一致）。 */
export interface Ticket {
  id: string;
  orgId: string;
  kind: TicketKind;
  /**
   * 票指向的**来源对象**（`msg_…` / `cmt_…` / `gh:owner/repo#123` / `tsk_…`）。
   * null = 手动创建，没有来源事件。
   */
  sourceRef: string | null;
  /** 一句话标题。空标题的票在 UI 上无法被认领，写入时直接拒绝。 */
  subject: string;
  status: TicketStatus;
  /** 谁在处理这张票。**单值**——票是「一件东西归一个人」，不是责任域（A4 是另一个概念）。 */
  assignee: string | null;
  /**
   * 可选关联的 Task（治理对象）。**不是从属关系**：
   * 删 task 只会把这一列置空（`ON DELETE SET NULL`），票本身继续存在且可读。
   */
  taskId: string | null;
  createdAt: number;
  updatedAt: number;
}
