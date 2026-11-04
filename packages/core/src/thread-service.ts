/**
 * 流服务：ensure / claim / release / direct-through / record / route。
 *
 * 边界：**这里不做业务判断**（能不能接、该不该做），只回答「这条消息属于哪条流、
 * 这条流现在归谁、这次事件要不要留痕」。所有分支都由 shared 的纯函数给出
 * （`gateVerdict`），因此可以用 8 个用例穷举完，不需要跑 LLM。
 *
 * 依赖用结构化接口（`ThreadStoreLike` / `DispositionStoreLike`）注入，不直接 import
 * storage 包：core 不依赖 sqlite，测试里也就不用建库。
 */
import {
  gateVerdict, deliveryFor,
  type ActorKind, type Addressing, type Autonomy, type Disposition, type GateVerdict, type MatchedRule, type ThreadRef, type TriggerKind,
} from '@markus/shared';
import type { WakeEvent } from './rest-wake.js';

export interface ThreadRowLike {
  id: string;
  ref: string;
  lastActivity: number;
}

export interface SubscriptionLike {
  ticketId: string;
  agentId: string;
  purpose: 'own' | 'context';
}

/**
 * 只读投影的结论。字段与 `RouteResult` 同源（同一套 verdict / decision / delivery），
 * 只是**没有副作用**、且多一个 `needsAssessment` 说明「这一条会在切换后真的去研判」。
 */
export interface RoutePreview {
  verdict: GateVerdict;
  threadId: string;
  matchedRule: MatchedRule | 'duplicate' | 'direct-through';
  /** 确定性规则给出的处置（assess / duplicate 时没有）。 */
  decision?: Disposition;
  /** 直通时的四档投影结论：`drop` / `record-only` / `deliver`。 */
  delivery?: 'deliver' | 'record-only' | 'drop';
  ticketId?: string;
  /** 命中规则 6（待研判）：切换后会调用研判引擎，影子模式不代跑。 */
  needsAssessment?: boolean;
}

export interface ThreadStoreLike {
  upsert(ref: string, now?: number): { thread: ThreadRowLike; created: boolean };
  getByRef(ref: string): ThreadRowLike | null;
  touch(threadId: string, now?: number): void;
  subscribe(threadId: string, ticketId: string, agentId: string, purpose: 'own' | 'context'): void;
  listSubscriptions(threadId: string): SubscriptionLike[];
}

export interface DispositionStoreLike {
  record(d: {
    triggerId: string;
    threadId: string;
    action: string;
    reason: string;
    /** 命中的 Gate 规则（契约 §5；B1）。缺省 = 处置与 Gate 规则无关。 */
    matchedRule?: string | null;
    wouldAccept?: boolean;
    actor?: string;
    createdAt?: number;
  }): boolean;
  countByTrigger(triggerId: string): number;
}

/**
 * Eval 两段语义（B1）里第 2 段 assessment（LLM 研判）的**可插拔引擎**。
 *
 * - **可插拔**：由调用方注入（仿 `autonomyFor` 的注入模式），core 不依赖任何 LLM 实现。
 * - **无引擎 = 合法配置**（不是错误）：`assess` 为 `undefined` 时，gate 未命中的事件
 *   降级为 `needs-assessment`（保留 v1 现行为），**不抛异常、不静默当 accept**。
 * - **引擎返回 `decided:false`** = 引擎存在但判不了（例如置信度不足 / 载荷不完整）
 *   → 同样降级为 needs-assessment，并把引擎给的原因写进 reason。
 */
export interface AssessInput {
  kind: TriggerKind;
  ref: ThreadRef;
  actorKind: ActorKind;
  addressing: Addressing;
  threadEnded?: boolean;
  entityRef?: ThreadRef;
  directTargetAgentId?: string;
  summary?: string;
  body?: string;
}

export type AssessOutcome =
  | { decided: true; disposition: Disposition }
  | { decided: false; reason: string };

export interface RouteInput {
  triggerId: string;
  kind: TriggerKind;
  ref: ThreadRef;
  actorKind: ActorKind;
  addressing: Addressing;
  /** 卡已结束（任务完成/关闭）：非人事件只留痕，不唤醒 */
  threadEnded?: boolean;
  /** 明确指向既有平台实体（`tsk_…`）时直接挂载 */
  entityRef?: ThreadRef;
  /** 人已经指定了要谁来处理 */
  directTargetAgentId?: string;
}

