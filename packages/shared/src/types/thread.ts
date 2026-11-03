/**
 * Thread / Trigger / Router 的对象层（纯类型 + 纯函数，零 IO）。
 *
 * 设计依据：《Markus × Super-agent 分析与目标设计》§7。
 * 三条关键取舍（v1.5 奥卡姆审查后）：
 *  1. `ThreadRef` 是**字符串命名空间键**，不是枚举——加一个平台不需要改核心类型；
 *  2. `SourceAdapter` 是**注册表**（见 event-source.ts），核心不枚举来源；
 *  3. 只有 `ThreadStage` 与 `Autonomy` 是闭集——它们必须被编译器和 UI 穷举。
 */

// ─────────────────────────────────────────────────────────────
// 轴 2：它属于哪条流
// ─────────────────────────────────────────────────────────────

/**
 * 流的实体命名空间键。一套命名空间，不是分类法。
 * 既有实体直接用平台 id（`tsk_…` / `req_…` / `cs_…` / `agt_…`），
 * 外部资源用注册过的前缀（`gh:owner/repo` / `xhs:brand_01` / `rss:competitor-a`）。
 */
export type ThreadRef = string;

/** 解析命名空间键。无前缀（如 `tsk_7f3a`）返回 null——它本身就是平台 id。 */
export function parseThreadRef(ref: string): { prefix: string; local: string } | null {
  const i = ref.indexOf(':');
  if (i <= 0 || i === ref.length - 1) return null;
  return { prefix: ref.slice(0, i), local: ref.slice(i + 1) };
}

/** 归一化实体键：唯一入口，保证「同一个实体永远产出同一个字符串」。 */
export function threadRefOf(entityRef: string): ThreadRef {
  const trimmed = entityRef.trim();
  if (!trimmed) throw new Error('THREAD_REF_EMPTY: entity ref must be non-empty');
  return trimmed;
}

/** 前缀是否属于某个已注册适配器（由调用方传入注册表，纯函数便于测试）。 */
export function hasRegisteredPrefix(ref: ThreadRef, prefixes: readonly string[]): boolean {
  const parsed = parseThreadRef(ref);
  if (!parsed) return true; // 平台内置 id，不需要前缀注册
  return prefixes.includes(parsed.prefix);
}

// ─────────────────────────────────────────────────────────────
// 轴 3：它在等谁（派生，不存储）—— 唯一合法的闭集之一
// ─────────────────────────────────────────────────────────────

export type ThreadStage =
  | 'person:approval' // 等人批
  | 'person:answer' // 等人回话
  | 'person:review' // 等人验收
  | 'person:blocked' // 等人解锁
  | 'system:queued' // 排队等资源
  | 'idle' // 回合结束、等事件
  | 'working'; // 正在跑

export interface StageFacts {
  pendingApproval: boolean;
  openQuestion: boolean;
  submittedReview: boolean;
  /** 自上次人类介入以来报过阻塞 */
  reportedBlockedSinceHuman: boolean;
  assignment?: { state: 'pending' | 'running' | 'ended' };
}

/** 第一个命中胜出，顺序即优先级。零写者、零竞态。 */
export function deriveStage(f: StageFacts): ThreadStage {
  if (f.pendingApproval) return 'person:approval';
  if (f.openQuestion) return 'person:answer';
  if (f.submittedReview) return 'person:review';
  if (f.reportedBlockedSinceHuman) return 'person:blocked';
  if (f.assignment?.state === 'pending') return 'system:queued';
  if (!f.assignment || f.assignment.state === 'ended') return 'idle';
  return 'working';
}

/** 「在等人」的四类 stage，顺序即 UI 排序。 */
export const PERSON_STAGES = ['person:approval', 'person:answer', 'person:review', 'person:blocked'] as const;

export function isPersonStage(stage: ThreadStage): boolean {
  return stage.startsWith('person:');
}

