/**
 * Thread / Trigger / Router 的持久层。
 *
 * 为什么不塞进 sqlite-storage.ts：那个文件已经 6600 行、30+ 个 repo 类。
 * 再塞 5 张表会把它变成不可 review 的泥球。这里只做「表 ↔ 结构体」的搬运，
 * 任何业务判断（能不能接、接给谁）都不属于 repo —— 那是 service 的事。
 *
 * 时间列一律 INTEGER（epoch ms），与既有 `created_at TEXT` 的老表不同：
 * 新表全部新写，用毫秒整数才能让 `ORDER BY created_at DESC` 走索引。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Autonomy, ResourceBinding, ResourceScope } from '@markus/shared';

/**
 * 一条流的**登记行**。
 *
 * 这里刻意**没有 owner 字段**（`owner_agent` / `owner_session` / `owner_since` 已删除）。
 * 「谁负责」的唯一事实源是 `thread_subscriptions(purpose='own')` —— 它是**多值**的。
 *
 * 删因：owner 曾以单值列存在 threads 上，与 subscriptions 重复表达同一件事（两个写者），
 * 而且“一条流只能有一个 owner”直接导致“一个外部对象只能一个人盯”——那才是
 * P2-⑦「一 ref 多流」矛盾的**真正来源**，不是 UNIQUE(ref)。
 * UNIQUE(ref) 是对的：一个外部对象在平台里只该有一条代理记录。
 *
 * 零行为变化：upsert 写入的就是三列 NULL，setOwner/clearOwner 在生产代码零调用（只有测试驱动），
 * gateVerdict 的 `hasOwner || hasSubscriptions` 一直由 hasSubscriptions 单独生效。
 */
export interface ThreadRow {
  id: string;
  ref: string;
  createdAt: number;
  lastActivity: number;
}

export interface ThreadSubscriptionRow {
  threadId: string;
  ticketId: string;
  agentId: string;
  purpose: 'own' | 'context';
}

export interface DispositionRow {
  id: string;
  triggerId: string;
  threadId: string;
  action: string;
  reason: string;
  /**
   * 命中的 Gate 规则 id（契约 §5 六条，见 shared `MatchedRule`）。
   * null = 处置不是由 Gate 规则产生的（历史行 / 外部直接写入）。
   * 它是「为什么走了这条」的机器可读载体，与 `reason`（人话）互补。
   */
  matchedRule: string | null;
  /**
   * 「若闸门放行，他会不会接」。三态：
   *   true      会接
   *   false     不会接
   *   null      本次处置**没问过**这个问题（dispatch / attach / stop）
   * 不要把它当布尔用：`null` 读成 `false` 会让「没问过」伪装成「拒绝」。
   */
  wouldAccept: boolean | null;
  actor: string;
  createdAt: number;
}

export interface EventSourceRow {
  id: string;
  orgId: string;
  prefix: string;
  /**
   * 读取位点：**这条来源的上游读到哪儿了**。
   *
   * - `null` = 没有位点：推送式来源（webhook）不读，或历史行从未拉取过。
   * - 非 null = 上一次**全部消费成功**后提交的位置（失败不推进，见 `advanceCursor`）。
   *
   * 与幂等键的分工：位点负责「不重复拉」（拉取侧、按上游顺序），
   * 幂等键负责「重复投递只留一行」（入口侧、与顺序无关）。两者不可互替。
   */
  cursor: string | null;
  /** 最近一次拉取尝试的时间（观测用，不参与任何判定） */
  lastPolledAt: number | null;
  /** HMAC 密钥；**永不**写日志、永不进 API 响应 */
  secret: string | null;
  config: Record<string, unknown>;
  health: Record<string, unknown>;
  createdAt: number;
}

type RawThread = {
  id: string;
  ref: string;
  created_at: number;
  last_activity: number;
};

type RawDisposition = {
  id: string;
  trigger_id: string;
  thread_id: string;
  action: string;
  reason: string;
  matched_rule: string | null;
  would_accept: number | null;
  actor: string;
  created_at: number;
};

type RawBinding = {
  id: string;
  holder_kind: string;
  holder_id: string;
  resource: string;
  scope: string;
  autonomy: string;
  granted_by: string;
  since: number;
};