export interface RouteResult {
  verdict: GateVerdict;
  threadId: string;
  /**
   * 命中的 Gate 规则（契约 §5；B1）。随 `decision` 一并产出，供调用方展示/审计，
   * 也随 `dispositions.record(matchedRule)` 落库 —— 回答「Eval 为什么走了这条」。
   */
  matchedRule?: MatchedRule;
  /** null = 直通：命中已有主/订阅，不产生处置记录（流本身就是证据） */
  decision: Disposition | null;
  /** 直通时命中的 ticket（v1 里 ticket 就是 thread 本身） */
  ticketId?: string;
  /**
   * 这次要不要真的把事件交到人手里（四档投影的结果）。
   *
   * 为什么不能只看 `decision`：直通路径原本不产生 decision（流本身是证据），
   * 于是「要不要唤醒」这个判断没有地方承载。把它塞进 decision 会伪造一条
   * 本来不存在的处置记录；塞进 boolean 又会让 `off` 和 `observe` 分不开。
   * 单独一个字段最诚实：它就是 deliveryFor(autonomy) 的原样返回。
   *
   * 未注入 `autonomyFor` 时为 undefined —— 调用方按旧行为（直通即唤醒）。
   */
  delivery?: 'deliver' | 'record-only' | 'drop';
}

export class ThreadService {
  constructor(
    private deps: {
      threads: ThreadStoreLike;
      dispositions: DispositionStoreLike;
      now?: () => number;
      /**
       * 事件路由完成后通知外部「有新事件」。
       *
       * 为什么用回调而不是直接叫醒等待者：这个服务不知道 agent 的存在（core 分层），
       * 也不该知道。回调让「路由」和「唤醒」保持正交——测试里可以用一个 spy 验
       * 「什么情况下会通知」，不需要建整个 agent。
       */
      onWake?: (event: WakeEvent) => void;
      /**
       * 查「这个 agent 在这条流上的自主档位」。
       *
       * 为什么由外部注入而不是直接读绑定表：core 不依赖 storage（见文件头）。
       * 未注入 = 不做档位判定（保持旧行为），这样纯路由测试不必造绑定表；
       * 生产由 org-manager 注入真绑定查询 —— **一条链路上只有一个读档位的地方**。
       */
      autonomyFor?: (ref: ThreadRef, agentId: string) => Autonomy | null;
      /**
       * Eval 第 2 段：assessment（LLM 研判）的可插拔引擎。
       *
       * - **未注入 = 合法配置**：gate 未命中时降级 needs-assessment（保留 v1 行为），
       *   不抛异常、不静默当 accept。所以生产（org-manager）不注入也能跑 —— 这是默认。
       * - 注入后：仅当 gate 规则 1–5 全部未命中（verdict==='assess'）时才调用它。
       *   （规则命中时**绝不**调 assessment —— 见 `decisionFor`，有测试守着零调用。）
       *
       * 为什么由外部注入而不是 core 直接依赖 LLM：core 分层不碰任何 provider/gateway，
       * 和 `autonomyFor` 同一个道理 —— 测试里注入一个 spy 就能断言「命中了不去研判」。
       */
      assess?: (input: AssessInput) => AssessOutcome | undefined;
    },
  ) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** 幂等：同一个 ref 永远同一条流（I1 在 repo 层，这里只负责「拿到它」）。 */
  ensure(ref: ThreadRef): { thread: ThreadRowLike; created: boolean } {
    return this.deps.threads.upsert(ref, this.now());
  }

  // claim/release 已删除：它们只是 threads.owner_agent 的写入口，
  // 而"谁负责"的唯一事实源是 subscribe(purpose='own')（多值）。
  // 留着它们就等于给已删的单值列留一个驼一个的写者。

  subscribe(ref: ThreadRef, ticketId: string, agentId: string, purpose: 'own' | 'context' = 'own'): void {
    const { thread } = this.ensure(ref);
    this.deps.threads.subscribe(thread.id, ticketId, agentId, purpose);
  }

