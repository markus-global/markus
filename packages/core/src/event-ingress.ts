/**
 * 事件入口：**单一顺序** verify → normalize → 幂等 → gate → record → dispatch。
 *
 * 为什么不把顺序留给调用方：以前每个入口自己拼这套流程（webhook / IM / 定时 / A2A），
 * 结果是「有的入口查幂等、有的不查；有的先落审计、有的直接投递」。同一类 bug 换了
 * 四种写法出现。现在顺序写死在一个方法里，任何新入口只能复用它。
 *
 * 职责边界：ingress 不做业务判断，只把事件喂给 `ThreadService.route()` 并按结果投递。
 */
import { ThreadService } from './thread-service.js';
import type { RouteInput } from './thread-service.js';
import type { NormalizedEvent, RawEvent, SourceRegistry } from './event-source.js';
import type { Admission, AdmissionRule } from './source-admission.js';
import type { GateVerdict } from '@markus/shared';

export type IngressStatus =
  | 'unknown-source' // 前缀没有注册适配器
  | 'unauthorized' // 签名不对 → 401，不解析载荷
  | 'filtered' // 准入判定拒绝（进领域之前就丢：自激 / 类别 / 范围 / 时间窗）
  | 'duplicate' // 幂等命中 → 200，不重复处理
  | 'direct-through' // 命中已有主/订阅 → 投给持有者，不产生处置
  | 'dispatched' // 人已指定目标 → 直接投递
  | 'attached' // 挂到既有流
  | 'ignored' // 留痕但不唤醒
  | 'deferred'; // 待研判（v1 记录并延后）

export interface IngressResult {
  status: IngressStatus;
  reason: string;
  threadId?: string;
  ticketId?: string;
  events: number;
  /**
   * 本次投递是否**失败**（区别于「被规则拒绝」）。
   *
   * 只用于一件事：拉取侧位点推进的判据 —— 失败不得推进位点（宁可重拉，不可漏）。
   * 因此它必须是**入口自己给的结论**，而不是让消费方猜 `status` 的字符串含义
   * （「ignored」既可能是「规则拒绝」也可能是「归一化失败」，猜错就会漏事件）。
   */
  failed?: boolean;
  /** 被准入规则拒绝时的可判定标签（与 `reason` 同一份事实） */
  filteredBy?: AdmissionRule;
  /** 一个请求含多个事件时，逐事件结果（批量入口与测试用；单事件可省略） */
  results?: IngressResult[];
}

/**
 * 影子判定的结论。`status` **复用 `IngressStatus` 的词汇**：它说的就是
 * 「切换成真路由后，`ingest()` 会返回这个 status」。
 *
 * 之所以要复用而不是另造一套：两套词汇就意味着一份翻译表，而翻译表必然会漂移。
 */
export interface EventObservation {
  /** `unknown-thread` = 这条流还不存在（调用方应先 ensureThread）。 */
  status: IngressStatus | 'unknown-thread';
  reason: string;
  /** Gate 结论（`duplicate` / `dispatch` / `direct-through` / `attach` / `ignore-ended` / `assess`）。 */
  verdict?: GateVerdict;
  matchedRule?: string;
  /** 切换后会投递给谁；`undefined` = 不会投递。 */
  wouldDeliver?: string;
  threadId?: string;
  filteredBy?: AdmissionRule;
}

export interface DispatchTarget {
  threadRef: string;
  agentId: string;
  sessionId?: string;
  event: NormalizedEvent;
  /** 直通时命中的 ticket（v1 里 ticket 就是 thread 本身） */
  ticketId?: string;
}

export interface IngressDeps {
  registry: SourceRegistry;
  service: ThreadService;
  /**
   * 准入判定：**什么算事件**。
   *
   * **刻意是必填**（与 `triggers` 同一个教训）：可选时漏传不报类型错、运行期也不报错，
   * 事件照样路由 —— 只是「机器人自己发的消息」不再被丢弃，自激循环重新变成可能。
   * 改必填 = 漏传变成编译错误。判定逻辑本身只在 `source-admission.ts` 一处。
   */
  admission: (ev: NormalizedEvent) => Admission;
  /** 投递到 agent mailbox。core 不直接依赖 agent，由调用方注入。 */
  deliver(target: DispatchTarget): void;
  /**
   * 触发器登记（幂等）。
   *
   * **刻意不是 optional**：`SqliteTriggerRepo` 有完整实现、从 storage 正常导出，
   * 但生产代码里**零使用** —— 于是 `triggers` 表永远是 0 行，A4.2/A4.3 永远验不了。
   * 这不是「没有流量」，是**没有写入者**（同一个病的第五次）。
   *
   * 之所以容易漏：它是可选字段时，漏传不报类型错，运行期也不报错 ——
   * 事件照样路由、照样投递，只是**没有任何一条「这条消息从哪来」的登记**。
   * 改必填 = 漏传变成编译错误。
   */
  triggers: {
    insertOrGet(t: {
      kind: string;
      idempotencyKey: string;
      actorKind?: string | null;
      actorId?: string | null;
      addressing?: string | null;
      summary?: string | null;
      body?: string | null;
      threadRefs?: string[];
      receivedAt?: number;
    }): { trigger: unknown; created: boolean };
  };
  now?: () => number;
}

