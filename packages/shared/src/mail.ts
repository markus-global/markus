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
