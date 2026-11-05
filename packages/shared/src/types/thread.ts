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
// 授权：逐件事的 Mandate × 逐资源的 ResourceBinding
//
// 两种「授权」长期被混为一路（A4），而它们在回答**两个不同的问题**：
//
//   | 概念              | 回答                                   | 粒度   |
//   | ----------------- | -------------------------------------- | ------ |
//   | Mandate（审批）    | 这**一件事**能不能做                    | 逐件事 |
//   | ResourceBinding   | 在这块地上我能**自主到什么程度**        | 逐资源 |
//
// 混用的两个方向都必须被拒，且都必须有可行动提示：
//   ① autonomy=trusted 但这件事没批 → 不得当成已批准（"我权限大" ≠ "这件事批了"）
//   ② 这件事批了但 binding=observe → 不得越过 observe 上限（"批了" ≠ "我有这个权")
//
// **为什么判定顺序是 先 binding(scope) → 再 autonomy → 最后 mandate**：
// binding 是能力上限，mandate 是单次许可。反序（先问审批）会让人去批一件
// 他根本授权不到的事 —— 白花人的注意力，而注意力是这套平台最贵的资源（Q4）。
// 顺序在这一处写死，调用方无从选择，也就无从漂移。
//
// **I5（直通不改变授权）为什么在结构上成立**：本函数的入参里**没有**
// 「这个事件是直通来的 / 是研判来的」这一位。想让直通减免授权，必须先改签名
// —— 那是评审看得见的改动，不可能顺手做掉。
// ─────────────────────────────────────────────────────────────

/**
 * 一件事的审批状态（mandate）。
 *
 * 刻意**不是**闭集枚举的第二个写者：它直接对应 `approvals.status` 的既有取值
 * （pending / approved / rejected / expired），只把 rejected 收敛成 denied ——
 * 因为在「能不能做」这个问题上，被拒和过期是同一个答案。
 */
export type MandateState = 'none' | 'pending' | 'approved' | 'denied';

/**
 * 逐件事许可（Mandate）在审批行上的**结构判据**：`details.resource` 与
 * `details.actionScope` 同时存在。
 *
 * 为什么不用一个新的 `approvals.type` 枚举值：那个联合类型是 UI 面（标签、i18n、
 * 渲染分支）的输入，为一张新单子加一个枚举值会牵动一整条渲染链；而"这张单是给
 * 哪块地上的哪一档动作签的字"这件事，本来就已经被两个 details 字段**唯一**表达。
 * 判据留在数据里，不新增概念。
 */


/** 判定结论的机器可读原因。人话在 `reason` / `hint` 里。 */
export type AuthorizationCode =
  /** 放行 */
  | 'allowed'
  /** 没有绑定：这块地你根本没有授权（缺 binding） */
  | 'no-binding'
  /** 动作超出绑定授予的 scope 上限（缺档位） */
  | 'above-binding-scope'
  /** autonomy=off：连读都不做 */
  | 'autonomy-off'
  /** autonomy=observe：只记录判断，不执行 */
  | 'autonomy-observe'
  /** 红线动作（L3/admin），必须有人为**这一件事**签字，而当前没有 */
  | 'mandate-required'
  /** 审批还在等人 */
  | 'mandate-pending'
  /** 审批被拒/过期 */
  | 'mandate-denied';

export interface AuthorizationQuery {
  /**
   * 逐资源：该 agent 在这块地上的绑定。
   * `null` = 没有绑定 —— 没有授权空间（不是「默认放行」）。
   */
  binding: { scope: ResourceScope; autonomy: Autonomy } | null;
  /** 这一件事的动作有多难撤回（由 `classifyToolAction` / 调用方给出） */
  actionScope: ResourceScope;
  /** 逐件事：这一件事的审批状态 */
  mandate: MandateState;
  /** 仅用于拼可行动提示（不参与判定） */
  resource?: ThreadRef;
  /** 谁有权批（人名/角色），仅用于提示「需要谁批」 */
  approver?: string;
}

