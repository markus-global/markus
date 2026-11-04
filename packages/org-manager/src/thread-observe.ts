/**
 * 进程内事件的**影子判定**（埋点，不改行为）。
 *
 * ## 为什么需要这一层
 * chat 回合 / task 评论 / a2a 投递这三类事件已经在写时间线（`triggers` 一行），但它们
 * **从来没有进过事件管线**：`EventIngress.ingest()` 只有两个调用者，都是 webhook
 * （`source-cursor.ts` 拉取、`event-routes.ts` 推送）。也就是说这批事件的「准入 / 路由 /
 * 四档投递」全部没跑过，谁也不知道切换之后它们会变成什么。
 *
 * 本文件只回答一个问题：**「如果现在切，会怎样」**。答案进两处（都是可读的）：
 * 一条稳定的 info 日志 + `threadWiringHealth().observed[入口][结论]` 计数（`/api/health`）。
 *
 * ## 边界（这些是刻意的，不是没做）
 * - **不投递**：`deliver` 是空实现。埋点绝不能顺手叫醒 agent。
 * - **不写处置、不登 trigger**：一旦写处置，`dispositions.countByTrigger` 会让真事件
 *   被判定为 `duplicate` —— 埋点会**改变**行为。
 * - **不造流**：流不存在就报 `unknown-thread`（观测不负责造对象，H1）。
 * - **不代跑研判引擎**：规则 6 要 LLM，影子模式给不出可复现答案，只报 `deferred`。
 *
 * ## 切换方式（下一张卡，一个可独立回滚的提交）
 * 把 `observeThreadEvent(...)` 的调用点改成走 `ingress.ingestInternal(ev)` 的真路由路径。
 * 本文件与 `EventIngress.observe()` 共用同一份 gate 判定（`ThreadService.previewRoute`
 * → `gateFor` / `decisionFor`），所以「预告」与「实际」不会分叉。
 */
import { EventIngress, SourceRegistry, ThreadService, admitEvent } from '@markus/core';
import type { EventObservation, NormalizedEvent } from '@markus/core';
import type { ActorKind } from '@markus/shared';
import { createLogger } from '@markus/shared';
import type { StorageBridge } from './storage-bridge.js';
import { bumpObserved } from './thread-wiring-metrics.js';

const log = createLogger('thread-observe');

/**
 * 进程内事件没有 `event_sources` 行，所以没有策略可读 —— 缺省策略 = 全收。
 *
 * 这不代表「自激永远不会被挡」：`self` 规则按**身份**匹配（`selfActorIds`），
 * 空策略等于「没有登记自激身份」。切换那张卡必须为这三类事件补上策略，
 * 否则 a2a 这类「agent 发给 agent」的事件在真路由里会一路走到研判段。
 * 这也是影子数据里最值得看的一列。
 */
const INTERNAL_POLICY = {} as const;

/**
 * 制造者类别。给了就用（a2a / chat 明确知道是 agent）；没给则按 id 前缀推断。
 *
 * 为什么允许推断：`recordThreadEvent` 的调用方大多只拿得到 id（`authorId` / `fromId`）。
 * 要求每个调用点都补一个 `actorKind` 会把同一个事实写成 N 份；前缀约定是平台级的
 * （`agt_` = agent，`usr_` = 人），在这里归一一次即可。
 * 推断只影响影子的准入/派发判定，**不影响任何真实行为**。
 */
export function actorKindOf(actorId: string | undefined, override?: ActorKind): ActorKind {
  if (override) return override;
  if (!actorId) return 'system';
  if (actorId.startsWith('agt_')) return 'agent';
  if (actorId.startsWith('usr_') || actorId.startsWith('u_')) return 'human';
  return 'system';
}

/**
 * 按 storage 缓存 ingress：每个 storage 一份（`ThreadService` 只持 repo 引用，构造极轻，
 * 但热路径上每次事件都 new 一套对象是没必要的形状抖动）。
 */
const ingressByStorage = new WeakMap<object, EventIngress>();