type RawEventSource = {
  id: string;
  org_id: string;
  prefix: string;
  secret: string | null;
  cursor: string | null;
  last_polled_at: number | null;
  config: string | null;
  health: string | null;
  created_at: number;
};

const toThread = (r: RawThread): ThreadRow => ({
  id: r.id,
  ref: r.ref,
  createdAt: r.created_at,
  lastActivity: r.last_activity,
});

/**
 * `would_accept` 列的**唯一转换点**（B3，2026-11-03；术语映射表见
 * `docs/architecture/concept-naming.md`）。
 *
 * SQLite 没有布尔类型，这条边界必须存在；但**实现只能有一份**。改之前：
 * encode 在 `record()`、decode 在 `toDisposition()` 各写一句（`? 1 : 0` / `=== 1`），
 * 两处各自猜测「缺失值算什么」——于是 `undefined`（dispatch / attach / stop 这些
 * 本来就没问过「若放行会不会接」的处置）被压成 `false`，UI 的「当时判定不该来」
 * 徽章对这些行亮起。一次转换两处实现 = 一个事实两个写者（契约 H7）。
 *
 * 三个状态各自有唯一编码，且互为反函数（回环测试：
 * `packages/storage/test/thread-store.test.ts` / `thread-e2e-autonomy.test.ts`）：
 *   true       → 1
 *   false      → 0
 *   undefined  → NULL（没问过 / 不适用，**不等于**不会接）
 *
 * 调用方一律走这两个函数，**不得自拼** `? 1 : 0` 或 `=== 1`。
 */
export const WouldAccept = {
  /** TS 三态 → DB 三态。`null` 与 `undefined` 都表达「没问过」。 */
  encode(v: boolean | null | undefined): 0 | 1 | null {
    if (v === null || v === undefined) return null;
    return v ? 1 : 0;
  },
  /** DB 三态 → TS 三态。NULL → null（不是 false）。 */
  decode(v: number | null): boolean | null {
    if (v === null || v === undefined) return null;
    return v === 1;
  },
} as const;

const toDisposition = (r: RawDisposition): DispositionRow => ({
  id: r.id,
  triggerId: r.trigger_id,
  threadId: r.thread_id,
  action: r.action,
  reason: r.reason,
  matchedRule: r.matched_rule,
  wouldAccept: WouldAccept.decode(r.would_accept),
  actor: r.actor,
  createdAt: r.created_at,
});