  /**
   * 直通判定：有主 or 有订阅 → 不研判、不产生处置。
   *
   * `owners` 从 subscriptions(purpose='own') 派生 —— 多值。
   * 曾经用 threads.owner_agent（单值且恒 NULL）表达责任，导致“一个外部对象只能一个人盯”
   * 才看起来必须拆成多条流；现在“多流”由多条 own 订阅表达，`UNIQUE(ref)` 无需放宽。
   */
  directThrough(
    ref: ThreadRef,
  ): { thread: ThreadRowLike; owners: string[]; subscriptions: SubscriptionLike[] } | null {
    const thread = this.deps.threads.getByRef(ref);
    if (!thread) return null;
    const subscriptions = this.deps.threads.listSubscriptions(thread.id);
    if (subscriptions.length === 0) return null;
    const owners = subscriptions.filter(s => s.purpose === 'own').map(s => s.agentId);
    return { thread, owners, subscriptions };
  }

  /**
   * 四档投影：已知「有人负责」之后，问他现在允许被打扰吗。
   *
   * 返回 `undefined` = 无法判定档位（没接绑定查询 / 这条流上没有绑定记录）→
   * 调用方保持旧行为（直通即唤醒）。**为什么不默认 observe**：设计里
   * observe 是「负责某个资源」时的默认档，而直通也可能来自 context 订阅，
   * 那些场景根本没有绑定记录。把它们一并降级成 record-only 会让现存 agent
   * 集体失聪 —— 那不是收紧，是事故。
   */
  private deliveryForOwner(
    ref: ThreadRef,
    subscriptions: SubscriptionLike[],
  ): { delivery: 'deliver' | 'record-only' | 'drop'; autonomy: Autonomy; ownerId: string } | undefined {
    if (!this.deps.autonomyFor) return undefined;
    const ownerId = subscriptions.find(s => s.purpose === 'own')?.agentId ?? subscriptions[0]?.agentId;
    if (!ownerId) return undefined;
    const autonomy = this.deps.autonomyFor(ref, ownerId);
    if (!autonomy) return undefined;
    return { delivery: deliveryFor(autonomy), autonomy, ownerId };
  }

  /**
   * 路由：唯一入口。顺序固定 —— 幂等 → 已结束 → 人指定 → 直通 → 挂载 → 待研判。
   * 返回值带 `verdict`，调用方（ingress）不必重复判断。
   */
  route(input: RouteInput): RouteResult {
    const { thread } = this.ensure(input.ref);
    const subscriptions = this.deps.threads.listSubscriptions(thread.id);

    const verdict = this.gateFor(input, subscriptions);

    if (verdict === 'duplicate') {
      // 不重复写审计（UNIQUE 也会挡），只回报判定结果
      return {
        verdict,
        threadId: thread.id,
        matchedRule: 'duplicate',
        decision: { action: 'ignore', threadRef: input.ref, reason: '幂等命中：该事件已处置过', wouldAccept: false },
      };
    }

    if (verdict === 'direct-through') {
      const ticketId = subscriptions[0]?.ticketId ?? thread.id;

      // 四档投影：直通命中「有人负责」之后，还要问「他现在允许被打扰吗」。
      //
      // 这一段是四档语义**唯一的消费点**。此前 `autonomy` 只存在于绑定表里，
      // `gateVerdict` 根本不读它 —— 于是 observe 档的 agent 照样被叫醒，
      // 而 resource_bind 的工具描述却写着「observe：不会自动动手」。
      // 机制存在、没有消费方，和红线闸门是同一种死法。
      const gate = this.deliveryForOwner(input.ref, subscriptions);
      const delivery = gate?.delivery;
      if (delivery === 'drop') {
        // off：只记录事件发生过，不投递、不动手，也不写「判断」——
        // 没做的决定没有可记的内容（写了就是把「没判断」伪装成「判断过」）。
        return { verdict, threadId: thread.id, matchedRule: 'direct-through', decision: null, ticketId, delivery };
      }
      if (delivery === 'record-only') {
        // observe：记下「本会接」但不叫醒。`wouldAccept: true` 是这句记录的
        // 全部信息量 —— 人回看时能回答「他当时会怎么做」。
        const decision = {
          action: 'ignore' as const,
          threadRef: input.ref,
          reason: `自主档位为 observe：已记录判断，未执行（若为 auto 则会接这条事件）`,
          wouldAccept: true,
        };
        this.record(input.triggerId, thread.id, decision, undefined, 'autonomy-gate');
        return { verdict, threadId: thread.id, decision, matchedRule: 'direct-through', ticketId, delivery };
      }

      // auto / trusted：叫醒。两者在「要不要做」上一致，差别只在要不要逐次登记 ——
      // 而这差别由动作侧（action-gate / 审计）承担，不在这里伪造。
      this.notifyWake(input);
      return { verdict, threadId: thread.id, matchedRule: 'direct-through', decision: null, ticketId, delivery };
    }

    const { decision, matchedRule } = this.decisionFor(verdict, input, thread.id);
    this.record(input.triggerId, thread.id, decision, matchedRule, 'gate');
    this.notifyWake(input);
    return { verdict, threadId: thread.id, decision, matchedRule };
  }