/** Inbox 排序键：小的在前。 */
export function stageSortRank(stage: ThreadStage): number {
  switch (stage) {
    case 'person:approval':
      return 0;
    case 'person:answer':
      return 1;
    case 'person:review':
      return 2;
    case 'person:blocked':
      return 3;
    case 'system:queued':
      return 4;
    case 'working':
      return 5;
    case 'idle':
      return 6;
  }
}

// ─────────────────────────────────────────────────────────────
// 轴 1：事件从哪来（审计标签，不参与派发）
// ─────────────────────────────────────────────────────────────

export type TriggerKind =
  | 'chat'
  | 'im'
  | 'a2a'
  | 'task'
  | 'requirement'
  | 'external'
  | 'schedule'
  | 'system';

export type ActorKind = 'human' | 'agent' | 'bot' | 'system';
export type Addressing = 'direct' | 'mention' | 'ambient';

export interface Trigger {
  id: string;
  kind: TriggerKind;
  /** 幂等键：同一来源同一事件只进一次 */
  idempotencyKey: string;
  /** 归属的流（Source 的解析规则产出，可能多个） */
  threads: ThreadRef[];
  actor: { kind: ActorKind; id: string; name?: string };
  addressing: Addressing;
  content: { summary: string; body: string; refs?: string[]; attachments?: string[] };
  receivedAt: number;
}

// ─────────────────────────────────────────────────────────────
// 一次路由的**处置**（disposition）：唯一审计事实
//
// 原名 `RouteDecision`（2026-11-03 改名，见 docs/architecture/concept-naming.md）。
// 为什么改：`Decision` 当时同时被邮箱的注意力仲裁用着，一个名字指两件事。
// 新名字与它落库的地方同名 —— `thread_dispositions` 一行 = 一次处置，
// 这样「决定」与「记录」不再有两种叫法。旧名只在历史说明里出现。
//
// 顺带删除零引用的 `RouteAction`：动作标签已由本联合类型的 `action` 字段穷举表达，
// 留一个没人用的同步枚举 = 第二个写者。
// ─────────────────────────────────────────────────────────────

export type Disposition =
  | { action: 'accept'; threadRef: ThreadRef; newThread?: boolean; ticketId?: string; reason: string }
  | { action: 'attach'; threadRef: ThreadRef; ticketId: string; reason: string }
  | { action: 'dispatch'; threadRef: ThreadRef; agentId: string; sessionId?: string; reason: string }
  | { action: 'stop'; threadRef: ThreadRef; ticketId: string; reason: string }
  | { action: 'ignore'; threadRef: ThreadRef; reason: string; wouldAccept?: boolean }
  | { action: 'defer'; threadRef: ThreadRef; until: number; reason: string };

// ─────────────────────────────────────────────────────────────
// 责任域：agent 能被指派「负责」的资源（仓库只是其中一种）
// ─────────────────────────────────────────────────────────────

/** 一条按「可撤回性」排序的轴：可见性 × 撤回来有多难。 */
export type ResourceScope = 'read' | 'draft' | 'publish' | 'admin';

export const SCOPE_RANK: Record<ResourceScope, number> = { read: 0, draft: 1, publish: 2, admin: 3 };
export const RESOURCE_SCOPES: readonly ResourceScope[] = ['read', 'draft', 'publish', 'admin'];

/** 「最高档」= admin；同一资源同一时刻只能有一个这样的负责人。 */
export const L3_SCOPE: ResourceScope = 'admin';

export function isScope(value: string): value is ResourceScope {
  return (RESOURCE_SCOPES as readonly string[]).includes(value);
}

export function scopeAtLeast(actual: ResourceScope, required: ResourceScope): boolean {
  return SCOPE_RANK[actual] >= SCOPE_RANK[required];
}

/** 自主档位：与 scope 正交（scope 是「允许到哪」，autonomy 是「不问就做还是先报」）。 */
export type Autonomy = 'off' | 'observe' | 'auto' | 'trusted';

export const AUTONOMIES: readonly Autonomy[] = ['off', 'observe', 'auto', 'trusted'];
export const AUTONOMY_RANK: Record<Autonomy, number> = { off: 0, observe: 1, auto: 2, trusted: 3 };