function parseJson(v: string | null): Record<string, unknown> {
  if (!v) return {};
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class SqliteThreadRepo {
  constructor(private db: DatabaseSync) {}

  getById(id: string): ThreadRow | null {
    const row = this.db.prepare(`SELECT * FROM threads WHERE id = ?`).get(id) as RawThread | undefined;
    return row ? toThread(row) : null;
  }

  getByRef(ref: string): ThreadRow | null {
    const row = this.db.prepare(`SELECT * FROM threads WHERE ref = ?`).get(ref) as RawThread | undefined;
    return row ? toThread(row) : null;
  }

  /**
   * 幂等 upsert —— 不变量 I1 的唯一执行点。
   *
   * 用 `ON CONFLICT(ref) DO UPDATE ... WHERE 0` 而不是先 SELECT 再 INSERT：
   * 后者在并发下有 TOCTOU 窗口，两个请求都会看到「不存在」然后各插一行
   * （虽然 UNIQUE 会挡住第二行，但会抛异常而不是优雅复用）。
   * 这里让冲突变成 no-op，再用一次 SELECT 拿回既有行——归一到「同一个 ref 永远同一条流」。
   */
  upsert(ref: string, now = Date.now()): { thread: ThreadRow; created: boolean } {
    const existing = this.getByRef(ref);
    if (existing) return { thread: existing, created: false };
    const id = `thr_${randomId()}`;
    this.db
      .prepare(
        `INSERT INTO threads (id, ref, created_at, last_activity)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(ref) DO NOTHING`,
      )
      .run(id, ref, now, now);
    const thread = this.getByRef(ref);
    if (!thread) throw new Error(`THREAD_UPSERT_FAILED: ref=${ref}`);
    return { thread, created: thread.id === id };
  }

  touch(threadId: string, now = Date.now()): void {
    this.db.prepare(`UPDATE threads SET last_activity = ? WHERE id = ?`).run(now, threadId);
  }

  list(limit = 100): ThreadRow[] {
    return (this.db.prepare(`SELECT * FROM threads ORDER BY last_activity DESC LIMIT ?`).all(limit) as RawThread[]).map(
      toThread,
    );
  }

  subscribe(threadId: string, ticketId: string, agentId: string, purpose: 'own' | 'context'): void {
    this.db
      .prepare(
        `INSERT INTO thread_subscriptions (thread_id, ticket_id, agent_id, purpose) VALUES (?, ?, ?, ?)
         ON CONFLICT(thread_id, ticket_id) DO UPDATE SET agent_id = excluded.agent_id, purpose = excluded.purpose`,
      )
      .run(threadId, ticketId, agentId, purpose);
  }

  unsubscribe(threadId: string, ticketId: string): void {
    this.db.prepare(`DELETE FROM thread_subscriptions WHERE thread_id = ? AND ticket_id = ?`).run(threadId, ticketId);
  }

  listSubscriptions(threadId: string): ThreadSubscriptionRow[] {
    const rows = this.db.prepare(`SELECT * FROM thread_subscriptions WHERE thread_id = ?`).all(threadId) as Array<{
      thread_id: string;
      ticket_id: string;
      agent_id: string;
      purpose: string;
    }>;
    return rows.map(r => ({
      threadId: r.thread_id,
      ticketId: r.ticket_id,
      agentId: r.agent_id,
      purpose: r.purpose === 'own' ? 'own' : 'context',
    }));
  }

  listSubscriptionsByAgent(agentId: string): ThreadSubscriptionRow[] {
    const rows = this.db.prepare(`SELECT * FROM thread_subscriptions WHERE agent_id = ?`).all(agentId) as Array<{
      thread_id: string;
      ticket_id: string;
      agent_id: string;
      purpose: string;
    }>;
    return rows.map(r => ({
      threadId: r.thread_id,
      ticketId: r.ticket_id,
      agentId: r.agent_id,
      purpose: r.purpose === 'own' ? 'own' : 'context',
    }));
  }
}

export class SqliteDispositionRepo {
  constructor(private db: DatabaseSync) {}

  /**
   * 记录一条处置 —— 不变量 I3/I4 的执行点。
   *
   * - `reason` 空 → 直接抛（I4）。处置没有理由等于没有审计，宁可拒绝写入。
   * - 重复 `(trigger_id, thread_id)` → 返回 false，不覆盖旧行（I3，webhook 重试 50 次也只留一行）。
   */
  record(d: {
    id?: string;
    triggerId: string;
    threadId: string;
    action: string;
    reason: string;
    /** 命中的 Gate 规则（契约 §5）。null = 处置与 Gate 规则无关 / 未记录。 */
    matchedRule?: string | null;
    /** 三态：见 `WouldAccept`。缺省 = 本次处置没问过这个问题 → 落 NULL。 */
    wouldAccept?: boolean;
    actor?: string;
    createdAt?: number;
  }): boolean {
    if (!d.reason || !d.reason.trim()) {
      throw new Error(`DISPOSITION_REASON_REQUIRED: trigger=${d.triggerId} action=${d.action}`);
    }
    const res = this.db
      .prepare(
        `INSERT INTO thread_dispositions (id, trigger_id, thread_id, action, reason, matched_rule, would_accept, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(trigger_id, thread_id) DO NOTHING`,
      )
      .run(
        d.id ?? `dsp_${randomId()}`,
        d.triggerId,
        d.threadId,
        d.action,
        d.reason,
        d.matchedRule ?? null,
        WouldAccept.encode(d.wouldAccept),
        d.actor ?? 'router',
        d.createdAt ?? Date.now(),
      );
    return Number(res.changes) > 0;
  }

  listByThread(threadId: string, limit = 50): DispositionRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM thread_dispositions WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?`)
        .all(threadId, limit) as RawDisposition[]
    ).map(toDisposition);
  }

  listRecent(limit = 100): DispositionRow[] {
    return (
      this.db.prepare(`SELECT * FROM thread_dispositions ORDER BY created_at DESC LIMIT ?`).all(limit) as RawDisposition[]
    ).map(toDisposition);
  }

  countByTrigger(triggerId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM thread_dispositions WHERE trigger_id = ?`)
      .get(triggerId) as { n: number };
    return Number(row.n);
  }
}

