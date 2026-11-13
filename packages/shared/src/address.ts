/**
 * 邮件地址标准 v1 —— 唯一写入点（formatAddress）与唯一解析器（parseAddress）。
 *
 * 契约：markus-master-refactor-plan-2026-11-11.md §4.9
 * 口子：markus-cut6-mailbox-address-design-2026-11-10.md §2.8（H1/H2/H12、A1–A4）
 *
 * 三条设计纪律：
 * 1. 结构不从载荷推断：点数决定命名空间（0 点平台 / 1 点组织 / ≥2 点保留），
 *    不靠猜内容，也不靠 split 后的启发式回退。
 * 2. 字符串 ≠ 身份：外部域地址原样保存为 opaque，绝不解析出 local / orgSlug；
 *    调用方必须另看信封上的 verified 才能当内部身份用。
 * 3. 越界时拒绝 + 给可行动提示，不静默改写（不大写转小写、不自动 slugify）。
 *
 * 本模块只定形状，不接收发、不建列、不碰 DNS。
 */

import type { BounceReason } from './mail.js';

/** 域名固定 apex，不按组织分子域（单条 MX / 单把 DKIM 密钥即可服务全部组织）。 */
export const MARKUS_MAIL_DOMAIN = 'markus.global';

/**
 * 平台级保留邮箱（0 个点）。已在生产/文档中使用的三个必须保留：
 * conduct@ / business@ / security@markus.global。
 * 这是闭集：组织不得绑定，也不得新造 0 点地址。
 */
export const PLATFORM_RESERVED_ADDRESSES: readonly string[] = Object.freeze([
  'conduct', 'business', 'security',
  'postmaster', 'abuse', 'hostmaster', 'webmaster',
  'info', 'marketing', 'sales', 'support',
  'noreply', 'no-reply', 'mailer-daemon', 'bounces',
  'dmarc', 'spf', 'dkim', 'tlsa',
]);

/** local 段保留字：平台名 + 运维/主机同名，避免「主机」与「邮箱」互相污染。 */
const LOCAL_RESERVED: ReadonlySet<string> = new Set([
  ...PLATFORM_RESERVED_ADDRESSES,
  'admin', 'root', 'all', 'team', 'everyone', 'system', 'platform', 'default',
  'catch-all', 'bounce', 'www', 'api', 'mail', 'smtp', 'imap', 'pop',
  'remote', 'hub', 'app', 'static', 'assets', 'cdn', 'markus', 'global',
]);

/** org 段保留字：与已有主机子域同名的一律禁用。 */
const ORG_RESERVED: ReadonlySet<string> = new Set([
  'www', 'api', 'mail', 'smtp', 'remote', 'hub', 'app', 'cdn',
  'default', 'system', 'platform', 'markus', 'global',
  'security', 'conduct', 'business',
]);

export const MAX_LOCAL_LENGTH = 32;
export const MAX_ORG_SLUG_LENGTH = 30;

/** 判别联合：信封 from/to 的形状（第六刀 H1），verified 由信封单独携带，不塞进地址对象。 */
export type AddressRef =
  | { kind: 'markus'; address: string; local: string; orgSlug: string }
  | { kind: 'platform'; address: string; local: string }
  | { kind: 'external'; address: string };

export type AddressRejectReason =
  | 'malformed'
  | 'invalid_label'
  | 'reserved_word'
  | 'unknown_platform_address'
  | 'team_level_reserved';

export type AddressResult =
  | { ok: true; value: AddressRef }
  | { ok: false; reason: AddressRejectReason; hint: string };

/** 所有拒绝共用一条可行动提示，保证调用方能建模下一步，而不是只拿到 false。 */
function reject(reason: AddressRejectReason): Extract<AddressResult, { ok: false }> {
  return {
    ok: false,
    reason,
    hint: `Use the canonical form <local>.<org>@markus.global: both segments must be lowercase ASCII [a-z0-9-] with no leading/trailing or doubled hyphens (local <= ${MAX_LOCAL_LENGTH}, org <= ${MAX_ORG_SLUG_LENGTH}). Reserved names and 0-dot or multi-dot addresses cannot be bound; external domains are kept opaque.`,
  };
}

/** 段级校验：唯一执行点，formatAddress 与 parseAddress 共用，不允许出现第二套规则。 */
function validateLabel(
  label: string,
  maxLength: number,
  reserved: ReadonlySet<string>,
): Extract<AddressResult, { ok: false }> | null {
  if (
    typeof label !== 'string'
    || label.length === 0
    || label.length > maxLength
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    || label.includes('--')
  ) {
    return reject('invalid_label');
  }
  if (reserved.has(label)) return reject('reserved_word');
  return null;
}

/**
 * 唯一写入点：把 (local, orgSlug) 铸成规范形。不接受大写/中文/+tag/多点输入，
 * 越界时拒绝并给提示，绝不静默 normalize（缓存友好性：一种输入只产出一种字节序列）。
 */
