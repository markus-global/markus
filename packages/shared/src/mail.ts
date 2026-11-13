/**
 * 投递退信原因（第六刀 §2.5）—— 闭集，`drop_reason` 必填。
 *
 * 为什么要有这一层：旧实现把「没投进去」的信号写成 `dropped` 终态，真实库
 * ≥28621 行没有任何回声，人被静默丢弃。退信原因必须**结构化**（不是日志文本），
 * 否则概览无法按原因聚合，「一个没投进去的信号恰好出现一次、原因可查」这条
 * 判据就永远无法验证。
 *
 * 第 6 类 `dsn_bounce`（`MAILER-DAEMON` / DSN 退信）本刀**只预留枚举位**：
 * 形状定稿，但 C1 不产生、不发 DSN（§2.8 H8）。C10 接外部邮件时直接复用
 * `bounced → catch_all` 通道，避免将来临时加分支。判据见 {@link RESERVED_BOUNCE_REASONS}：
 * 预留位不在「可产生」集合里。
 *
 * 唯一事实源：主计划 §4.9.5 H8 / 执行文档 §2.5。
 */

/** 本刀可产生的五类退信原因（投递状态机 C3 的写值域）。 */
export const ACTIVE_BOUNCE_REASONS = [
  'unresolved_address',
  'no_active_target',
  'lease_expired',
  'duplicate_message_id',
  'stale_signal',
] as const;

/** 预留位：形状已定，本刀不得产生（C10 接外部邮件时才启用）。 */
export const RESERVED_BOUNCE_REASONS = ['dsn_bounce'] as const;

export type ActiveBounceReason = (typeof ACTIVE_BOUNCE_REASONS)[number];
export type ReservedBounceReason = (typeof RESERVED_BOUNCE_REASONS)[number];

/** 六类原因的闭集（持久化列 `mailbox_items.drop_reason` 的取值域）。 */
export type BounceReason = ActiveBounceReason | ReservedBounceReason;

export const BOUNCE_REASONS: readonly BounceReason[] = Object.freeze([
  ...ACTIVE_BOUNCE_REASONS,
  ...RESERVED_BOUNCE_REASONS,
]);

/** 窄化守卫：写库前用它校验，避免把自由文本写进结构列。 */
export function isBounceReason(value: string): value is BounceReason {
  return (BOUNCE_REASONS as readonly string[]).includes(value);
}

/** 本刀允许产生的原因（`dsn_bounce` 被显式排除，而不是靠调用方自觉）。 */
export function isActiveBounceReason(value: string): value is ActiveBounceReason {
  return (ACTIVE_BOUNCE_REASONS as readonly string[]).includes(value);
}

// ─── 投递信封（第六刀 §2.1，H1/H5/H6） ───────────────────────────────────────
//
// 为什么要有信封：旧实现里「这条信号是谁发给谁的」只存在于 `payload.extra`
// 与几个 `sourceType === '…'` 分支的**推断**里。R3' 的教训是结构不能从载荷推断：
// 载荷是内容，结构是身份。信封把身份第一次写成可查询的列（`mailbox_items.envelope`），
// 路由只读它。
//
// 本卡只落**形状**：不实现外部邮件的收发与 SPF/DKIM/DMARC 校验（H5/H6），
// `auth` / `replyTo` 是预留槽位，恒为 null；`workUnitRef` 恒 null（C7 才有写者）。

import type { AddressRef, MailAddressRef } from './address.js';
import { agentAddressRef, platformAddressRef } from './address.js';

/** 六类信号类别（一列可聚合，不再靠 sourceType 字符串现场归类）。 */
export type SignalClass = 'chat' | 'a2a' | 'callback' | 'governance_event' | 'record' | 'system';

/**
 * 投递意图 —— 从 `payload.extra.triggerExecution` / `extra.actionRequired`
 * 两个布尔推断里提上来的**结构字段**（§2.1 四条硬规则第 3 条）。
 *
 * - `deliver`            —— 只是送达（信息类；不欠动作）
 * - `trigger_execution`  —— 真跑活（任务执行；权威态，不得 defer/drop/merge）
 * - `action_required`    —— 欠一个动作（需求/工作流收尾；同样权威）
 */
export type MailboxIntent = 'deliver' | 'trigger_execution' | 'action_required';

/** 权威态判据：只有一种写法，别处不得再各判一次。 */
export function isAuthoritativeIntent(intent: MailboxIntent | undefined): boolean {
  return intent === 'trigger_execution' || intent === 'action_required';
}

/**
 * 信封 `auth` 槽位（预留，H5）。本卡恒为 null —— 形状先定，C10 接外部邮件时才写值。
 * 保留成可判别形状（而不是 `unknown`）是为了让「有没有验证过」在类型上无法被忽略。
 */
export interface EnvelopeAuth {
  spf: 'pass' | 'fail' | 'none';
  dkim: 'pass' | 'fail' | 'none';
  dmarc: 'pass' | 'fail' | 'none';
}

