/**
 * 外部事件入口 + 流/责任域 的 HTTP 面。
 *
 * 为什么单独成文件：`api-server.ts` 已近 1.5 万行，再往里塞路由就是继续加债。
 * 这里只做「HTTP ↔ 服务」的翻译：解析路径、挑仓库、调 `EventIngress`、回状态码。
 *
 * 鉴权分工（刻意如此）：
 *  - `POST /api/events/:prefix` **只认 HMAC**，不认用户会话——webhook 没有用户身份；
 *  - `/api/threads*` 与 `/api/resources/bindings*` 走 api-server 的既有 auth，
 *    由调用方在调用本函数**之前**完成，本文件不再重复实现一套权限判断。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventIngress } from '@markus/core';
import { createGenericWebhookAdapter, SourceRegistry } from '@markus/core';
import { ThreadService } from '@markus/core';
import { admitEvent, policyOf, validateSourcePolicy, consumeBatch } from '@markus/core';
import type { DispatchTarget } from '@markus/core';
import { authorizeAction, deriveStage, isScope, RESOURCE_SCOPES, stageSortRank } from '@markus/shared';

export interface EventRouteDeps {
  orgId: string;
  /** 存储仓库（类型与 storage-bridge 一致，用 any 避免在此处绑定 sqlite 实现） */
  repos: {
    threadRepo: any;
    dispositionRepo: any;
    resourceBindingRepo: any;
    eventSourceRepo: any;
    /** 可选：用于把任务状态折算成「在等谁」。缺失时 stage 会标记为部分推断。 */
    taskRepo?: any;
    /** 可选：用于判定「等你批准」。缺失时 pendingApproval 会列进 missingFacts。 */
    approvalRepo?: any;
    /**
     * 触发器登记（`triggers` 表的唯一写入者），同时也是**时间线的唯一数据源**。
     *
     * **必填**：它此前根本没被接进来，于是仓储实现了、导出了，生产却零使用 ——
     * `triggers` 永远 0 行，A4.2/A4.3 永远验不了。
     *
     * 时间线曾单独接一个 `threadEventRepo`（写 `thread_events` 表）。那张表存的是
     * `triggers` 内容的副本——同一件事的第二个写者，已于 2026-11-03 删除，
     * 见 workspace/CONCEPT-CLARITY-*.md §8。现在 `/events` 从本仓库派生。
     */
    triggerRepo: any;
    /**
     * 票的仓储（`tickets` 表的**唯一写入者**，见 docs/architecture/ticket.md）。
     *
     * 为什么必填：`thread_subscriptions.ticket_id` 一直在指向一个不存在的对象
     * （C1）。票表建起来之后，这个仓储就是它唯一的读写口 —— 缺它则 HTTP 面
     * 只能回 501（而不是悄悄返回空数组冒充「没有票」）。
     */
    ticketRepo?: any;
  };
  /** 投递到 agent mailbox；未接线时返回 null（事件仍会留痕） */
  deliver: ((target: DispatchTarget) => void) | null;
  /**
   * 往一条流上记一件事 —— **只允许指向 `thread-ensure.recordThreadEvent`**
   * （`triggers` 表的唯一写入者）。
   *
   * 为什么要从这里开口而不是直接拿 `repos.triggerRepo.insertOrGet()` 写：
   * 那就是「同一件事的第二个写者」。时间线是证据，两个写者必然会在某天不一致，
   * 而错了最难发现（A1 整条链路为 0 行就是这么来的）。
   *
   * 未接线时票照常建/照常流转，只是不登记事件 —— 旁路记账不能回滚业务写入。
   */
  recordEvent?: (ref: string, event: { kind: string; actor?: string; summary: string; eventId?: string }) => void;
  now?: () => number;
}

/**
 * 把「流标识」归一到内部 `threads.id`（`thr_xxx`）。
 *
 * 为什么需要这一层（实测踩到，2026-11-02）：
 * `thread_events.thread_id` 存的是内部 id，但 `/api/threads` 给业务行返回的 `id`
 * 是**业务 ref**（`tsk_xxx` / `req_xxx` / `a2a_xxx`）。Thread 视图直接拿 `row.id`
 * 去查 `WHERE thread_id = ?` → 任务流永远 0 条、时间线空白，**且不报错**。
 * 真实数据：同一个流按 `thr_` 查 19 条，按 `tsk_` 查 0 条。
 *
 * 所以读取端必须同时接受两种身份，而不是让前端猜该传哪个 ——
 * 前端手里只有列表给它的那一个值，让它猜等于把「两套 id 并存」的债转嫁给调用方。
 *
 * 解析不到时**原样返回**：往下查就是空数组。这不是错误状态
 * （可能只是这条流还没有事件），不需要 404。
 */
function resolveThreadId(deps: EventRouteDeps, key: string): string {
  const threadRepo = deps.repos.threadRepo;
  if (!threadRepo) return key;
  // 先按内部 id 试（事件表的原生口径），再按 ref 试（列表页给的口径）。
  const byId = threadRepo.getById?.(key);
  if (byId) return String(byId.id);
  const byRef = threadRepo.getByRef?.(key);
  if (byRef) return String(byRef.id);
  return key;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.byteLength),
  });
  res.end(payload);
}