function ingressFor(storage: StorageBridge): EventIngress | null {
  const threads = storage.threadRepo;
  if (!threads) return null;
  const cached = ingressByStorage.get(storage);
  if (cached) return cached;

  const ingress = new EventIngress({
    // 进程内事件不走适配器：没有前缀、没有 HMAC。空注册表 = 任何人调 ingest()
    // 都会被拒（unknown-source），只有 observe() 这条路能进来 —— 这不是遗漏，是隔离。
    registry: new SourceRegistry(),
    service: new ThreadService({ threads, dispositions: storage.dispositionRepo }),
    admission: (ev: NormalizedEvent) => admitEvent(ev, INTERNAL_POLICY, Date.now()),
    // 影子模式：绝不投递。写成注释而不是「忘了接」。
    deliver: () => {},
    // `observe()` 不会碰它；传真实仓储而不是假对象，避免「哪天 observe 写了一点也没人发现」。
    triggers: storage.triggerRepo,
  });
  ingressByStorage.set(storage, ingress);
  return ingress;
}

/** 埋点入口的 `link` 取值 —— 只允许这三个（多一个就是新入口，需要新的策略判定）。 */
export type ObserveLink = 'chat.turn' | 'task.comment' | 'a2a.deliver' | 'other';

/** 从 ref 前缀推断入口：三个调用点都走 `recordThreadEvent`，ref 是它们唯一稳定的身份。 */
export function linkOfRef(ref: string): ObserveLink {
  if (ref.startsWith('cs_')) return 'chat.turn';
  if (ref.startsWith('tsk_')) return 'task.comment';
  if (ref.startsWith('a2a_')) return 'a2a.deliver';
  return 'other';
}

/**
 * 记一条影子判定。
 *
 * @returns 判定结论（测试用来断言「埋点真的跑了、且什么都没写」）；
 *   存储没挂 thread repo / 流不存在时返回 `null`（不抛 —— 埋点是附加设施）。
 */
export function observeThreadEvent(
  storage: StorageBridge | null | undefined,
  event: {
    ref: string;
    kind: string;
    actor?: string;
    actorKind?: ActorKind;
    summary: string;
    /**
     * **调用方已用于落库的那个**幂等键（唯一正确来源）。
     *
     * 为什么不在这里自己算：影子要回答的是「若真走 router 会怎样」，而 router 判重读的是
     * `dispositions.countByTrigger(triggerId)` —— triggerId 就是落库用的键。
     * 自己再算一份（曾经是 `sha1Like(ref|kind|summary)`）会让影子里的 `duplicate` 恒为 0，
     * 而「会不会重复」恰好是切换前最需要看的一列。**同一事实只能有一个键。**
     */
    idempotencyKey: string;
  },
): EventObservation | null {
  if (!storage) return null;
  const ingress = ingressFor(storage);
  if (!ingress) return null;

  const link = linkOfRef(event.ref);
  const normalized: NormalizedEvent = {
    kind: event.kind as NormalizedEvent['kind'],
    // 原样使用调用方落库的键（唯一事实源）。
    idempotencyKey: event.idempotencyKey,
    ref: event.ref,
    actorKind: actorKindOf(event.actor, event.actorKind),
    actorId: event.actor ?? 'system',
    // 进程内事件天然是「直接冲这条流来的」，不是 ambient 蹭到的。
    addressing: 'direct',
    summary: event.summary,
    // 正文刻意不带：影子判定不需要内容，而我们没有可靠的正文来源（有的话也不该复制第二份）。
    body: '',
    receivedAt: Date.now(),
  };

  const observation = ingress.observe(normalized);
  bumpObserved(link, observation.status);
  // 一行一日志：切换前想统计什么，直接 grep 这个前缀即可（格式稳定，字段不随内容变形）。
  log.info('observe', {
    link,
    status: observation.status,
    verdict: observation.verdict ?? null,
    wouldDeliver: observation.wouldDeliver ?? null,
    ref: event.ref,
    kind: event.kind,
  });
  return observation;
}