export class SqliteResourceBindingRepo {
  constructor(private db: DatabaseSync) {}

  /**
   * 绑定一个责任域 —— 不变量 I8 的执行点。
   *
   * `admin`（= L3，最高档）同一资源全局唯一：两个 agent 都是 admin，等于都不是。
   * 被拒时返回**可行动提示**（谁占着、怎么接管），而不是一句 "conflict" ——
   * 平台规则第 5 条：越界时拒绝 + 给可行动提示。
   */
  /**
   * 绑定即订阅 —— **唯一写者在这里**。
   *
   * 为什么放进仓储而不是留给调用方（实测踩到，2026-11-02）：
   * 同一个事实有两条创建路径 —— `resource_bind` 工具会补充订阅，
   * 而 `POST /api/resources/bindings` 只写绑定不订阅。结果是「绑了却不收事件」：
   * 事件落到 `needs-assessment` 而不是 `direct-through`，**四档闸门根本不会被触发**。
   * 这不是「某个入口忘了写一行」，是**一个事实两个写者**（R1）。
   *
   * 所以把「订阅」放进绑定成功的那一刻：谁创建绑定，谁就自动拥有订阅，
   * 不需要任何调用方记得。想取消订阅只能解绑（unbind 同步清理）。
   *
   * 只对 **agent** holder 生效：订阅是「哪个 agent 被叫醒」这件事，
   * team 绑定没有指定具体 agent，不能替它编一个。
   */
  private ensureSubscription(resource: string, holder: { kind: 'agent' | 'team'; id: string }): boolean {
    // team 绑定不产生订阅：订阅回答的是「哪个 agent 被叫醒」，替团队编一个 agent
    // 就是编事实。返回 false 而不是静默 no-op —— 调用方（工具）要把它如实告诉 agent。
    if (holder.kind !== 'agent') return false;
    const threads = new SqliteThreadRepo(this.db);
    const { thread } = threads.upsert(resource);
    threads.subscribe(thread.id, thread.id, holder.id, 'own');
    return true;
  }

