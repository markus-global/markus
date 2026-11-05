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

export type IngressStatus =
  | 'unknown-source' // 前缀没有注册适配器
  | 'unauthorized' // 签名不对 → 401，不解析载荷
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
      return { status: 'unknown-source', reason: `未注册的来源前缀 ${raw.prefix}：请先在 event_sources 里登记适配器`, events: 0 };
    }

    // 2. 签名：失败即返回，**不解析载荷**
    if (!adapter.verify(raw)) {
      return { status: 'unauthorized', reason: `${raw.prefix} 签名校验失败（原始字节 HMAC 不匹配）`, events: 0 };
    }

    // 3. 归一化（一个请求可能是多个事件）
    let events: NormalizedEvent[];
    try {
      events = adapter.normalize(raw);
    } catch (e) {
      return { status: 'ignored', reason: `归一化失败：${(e as Error).message}`, events: 0 };
    }
    if (events.length === 0) return { status: 'ignored', reason: '该载荷不包含需要处理的事件', events: 0 };

    // 4. 逐事件走同一条确定性链路
    let last: IngressResult = { status: 'ignored', reason: '无事件', events: 0 };
    for (const ev of events) {
      last = this.ingestOne(ev);
      if (last.status === 'unauthorized' || last.status === 'unknown-source') break;
    }
    return { ...last, events: events.length };
  }

  private ingestOne(ev: NormalizedEvent): IngressResult {
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