export class EventIngress {
  constructor(private deps: IngressDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  ingest(raw: RawEvent): IngressResult {
    // 1. 来源必须已注册（未注册 = 拒绝，而不是「先收下再说」）
    const adapter = this.deps.registry.get(raw.prefix);
    if (!adapter) {
      return { status: 'unknown-source', failed: true, reason: `未注册的来源前缀 ${raw.prefix}：请先在 event_sources 里登记适配器`, events: 0 };
    }

    // 2. 签名：失败即返回，**不解析载荷**
    if (!adapter.verify(raw)) {
      return { status: 'unauthorized', failed: true, reason: `${raw.prefix} 签名校验失败（原始字节 HMAC 不匹配）`, events: 0 };
    }

    // 3. 归一化（一个请求可能是多个事件）
    let events: NormalizedEvent[];
    try {
      events = adapter.normalize(raw);
    } catch (e) {
      return { status: 'ignored', failed: true, reason: `归一化失败：${(e as Error).message}`, events: 0 };
    }
    if (events.length === 0) return { status: 'ignored', reason: '该载荷不包含需要处理的事件', events: 0 };

    // 4. 逐事件走同一条确定性链路
    const results: IngressResult[] = [];
    let last: IngressResult = { status: 'ignored', reason: '无事件', events: 0 };
    for (const ev of events) {
      try {
        last = this.ingestOne(ev);
      } catch (e) {
        // 单事件异常不静默：标 failed 让拉取侧拒绝推进位点，而不是「这条过去了」。
        last = { status: 'ignored', failed: true, reason: `处理异常：${(e as Error).message}`, events: 1 };
      }
      results.push(last);
      if (last.status === 'unauthorized' || last.status === 'unknown-source') break;
    }
    return { ...last, events: events.length, results };
  }

  /**
   * **进程内事件的埋点入口**（chat 回合 / task 评论 / a2a 投递）。
   *
   * 为什么需要它：`ingest()` 只接受带前缀的 *webhook* 原始字节（verify → normalize）。
   * 进程内事件既没有 webhook 前缀，也没有 HMAC —— 让它们伪造一份原始字节去避适配器，
   * 就是把「内部事件」伪装成「外部推送」。那层伪装哪天真被当真，就是最贵的一类错。
   *
   * 所以这里直接吃已经归一化的 `NormalizedEvent`，**但共用同一套顺序与同一套语义**：
   * 准入判定（`admission`）→ 路由判定（`service.previewRoute`，与 `route()` 同一份 gate）。
   *
   * 边界（本卡明确不做的事）：**只读**。不登 trigger、不写处置、不投递、不唤醒。
   * 一旦写处置，`dispositions.countByTrigger` 就会在真事件到来时回 `duplicate` ——
   * 埋点会**改变行为**，这是不能接受的。
   *
   * 切换到真路由 = 把调用点改成走 `ingestOne(ev)`（一个可独立回滚的提交）。
   */
  observe(ev: NormalizedEvent): EventObservation {
    const verdictAdmission = this.deps.admission(ev);
    if (!verdictAdmission.admitted) {
      return { status: 'filtered', reason: verdictAdmission.reason, filteredBy: verdictAdmission.rule };
    }

    const preview = this.deps.service.previewRoute(this.routeInputOf(ev));
    if (!preview) {
      return {
        status: 'unknown-thread',
        reason: `流 ${ev.ref} 还不存在：调用方应先 ensureThread（观测不负责造对象）`,
      };
    }

    const found = { verdict: preview.verdict, matchedRule: preview.matchedRule, threadId: preview.threadId };
    switch (preview.verdict) {
      case 'duplicate':
        return { ...found, status: 'duplicate', reason: '幂等命中：该事件已处置过' };
      case 'direct-through': {
        if (preview.delivery === 'drop') {
          return { ...found, status: 'ignored', reason: '自主档位为 off：只记录事件，不投递' };
        }
        if (preview.delivery === 'record-only') {
          return { ...found, status: 'ignored', reason: '自主档位为 observe：会记判断但不会自动化' };
        }
        const owner = this.deps.service.directThrough(ev.ref);
        const agentId = owner?.owners[0] ?? owner?.subscriptions[0]?.agentId;
        return {
          ...found,
          status: 'direct-through',
          reason: `流已有主/订阅 → 直通（ticket=${preview.ticketId ?? 'thread'}）`,
          wouldDeliver: agentId,
        };
      }
      case 'dispatch': {
        const decided = preview.decision;
        return {
          ...found,
          status: 'dispatched',
          reason: decided?.reason ?? '人已指定处理者',
          wouldDeliver: decided && decided.action === 'dispatch' ? decided.agentId : undefined,
        };
      }
      case 'attach':
        return { ...found, status: 'attached', reason: preview.decision?.reason ?? '挂到既有流' };
      case 'ignore-ended':
        return { ...found, status: 'ignored', reason: preview.decision?.reason ?? '流已结束，只留痕' };
      case 'assess':
      default:
        return {
          ...found,
          status: 'deferred',
          reason: preview.needsAssessment
            ? 'needs-assessment：会进入研判引擎（影子模式不代跑）'
            : '无处置决定',
        };
    }
  }

  private ingestOne(ev: NormalizedEvent): IngressResult {
    // 0. 准入：**进领域之前**丢弃（自激 / 类别 / 监听范围 / 时间窗）。
    //
    // 为什么必须在 `triggers.insertOrGet` 之前：被规则拒绝的事件不该占用幂等键
    // —— 否则「同一个 id，先被过滤、后来又在监听范围内」就会被错认成重复而永久丢失。
    // 同理也不该产生 disposition：领域根本没看见它。
    const verdict = this.deps.admission(ev);
    if (!verdict.admitted) {
      return { status: 'filtered', reason: verdict.reason, filteredBy: verdict.rule, events: 1 };
    }

    // 触发器登记：**先登记「这条消息从哪来」，再路由**。
    //
    // 为什么必须在 route() 之前：`route()` 用 `countByTrigger` 判幂等，
    // 而那份「这个 trigger 存在过」的事实本该由这里建立。顺序反了的话，
    // 幂等判定读的是一张永远空着的表 —— 重投将永远不被识别为重复。
    //
    // 幂等语义在仓储层（`insertOrGet`：先查 + ON CONFLICT DO NOTHING + 回查），
    // 这里不重复实现，也不因为「已存在」而改变后续路由 —— 重投是正常情况
    // （webhook 重试 / IM 重发 / 进程重启），不是异常。
    this.deps.triggers.insertOrGet({
      kind: ev.kind,
      idempotencyKey: ev.idempotencyKey,
      actorKind: ev.actorKind,
      actorId: ev.actorId,
      addressing: ev.addressing,
      summary: ev.summary,
      body: ev.body,
      threadRefs: [ev.ref],
      receivedAt: ev.receivedAt,
    });

    const input = this.routeInputOf(ev);
    const result = this.deps.service.route(input);

    if (result.verdict === 'duplicate') {
      return { status: 'duplicate', reason: `幂等命中：${ev.idempotencyKey} 已处置过`, threadId: result.threadId, events: 1 };
    }

    if (result.verdict === 'direct-through') {
      // 直通命中了负责人，但不等于「现在就允许打扰他」——
      // 四档判定在 ThreadService 里算完，这里必须照做，否则那一层等于没写。
      // （这条曾真的漏过：闸门加了、消费方没接，事件照样投出去。）
      if (result.delivery === 'drop') {
        return {
          status: 'ignored',
          reason: `自主档位为 off：只记录事件，不投递、不动手`,
          threadId: result.threadId, events: 1,
        };
      }
      if (result.delivery === 'record-only') {
        return {
          status: 'ignored',
          reason: `自主档位为 observe：已记录判断（would-accept），未投递`,
          threadId: result.threadId, events: 1,
        };
      }
      // 直通 = 投给持有者，不产生处置记录
      const target = this.targetFor(ev, result.ticketId);
      if (target) this.deps.deliver(target);
      return {
        status: 'direct-through',
        reason: `流已有主/订阅 → 直通（ticket=${result.ticketId ?? 'thread'}）`,
        threadId: result.threadId,
        ticketId: result.ticketId,
        events: 1,
      };
    }

    const decision = result.decision;
    if (!decision) return { status: 'ignored', reason: '无处置决定', threadId: result.threadId, events: 1 };

    switch (decision.action) {
      case 'dispatch': {
        this.deps.deliver({ threadRef: ev.ref, agentId: decision.agentId, sessionId: decision.sessionId, event: ev });
        return { status: 'dispatched', reason: decision.reason, threadId: result.threadId, events: 1 };
      }
      case 'attach': {
        // 挂到既有流：交给该流的持有者；无持有者时不投递（留痕即可）
        const target = this.targetFor(ev, decision.ticketId);
        if (target) this.deps.deliver(target);
        return { status: 'attached', reason: decision.reason, threadId: result.threadId, ticketId: decision.ticketId, events: 1 };
      }
      case 'ignore':
      case 'stop':
      case 'defer':
      default:
        return { status: 'ignored', reason: decision.reason, threadId: result.threadId, events: 1 };
    }
  }

  private routeInputOf(ev: NormalizedEvent): RouteInput {
    return {
      triggerId: ev.idempotencyKey,
      kind: ev.kind,
      ref: ev.ref,
      actorKind: ev.actorKind,
      addressing: ev.addressing,
      threadEnded: ev.threadEnded,
    };
  }


  private targetFor(ev: NormalizedEvent, ticketId?: string): DispatchTarget | null {
    const owner = this.deps.service.directThrough(ev.ref);
    if (!owner) return null;
    const agentId =
      owner.owners[0] ??
      owner.subscriptions[0]?.agentId;
    if (!agentId) return null;
    return { threadRef: ev.ref, agentId, event: ev, ticketId };
  }
}