/** 从 StorageBridge 之外的来源构造注册表：每个 `event_sources` 行 = 一个通用适配器。 */
export function buildRegistry(deps: EventRouteDeps): SourceRegistry {
  const registry = new SourceRegistry();
  for (const src of deps.repos.eventSourceRepo.listByOrg(deps.orgId)) {
    registry.register(createGenericWebhookAdapter(src.prefix));
  }
  return registry;
}

/**
 * 给一条流补上派生状态 `stage`（「它在等谁」）。
 *
 * 三条纪律：
 *  1. **方法名不是猜的**：taskRepo 上读单条的入口是 `findById`（不是 `get`/`getById`）。
 *     用可选调用 `?.` 会把「方法名写错」变成静默的 undefined —— 那正是本函数第一版犯的错，
 *     现在由 `event-routes.test.ts` 用**真实** SqliteTaskRepo 钉住，写错就红。
 *  2. **误报比漏报更糟**：approvals 表没有 task_id 列，只能从 `details.taskId` 精确匹配。
 *     「这个 agent 有待批」不足以把一条不相干的流标成「等你批准」——那会训练人忽略这个信号。
 *     所以 agent 级匹配只写进 `approvalHint`，不改 stage。
 *  3. **没接的事实明说**：`openQuestion` 仍无稳定数据源 → 永远列进 missingFacts。
 */
function withStage(t: any, deps: EventRouteDeps): Record<string, unknown> {
  const ref: string = typeof t?.ref === 'string' ? t.ref : '';

  const task = ref.startsWith('tsk_') && deps.repos.taskRepo ? (deps.repos.taskRepo.findById?.(ref) ?? null) : null;
  const status: string | undefined = task?.status;

  // 待审批：只认能精确归属到这条流的那条审批
  let pendingApproval = false;
  let approvalHint: string | undefined;
  let approvalId: string | undefined;
  if (deps.repos.approvalRepo && ref) {
    const pending: any[] = deps.repos.approvalRepo.list({ status: 'pending', limit: 200 }) ?? [];
    // 第三个分支：孤儿审批（无归属任务）自带 ref = apr_<id>
    const exact = pending.find(
      a => a?.details?.taskId === ref || a?.details?.requirementId === ref || `apr_${a.id}` === ref,
    );
    if (exact) {
      pendingApproval = true;
      approvalId = exact.id;
    } else if (t?.ownerAgent) {
      const byAgent = pending.find(a => a?.agentId === t.ownerAgent);
      if (byAgent) {
        // 不升 stage：这条待批未必属于当前流，只作为提示
        approvalHint = `${t.ownerAgent} 有一条待批（${byAgent.id}），但无法确认属于这条流`;
      }
    }
  }

  const assignment: { state: 'pending' | 'running' | 'ended' } =
    status === 'pending'
      ? { state: 'pending' }
      : status === 'in_progress' || status === 'review' || status === 'blocked'
        ? { state: 'running' }
        : status
          ? { state: 'ended' }
          : t?.ownerAgent
            ? { state: 'running' }
            : { state: 'ended' };

  const stage = deriveStage({
    pendingApproval,
    openQuestion: false,
    submittedReview: status === 'review',
    reportedBlockedSinceHuman: status === 'blocked' || status === 'failed',
    assignment,
  });

  const missingFacts: string[] = ['openQuestion'];
  if (!deps.repos.approvalRepo) missingFacts.unshift('pendingApproval');

  return {
    ...t,
    stage,
    stageRank: stageSortRank(stage),
    stageBasis: missingFacts.length === 0 ? 'full' : 'partial',
    missingFacts,
    taskStatus: status ?? null,
    approvalHint,
    // 供概览直接渲染：省掉前端再各查一遍 task/approval 表（那就是第二写者）
    approvalId: approvalId ?? null,
    detail: task?.description ?? t?.detail ?? null,
    priority: task?.priority ?? t?.priority ?? null,
  };
}

/**
 * 统一时间戳为 epoch ms。
 *
 * 为什么需要这个：tasks 的 `updatedAt/createdAt` 经 `toDate()` 后是 **Date 对象**，
 * 而 threads 表用的是 epoch ms 整数。直接在两类数据上做 `Date.now() - t.updatedAt`，
 * Date 那一支会得到 NaN —— 前端就渲染成「已等 NaN 天」。
 *
 * 这是**结构问题**不是脏数据：同一个字段（时间）在两张表里有两种表示。
 * 归一化放在聚合出口这一处，调用方就不必各自防御。
 */
function toEpochMs(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v instanceof Date) {
    const t = v.getTime();
    if (Number.isFinite(t)) return t;
  }
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
    const d = new Date(v).getTime();
    if (Number.isFinite(d)) return d;
  }
  return fallback;
}

/**
 * Inbox 行 = 「需要人」的对象，从**真实业务表现算**。
 *
 * 为什么不是 `threadRepo.list()`：threads 表只由外部事件写入，而日常主链路
 * （任务 / 需求 / 评论 / 会话）**不创建 thread**。旧实现读空表 → 循环零次 →
 * 概览永远空。这是 H1 未验证的直接后果（复审文档 §9.2「路灯下找钥匙」）。
 *
 * 不变量：同一个 ref 只产生一行（Map 去重）—— R6「恰好出现一次」。
 * 零写入：deriveStage 是纯函数，本函数只读。
 */