/**
 * 升到 auto 及以上需要人批准；off/observe 可自助。
 *
 * ⚠️ 这是**授权闸门**（能不能升到这个档，一次性），不是执行闸门。
 * 执行前置的是 `gateAction`——两者长期被混为一谈，是 B2.1 一直验不了的原因之一。
 */
export function autonomyNeedsApproval(target: Autonomy): boolean {
  return AUTONOMY_RANK[target] >= AUTONOMY_RANK.auto;
}

/** 一次动作的结局。`record-only` = 记下判断但不执行（设计里的 would-accept）。 */
export type ActionVerdict = 'allow' | 'record-only' | 'deny';

/**
 * **执行前闸门**：给定「这个动作有多难撤回」(scope) 和「我被授权到什么程度」(autonomy)，
 * 决定这一次该放行、只记录、还是拒绝。
 *
 * 语义来源：设计文档 §7.8 四档表 + 两条硬约束
 * （默认 observe；「合 main / 发版 / 删数据」在任何档位都不可自主）。
 *
 * 与 `autonomyNeedsApproval` 的分工：
 *   autonomyNeedsApproval → 「能不能升到这个档」   （授权，一次性）
 *   gateAction            → 「这个档能不能做这个动作」（执行，每次）
 *
 * 为什么 admin 不交给任何一个档位：红线是**平台不变量**，不是档位参数。
 * 一旦它变成可配置项，就迟早会有人把它打开。
 */
export function gateAction(scope: ResourceScope, autonomy: Autonomy): ActionVerdict {
  // 红线：admin（删数据 / 合 main / 发版 / 改他人绑定）——任何档位都不可自主。
  if (scope === 'admin') return 'deny';

  switch (autonomy) {
    case 'off':
      // 连读都不行：off 的定义是「只记录事件，不投递、不动手」。
      return 'deny';
    case 'observe':
      // 读可以，其余只记录判断不执行（observe = 看得到、提建议、不代你动手）。
      return scope === 'read' ? 'allow' : 'record-only';
    case 'auto':
    case 'trusted':
      // 非红线动作上两者都是放行；它们的差别在「事后登记 vs 不逐次登记」，
      // 不在能不能做。把差别写在这里会变成第三轴，而它不是一个轴。
      return 'allow';
  }
}

export interface ResourceBinding {
  id: string;
  holder: { kind: 'agent' | 'team'; id: string };
  /** 命名空间键；前缀必须是已注册适配器 */
  resource: ThreadRef;
  scope: ResourceScope;
  autonomy: Autonomy;
  since: number;
  grantedBy: { kind: 'human' | 'agent'; id: string };
}

// ─────────────────────────────────────────────────────────────
// 四档在「要不要叫醒这个人」上的投影
// ─────────────────────────────────────────────────────────────

/**
 * 一次投递的结局。
 *  · `deliver`     叫醒他，他会动手
 *  · `record-only` 记下「本会接、但没动手」，不叫醒（= 设计里的 would-accept）
 *  · `drop`        连判断都不记（off 的定义是「只记录事件，不投递、不动手」——
 *                  注意它记的是**事件**，不是**判断**：没做的决定没有可记的内容）
 */
export type DeliveryDecision = 'deliver' | 'record-only' | 'drop';

/**
 * **投递前闸门**：给定自主档位，决定这次要不要把事件交到人手里。
 *
 * 与 `gateAction(scope, autonomy)` 的分工（两者都不许省）：
 *   gateAction  → 「这个档位能不能做**这个动作**」（动作级，看 scope 有多难撤回）
 *   deliveryFor → 「这个档位要不要**被打扰**」（投递级，看要不要叫醒他去判断）
 *
 * 为什么不合并成一个：投递发生在动作之前，此时还不知道他会想做什么，
 * 也就没有 scope 可传。硬要合并，只能给投递编一个假 scope ——
 * 那会让「读一条消息」和「删一个项目」在同一个入参上无法区分。
 *
 * 语义来源：设计 §7.8 四档表 —— off(never act) / observe(record, do not act) /
 * auto(act, then report) / trusted(act silently)。
 */