  bind(b: {
    id?: string;
    holder: { kind: 'agent' | 'team'; id: string };
    resource: string;
    scope: ResourceScope;
    autonomy?: Autonomy;
    grantedBy: string;
    since?: number;
  }): { ok: true; binding: ResourceBinding; subscribed: boolean } | { ok: false; reason: string } {
    const existing = this.findByHolder(b.holder.kind, b.holder.id, b.resource);
    if (existing) {
      const written = this.writeTranslatingL3(b.resource, () =>
        this.db
          .prepare(`UPDATE resource_bindings SET scope = ?, autonomy = ?, granted_by = ?, since = ? WHERE id = ?`)
          .run(b.scope, b.autonomy ?? existing.autonomy, b.grantedBy, b.since ?? Date.now(), existing.id),
      );
      if (!written.ok) return written;
      const updated = this.findById(existing.id);
      if (!updated) throw new Error(`BINDING_VANISHED: ${existing.id}`);
      // 已存在绑定也要补订阅：它可能是本次修复之前（或经 API 路径）创建的，
      // 库里那批「绑了却没订阅」的存量靠这一句自愈，不需要写迁移脚本。
      const subscribed = this.ensureSubscription(b.resource, b.holder);
      return { ok: true, binding: updated, subscribed };
    }

    // 刻意**没有**「先查有没有别的 admin，再插入」的预检：
    // 那是一个只在单进程单连接内成立的检查（靠排队保证正确性），并发下两个调用
    // 各自查到「还没有 admin」，然后都插进去了 —— 这正是两个写者同时改一个东西。
    // I8 现在由数据库的部分唯一索引 `uniq_rbd_l3` 守（sqlite-storage.ts 迁移段），
    // 这里只负责把约束错误翻译成人能照着做的提示。
    const id = b.id ?? `rbd_${randomId()}`;
    const written = this.writeTranslatingL3(b.resource, () =>
      this.db
        .prepare(
          `INSERT INTO resource_bindings (id, holder_kind, holder_id, resource, scope, autonomy, granted_by, since)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, b.holder.kind, b.holder.id, b.resource, b.scope, b.autonomy ?? 'observe', b.grantedBy, b.since ?? Date.now()),
    );
    if (!written.ok) return written;
    const created = this.findById(id);
    if (!created) throw new Error(`BINDING_INSERT_FAILED: ${id}`);
    // 绑定即订阅：同一次调用里完成，调用方不需要记得补。
    const subscribed = this.ensureSubscription(b.resource, b.holder);
    return { ok: true, binding: created, subscribed };
  }

  /**
   * 把 L3 唯一性约束错误翻译成**可行动提示**（平台规则第 5 条：越界时拒绝 + 给提示）。
   *
   * 为什么不在写入前预检、而是接住约束错误：预检是第二写者，而且它只能看见
   * 自己这条连接上的状态。约束是唯一执行点，所以「谁占着」这件事要**事后读**——
   * 顺带天然正确：读到的就是当前真实持有者。
   */
  private writeTranslatingL3(
    resource: string,
    write: () => { changes: number | bigint },
  ): { ok: true } | { ok: false; reason: string } {
    try {
      write();
      return { ok: true };
    } catch (err) {
      if (!isL3UniqueViolation(err)) throw err;
      const holder = this.listByResource(resource).find(x => x.scope === 'admin');
      const who = holder ? `${holder.holder.kind}:${holder.holder.id}` : '另一个持有者';
      return {
        ok: false,
        reason: `资源 ${resource} 已由 ${who} 以 admin 档负责（同一资源同一时刻只能有一个 L3 责任人，I8）。`
          + '要接管，先让对方释放，或由人执行 transfer（transfer 会记录审计）。',
      };
    }
  }

  findById(id: string): ResourceBinding | null {
    const row = this.db.prepare(`SELECT * FROM resource_bindings WHERE id = ?`).get(id) as RawBinding | undefined;
    return row ? toBinding(row) : null;
  }

  findByHolder(kind: 'agent' | 'team', id: string, resource: string): ResourceBinding | null {
    const row = this.db
      .prepare(`SELECT * FROM resource_bindings WHERE holder_kind = ? AND holder_id = ? AND resource = ?`)
      .get(kind, id, resource) as RawBinding | undefined;
    return row ? toBinding(row) : null;
  }

  listByHolder(kind: 'agent' | 'team', id: string): ResourceBinding[] {
    return (
      this.db
        .prepare(`SELECT * FROM resource_bindings WHERE holder_kind = ? AND holder_id = ? ORDER BY since DESC`)
        .all(kind, id) as RawBinding[]
    ).map(toBinding);
  }

  listByResource(resource: string): ResourceBinding[] {
    return (this.db.prepare(`SELECT * FROM resource_bindings WHERE resource = ? ORDER BY since DESC`).all(resource) as RawBinding[]).map(
      toBinding,
    );
  }

  /**
   * 全量列出责任域绑定（Settings「责任域」组的唯一数据源）。
   *
   * 为什么需要它：原来的两个方法都必须带 resource 或 holder —— 于是「全局看谁管什么」
   * 这件事在 UI 上无法表达，只能一个个 agent 去翻。而监督的前提就是能一眼看全。
   */
  listAll(limit = 500): ResourceBinding[] {
    return (
      this.db.prepare(`SELECT * FROM resource_bindings ORDER BY since DESC LIMIT ?`).all(limit) as RawBinding[]
    ).map(toBinding);
  }

  setAutonomy(id: string, autonomy: Autonomy): void {
    this.db.prepare(`UPDATE resource_bindings SET autonomy = ? WHERE id = ?`).run(autonomy, id);
  }

  /**
   * 解绑 —— 必须**同时退订**，否则会出现「已经解除责任，事件还在往他那儿送」。
   * 与 `bind()` 里的 `ensureSubscription` 严格对称：一个事实只有一个写者，
   * 建立和销毁写在同一个类里，调用方不需要记得任何一边。
   */
  unbind(id: string): boolean {
    const binding = this.findById(id);
    const res = this.db.prepare(`DELETE FROM resource_bindings WHERE id = ?`).run(id);
    if (Number(res.changes) === 0) return false;
    if (binding && binding.holder.kind === 'agent') {
      const threads = new SqliteThreadRepo(this.db);
      const thread = threads.getByRef(binding.resource);
      if (thread) threads.unsubscribe(thread.id, thread.id);
    }
    return true;
  }
}

export class SqliteEventSourceRepo {
  constructor(private db: DatabaseSync) {}

  upsert(s: {
    id?: string;
    orgId: string;
    prefix: string;
    secret?: string | null;
    config?: Record<string, unknown>;
    health?: Record<string, unknown>;
    createdAt?: number;
  }): EventSourceRow {
    const existing = this.getByPrefix(s.orgId, s.prefix);
    if (existing) {
      this.db
        .prepare(`UPDATE event_sources SET secret = ?, config = ?, health = ? WHERE id = ?`)
        .run(
          s.secret === undefined ? existing.secret : s.secret,
          JSON.stringify({ ...existing.config, ...(s.config ?? {}) }),
          JSON.stringify({ ...existing.health, ...(s.health ?? {}) }),
          existing.id,
        );
      const after = this.getByPrefix(s.orgId, s.prefix);
      if (!after) throw new Error(`SOURCE_VANISHED: ${s.prefix}`);
      return after;
    }
    const id = s.id ?? `src_${randomId()}`;
    this.db
      .prepare(
        `INSERT INTO event_sources (id, org_id, prefix, secret, config, health, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        s.orgId,
        s.prefix,
        s.secret ?? null,
        JSON.stringify(s.config ?? {}),
        JSON.stringify(s.health ?? {}),
        s.createdAt ?? Date.now(),
      );
    const created = this.getById(id);
    if (!created) throw new Error(`SOURCE_INSERT_FAILED: ${id}`);
    return created;
  }

  getById(id: string): EventSourceRow | null {
    const row = this.db.prepare(`SELECT * FROM event_sources WHERE id = ?`).get(id) as RawEventSource | undefined;
    return row ? toEventSource(row) : null;
  }

  getByPrefix(orgId: string, prefix: string): EventSourceRow | null {
    const row = this.db.prepare(`SELECT * FROM event_sources WHERE org_id = ? AND prefix = ?`).get(orgId, prefix) as
      | RawEventSource
      | undefined;
    return row ? toEventSource(row) : null;
  }

  listByOrg(orgId: string): EventSourceRow[] {
    return (this.db.prepare(`SELECT * FROM event_sources WHERE org_id = ? ORDER BY prefix`).all(orgId) as RawEventSource[]).map(
      toEventSource,
    );
  }

  updateHealth(id: string, patch: Record<string, unknown>): void {
    const cur = this.getById(id);
    if (!cur) return;
    this.db
      .prepare(`UPDATE event_sources SET health = ? WHERE id = ?`)
      .run(JSON.stringify({ ...cur.health, ...patch }), id);
  }

  /**
   * 位点推进 —— **全仓唯一一条写 `event_sources.cursor` 的语句**。
   *
   * 三条纪律，每条都用结构保证而不是靠调用方自觉：
   *  1. **CAS**：`WHERE id = ? AND cursor IS ?`。调用方必须交回「它读到哪」，所以
   *     重复推进 / 乱序推进 / 两个拉取者撞车 → 0 行 no-op，永远不会把位点推回去。
   *     没有这个前置条件，「慢的那个覆盖快的」就是结构上可表达的 bug。
   *  2. **只有成功才能拿到凭证**：入参类型 `CursorAdvance` 只在 core 里由
   *     `mintCursorAdvance()` 铸造，该函数在 `failed > 0` 时直接抛错（拒绝 + 可行动提示）。
   *     于是「消费失败还推进位点」不是靠人记得，而是拿不到凭证。
   *  3. **一列一个问题**：推送式来源（webhook）**不写**这一列 —— 它没有读取位点。
   *     所以本方法只有一个调用方：拉取消费编排的成功分支。
   *
   * @returns true = 本次推进生效；false = 期望位点已不匹配（他人已推进）或来源不存在
   */
  advanceCursor(a: {
    sourceId: string;
    /** 读取前看到的位点；CAS 期望值 */
    expectedCursor: string | null;
    /** 推进到的位点（批次末尾位置） */
    cursor: string | null;
    polledAt: number;
  }): boolean {
    const res = this.db
      .prepare(`UPDATE event_sources SET cursor = ?, last_polled_at = ? WHERE id = ? AND cursor IS ?`)
      .run(a.cursor, a.polledAt, a.sourceId, a.expectedCursor);
    return Number(res.changes) > 0;
  }

  delete(id: string): boolean {
    const res = this.db.prepare(`DELETE FROM event_sources WHERE id = ?`).run(id);
    return Number(res.changes) > 0;
  }
}

/**
 * `granted_by` 落库格式是 `human:<id>` / `agent:<id>`。
 * 为什么要编码 kind：「谁给的权限」是审计的关键一环——agent 自绑与人授权
 * 在事后追责时完全不同，不能都记成一行裸 id 再靠猜。
 */
function parseGranter(raw: string): { kind: 'human' | 'agent'; id: string } {
  const i = raw.indexOf(':');
  if (i > 0) {
    const kind = raw.slice(0, i);
    if (kind === 'human' || kind === 'agent') return { kind, id: raw.slice(i + 1) };
  }
  return { kind: 'human', id: raw };
}

function toBinding(r: RawBinding): ResourceBinding {
  return {
    id: r.id,
    holder: { kind: r.holder_kind === 'team' ? 'team' : 'agent', id: r.holder_id },
    resource: r.resource,
    scope: r.scope as ResourceScope,
    autonomy: r.autonomy as Autonomy,
    since: r.since,
    grantedBy: parseGranter(r.granted_by),
  };
}

/**
 * 这条错误是不是「同一资源只能有一个 admin」那条部分唯一索引（`uniq_rbd_l3`）。
 *
 * 判据刻意**只认约束名**，不认泛化的 `UNIQUE constraint failed`：
 * `resource_bindings` 上还有 `UNIQUE(holder_kind, holder_id, resource)`，
 * 把两者混为一谈会把「同一个 holder 重复绑定」误报成「L3 被别人占了」——
 * 那种提示会把 agent 引向一个不存在的人。
 */
function isL3UniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /uniq_rbd_l3/i.test(msg) || /resource_bindings\.resource/i.test(msg);
}

function toEventSource(r: RawEventSource): EventSourceRow {
  return {
    id: r.id,
    orgId: r.org_id,
    prefix: r.prefix,
    cursor: r.cursor ?? null,
    lastPolledAt: r.last_polled_at ?? null,
    secret: r.secret,
    config: parseJson(r.config),
    health: parseJson(r.health),
    createdAt: r.created_at,
  };
}

/** 与既有 repo 一致的短 id：16 位 base36。可预测但不含时序噪声，便于测试断言前缀。 */
function randomId(): string {
  let out = '';
  for (let i = 0; i < 16; i++) out += Math.floor(Math.random() * 36).toString(36);
  return out;
}

// ── Trigger（幂等载体） ──────────────────────────────────────────────────

/**
 * 一次真实到达的触发。**不可变**：只插入，无 UPDATE 路径。
 *
 * 为什么它必须是一等对象，而不是只靠 disposition 的 (trigger_id, thread_id)：
 *   ① 同一 trigger 可路由到多条 thread → 那组唯一约束允许多行，挡不住重投；
 *   ② 一条 trigger 可能还没产生任何 disposition（被忽略 / 直通 / 进程崩溃）就重投。
 * 「这个投递我见过」必须能在**任何副作用之前**被回答，所以只能按 idempotency_key 唯一。
 */
export interface TriggerRow {
  id: string;
  orgId: string | null;
  kind: string;
  idempotencyKey: string;
  actorKind: string | null;
  actorId: string | null;
  addressing: string | null;
  summary: string | null;
  body: string | null;
  threadRefs: string[];
  receivedAt: number;
}

type RawTrigger = {
  id: string;
  org_id: string | null;
  kind: string;
  idempotency_key: string;
  actor_kind: string | null;
  actor_id: string | null;
  addressing: string | null;
  summary: string | null;
  body: string | null;
  thread_refs: string | null;
  received_at: number;
};

function parseJsonArray(v: string | null): string[] {
  if (!v) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function toTrigger(r: RawTrigger): TriggerRow {
  return {
    id: r.id,
    orgId: r.org_id,
    kind: r.kind,
    idempotencyKey: r.idempotency_key,
    actorKind: r.actor_kind,
    actorId: r.actor_id,
    addressing: r.addressing,
    summary: r.summary,
    body: r.body,
    threadRefs: parseJsonArray(r.thread_refs),
    receivedAt: r.received_at,
  };
}

export class SqliteTriggerRepo {
  constructor(private db: DatabaseSync) {}

  getByIdempotencyKey(key: string): TriggerRow | null {
    const row = this.db.prepare(`SELECT * FROM triggers WHERE idempotency_key = ?`).get(key) as
      | RawTrigger
      | undefined;
    return row ? toTrigger(row) : null;
  }

  getById(id: string): TriggerRow | null {
    const row = this.db.prepare(`SELECT * FROM triggers WHERE id = ?`).get(id) as RawTrigger | undefined;
    return row ? toTrigger(row) : null;
  }

  /**
   * 幂等登记一次触发 —— 不变量 I2 的唯一执行点。
   *
   * 与 `SqliteThreadRepo.upsert` 同一手法：先查，再用 `ON CONFLICT DO NOTHING` 兜住并发窗口，
   * 最后回查拿行。不实现成「先 INSERT 再看异常」：异常路径会把并发重投变成错误，
   * 而重投是**正常情况**（webhook 重试、IM 重发、进程重启），不是异常。
   */
  insertOrGet(t: {
    id?: string;
    orgId?: string | null;
    kind: string;
    idempotencyKey: string;
    actorKind?: string | null;
    actorId?: string | null;
    addressing?: string | null;
    summary?: string | null;
    body?: string | null;
    threadRefs?: string[];
    receivedAt?: number;
  }): { trigger: TriggerRow; created: boolean } {
    const existing = this.getByIdempotencyKey(t.idempotencyKey);
    if (existing) return { trigger: existing, created: false };

    const id = t.id ?? `trg_${randomId()}`;
    const now = t.receivedAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO triggers
           (id, org_id, kind, idempotency_key, actor_kind, actor_id, addressing, summary, body, thread_refs, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run(
        id,
        t.orgId ?? null,
        t.kind,
        t.idempotencyKey,
        t.actorKind ?? null,
        t.actorId ?? null,
        t.addressing ?? null,
        t.summary ?? null,
        t.body ?? null,
        JSON.stringify(t.threadRefs ?? []),
        now,
      );

    const trigger = this.getByIdempotencyKey(t.idempotencyKey);
    if (!trigger) throw new Error(`TRIGGER_INSERT_FAILED: key=${t.idempotencyKey}`);
    return { trigger, created: trigger.id === id };
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM triggers`).get() as { c: number } | undefined;
    return Number(row?.c ?? 0);
  }

  list(limit = 100): TriggerRow[] {
    return (
      this.db.prepare(`SELECT * FROM triggers ORDER BY received_at DESC LIMIT ?`).all(limit) as RawTrigger[]
    ).map(toTrigger);
  }

  /**
   * 时间线：某条流上「发生过什么」—— **从 `triggers` 派生，不落表**。
   *
   * 为什么没有 `thread_events` 表（2026-11-03 定案，见 workspace/CONCEPT-CLARITY-*.md §8）：
   * 它会存 `summary`/`body` 的副本 —— 那是同一内容的第二个写者，注定与 triggers 不一致。
   * 「发生在什么时刻」本来就是查询，物化成表就必须有人负责同步；没人负责，它就是第二写者。
   *
   * `thread_refs` 没建索引：当前量级（本地库万行内）全扫可接受。上到十万级再加，不预先猜。
   *
   * 排序用 `received_at DESC, rowid DESC`：同一毫秒内的多条事件靠 `rowid`（SQLite 的插入
   * 序列）确定真实先后——按随机 id 排会给出「确定性但错误」的顺序。
   */
  listByThreadRef(ref: string, limit = 100): TriggerRow[] {
    return (
      this.db
        .prepare(
          `SELECT t.* FROM triggers t, json_each(t.thread_refs) j
            WHERE j.value = ?
            ORDER BY t.received_at DESC, t.rowid DESC
            LIMIT ?`,
        )
        .all(ref, limit) as RawTrigger[]
    ).map(toTrigger);
  }
}