export function formatAddress(local: string, orgSlug: string): AddressResult {
  const localError = validateLabel(local, MAX_LOCAL_LENGTH, LOCAL_RESERVED);
  if (localError) return localError;
  const orgError = validateLabel(orgSlug, MAX_ORG_SLUG_LENGTH, ORG_RESERVED);
  if (orgError) return orgError;
  return {
    ok: true,
    value: {
      kind: 'markus',
      address: `${local}.${orgSlug}@${MARKUS_MAIL_DOMAIN}`,
      local,
      orgSlug,
    },
  };
}

/**
 * 唯一解析器：只看点数与域名，不做内容启发式。
 * - 非 markus.global 域 → external，原样 opaque（含长得像内部地址的伪造来信）
 * - 0 个点 → platform，必须是保留集内；否则 unknown_platform_address
 * - 1 个点 → markus，两段都过同一套段级校验
 * - ≥2 个点 → team_level_reserved（v2 团队级口子）
 */
export function parseAddress(raw: string): AddressResult {
  if (typeof raw !== 'string' || raw.length === 0) return reject('malformed');

  const at = raw.lastIndexOf('@');
  if (at <= 0 || at === raw.length - 1 || raw.indexOf('@') !== at) return reject('malformed');

  const localPart = raw.slice(0, at);
  const domain = raw.slice(at + 1);

  // 大小写不敏感的域名比较只用于「识别有人想写我们的域」；规范形必须精确小写。
  if (domain.toLowerCase() === MARKUS_MAIL_DOMAIN) {
    if (domain !== MARKUS_MAIL_DOMAIN) return reject('invalid_label');
  } else {
    return { ok: true, value: { kind: 'external', address: raw } };
  }

  const segments = localPart.split('.');
  if (segments.length === 1) {
    const name = segments[0]!;
    if (!PLATFORM_RESERVED_ADDRESSES.includes(name)) return reject('unknown_platform_address');
    return {
      ok: true,
      value: { kind: 'platform', address: raw, local: name },
    };
  }
  if (segments.length >= 3) return reject('team_level_reserved');

  const localError = validateLabel(segments[0]!, MAX_LOCAL_LENGTH, LOCAL_RESERVED);
  if (localError) return localError;
  const orgError = validateLabel(segments[1]!, MAX_ORG_SLUG_LENGTH, ORG_RESERVED);
  if (orgError) return orgError;
  return {
    ok: true,
    value: { kind: 'markus', address: raw, local: segments[0]!, orgSlug: segments[1]! },
  };
}

/**
 * 人类邮箱隔离守卫（A4）：users.email 不得占用组织地址格式。
 * 只有组织内地址返回 true；平台保留邮箱与外部地址都返回 false。
 */
export function isMarkusOrgAddress(raw: string): boolean {
  const result = parseAddress(raw);
  return result.ok && result.value.kind === 'markus';
}

// ─── 地址绑定的返回体（第六刀 C1 §2.4）────────────────────────────────────────
//
// 判据：Agent 看不到日志，只能靠返回值建模。所以「没绑上」必须是一个**有名字的
// 状态**，不能只写一行日志然后返回 false。这里把三种结局都变成显式的判别联合：
// 绑上 / 退信（带可行动提示）/ 冲突。将来接外部邮件（C10）或补 catch-all（C3）
// 时，字段只增不改形状 —— 同一个逻辑输入只产出一种字节序列。

/** 解析阶段拒绝的精确原因（比 `BounceReason` 更细，供 Agent 决定下一步动作）。 */
export type AddressBindRejectDetail =
  | AddressRejectReason
  /** 外部域地址：本刀不认领（C10 才接外部邮件）。 */
  | 'external_domain'
  /** 平台保留的 0 点地址（conduct@ 等）：组织不得绑定。 */
  | 'platform_reserved';

/** `bind_address` 的结局。 */
export type AddressBindOutcome =
  | { status: 'bound'; address: string; targetRef: string; unchanged?: true }
  | {
      status: 'bounced';
      address: string;
      reason: BounceReason;
      detail: AddressBindRejectDetail;
      hint: string;
      /**
       * catch-all 概览 id。C1 恒为 `null`：概览记录的唯一写者是 C3 的
       * `bounced → catch_all` 通道（§2.5）。字段先占位，C3 上线时工具返回形状不变。
       */
      catchAllId: string | null;
    }
  | { status: 'conflict'; address: string; hint: string }
  /** I5：只能绑自己。`target_ref` 指向别人时明确拒绝，而不是悄悄改成自己。 */
  | { status: 'forbidden'; address: string; hint: string };

/** `address_revoke` 的结局。`forbidden` 是 I5 的正面回答，不是错误码。 */
export type AddressRevokeOutcome =
  | { status: 'revoked'; address: string }
  | { status: 'forbidden'; address: string; hint: string }
  | { status: 'not_bound'; address: string; hint: string }
  | {
      status: 'bounced';
      address: string;
      reason: BounceReason;
      detail: AddressBindRejectDetail;
      hint: string;
      catchAllId: string | null;
    };

/** 解析结果：只有「唯一 active 目标」与「没有」两种，没有第三种悄悄丢掉。 */
export type AddressResolution =
  | { matched: true; address: string; targetRef: string; agentId: string }
  | {
      matched: false;
      address: string;
      reason: Extract<BounceReason, 'unresolved_address' | 'no_active_target'>;
    };