  /** Gate 规则 1–5 的唯一计算点（纯函数 + 两个只读查询）。 */
  private gateFor(input: RouteInput, subscriptions: SubscriptionLike[]): GateVerdict {
    return gateVerdict(input.kind, {
      alreadyHandled: this.deps.dispositions.countByTrigger(input.triggerId) > 0,
      actorKind: input.actorKind,
      addressing: input.addressing,
      hasOwner: subscriptions.some(s => s.purpose === 'own'),
      hasSubscriptions: subscriptions.length > 0,
      threadEnded: !!input.threadEnded,
      entityRef: input.entityRef,
      directTargetAgentId: input.directTargetAgentId,
    });
  }

  /**
   * **只读投影**：问「这条事件若真的走 router，会得到什么结论」，**不产生任何副作用**
   * （不 upsert 流、不写处置、不唤醒、不调研判引擎）。
   *
   * 为什么需要它：进程内事件（chat / task 评论 / a2a）已经在写时间线，但还**没有**走
   * router。切换之前必须能回答「切了会变成什么」，否则切换就是一次没有数据的赌博。
   *
   * 为什么复用 `gateFor` / `decisionFor` 而不是自己再写一遍判断：影子判定若与真路由
   * 是两份实现，「预告」与「实际」必然分叉 —— 那时这个埋点的全部价值就是负的。
   *
   * 返回 `null` = 这条流还不存在（调用方应先 ensureThread；观测不负责造对象，H1）。
   * `needsAssessment: true` = 会进入 LLM 研判段，影子模式**不代跑**（会烧钱且不可复现）。
   */
  previewRoute(input: RouteInput): RoutePreview | null {
    const thread = this.deps.threads.getByRef(input.ref);
    if (!thread) return null;
    const subscriptions = this.deps.threads.listSubscriptions(thread.id);
    const verdict = this.gateFor(input, subscriptions);

    if (verdict === 'duplicate') {
      return { verdict, threadId: thread.id, matchedRule: 'duplicate' };
    }
    if (verdict === 'direct-through') {
      const ticketId = subscriptions[0]?.ticketId ?? thread.id;
      const gate = this.deliveryForOwner(input.ref, subscriptions);
      return { verdict, threadId: thread.id, matchedRule: 'direct-through', ticketId, delivery: gate?.delivery };
    }
    if (verdict === 'assess') {
      // 唯一不代算的分支：规则 6 要调研判引擎，影子模式没有可复现的答案，只报告「会走到这里」。
      return { verdict, threadId: thread.id, matchedRule: 'assess', needsAssessment: true };
    }
    // dispatch / attach / ignore-ended：`decisionFor` 这三个分支不触碰 assessment（有测试守着零调用），
    // 所以它们在这里是纯的，可以直接复用同一份产出。
    const { decision, matchedRule } = this.decisionFor(verdict, input, thread.id);
    return { verdict, threadId: thread.id, matchedRule, decision };
  }

  /**
   * 事件已落库 → 通知在等它的 rest。
   *
   * 幂等命中（duplicate）不通知：那个事件已经被处置过，再叫醒一次就是重复劳动。
   * 只传摘要，不传正文：C2.2 要求「拿到新事件摘要而非重读全部历史」。
   */
  private notifyWake(input: RouteInput): void {
    if (!this.deps.onWake) return;
    this.deps.onWake({
      kind: 'trigger',
      threadRef: input.ref,
      summary: `${input.kind} 事件落到 ${input.ref}（actor=${input.actorKind}, addressing=${input.addressing}）`,
    });
  }