export interface AuthorizationResult {
  /**
   * `allow` 执行 / `record-only` 记下"本会做"但不做（would-accept）/
   * `deny` 拒绝。
   *
   * `record-only` 也是**拒绝执行**：observe 档的语义正是「看得到、提建议、不代你动手」，
   * 所以它不能返回 allow；但它也不能返回 deny —— 那会把设计要求的 would-accept
   * 记录一起丢掉（§7.8）。
   */
  verdict: 'allow' | 'record-only' | 'deny';
  code: AuthorizationCode;
  /** 为什么（人话；I4 的同一精神：没有理由的判定等于没有审计） */
  reason: string;
  /** 可行动提示：缺谁批 / 缺哪个档位。deny 与 record-only 必有。 */
  hint?: string;
}

/**
 * **唯一判定点**：某 agent 现在能不能对某资源执行某动作。
 *
 * 唯一事实源的分工（三者各占一个入参位，任何两者合并都编译不过）：
 *   · `actionScope`  ← `classifyToolAction()`（动作多难撤回）
 *   · `binding`      ← `resource_bindings` 一行（逐资源上限 + 自主档）
 *   · `mandate`      ← `approvals` 一条（逐件事批没批）
 *
 * 中间那层的档位语义不在这里重写，直接调用 `gateAction` —— 否则就是
 * 第二个「四档语义」写者。
 */