/**
 * 投递信封 —— 每条入站信号的身份头。持久化到 `mailbox_items.envelope`（JSON）。
 *
 * 唯一形状写者是 {@link buildDeliveryEnvelope}；任何模块都不得手写这个对象字面量
 * （否则「信封长什么样」立刻有两个答案）。
 */
export interface DeliveryEnvelope {
  /** 谁发的。`kind='external'` 时地址原样保存，身份未验证。 */
  from: AddressRef;
  /** 发给谁。收件方身份由投递点给出（agent / im / markus 地址）。 */
  to: AddressRef;
  /** 展示用摘要（不参与路由，不参与去重）。 */
  subject: string;
  /**
   * 平台内唯一 id（外部邮件 = RFC Message-ID）。**幂等身份**：
   * 同一 `(agent, messageId)` 第二次投递 → `duplicate_message_id` 退信（V5）。
   * 由投递点提供；缺省用 platform 生成的 `mbx_*`（永不自撞）。
   */
  messageId: string;
  /** 投递意图（结构化，不再从 payload.extra 推断）。 */
  intent: MailboxIntent;
  /** 信号类别（由 sourceType 经 `routeMailboxItem()` 的单一映射得出）。 */
  signalClass: SignalClass;
  /** 预留（H5）：本卡恒 null。 */
  auth: EnvelopeAuth | null;
  /** 预留（H6）：本卡恒 null。 */
  replyTo: MailAddressRef | null;
  /** 预留（C7）：本卡恒 null —— 本卡只加列不建引用，避免先有引用后有实体。 */
  workUnitRef: string | null;
  /** 因果链（In-Reply-To / References 的等价物）。只读，**不参与路由/去重**。 */
  externalThreadRef: string | null;
  /**
   * `from` 的身份是否已验证。只有 `kind='external'` 有意义，且本卡恒 false ——
   * 外部字符串绝不被当成内部身份（H1）。
   */
  fromVerified: boolean;
}

/** 信封构造输入：投递点只需要提供它真正知道的那几件事。 */
export interface DeliveryEnvelopeInput {
  from: AddressRef;
  to: AddressRef;
  messageId: string;
  signalClass: SignalClass;
  intent?: MailboxIntent;
  subject?: string;
  externalThreadRef?: string | null;
  fromVerified?: boolean;
}

/**
 * **唯一**信封形状写者。纯函数：同一输入 → 同一字节序列（可缓存、可断言）。
 *
 * 预留槽位在这里一次性补 null，而不是「缺省就省略字段」——省略会让 JSON 形状随
 * 输入变化，读侧就得为每种形状写一个分支（两种形状 = 两个解析器 = 两份事实）。
 */
export function buildDeliveryEnvelope(input: DeliveryEnvelopeInput): DeliveryEnvelope {
  return {
    from: input.from,
    to: input.to,
    subject: input.subject ?? '',
    messageId: input.messageId,
    intent: input.intent ?? 'deliver',
    signalClass: input.signalClass,
    auth: null,
    replyTo: null,
    workUnitRef: null,
    externalThreadRef: input.externalThreadRef ?? null,
    fromVerified: input.fromVerified ?? false,
  };
}

/**
 * 读侧归一：持久化行里的 envelope 可能是历史形状或坏 JSON。
 *
 * 旧行（`envelope IS NULL`）= 无信封 → 返回 `undefined`，调用方 `warn` 并回退到
 * `agent_id`。**绝不**在这里编造一个「看起来合法」的信封：那会把「历史数据没带
 * 身份」这件事永久抹掉。
 */
export function parseEnvelope(raw: string | null | undefined): DeliveryEnvelope | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<DeliveryEnvelope> | null;
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (!parsed.from || !parsed.to || typeof parsed.messageId !== 'string') return undefined;
    return {
      from: parsed.from,
      to: parsed.to,
      subject: typeof parsed.subject === 'string' ? parsed.subject : '',
      messageId: parsed.messageId,
      intent: parsed.intent ?? 'deliver',
      signalClass: parsed.signalClass ?? 'system',
      auth: parsed.auth ?? null,
      replyTo: parsed.replyTo ?? null,
      workUnitRef: parsed.workUnitRef ?? null,
      externalThreadRef: parsed.externalThreadRef ?? null,
      fromVerified: parsed.fromVerified === true,
    };
  } catch {
    return undefined;
  }
}

/**
 * 平台自身产生的信号（心跳 / 日报 / 系统事件）的 `from`。
 *
 * `noreply` 在平台保留字闭集里，所以 `platformAddressRef` 必然成功；这里断言
 * 而不是兜底一个 `agent:system` —— 平台信号不是 agent 发的，把它记成 agent 会让
 * 「谁触发的」在审计里永远查不清。
 */
export function platformOriginRef(): AddressRef {
  const ref = platformAddressRef('noreply');
  if (!ref) throw new Error('noreply must be a reserved platform address');
  return ref;
}

/** 平台内 agent 作为 `from` 的便捷入口（转发到唯一构造点）。 */
export { agentAddressRef };
