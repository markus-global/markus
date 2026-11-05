/**
 * 外部事件来源适配器注册表。
 *
 * 设计约束（来自设计文档 §3.1）：**每个适配器只做归一化，不含业务规则**。
 * 能不能接、该谁接、要不要延后，全部由 ingress → ThreadService 决定。
 * 这样加一个平台（GitHub / 小红书 / RSS / 邮件）永远只是新增一个 ~60 行的适配器，
 * 而不是在核心 if 链里加一个分支。
 *
 * 安全约束：HMAC 必须对**原始字节**校验（`rawBody`），不能用解析后的 JSON 重新
 * 序列化——字段顺序/空格/unicode 转义任何一处不同都会让签名失配或（更糟）让攻击者
 * 构造出「解析后等价但签名有效」的载荷。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ActorKind, Addressing, ThreadRef, TriggerKind } from '@markus/shared';

export interface RawEvent {
  /** 适配器前缀（`gh` / `xhs` / `rss` / `im-feishu`） */
  prefix: string;
  headers: Record<string, string | string[] | undefined>;
  /** **原始字节**，签名校验的唯一输入 */
  rawBody: Buffer;
  /** 该来源配置的 HMAC 密钥；null = 未配置（适配器自行决定是否放行） */
  secret: string | null;
}

export interface NormalizedEvent {
  kind: TriggerKind;
  /** 幂等键：同一来源同一事件必须产出同一个键 */
  idempotencyKey: string;
  /** 事件归属的流（适配器已解析出外部资源键时放在这里） */
  ref: ThreadRef;
  actorKind: ActorKind;
  actorId: string;
  addressing: Addressing;
  summary: string;
  body: string;
  /** 已结束的卡/已关闭的议题：非人事件只留痕 */
  threadEnded?: boolean;
  receivedAt: number;
  /** 原始头部里的可审计信息（不含密钥） */
  meta?: Record<string, string>;
}

export interface SourceAdapter {
  readonly prefix: string;
  /**
   * 签名校验。返回 false 时 ingress 直接 401，**不解析载荷**。
   * 无密钥的来源（如内网 RSS 拉取）应显式 `return true` 并在 config 里标注，
   * 而不是让判定散落在 ingress 里。
   */
  verify(raw: RawEvent): boolean;
  /** 归一化：一条请求可能产出多个事件（批量 webhook），返回数组 */
  normalize(raw: RawEvent): NormalizedEvent[];
}

/** `sha256=<hex>` / `sha1=<hex>` / 裸 hex 都能取出来。 */
export function signatureFromHeader(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v) return undefined;
  const eq = v.indexOf('=');
  return (eq >= 0 ? v.slice(eq + 1) : v).trim() || undefined;
}

/**
 * HMAC 校验：对原始字节 + `timingSafeEqual`。
 *
 * 长度不等时 `timingSafeEqual` 会抛异常，所以必须先比长度再比内容
 * （长度本身不是秘密，签名算法是公开的）。
 */
export function verifyHmac(raw: RawEvent, headerName: string, algo: 'sha256' | 'sha1' = 'sha256'): boolean {
  if (!raw.secret) return false;
  const provided = signatureFromHeader(raw.headers[headerName]);
  if (!provided) return false;
  const expected = createHmac(algo, raw.secret).update(raw.rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided.toLowerCase(), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export class SourceRegistry {
  private adapters = new Map<string, SourceAdapter>();

  register(adapter: SourceAdapter): void {
    if (!adapter.prefix.trim()) throw new Error('SOURCE_PREFIX_EMPTY');
    if (this.adapters.has(adapter.prefix)) {
      throw new Error(`SOURCE_PREFIX_DUPLICATE: ${adapter.prefix} 已被注册（一个前缀只能有一个适配器）`);
    }
    this.adapters.set(adapter.prefix, adapter);
  }

  get(prefix: string): SourceAdapter | undefined {
    return this.adapters.get(prefix);
  }

  prefixes(): string[] {
    return [...this.adapters.keys()].sort();
  }

  has(prefix: string): boolean {
    return this.adapters.has(prefix);
  }
}

/** 通用幂等键：`<prefix>:<事件唯一 id>`。适配器拿不到稳定 id 时用内容哈希兜底。 */
export function sourceIdempotencyKey(prefix: string, eventId: string): string {
  return `${prefix}:${eventId}`;
}

/** 通用信封：任何平台只要能发出这个结构 + HMAC，就能接进来，无需写代码。 */
export interface GenericWebhookPayload {
  /** 事件唯一 id（重投必须相同） */
  id: string;
  /** 归属的流：平台实体 id（`tsk_…`）或已注册的外部前缀键（`gh:owner/repo`） */
  ref: string;
  kind?: TriggerKind;
  actorKind?: ActorKind;
  actorId?: string;
  addressing?: Addressing;
  summary?: string;
  body?: string;
  threadEnded?: boolean;
}

/**
 * 通用适配器：把「归一化」这件事从代码搬到载荷里。
 *
 * 取舍：真正需要凭据轮换、分页位点、事件类型映射的平台（GitHub / 飞书）应该写专用
 * 适配器；通用适配器是给「自家脚本 / 内部系统 / 长尾平台」用的，让它们先用起来，
 * 等规则复杂到超过一个信封再升格成专用适配器。
 */
export function createGenericWebhookAdapter(prefix: string, headerName = 'x-markus-signature'): SourceAdapter {
  return {
    prefix,
    verify: raw => verifyHmac(raw, headerName),
    normalize: (raw: RawEvent): NormalizedEvent[] => {
      const parsed = JSON.parse(raw.rawBody.toString('utf8')) as
        | GenericWebhookPayload
        | { events?: GenericWebhookPayload[] };
      const list = Array.isArray((parsed as { events?: GenericWebhookPayload[] }).events)
        ? (parsed as { events: GenericWebhookPayload[] }).events
        : [parsed as GenericWebhookPayload];

      return list.map(p => {
        if (!p.id || !p.ref) throw new Error('GENERIC_ENVELOPE_INVALID: 需要 id 与 ref 两个字段');
        return {
          kind: p.kind ?? 'external',
          idempotencyKey: sourceIdempotencyKey(prefix, p.id),
          ref: p.ref,
          actorKind: p.actorKind ?? 'bot',
          actorId: p.actorId ?? `${prefix}:unknown`,
          addressing: p.addressing ?? 'ambient',
          summary: p.summary ?? `${prefix} 事件 ${p.id}`,
          body: p.body ?? '',
          threadEnded: p.threadEnded,
          receivedAt: Date.now(),
          meta: { prefix },
        } satisfies NormalizedEvent;
      });
    },
  };
}