function buildInboxRows(deps: EventRouteDeps): any[] {
  const rows = new Map<string, any>();

  // 1) 停在「需要人」状态的任务：review（等人批）/ blocked / failed（等人解）
  const taskRepo = deps.repos.taskRepo;
  if (taskRepo?.listByOrg) {
    // 「正常阻塞」= 还在等未完成的依赖，不需要人。判据下沉到后端：
    // 原来这条规则在 web-ui/Home.tsx 的 isBlockedAbnormally 里，依赖 board 全量数据 ——
    // 那是第二事实源，且移动端根本拿不到 board，同一判断会分叉。规则不变：
    //   无依赖却 blocked → 异常；依赖全部 completed 却仍 blocked → 异常；否则正常（等依赖，不用人）。
    const all: any[] = taskRepo.listByOrg(deps.orgId) ?? [];
    const statusById = new Map<string, string>(all.map((t: any) => [String(t.id), String(t.status)]));
    const blockedNeedsPerson = (t: any): boolean => {
      const depIds: string[] = Array.isArray(t?.blockedBy) ? t.blockedBy : [];
      if (depIds.length === 0) return true;
      return depIds.every(id => statusById.get(String(id)) === 'completed');
    };

    for (const status of ['review', 'blocked', 'failed']) {
      const list: any[] = all.filter((t: any) => String(t.status) === status);
      for (const t of list) {
        const id = String(t?.id ?? '');
        if (!id || rows.has(id)) continue;
        if (status === 'blocked' && !blockedNeedsPerson(t)) continue;
        rows.set(id, {
          id,
          ref: id,
          ownerAgent: t.assignedAgentId ?? null,
          ownerSession: null,
          lastActivity: toEpochMs(t.updatedAt ?? t.createdAt, Date.now()),
          title: t.title ?? null,
          detail: t.description ?? null,
          priority: t.priority ?? null,
        });
      }
    }
  }

  // 2) 待审批：能精确归属到任务/需求的合并进同一行（交给 withStage 算），
  //    归属不了的（孤儿审批）自成一行，ref = apr_<id>
  const pending: any[] = deps.repos.approvalRepo?.list?.({ status: 'pending', limit: 500 }) ?? [];
  for (const a of pending) {
    const ownerRef: string | undefined = a?.details?.taskId ?? a?.details?.requirementId;
    const key = ownerRef ?? `apr_${a.id}`;
    if (rows.has(key)) continue;
    rows.set(key, {
      id: key,
      ref: key,
      ownerAgent: a?.agentId ?? null,
      ownerAgentName: a?.agentName ?? null,
      ownerSession: null,
      lastActivity: toEpochMs(a?.requestedAt, Date.now()),
      title: a?.title ?? null,
      detail: a?.description ?? null,
    });
  }

  return [...rows.values()].sort((x, y) => Number(y.lastActivity ?? 0) - Number(x.lastActivity ?? 0));
}

/**
 * 一条流（**单个 ref**）的读取单元：**业务事实优先**。
 *
 * 为什么必须有它（B4 的结构理由）：
 * 时间线要能从「任务详情 / 票据详情 / agent 详情」**就地**打开，此时前端手里
 * 只有一个实体 id（`tsk_…` / `tkt_…` / `agent:…`），它不该为了渲染一条流去拉
 * 全局列表再按 id 找 —— 那是「必须先到目录页」的旧心智，也是第二套查找实现。
 *
 * 单一构造点：**ref → 行** 只在本函数里发生。列表（`/api/threads`）对已登记的流
 * 也走这里，所以「同一 ref 在单读与列表里字段不一致」这种漂移在结构上不成立
 * （由 `event-routes.test.ts` 的对照用例钉住）。
 *
 * 优先级顺序即语义：业务事实（任务 / 票据）> 已登记的流 > 只有 ref。
 * 反了会让标题/负责人永远为空（历史教训：threads 表的 owner 列已删）。
 */
function rowForRef(deps: EventRouteDeps, ref: string): Record<string, unknown> {
  const now = deps.now ? deps.now() : Date.now();
  const base: Record<string, unknown> = {
    id: ref,
    ref,
    ownerAgent: null,
    ownerSession: null,
    lastActivity: now,
    title: null,
    detail: null,
  };

  // 1) 任务：标题/描述/负责人就是任务本身的事实（任务流也是最多的一类）
  if (ref.startsWith('tsk_') && deps.repos.taskRepo?.findById) {
    const task: any = deps.repos.taskRepo.findById(ref) ?? null;
    if (task) {
      return {
        ...base,
        ownerAgent: task.assignedAgentId ?? null,
        lastActivity: toEpochMs(task.updatedAt ?? task.createdAt, now),
        title: task.title ?? null,
        detail: task.description ?? null,
        priority: task.priority ?? null,
      };
    }
  }

  // 2) 票据：票不驱动执行，但它是「这件事的凭据」，标题取 subject
  if (ref.startsWith('tkt_') && deps.repos.ticketRepo?.getById) {
    const ticket: any = deps.repos.ticketRepo.getById(ref) ?? null;
    if (ticket) {
      return {
        ...base,
        ownerAgent: ticket.assignee ?? null,
        lastActivity: toEpochMs(ticket.updatedAt ?? ticket.createdAt, now),
        title: ticket.subject ?? null,
        detail: ticket.kind ?? null,
      };
    }
  }

  // 3) 已登记的流（外部资源 `gh:` / agent 轴 `agent:` / 会话轴……）
  const persisted: any = deps.repos.threadRepo?.getByRef?.(ref) ?? null;
  if (persisted) return { ...base, ...persisted };

  // 4) 兜底：只有 ref，没有业务事实。
  //    **不编标题** —— 编出来的标题会让人以为平台知道这件事是什么。
  return base;
}