export function authorizeAction(q: AuthorizationQuery): AuthorizationResult {
  const where = q.resource ? `资源 ${q.resource}` : '该资源';
  const who = q.approver ?? '人';

  // ① 逐资源上限：没有绑定 = 没有授权空间。
  //    「没绑定」绝不等于「默认允许」—— 默认值是 observe（§7.8），而 observe
  //    至少还要一条绑定才谈得上"负责这块地"。
  if (!q.binding) {
    return {
      verdict: 'deny',
      code: 'no-binding',
      reason: `${where} 上没有这个 agent（或它的团队）的责任域绑定，因此没有任何授权空间。`,
      hint: `缺 binding：先用 resource_bind 声明负责 ${where} 到哪一档（read/draft/publish），再谈能不能做。`
        + '没有绑定时的默认不是 observe 而是「无授权」，所以不能靠「应该没事」开工。',
    };
  }

  // ② 动作是否在绑定授予的档位之内（逐资源上限）。
  //    这一句是此前完全缺失的一半：`gateAction` 只吃 autonomy，不看 binding.scope，
  //    于是「绑定只给到 read、autonomy=auto」会放行 publish。
  if (!scopeAtLeast(q.binding.scope, q.actionScope)) {
    return {
      verdict: 'deny',
      code: 'above-binding-scope',
      reason: `${where} 的绑定只到 ${q.binding.scope} 档，而这个动作是 ${q.actionScope} 档 —— 越过逐资源上限。`
        + 'autonomy 再高也不能越过它：autonomy 回答「不问就做还是先报」，不回答「允许到哪一档」。',
      hint: `缺档位：请 ${who} 把 ${where} 的绑定从 ${q.binding.scope} 升到 ${q.actionScope}（或更高），`
        + '或者把这件事交给已持有该档位的人。不要用换工具名、拆步骤的方式绕过。',
    };
  }

  // ③ 自主档位 × 动作：语义只在 gateAction 一处，这里不重写。
  const autonomyVerdict = gateAction(q.actionScope, q.binding.autonomy);
  if (autonomyVerdict === 'deny') {
    // gateAction 对 admin 恒 deny —— 放行只能来自逐件事的审批（见 ④）。
    // 若这是 admin，走 mandate 分支；否则是 autonomy=off。
    if (q.actionScope !== L3_SCOPE) {
      return {
        verdict: 'deny',
        code: 'autonomy-off',
        reason: `${where} 的自主档位是 off：只记录事件，不投递、也不动手。`,
        hint: `请 ${who} 把 autonomy 从 off 升到至少 observe（升到 auto/trusted 需人批一次）。`,
      };
    }
  } else if (autonomyVerdict === 'record-only') {
    // ② 方向的反例守卫：**审批不能把 observe 抬上去**。
    // 这里刻意不看 mandate —— 即使这件事已经批了，observe 的上限仍然是"只记录"。
    return {
      verdict: 'record-only',
      code: 'autonomy-observe',
      reason: `${where} 的自主档位是 observe：本次只记录判断（would-accept），不执行 ${q.actionScope} 动作。`
        + (q.mandate === 'approved'
          ? '注意：这件事的审批已通过，但审批不改变逐资源上限 —— 它授的是「这件事可以做」，不是「这个 agent 可以自主做」。'
          : ''),
      hint: `要真正执行，需要两步且缺一不可：① ${who} 把 autonomy 升到 auto（升档需人批一次）；`
        + '② 这次动作本身仍需在档位允许范围内。只批其中一样都不够。',
    };
  }

  // ④ 逐件事：红线（L3/admin）动作在任何档位都不可自主 —— 只能靠 mandate。
  //    判断依据不是「新加一张红线表」，而是 gateAction 的推论：连 trusted 都过不去，
  //    说明拒绝来自动作本身（admin），不是来自授权不足。
  if (q.actionScope === L3_SCOPE) {
    switch (q.mandate) {
      case 'approved':
        return {
          verdict: 'allow',
          code: 'allowed',
          reason: `${q.actionScope} 档动作不可撤回，但${where}上这件事已由人批准。`,
        };
      case 'pending':
        return {
          verdict: 'deny',
          code: 'mandate-pending',
          reason: `${q.actionScope} 档动作需要人为**这一件事**签字，审批还在等（pending）。`,
          hint: `等 ${who} 在审批里给出结论；不要换写法重试同一件事 —— 那是绕过，不是推进。`,
        };
      case 'denied':
        return {
          verdict: 'deny',
          code: 'mandate-denied',
          reason: `${q.actionScope} 档动作的审批被拒（或已过期）。`,
          hint: `不要重复请求同一条。若确有新理由，先向 ${who} 说明新的依据，再重新发起审批。`,
        };
      case 'none':
        return {
          verdict: 'deny',
          code: 'mandate-required',
          reason: `${q.actionScope} 档动作（不可撤回 / 改规则本身）在**任何**自主档位都不可自主：`
            + `当前 autonomy=${q.binding.autonomy} 不构成批准 —— 「权限大」不等于「这件事批了」。`,
          hint: `需要 ${who} 为这一件事签字（Mandate）。请发起审批并说明：要做什么、为什么、影响范围、如何撤回。`
            + '这是逐件事的许可，不会被下次同类动作复用。',
        };
    }
  }

  // ⑤ 五条都过了：放行。
  return {
    verdict: 'allow',
    code: 'allowed',
    reason: `${where}：绑定 ${q.binding.scope}/${q.binding.autonomy} 覆盖本次 ${q.actionScope} 动作。`,
  };
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
  | 'assess'; // 判不了 → 进入 assessment（v1 无引擎时降级 needs-assessment）

/**
 * `matchedRule` = 一次处置命中的**哪条 Gate 规则**（契约 §5 六条，逐字对齐）。
 *
 * 与 `action`/`reason` 的分工：`action` 是「做了什么决定」，`reason` 是「人话为什么」，
 * `matchedRule` 是「哪一条确定性规则命中」——它是**可解释性**的机器可读载体，
 * 让 `SELECT matched_rule GROUP BY` 就能回答「Eval 为什么走了这条」（B1 的目标）。
 *
 * 每个值对应 §5 的一条规则：
 *  · duplicate        → 规则 1（幂等命中）
 *  · dispatch         → 规则 2（人已指定，不研判）
 *  · direct-through   → 规则 3（命中已订阅 Thread，直通不产生 Decision）
 *  · attach           → 规则 4（带 tsk_/req_/cs_ id 或资源键）
 *  · ignore-ended     → 规则 5（bot/CI 事件 + thread 已结束，只记录不唤醒）
 *  · assess           → 规则 6（其余 → 进入 assessment；未命中任何确定性规则）
 *
 * 「未命中任何规则」时 `assess` 作为兜底规则 id 仍被记录——这不是「命中了规则 6」，
 * 而是「规则 1–5 全部未命中，进入了第 2 段 assessment」，语义在「降级矩阵」文档里写死。
 */
export type MatchedRule = GateVerdict;

/** 六条规则各自的人话解释（用于 matchedRule 的可解释展示 / 审计可读化）。 */
export const MATCHED_RULE_LABEL: Record<MatchedRule, string> = {
  duplicate: '幂等命中：该事件已处置过',
  dispatch: '人已指定处理者，不研判',
  'direct-through': '命中已订阅 Thread，直通',
  attach: '明确指向既有实体，挂载',
  'ignore-ended': '流已结束 + 非人事件，只留痕不唤醒',
  assess: '规则 1–5 未命中，进入 assessment',
};

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