  /**
   * 落一条处置。`reason` 由 repo 强制非空（I4）—— 这里不兜底，
   * 因为「没有理由的处置」不该被静默补一句 `'n/a'` 混过去。
   *
   * `matchedRule`（命中的 Gate 规则）随处置一并落库 —— 这是「为什么走了这条」的
   * 机器可读载体（B1）。缺省 = 处置与 Gate 规则无关（外部直接写入）。
   */
  record(
    triggerId: string,
    threadId: string,
    decision: Disposition,
    matchedRule: MatchedRule | null | undefined = undefined,
    actor = 'router',
  ): boolean {
    return this.deps.dispositions.record({
      triggerId,
      threadId,
      action: decision.action,
      reason: decision.reason,
      matchedRule: matchedRule ?? undefined,
      wouldAccept: decision.action === 'ignore' ? decision.wouldAccept : undefined,
      actor,
      createdAt: this.now(),
    });
  }

  /**
   * Eval 的**单一决策点**：gate（规则 1–5，零 LLM）与 assessment（第 2 段 LLM 研判）
   * 的合并结论只在这里产生，并在一次 `record` 里连同 `matchedRule` 落库。
   *
   * 两层语义（B1）：
   *  - 命中 gate 规则（dispatch / attach / ignore-ended）→ `matchedRule` = 该规则 id，
   *    **不调用 assessment**（有行为测试用 spy 断言零调用）；
   *  - 未命中任何确定性规则（verdict==='assess'，规则 6）→ 进入 assessment：
   *      · 有引擎且 `decided:true` → 采用引擎的 disposition；
   *      · 无引擎 / 引擎 `decided:false` → **降级 needs-assessment**（保留 v1 现行为），
   *        不抛异常、不静默当 accept —— `matchedRule='assess'` + reason 指明原因。
   *
   * 「两者都缺」（无确定性规则命中 且 无研判结论）= 显式 needs-assessment 状态，
   * **不是默认放行**：改回「assess 直接当 accept」会被行为测试拉红。
   */
  private decisionFor(verdict: GateVerdict, input: RouteInput, threadId: string): { decision: Disposition; matchedRule: MatchedRule } {
    switch (verdict) {
      case 'dispatch':
        return {
          matchedRule: 'dispatch',
          decision: {
            action: 'dispatch',
            threadRef: input.ref,
            agentId: input.directTargetAgentId!,
            reason: `人已指定处理者 ${input.directTargetAgentId}，不研判`,
          },
        };
      case 'attach':
        return {
          matchedRule: 'attach',
          decision: { action: 'attach', threadRef: input.ref, ticketId: threadId, reason: `明确指向既有实体 ${input.entityRef}` },
        };
      case 'ignore-ended':
        return {
          matchedRule: 'ignore-ended',
          decision: {
            action: 'ignore',
            threadRef: input.ref,
            reason: `流已结束，${input.actorKind} 事件只留痕不唤醒（避免完成后再跑一轮）`,
            wouldAccept: false,
          },
        };
      case 'assess':
      default: {
        // 规则 1–5 全部未命中 → 第 2 段 assessment。
        const outcome = this.deps.assess?.({
          kind: input.kind,
          ref: input.ref,
          actorKind: input.actorKind,
          addressing: input.addressing,
          threadEnded: input.threadEnded,
          entityRef: input.entityRef,
          directTargetAgentId: input.directTargetAgentId,
        });
        if (outcome?.decided) {
          return { matchedRule: 'assess', decision: outcome.disposition };
        }
        // 无引擎 / 引擎判不了 → 显式降级 needs-assessment，不静默放行。
        const why = outcome && !outcome.decided ? outcome.reason : 'v1 无研判引擎';
        return {
          matchedRule: 'assess',
          decision: {
            action: 'ignore',
            threadRef: input.ref,
            reason: `needs-assessment：${why}，记录并延后（wouldAccept=true，便于灰度时回放）`,
            wouldAccept: true,
          },
        };
      }
    }
  }
}