function serviceOf(deps: EventRouteDeps): ThreadService {
  return new ThreadService({
    threads: deps.repos.threadRepo,
    dispositions: deps.repos.dispositionRepo,
    now: deps.now,
    // 四档语义的唯一读取点：路由要判断「这个负责人现在允许被打扰吗」。
    // 绑定记录里没他（或没有绑定表）→ 返回 null，服务层保持旧行为（直通即唤醒），
    // 不擅自把不负责这条流的 agent 降级成 observe。
    autonomyFor: (ref, agentId) => {
      const bindings = deps.repos.resourceBindingRepo;
      if (!bindings?.findByHolder) return null;
      try {
        const b = bindings.findByHolder('agent', agentId, ref);
        return b?.autonomy ?? null;
      } catch {
        // 绑定表读失败不能连累事件路由：返回 null = 按旧行为投递并留痕。
        return null;
      }
    },
  });
}

/**
 * 返回 true 表示本函数已处理该请求（调用方不要再往下走）。
 */
export async function handleEventRoutes(
  deps: EventRouteDeps,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<boolean> {
  // ── 来源登记（**必须在 webhook 分支之前**）────────────────────────────────
  // `/api/events/sources` 是 `/api/events/` 前缀下的保留子路径。若 webhook 分支先命中，
  // 它会把 "sources" 当成平台前缀去查 → 404「未登记的来源 sources」，
  // 于是来源永远登记不进来、整个入口不可用（实测踩到）。精确路径优先于前缀匹配。
  if (path === '/api/events/sources' && req.method === 'GET') {
    // secret 永不进响应 —— 只回「是否已配置」
    const sources = deps.repos.eventSourceRepo.listByOrg(deps.orgId).map((s: any) => ({
      id: s.id,
      prefix: s.prefix,
      hasSecret: !!s.secret,
      config: s.config,
      health: s.health,
      // 位点：可观测的一等事实（「读到哪儿」不该只能靠猜 health 里的某个键）
      cursor: s.cursor ?? null,
      lastPolledAt: s.lastPolledAt ?? null,
      createdAt: s.createdAt,
    }));
    json(res, 200, { sources });
    return true;
  }

  if (path === '/api/events/sources' && req.method === 'POST') {
    const body = ((req as any).__parsedBody__ ?? {}) as Record<string, unknown>;
    const prefix = String(body['prefix'] ?? '').trim();
    if (!prefix) {
      json(res, 400, { error: 'prefix 必填' });
      return true;
    }
    // 写入路径做一次严格校验：`policyOf()` 在读路径必须宽容（不能因为一条配置写错
    // 就让整条来源收不了事件），宽容的代价是「写错了不报」。所以问题必须在登记
    // 这一刻说出来 —— 否则「规则静默不生效」是最难查的一类故障。
    const config = (body['config'] as Record<string, unknown>) ?? {};
    const problems = validateSourcePolicy(config);
    if (problems.length > 0) {
      json(res, 400, { error: '来源策略配置有误', problems });
      return true;
    }
    const row = deps.repos.eventSourceRepo.upsert({
      orgId: deps.orgId,
      prefix,
      secret: body['secret'] === undefined ? undefined : String(body['secret']),
      config,
    });
    json(res, 200, {
      id: row.id,
      prefix: row.prefix,
      hasSecret: !!row.secret,
      // 位点不属于配置：新建来源恒为 null（推送式来源根本没有位点）
      cursor: row.cursor ?? null,
    });
    return true;
  }

  /**
   * 入口构造：webhook 与批量拉取**共用同一套** registry / 准入 / 触发器登记。
   *
   * 为什么必须共用：三个入口若各建一份 `EventIngress`，准入规则就会出现「这个入口有、
   * 那个入口没有」的偏差 —— 自激循环正是从那种偏差里漏回来的。
   */
  const ingressFor = (source: any): EventIngress => {
    const policy = policyOf(source.config);
    return new EventIngress({
      registry: buildRegistry(deps),
      service: serviceOf(deps),
      deliver: target => deps.deliver?.(target),
      // 准入（什么算事件）：**唯一判定点**在 core 的 `admitEvent()`，
      // 这里只把「这条来源的策略」喂进去，不复制任何规则。
      admission: ev => admitEvent(ev, policy, deps.now ? deps.now() : Date.now()),
      // 触发器登记：`triggers` 表的**唯一写入点**。
      // 之前这里也没有它 —— 仓储实现了、导出了，但生产零使用，
      // 于是 A4.2/A4.3（真实触发写入 trigger + 幂等）永远验不了。
      // 现在它是必填字段，漏传 = 编译错误。
      triggers: deps.repos.triggerRepo,
      now: deps.now,
    });
  };

  // ── 拉取侧的批量入口 + 位点提交（B2）────────────────────────────────────
  //
  // 为什么需要它：位点只在**拉取**语义下有意义。推送式来源（webhook）没有「读到哪儿」，
  // 所以它不写 cursor；拉取者（脚本 / RSS 轮询 / agent）需要「我从 X 读到这一批」的协议，
  // 而「全部消费成功才提交位点」由平台保证。平台**不实现 fetcher**（取数是适配器的事），
  // 只拥有**位置** —— 这正是「位点只有一个推进点」能成立的前提（H2：加实例不改核心）。
  //
  // 必须在 webhook 前缀分支**之前**匹配，否则 `/api/events/<prefix>/batch` 会被当成
  // 一个叫 `<prefix>/batch` 的来源前缀。
  {
    const m = /^\/api\/events\/([^/]+)\/batch$/.exec(path);
    if (m && req.method === 'POST') {
      const prefix = decodeURIComponent(m[1]!);
      const rawBody: Buffer | undefined = (req as any).__rawBody__;
      if (!rawBody) {
        json(res, 400, { error: '原始请求体不可用（需在 body 解析阶段保存 __rawBody__）' });
        return true;
      }
      const source = deps.repos.eventSourceRepo.getByPrefix(deps.orgId, prefix);
      if (!source) {
        json(res, 404, { error: `未登记的来源 ${prefix}：请先在 event_sources 里登记` });
        return true;
      }
      const body = ((req as any).__parsedBody__ ?? {}) as Record<string, unknown>;
      // `nextCursor` 必须**显式**给出（含显式的 null = 上游已到末尾）。
      // 缺省不推进：否则调用方忘传一次就会把位点重置成 null → 下次全量重拉。
      if (!('nextCursor' in body)) {
        json(res, 400, {
          error: 'nextCursor 必填',
          hint: '提交本批之后上游读到哪儿；若上游已到末尾请显式传 null',
        });
        return true;
      }
      const nextCursor = body['nextCursor'] === null ? null : String(body['nextCursor']);

      const result = consumeBatch(
        { sources: deps.repos.eventSourceRepo, ingress: ingressFor(source), now: deps.now },
        {
          sourceId: source.id,
          raw: {
            prefix,
            headers: req.headers as Record<string, string | string[] | undefined>,
            rawBody,
            secret: source.secret ?? null,
          },
          nextCursor,
        },
      );

      const first = result.results?.[0];
      const status =
        result.status === 'missing-source' || first?.status === 'unknown-source'
          ? 404
          : // 签名不对仍然是 401：把「你没权限」混进 409「稍后重试」会让调用方重试到天荒地老
            first?.status === 'unauthorized'
            ? 401
            : result.status === 'not-committed'
              ? 409
              : 200;
      json(res, status, result);
      deps.repos.eventSourceRepo.updateHealth(source.id, {
        lastEventAt: Date.now(),
        lastStatus: result.status,
        lastCursor: result.cursor,
        // 被准入规则丢掉时留下「为什么」（批量入口与单条入口同一口径）
        lastFiltered: result.results?.find(r => r.filteredBy)?.filteredBy,
        lastError: status >= 400 ? result.reason : undefined,
      });
      return true;
    }
  }

  // ── webhook 入站（前缀匹配，必须排在所有精确路径之后）──────────────────────
  if (path.startsWith('/api/events/') && req.method === 'POST') {
    const prefix = path.slice('/api/events/'.length);
    if (!prefix) {
      json(res, 400, { error: '缺少来源前缀' });
      return true;
    }
    const source = deps.repos.eventSourceRepo.getByPrefix(deps.orgId, prefix);
    const rawBody: Buffer | undefined = (req as any).__rawBody__;
    if (!rawBody) {
      json(res, 400, { error: '原始请求体不可用（需在 body 解析阶段保存 __rawBody__）' });
      return true;
    }

    if (!source) {
      json(res, 404, { error: `未登记的来源 ${prefix}：请先在 event_sources 里登记` });
      return true;
    }

    // 推送式来源**刻意不写位点**：它没有「读到哪儿」这件事。
    // 一个列只回答一个问题 —— 若这里也推进 cursor，那一列就同时承载
    // 「拉取位置」与「最后一条推送」，两种语义迟早互相踩。
    const result = ingressFor(source).ingest({
      prefix,
      headers: req.headers as Record<string, string | string[] | undefined>,
      rawBody,
      secret: source.secret ?? null,
    });

    const status =
      result.status === 'unknown-source'
        ? 404
        : result.status === 'unauthorized'
          ? 401
          : 200;
    json(res, status, result);
    deps.repos.eventSourceRepo.updateHealth(source.id, {
      lastEventAt: Date.now(),
      lastStatus: result.status,
      // 被准入规则丢掉时留下「为什么」：否则「事件没进来」永远只能靠翻日志
      lastFiltered: result.filteredBy,
      lastFilterReason: result.filteredBy ? result.reason : undefined,
      lastError: status >= 400 ? result.reason : undefined,
    });
    return true;
  }

  // ── 单条流（B4：入口倒置的读取面）──────────────────────────────────────────
  //
  // 契约：**只给 ref** 就能拿到这条流的头部事实（标题 / stage / 任务状态）。
  // 为什么是查询参数而不是 `/api/threads/<ref>`：ref 里可以有 `/`（`gh:owner/repo`），
  // 塞进路径要靠 `%2F` 穿透多层路由，任何一层解码就会把一条流劈成两段。
  // 只读：不写 threads 表 —— 视角不能顺手造对象（H1）。
  if (path === '/api/threads/one' && req.method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://local');
    const ref = (url.searchParams.get('ref') ?? '').trim();
    if (!ref) {
      json(res, 400, {
        error: 'ref 必填',
        hint: '例：?ref=tsk_xxx / ?ref=tkt_xxx / ?ref=agent:agt_xxx',
      });
      return true;
    }
    json(res, 200, { thread: withStage(rowForRef(deps, ref), deps) });
    return true;
  }

  // ── 流列表（Inbox 数据源 + 全局页的**检索语料**）──────────────────────────
  if (path === '/api/threads' && req.method === 'GET') {
    // 两条来源合并、按 ref 去重：
    //   a) threads 表 —— 外部事件真正创建过的流（有就有）
    //   b) buildInboxRows —— 日常主链路里「需要人」的对象（现算，零写入）
    // 旧的只读 (a) 在存量库里恒为空表 → 概览永远空（复审文档 §9.2）。
    const persisted: any[] = (deps.repos.threadRepo.list(200) ?? []) as any[];
    const inbox = buildInboxRows(deps);
    // **业务行优先**：同一条 ref 既有 thread 登记、又有任务时，"这条流归谁 / 标题 / 描述"
    // 以业务事实（task）为准。persisted 只补业务里没有的外部流。
    // 反了会让 owner 恒为 null（threads.owner_* 已删）→ 归属提示全部失效。
    const inboxRefs = new Set(inbox.map(r => String(r?.ref ?? '')));
    // 已登记的流也走 `rowForRef` —— 单读与列表必须是**同一个构造点**，
    // 否则同一个 ref 在两个入口给出不同标题/负责人（两个写者，第八种分叉）。
    const rows = [
      ...inbox,
      ...persisted
        .filter((t: any) => !inboxRefs.has(String(t?.ref ?? '')))
        .map((t: any) => rowForRef(deps, String(t?.ref ?? ''))),
    ];
    json(res, 200, { threads: rows.map((t: any) => withStage(t, deps)) });
    return true;
  }

  // ── 某条流的处置历史（审计视图）──────────────────────────────────────────
  {
    const m = /^\/api\/threads\/([^/]+)\/dispositions$/.exec(path);
    if (m && req.method === 'GET') {
      const key = decodeURIComponent(m[1]!);
      const threadId = resolveThreadId(deps, key);
      json(res, 200, { dispositions: deps.repos.dispositionRepo.listByThread(threadId, 100) });
      return true;
    }
  }

  // ── 某条流的时间线（S6）───────────────────────────────────────────
  {
    const m = /^\/api\/threads\/([^/]+)\/events$/.exec(path);
    if (m && req.method === 'GET') {
      const key = decodeURIComponent(m[1]!);
      // 时间线现在从 `triggers` 派生（`thread_refs` 存业务 ref），所以要把两种 id
      // 都归一到 ref：内部 `thr_xxx` → 业务 ref；已经是 ref 就原样用。
      const thread = deps.repos.threadRepo.getById?.(key) ?? deps.repos.threadRepo.getByRef?.(key);
      const ref = thread ? String(thread.ref) : key;
      const repo = deps.repos.triggerRepo;
      // **对外形状不变**（`ThreadEventAPI`：id/threadId/kind/actor/summary/createdAt）：
      // 时间线换了数据源（表 → 派生查询），不应让前端跟着改。后端仓储给的是 TriggerRow，
      // 在这里一次性折成对外 DTO；不做第二张存储，就只剩这一处映射。
      const events = repo
        ? repo.listByThreadRef(ref, 100).map((t: any) => ({
            id: String(t.id),
            threadId: ref,
            kind: String(t.kind),
            actor: t.actorId ?? undefined,
            summary: t.summary ?? '',
            createdAt: Number(t.receivedAt),
          }))
        : [];
      // 没有 repo 时返回空数组而不是 404：页面应该能区分
      // 「这条流没有事件」与「这个端点半不存在」。前者是正常状态。
      json(res, 200, { events });
      return true;
    }
  }

  // ── 全局路由决定（路由台的主数据源）──────────────────────────────────────
  // §5.4：路由台不是「待办列表」，而是「系统做过什么决定」的审计面。
  // 它必须能全局看，而不是只看某条流 —— 否则 observe 模式下
  // 「如果放开会自动接哪些活」永远没人看得到。
  if (path === '/api/threads/dispositions/recent' && req.method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://local');
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 500);
    json(res, 200, { dispositions: deps.repos.dispositionRepo.listRecent(limit) });
    return true;
  }

  // ── 某条流的订阅（路由台撤销 attach 的依据）──────────────────────────────
  // 撤销的对象是 **subscription**，不是 disposition —— 后者只是审计记录，
  // 表里也没有 ticket_id。把「决定」和「订阅」混为一谈会导致撤销无从落点。
  {
    const m = /^\/api\/threads\/([^/]+)\/subscriptions$/.exec(path);
    if (m && req.method === 'GET') {
      const threadId = decodeURIComponent(m[1]!);
      const subs =
        typeof deps.repos.threadRepo.listSubscriptions === 'function'
          ? deps.repos.threadRepo.listSubscriptions(threadId)
          : [];
      json(res, 200, { subscriptions: subs });
      return true;
    }
  }

  // ── 撤销一条错误的 attach（§5.4 明确要求）────────────────────────────────
  // 「人喊停」必须由路由层记录：取消订阅是人的动作，不是 agent 自述。
  {
    const m = /^\/api\/threads\/([^/]+)\/subscriptions\/([^/]+)$/.exec(path);
    if (m && req.method === 'DELETE') {
      const threadId = decodeURIComponent(m[1]!);
      const ticketId = decodeURIComponent(m[2]!);
      if (typeof deps.repos.threadRepo.unsubscribe !== 'function') {
        json(res, 501, { error: '该存储不支持取消订阅' });
        return true;
      }
      deps.repos.threadRepo.unsubscribe(threadId, ticketId);
      json(res, 200, { status: 'success', threadId, ticketId });
      return true;
    }
  }

  // ── 责任域绑定 ───────────────────────────────────────────────────────────
  if (path === '/api/resources/bindings' && req.method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://local');
    const resource = url.searchParams.get('resource');
    const holder = url.searchParams.get('holder');
    let bindings: unknown[] = [];
    if (resource) bindings = deps.repos.resourceBindingRepo.listByResource(resource);
    else if (holder) {
      const [kind, ...rest] = holder.split(':');
      const id = rest.join(':');
      bindings = kind === 'agent' || kind === 'team' ? deps.repos.resourceBindingRepo.listByHolder(kind, id) : [];
    } else {
      // 不带参数 = 全量。Settings「责任域」组用它一眼看全谁管什么。
      // 之前缺这个分支时返回空数组 —— UI 上表现为「没有任何责任域」，
      // 与真实的「已经绑了很多」完全相反（差数据比没数据更坏）。
      bindings = deps.repos.resourceBindingRepo.listAll();
    }
    json(res, 200, { bindings });
    return true;
  }

  /**
   * 授权判定的**唯一 HTTP 读取面**：某 agent 现在能不能对某资源执行某档动作。
   *
   * 为什么它必须是只读的：判定是纯函数（`authorizeAction`），写入一律发生在
   * 各自的领域路径（绑定写 `resource_bindings`、审批写 `approvals`）。
   * 如果这里也写，就会出现「查询顺便改状态」的第二个写者 —— 那正是本需求要收口的东西。
   *
   * 为什么需要它：判定点如果只活在 core 的执行路径里，人和 UI 就无法回答
   * 「他现在到底有没有这个权」，只能靠猜或去读两张表自己拼 —— 两个口径。
   */
  if (path === '/api/resources/authorization' && req.method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://local');
    const agentId = url.searchParams.get('agent') ?? '';
    const resource = url.searchParams.get('resource') ?? '';
    const actionScope = url.searchParams.get('action') ?? 'read';
    const holderKind = url.searchParams.get('holderKind') === 'team' ? 'team' : 'agent';
    if (!agentId || !resource) {
      json(res, 400, { error: 'agent 与 resource 必填（例：?agent=agt_x&resource=gh:o/r&action=publish）' });
      return true;
    }
    if (!isScope(actionScope)) {
      json(res, 400, { error: `action 只能是 ${RESOURCE_SCOPES.join(' / ')}，收到 "${actionScope}"` });
      return true;
    }

    const binding = deps.repos.resourceBindingRepo?.findByHolder
      ? deps.repos.resourceBindingRepo.findByHolder(holderKind, agentId, resource)
      : null;
    // 逐件事审批：查不到就等于没批（不是"可能批了"）
    const mandate = deps.repos.approvalRepo?.findMandate
      ? deps.repos.approvalRepo.findMandate({ agentId, resource, actionScope }).state
      : 'none';

    const authz = authorizeAction({
      binding: binding ? { scope: binding.scope, autonomy: binding.autonomy } : null,
      actionScope,
      mandate,
      resource,
    });

    json(res, 200, {
      agentId,
      holderKind,
      resource,
      actionScope,
      // 输入也回显：判定必须可复核 —— 否则又是一次"结论没有依据"
      inputs: {
        binding: binding ? { scope: binding.scope, autonomy: binding.autonomy, holder: binding.holder } : null,
        mandate,
      },
      verdict: authz.verdict,
      code: authz.code,
      reason: authz.reason,
      hint: authz.hint ?? null,
    });
    return true;
  }

  if (path === '/api/resources/bindings' && req.method === 'POST') {
    const body = ((await (req as any).__parsedBody__) ?? {}) as Record<string, unknown>;
    const holderKind = String(body['holderKind'] ?? 'agent');
    const holderId = String(body['holderId'] ?? '');
    const resource = String(body['resource'] ?? '');
    const scope = String(body['scope'] ?? 'read');
    if (!holderId || !resource) {
      json(res, 400, { error: 'holderId 与 resource 必填' });
      return true;
    }
    if (holderKind !== 'agent' && holderKind !== 'team') {
      json(res, 400, { error: "holderKind 只能是 'agent' 或 'team'" });
      return true;
    }
    const result = deps.repos.resourceBindingRepo.bind({
      holder: { kind: holderKind, id: holderId },
      resource,
      scope,
      autonomy: body['autonomy'] ? String(body['autonomy']) : undefined,
      grantedBy: String(body['grantedBy'] ?? 'human:unknown'),
    });
    json(res, result.ok ? 200 : 409, result);
    return true;
  }

  {
    const m = /^\/api\/resources\/bindings\/([^/]+)$/.exec(path);
    if (m && req.method === 'DELETE') {
      const ok = deps.repos.resourceBindingRepo.unbind(decodeURIComponent(m[1]!));
      json(res, ok ? 200 : 404, { ok });
      return true;
    }
  }

  // ── 票（执行侧的工作单位，见 docs/architecture/ticket.md）────────────────
  // 边界：Task = 治理对象（该不该做/谁批/谁验收）；Ticket = 「这件外部来的东西归谁、办完没」。
  // 票**不驱动执行**——没有 ticket → agent 的投递通道。这是它不变成「第二个任务」的判据。
  //
  // 单一写入点：本文件的三个入口都只调 `ticketRepo`（create / transition / linkTask），
  // 不再有第二条「直接拼 SQL 建票」的路径（由 ticket-store.test.ts 的源码守卫咬住）。
  {
    const tickets = deps.repos.ticketRepo;
    const unavailable = (): boolean => {
      json(res, 501, { error: "该存储没有 ticketRepo，票功能不可用（属接线缺陷，不是业务错误）" });
      return true;
    };

    if (path === '/api/tickets' && req.method === 'POST') {
      if (!tickets) return unavailable();
      const body = ((await (req as any).__parsedBody__) ?? {}) as Record<string, unknown>;
      try {
        const ticket = tickets.create({
          orgId: String(body['orgId'] ?? deps.orgId),
          kind: String(body['kind'] ?? ''),
          sourceRef: body['sourceRef'] == null ? null : String(body['sourceRef']),
          subject: String(body['subject'] ?? ''),
          assignee: body['assignee'] == null ? null : String(body['assignee']),
          taskId: body['taskId'] == null ? null : String(body['taskId']),
        });
        // 票轴的事件写者（B4-3 缺陷 C 的裁定）：票是「一件事」，它被建出来是**发生过的事**，
        // 必须登记成 trigger —— 否则 `tkt_…` 这条轴的来龙去脉在生产里长期空白，
        // 而空白面板会被读者读成「什么都没发生」。
        deps.recordEvent?.(String(ticket.id), {
          kind: 'ticket',
          summary: `票「${ticket.subject}」创建（${ticket.kind}）`,
          eventId: `ticket-created:${ticket.id}`,
        });
        json(res, 201, { ticket });
      } catch (err) {
        // 拒绝 + 可行动提示（不是 500）：这三类都是调用方输入问题。
        json(res, 400, { error: String((err as Error)?.message ?? err) });
      }
      return true;
    }

    {
      const m = /^\/api\/tickets\/([^/]+)$/.exec(path);
      if (m && req.method === 'GET') {
        if (!tickets) return unavailable();
        const ticket = tickets.getById(decodeURIComponent(m[1]!));
        if (!ticket) {
          // 404 而不是空对象：页面要能区分「票不存在」与「票存在但没内容」。
          json(res, 404, {
            error: `票 ${decodeURIComponent(m[1]!)} 不存在。用 POST /api/tickets 新建，或从 GET /api/tasks/:id/tickets 找正确的 id。`,
          });
          return true;
        }
        json(res, 200, { ticket });
        return true;
      }
    }

    {
      // 流转状态（状态机唯一执行点在 repo，这里只做 HTTP 翻译）
      const m = /^\/api\/tickets\/([^/]+)\/transition$/.exec(path);
      if (m && req.method === 'POST') {
        if (!tickets) return unavailable();
        const body = ((await (req as any).__parsedBody__) ?? {}) as Record<string, unknown>;
        try {
          const ticket = tickets.transition(decodeURIComponent(m[1]!), String(body['status'] ?? '') as any);
          // 状态流转同样是「发生过的事」（与建票同一个写者、同一张表、同一条轴）：
          // 时间线上必须能看到这张票什么时候被谁推进到哪一步，否则「票办完没」只能靠读当前状态猜。
          deps.recordEvent?.(String(ticket.id), {
            kind: 'ticket',
            summary: `票「${ticket.subject}」→ ${ticket.status}`,
            eventId: `ticket-status:${ticket.id}:${String(ticket.status)}`,
          });
          json(res, 200, { ticket });
        } catch (err) {
          const msg = String((err as Error)?.message ?? err);
          // 票不存在 → 404；其余（非法状态 / 非法转移）→ 400。都不静默 upsert。
          json(res, msg.startsWith('TICKET_NOT_FOUND') ? 404 : 400, { error: msg });
        }
        return true;
      }
    }

    {
      // 关联/断开任务（票不因 task 完成而消失，也不因 detach 被删）
      const m = /^\/api\/tickets\/([^/]+)$/.exec(path);
      if (m && req.method === 'PATCH') {
        if (!tickets) return unavailable();
        const body = ((await (req as any).__parsedBody__) ?? {}) as Record<string, unknown>;
        if (!('taskId' in body)) {
          json(res, 400, { error: "PATCH /api/tickets/:id 只接受 taskId（字符串或 null）。状态流转请用 POST /api/tickets/:id/transition。" });
          return true;
        }
        try {
          json(res, 200, {
            ticket: tickets.linkTask(decodeURIComponent(m[1]!), body['taskId'] == null ? null : String(body['taskId'])),
          });
        } catch (err) {
          const msg = String((err as Error)?.message ?? err);
          json(res, msg.startsWith('TICKET_NOT_FOUND') ? 404 : 400, { error: msg });
        }
        return true;
      }
    }

    {
      // 某张任务上的票。先确认任务存在：否则「任务不存在」与「任务没有票」都返回空数组，
      // 前端会把打错的 task id 显示成「这个任务没票」——差数据比没数据更坏。
      const m = /^\/api\/tasks\/([^/]+)\/tickets$/.exec(path);
      if (m && req.method === 'GET') {
        if (!tickets) return unavailable();
        const taskId = decodeURIComponent(m[1]!);
        const task = deps.repos.taskRepo?.findById?.(taskId) ?? null;
        if (!task) {
          json(res, 404, { error: `任务 ${taskId} 不存在。用 GET /api/tasks 确认 id。` });
          return true;
        }
        json(res, 200, { tickets: tickets.listByTask(taskId) });
        return true;
      }
    }
  }

  return false;
}
