/**
 * Ticket 的持久层 —— **全仓唯一的票写入点**。
 *
 * 为什么不塞进 sqlite-storage.ts：那个文件已 6600 行、30+ 个 repo 类；
 * 与 thread-store.ts 同一理由（那里写着「再塞 5 张表会把它变成不可 review 的泥球」）。
 * 这里只做「表 ↔ 结构体」的搬运 + 两条不变量，任何业务判断（这张票该不该建、
 * 该给谁）不属于 repo —— 那是调用方的事。
 *
 * ## 两条不变量，各有唯一执行点
 *
 * 1. **状态机**：`transition()` 只调 `@markus/shared` 的 `isValidTicketTransition`，
 *    自己**不写**任何 `if (from === 'open' && ...)` 分支。状态机的第二份实现
 *    = 一个事实两个写者（契约 H7），今天多一个分支、明天就多一种「票既能这样又能那样」。
 * 2. **创建入口**：只有 `create()` 会 `INSERT INTO tickets`。整个仓库里
 *    `INSERT INTO tickets` / `UPDATE tickets` 只允许出现在本文件（由
 *    `packages/storage/test/ticket-store.test.ts` 的源码扫描守卫咬住，
 *    加第二个写者即红）。为什么不能靠数据库权限：SQLite 同进程只有一个连接、
 *    没有 per-table ACL，物理上挡不住别的模块直接拼 SQL —— 所以把「单一写者」
 *    做成**一条会红的检查**，而不是一句注释。
 *
 * ## 越界一律「拒绝 + 可行动提示」（平台规则第 5 条）
 *
 * 流转一个不存在的票**不静默 upsert**：自动建票会让「流转了但票不存在」
 * 悄悄变成合法操作，于是「票存不存在」这件事再也没人信得过。
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  allowedTicketTransitions,
  isTicketStatus,
  isValidTicketTransition,
  type Ticket,
  type TicketStatus,
} from '@markus/shared';

type RawTicket = {
  id: string;
  org_id: string;
  kind: string;
  source_ref: string | null;
  subject: string;
  status: string;
  assignee: string | null;
  task_id: string | null;
  created_at: number;
  updated_at: number;
};

/**
 * DB 行 → 领域对象。`status` 列的**唯一转换点**。
 *
 * 非法状态值（手改库 / 旧版本写入）读成 `open` 而不是抛错：票是**可读优先**的对象，
 * 一条坏数据不该让整条任务详情的票列表 500。但写入侧不接受非法值（见 create/transition），
 * 所以「读宽写严」不会让坏值扩散。
 */