export function deliveryFor(autonomy: Autonomy): DeliveryDecision {
  switch (autonomy) {
    case 'off':
      return 'drop';
    case 'observe':
      return 'record-only';
    case 'auto':
    case 'trusted':
      return 'deliver';
  }
}

/**
 * auto 与 trusted 的唯一差别：要不要**逐次**登记。
 *
 * 为什么单独一个函数而不是塞进 gateAction：设计原文说得很清楚 ——
 * 「它们的差别在事后登记 vs 不逐次登记，不在能不能做」。
 * 把这条差别塞进「能不能做」那个函数，就凭空多出第三根轴。
 */
export function auditsEveryAction(autonomy: Autonomy): boolean {
  return autonomy === 'auto';
}

// ─────────────────────────────────────────────────────────────
// 优先级：从「类型的属性」变成「规则的函数」
// ─────────────────────────────────────────────────────────────

export interface PriorityInput {
  kind: TriggerKind;
  actorKind: ActorKind;
  addressing: Addressing;
  stage?: ThreadStage;
}

/** 数字小者优先。人永远第一。 */
export function triggerPriority(i: PriorityInput): number {
  if (i.kind === 'chat' && i.actorKind === 'human') return 0;
  if (i.stage && isPersonStage(i.stage)) return 1;
  if (i.kind === 'a2a' && i.addressing === 'direct') return 1;
  if (i.kind === 'external') return 2;
  if (i.kind === 'schedule') return 4;
  return 3;
}

// ─────────────────────────────────────────────────────────────
// Gate：第 1 层确定性规则（零 LLM）
// ─────────────────────────────────────────────────────────────

export type GateVerdict =
  | 'duplicate' // 幂等命中 → 丢弃
  | 'dispatch' // 人已指定目标 → 直接投递，不研判
  | 'direct-through' // 命中已有主/订阅 → 直通，不产生 Decision
  | 'attach' // 明确指向既有实体 → 挂到那条流
  | 'ignore-ended' // 已结束的卡 + 非人事件 → 只记录，不唤醒
  | 'assess'; // 判不了 → 延后（v1 记录 reason，不上 LLM）

export interface GateFacts {
  alreadyHandled: boolean;
  actorKind: ActorKind;
  addressing: Addressing;
  hasOwner: boolean;
  hasSubscriptions: boolean;
  threadEnded: boolean;
  entityRef?: ThreadRef;
  directTargetAgentId?: string;
}

/**
 * 顺序即语义，不可重排：
 * 幂等 → 已结束 → 人指定 → 直通 → 挂载 → 待研判。
 *
 * 两个写死的细节（实测踩出来的）：
 *  - `mention` 必须算 explicit，否则 GitHub/IM 上每条 @bot 都会被送去研判；
 *  - 人指定目标优先于直通，因为「人已经说了找谁」比「这条流有主」更强。
 */
export function gateVerdict(kind: TriggerKind, f: GateFacts): GateVerdict {
  if (f.alreadyHandled) return 'duplicate';
  if (f.threadEnded && f.actorKind !== 'human') return 'ignore-ended';
  if ((f.addressing === 'direct' || f.addressing === 'mention') && f.actorKind === 'human' && f.directTargetAgentId) {
    return 'dispatch';
  }
  if (f.hasOwner || f.hasSubscriptions) return 'direct-through';
  if (f.entityRef) return 'attach';
  return 'assess';
}

/** 幂等键兜底：某些来源给不出事件 id 时，用内容哈希 + 时间窗。 */
export function contentHashIdempotencyKey(kind: TriggerKind, subject: string, windowMs = 60_000, now = Date.now()): string {
  const bucket = Math.floor(now / windowMs);
  let h = 2166136261;
  const s = `${kind}|${subject}|${bucket}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${kind}:hash:${(h >>> 0).toString(36)}`;
}