function toTicket(r: RawTicket): Ticket {
  return {
    id: r.id,
    orgId: r.org_id,
    kind: r.kind,
    sourceRef: r.source_ref,
    subject: r.subject,
    status: isTicketStatus(r.status) ? r.status : 'open',
    assignee: r.assignee,
    taskId: r.task_id,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function randomId(): string {
  let out = '';
  for (let i = 0; i < 16; i++) out += Math.floor(Math.random() * 36).toString(36);
  return out;
}

/** 把 SQLite 的 FK 违规翻成可行动提示（外键错误信息只写「FOREIGN KEY constraint failed」，人看不懂）。 */
function translateForeignKeyError(err: unknown, taskId: string): Error {
  const msg = String((err as Error)?.message ?? err);
  if (/FOREIGN KEY constraint failed/i.test(msg)) {
    return new Error(
      `TICKET_TASK_NOT_FOUND: 任务 ${taskId} 不存在，票不能挂到不存在的任务上。` +
        `先建任务，或把 taskId 留空（票不需要任务也能独立存在）。`,
    );
  }
  return err as Error;
}

export class SqliteTicketRepo {
  constructor(private db: DatabaseSync) {}

  /**
   * 建票 —— **唯一的 INSERT 点**。
   *
   * 三条写入侧规矩（都在这里，不散到调用方）：
   *   · `subject` 必填非空：没有标题的票在 UI 上无法被认领；
   *   · 新建只能是 `open`：想建一张已结束的票 = 有人搞错了语义，直接拒绝；
   *   · `taskId` 必须指向真实任务（FK 执行 + 错误翻译成可行动提示）。
   */
  create(input: {
    id?: string;
    orgId: string;
    kind: string;
    sourceRef?: string | null;
    subject: string;
    assignee?: string | null;
    taskId?: string | null;
    now?: number;
  }): Ticket {
    const subject = String(input.subject ?? '').trim();
    if (!subject) {
      throw new Error(
        'TICKET_SUBJECT_REQUIRED: 票必须有标题（subject）。没有标题的票在列表里无法被认领 —— 用来源对象的一句话描述作为 subject。',
      );
    }
    const kind = String(input.kind ?? '').trim();
    if (!kind) {
      throw new Error(
        "TICKET_KIND_REQUIRED: 票必须声明 kind（这条东西是什么：message / comment / webhook / task / resource / manual …）。",
      );
    }
    if (!input.orgId) {
      throw new Error("TICKET_ORG_REQUIRED: 缺 org_id（Markus 单租户恒为 'default'）。");
    }

    const id = input.id ?? `tkt_${randomId()}`;
    const now = input.now ?? Date.now();
    const taskId = input.taskId ?? null;
    try {
      this.db
        .prepare(
          `INSERT INTO tickets (id, org_id, kind, source_ref, subject, status, assignee, task_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
        )
        .run(id, input.orgId, kind, input.sourceRef ?? null, subject, input.assignee ?? null, taskId, now, now);
    } catch (err) {
      throw taskId ? translateForeignKeyError(err, taskId) : (err as Error);
    }
    const created = this.getById(id);
    if (!created) throw new Error(`TICKET_INSERT_FAILED: ${id}`);
    return created;
  }

  getById(id: string): Ticket | null {
    const row = this.db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(id) as RawTicket | undefined;
    return row ? toTicket(row) : null;
  }

  /** 某张任务上挂的票（`GET /api/tasks/:id/tickets` 的数据源）。 */
  listByTask(taskId: string, limit = 100): Ticket[] {
    const rows = this.db
      .prepare(`SELECT * FROM tickets WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(taskId, limit) as RawTicket[];
    return rows.map(toTicket);
  }

  /** 某个组织下的票（按最近更新倒序）。 */
  listByOrg(orgId: string, limit = 100): Ticket[] {
    const rows = this.db
      .prepare(`SELECT * FROM tickets WHERE org_id = ? ORDER BY updated_at DESC LIMIT ?`)
      .all(orgId, limit) as RawTicket[];
    return rows.map(toTicket);
  }

  /**
   * 流转状态 —— **唯一的 UPDATE status 点**（状态机唯一执行点）。
   *
   * 两个拒绝都带可行动提示：
   *   · 票不存在 → 告诉调用方**别指望流转会自动建票**，要么先 create，要么确认 id；
   *   · 转移非法 → 列出当前状态允许的去处（而不是一句 "invalid transition"）。
   */
  transition(id: string, next: TicketStatus, now = Date.now()): Ticket {
    const current = this.getById(id);
    if (!current) {
      throw new Error(
        `TICKET_NOT_FOUND: 票 ${id} 不存在，不能流转状态。` +
          `用 GET /api/tickets/${id} 确认 id，或用 POST /api/tickets 新建一张（流转不会自动建票）。`,
      );
    }
    if (!isTicketStatus(next)) {
      throw new Error(`TICKET_STATUS_INVALID: 「${String(next)}」不是合法票状态（open / ended / cancelled）。`);
    }
    if (!isValidTicketTransition(current.status, next)) {
      throw new Error(
        `TICKET_TRANSITION_INVALID: ${current.status} → ${next} 不允许。` +
          `${current.status} 只能转到 [${allowedTicketTransitions(current.status).join(', ') || '∅（终态）'}]。`,
      );
    }
    this.db.prepare(`UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?`).run(next, now, id);
    const updated = this.getById(id);
    if (!updated) throw new Error(`TICKET_VANISHED: ${id}`);
    return updated;
  }

  /**
   * 关联/断开任务 —— 唯一的 UPDATE task_id 点。
   *
   * `null` = 断开（不删票）。为什么允许断开：票的生命周期**不跟随**任务
   * （设计原文「Ticket 自己定义状态，不跟随 Executor」）。
   */
  linkTask(id: string, taskId: string | null, now = Date.now()): Ticket {
    const current = this.getById(id);
    if (!current) {
      throw new Error(
        `TICKET_NOT_FOUND: 票 ${id} 不存在，不能关联任务。用 GET /api/tickets/${id} 确认 id，或先 POST /api/tickets。`,
      );
    }
    try {
      this.db.prepare(`UPDATE tickets SET task_id = ?, updated_at = ? WHERE id = ?`).run(taskId, now, id);
    } catch (err) {
      throw taskId ? translateForeignKeyError(err, taskId) : (err as Error);
    }
    const updated = this.getById(id);
    if (!updated) throw new Error(`TICKET_VANISHED: ${id}`);
    return updated;
  }
}
