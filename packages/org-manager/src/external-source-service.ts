/**
 * C10-B —— ExternalSourceService：外部信号的**唯一 ingest 点**（计划 §B）。
 *
 * 一条外部信号（webhook POST / RSS item）在这里走完三件事，然后交给 mailbox：
 *   ① 身份：`WORK_UNIT_REF.external(source.id, messageId)` —— 唯一构造器，入队前建好，
 *      装配点 ensureIdentity 保证实体存在（「先入队后补身份」结构上不可表达）；
 *   ② 天花板：未验证外部信号的 intent 经唯一谓词 mayExternalSignalDemandAction 封顶
 *      deliver（B 恒 fromVerified=false；认证是 C10-D 的事）；
 *   ③ 路由：只声明 origin.to = 源地址，解析归 mailbox 唯一解析器（addressLookup）。
 *      地址绑给谁就投谁的 mailbox；无绑定 → 投源主 mailbox 由解析器落 no_active_target
 *      退信回声（同一条退信通道，不造第二个退信写者）。
 *
 * kill switch：每次 ingest / poll **现读 DB**（sources.get），不持内存缓存 ——
 * 第二写者直接 UPDATE enabled 也立刻生效；重启后状态保持（持久列，不是内存缓冲）。
 *
 * 适配器只翻译（@markus/comms external-source）；本服务不解析 XML、不读 payload 推断
 * 结构（R3'）。messageId 缺省 = 平台 mbx_* id（诚实：无幂等声明 = 每次新事件）。
 */
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  WORK_UNIT_REF,
  mayExternalSignalDemandAction,
  isBounceSignalStatus,
  parseAddress,
  type ExternalIngressPolicy,
  type MailboxIntent,
} from '@markus/shared';
import { rssAdapter, webhookAdapter, type ExternalEvent } from '@markus/comms';
import type { AgentMailbox } from '@markus/core';
import type { SqliteExternalSourceRepo } from '@markus/storage';

export type IngestOutcome =
  | { status: 'ingested'; itemId: string; workUnitRef: string }
  | { status: 'bounced'; itemId: string | null; dropReason: string }
  | { status: 'disabled' }
  | { status: 'refused'; reason: 'org_ingress_off'; policy: ExternalIngressPolicy }
  | { status: 'unknown_source' };

export interface ExternalSourceServiceDeps {
  /** external_sources 唯一写者（storage repo）。 */
  sources: SqliteExternalSourceRepo;
  /** 地址簿读口（C10-A findActive）：路由跟绑定走，不跟源主走。 */
  findActive(address: string): { agentId: string; targetRef: string } | undefined;
  /** agent mailbox 装配口（agent-manager 提供）。 */
  mailboxOf(agentId: string): AgentMailbox | undefined;
  /** RSS 抓取注入点（测试给夹具；生产走全局 fetch —— cli 已装 egress 代理）。 */
  fetchText?(url: string): Promise<string>;
  /**
   * C10-F：组织级入站策略读口（唯一读者 = ingest 下方）。现读 DB —— 与源开关
   * 同纪律：第二写者直接改列也立刻生效，重启后保持。缺省 'off'（失败关闭）。
   */
  ingressPolicy?(orgId: string): ExternalIngressPolicy;
  now?(): Date;
}

/** RSS 水位（入库 JSON）：seenIds 有界（≤200），lastPublishedAt 留痕。 */
interface RssCursor {
  seenIds?: string[];
  lastPublishedAt?: string | null;
}

const RSS_SEEN_LIMIT = 200;

/**
 * 外部内容落库前的硬上限（32 KB）。
 *
 * 为什么必须有：webhook 的 `content` 会**整段进入提示词**（agent 侧「有 content 就跳过
 * 2000 字截断」）。没有上限时，一个几 MB 的 body = 一次超大上下文调用 —— 对开源用户
 * 就是「一条请求烧掉一整天的额度」，而且能用来把系统提示里的约束冲掉（提示注入面）。
 *
 * 上限放在**唯一 ingest 点**：webhook / RSS / 运营投递三条路共用同一个执行点，
 * 不靠每个适配器自己记得截断（那是三个写者）。
 */
const EXTERNAL_CONTENT_LIMIT = 32 * 1024;

/**
 * 给 webhook 源铸造共享密钥。
 *
 * 第一性原理：**「无鉴权的入站口」不应该是一种可选状态**。旧实现把 token 当可选项，
 * 于是「不安全」是默认态、「安全」要靠用户记得配 —— 对开源产品的绝大多数用户，
 * 默认值就是实际配置。现在注册时必然产出密钥（不传就生成），入站时无密钥一律拒收。
 */
function mintWebhookSecret(): string {
  return randomBytes(24).toString('hex');
}

/** 恒定时间比较；长度不同直接 false（timingSafeEqual 长度不等会抛）。 */
function secretEquals(provided: string | null, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}


function safeJson(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function defaultFetchText(url: string): Promise<string> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`feed fetch HTTP ${res.status}`);
  return await res.text();
}

export class ExternalSourceService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: ExternalSourceServiceDeps) {}

  /** 唯一 ingest 点：ref 构造 + 天花板 + 交 mailbox（ensure 在装配点）。 */
  ingest(
    sourceId: string,
    event: ExternalEvent,
    opts?: {
      intent?: MailboxIntent;
      /**
       * B（Owner 2026-11-25）：目标地址覆写 —— **仅鉴权运营路径可达**。
       * 公开 webhook 入口（receiveWebhook）不传它，所以外部方结构上无法重定向；
       * 不是靠读 payload 里的字段再校验（那就是从载荷推断结构）。
       */
      targetAddress?: string;
    },
  ): IngestOutcome {
    // 现读 DB：kill switch 与源配置都以库为准（无内存缓存 = 无第二写者）。
    const source = this.deps.sources.get(sourceId);
    if (!source) return { status: 'unknown_source' };
    if (!source.enabled) return { status: 'disabled' };

    // C10-F：组织级入站策略 —— **唯一读者就在这里**。三条外部入口（公开 webhook /
    // RSS 轮询 / 运营投递）全部经过本方法，所以没有任何适配器能持有一份自己的副本。
    // 现读 DB（不缓存 = 无第二写者）；未接线 ⇒ 'off'（失败关闭，不是「等于放行」）。
    const policy: ExternalIngressPolicy = this.deps.ingressPolicy?.(source.orgId) ?? 'off';
    if (policy === 'off') return { status: 'refused', reason: 'org_ingress_off', policy };

    // 目标地址：运营路径可覆写，否则就是源自己的地址。下游只有**一条**路由规则
    // （跟目标地址的绑定走），不因为多了一个入口而多一个路由写者。
    const destAddress = opts?.targetAddress ?? source.address;
    const to = parseAddress(destAddress);
    if (!to.ok || to.value.kind !== 'markus') {
      return { status: 'bounced', itemId: null, dropReason: 'unresolved_address' };
    }

    // 幂等键：适配器交出的稳定原生 id；缺省生成平台 id（不声称幂等）。
    const messageId = event.messageId ?? `mbx_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const workUnitRef = WORK_UNIT_REF.external(source.id, messageId);

    // B 不做认证（fromVerified 恒 false，auth 槽恒 null，C10-D 才写值）。
    const fromVerified = false;
    const requested: MailboxIntent = opts?.intent ?? 'deliver';
    // A（Owner 2026-11-25 裁决）：**欠不欠回合由平台判定，不由发送者权威决定**。
    // 外部事件一律欠一个回合 → action_required（routeMailboxItem 据此 invokesLLM=true）。
    // 旧写法把未验证信号的 intent 擦成 deliver，等于用「让事件消失」来限制发送者 ——
    // 削掉的是平台的决策机会，不是发送者的权威。发送者现在只能**升权**、不能决定
    // 要不要回合：升到 trigger_execution（权威 FSM 待遇）须已验证。未验证来源的
    // 权威侧执行点移到 agent 级天花板：fromVerified 喂 selfInitiationCeiling →
    // maySelfInitiate，封的是**自主发起**，不是这个回合。
    const intent: MailboxIntent =
      requested === 'trigger_execution' && mayExternalSignalDemandAction(fromVerified)
        ? 'trigger_execution'
        : policy === 'accept'
          ? 'action_required'
          : // 'observe'：收下、留痕，但**不欠回合**（deliver 不唤醒 agent）。
            // 这仍是平台的判决，不是发送者的权威 —— 只是判决依据从「通道」变成了
            // 「组织策略」。
            'deliver';

    // 路由跟绑定走；无绑定 → 源主 mailbox 收解析器的 no_active_target 退信回声。
    const binding = this.deps.findActive(destAddress);
    const targetAgentId = binding?.agentId ?? source.agentId;
    const mailbox = this.deps.mailboxOf(targetAgentId);
    if (!mailbox) return { status: 'bounced', itemId: null, dropReason: 'no_active_target' };

    const config = safeJson(source.config);
    const fromAddress =
      event.from.length > 0
        ? event.from
        : source.kind === 'rss'
          ? (typeof config['feedUrl'] === 'string' ? (config['feedUrl'] as string) : 'rss')
          : 'webhook';

    // 内容上限：所有适配器共用这一个执行点（webhook / RSS / 运营投递）。
    // 没有它时，一条几 MB 的外部 body 会整段进入提示词 —— 对开源用户就是
    // 「一条请求烧掉一天额度」，而且能冲掉系统提示里的约束（提示注入面）。
    const rawContent = typeof event.content === 'string' ? event.content : '';
    const contentTruncated = rawContent.length > EXTERNAL_CONTENT_LIMIT;
    const boundedContent = contentTruncated
      ? `${rawContent.slice(0, EXTERNAL_CONTENT_LIMIT)}\n\n[truncated: original ${rawContent.length} chars]`
      : rawContent;

    const item = mailbox.enqueue(
      'external_signal',
      {
        summary: event.subject || boundedContent.slice(0, 120),
        content: boundedContent,
        ...(contentTruncated ? { contentTruncated: true } : {}),
      },
      {
        intent,
        workUnitRef,
        refOrigin: 'entity',
        origin: {
          // 命名空间由到达通道决定（external），字符串相似度永不决定身份。
          from: { kind: 'external', address: fromAddress },
          to: to.value,
          messageId,
          subject: event.subject,
          externalThreadRef: event.externalThreadRef,
          fromVerified,
        },
      },
    );

    // 退信态用唯一谓词 isBounceSignalStatus 判定（bounced 或已归集 catch_all）；
    // 不另写 === 'bounced'（退信两终态：未持久化投影 bounced / 已归集 catch_all）。
    if (isBounceSignalStatus(item.status)) {
      return { status: 'bounced', itemId: item.id, dropReason: item.dropReason ?? 'unknown' };
    }
    // 留痕：last_event_at（cursor 原样保留，webhook 无水位）。
    this.deps.sources.updateCursor(source.id, source.cursor, this.nowIso());
    return { status: 'ingested', itemId: item.id, workUnitRef };
  }

  /**
   * 注册一个源（工具面 + API 共用同一裁决点，R2）。
   * 顺序：格式门（parseAddress）→ 归属门（地址必须 active 绑给**自己**）→ 唯一写者落库。
   * 归属拒绝沿用结构化 reason，不静默改写；格式门交出解析值供归属门读（不二次推断）。
   */
  registerSource(input: {
    orgId: string; agentId: string; kind: string; address: string; config?: Record<string, unknown>;
  }): { status: string; source?: { id: string }; secret?: string; reason?: string; hint?: string } {
    const parsed = parseAddress(input.address);
    if (!parsed.ok || parsed.value.kind !== 'markus') {
      return {
        status: 'bounced', reason: 'invalid_address',
        hint: `address must be a claimable <local>.<org>@markus.global address bound to you (bind_address first).`,
      };
    }
    const binding = this.deps.findActive(parsed.value.address);
    if (!binding || binding.agentId !== input.agentId) {
      return {
        status: 'forbidden', reason: 'address_not_bound_to_you',
        hint: 'The address is not actively bound to you. Bind it to yourself (bind_address) before registering a source on it.',
      };
    }
    // 安全默认值（开源产品关键）：webhook 源**必然**带共享密钥。
    // 不传就现铸一个 —— 让「无鉴权的入站口」在结构上不可表达，而不是靠用户记得配。
    // 密钥只在注册响应里返回一次（调用方自己保管）；listSources 不回显，避免二次扩散。
    let mintedSecret: string | undefined;
    let config = input.config;
    if (input.kind === 'webhook') {
      const next = { ...(input.config ?? {}) };
      const existing = next['token'];
      if (typeof existing !== 'string' || existing.trim().length === 0) {
        mintedSecret = mintWebhookSecret();
        next['token'] = mintedSecret;
      }
      config = next;
    }
    const out = this.deps.sources.register({ ...input, address: parsed.value.address, config });
    if (out.status === 'bounced') {
      return { status: 'bounced', reason: out.reason, hint: out.hint };
    }
    return {
      status: 'registered',
      source: { id: out.source.id },
      ...(mintedSecret
        ? {
            secret: mintedSecret,
            hint:
              'Store this secret now — it is shown once. The endpoint requires it in the x-webhook-token header; ' +
              'losing it means re-registering the source.',
          }
        : {}),
    };
  }

  /**
   * B（Owner 2026-11-25 裁决）—— 鉴权运营投递入口。
   *
   * 为什么存在：M1 落地后撤销绑定会连带禁用源，而注册又要求地址已 active 绑给自己，
   * 于是「无人认领的地址」今天没有任何入站口 —— M2/M4 会是没输入的空转机器。
   *
   * 为什么不动注册闸门：那道门防的是「先注册后绑定」的自助抢占。这里运营者用
   * **自己已注册的源**当出处（归属门 below），只额外指定目标地址：不创建源行、
   * 不认领地址，所以抢占守卫原样保留。ref 仍是真实体 external:<真源id>:<msgId>，
   * 不造伪源 id（判据 15 与唯一构造器都不动）。
   *
   * 它是**显式运营动作**，不是真外部通道；天然能投任意地址的通道仍是 email（C10-D）。
   */
  deliverAsOperator(input: {
    orgId: string; agentId: string; sourceId: string; address: string; body: unknown;
  }): { status: string; itemId?: string; workUnitRef?: string; reason?: string; hint?: string } {
    const source = this.deps.sources.get(input.sourceId);
    if (!source || source.orgId !== input.orgId || source.agentId !== input.agentId) {
      return {
        status: 'forbidden', reason: 'not_your_source',
        hint: 'Deliver through a source you own. The source is the provenance; the target address is separate.',
      };
    }
    if (!source.enabled) return { status: 'disabled' };
    const parsed = parseAddress(input.address);
    if (!parsed.ok || parsed.value.kind !== 'markus') {
      return {
        status: 'bounced', reason: 'invalid_address',
        hint: 'target address must be a <local>.<org>@markus.global address (it need not be claimed).',
      };
    }
    // 翻译复用同一个适配器（不造第二个载荷解析器）。
    const event = webhookAdapter.translate(input.body);
    if (!event || Array.isArray(event)) {
      return { status: 'bounced', reason: 'payload_invalid' };
    }
    const out = this.ingest(input.sourceId, event, { targetAddress: parsed.value.address });
    return out as { status: string; itemId?: string; workUnitRef?: string; reason?: string };
  }

  /** 只列自己的源（orgId + agentId 双限定，唯一写者读口）。 */
  listSources(
    orgId: string,
    agentId: string,
  ): Array<{
    id: string; kind: string; address: string; enabled: boolean;
    /** 完整入站路径（相对）；RSS 源为 null。前端拼公网基址，不在服务层猜域名。 */
    urlPath: string | null;
    /** 共享密钥的状态与尾四位（永不返回完整密钥——它只在注册/轮换时一次性下发）。 */
    hasSecret: boolean; secretPreview: string | null;
    /** RSS 的抓取地址；webhook 源为 null。 */
    feedUrl: string | null;
    lastEventAt: string | null; lastError: string | null;
  }> {
    return this.deps.sources.listByAgent(orgId, agentId).map(s => {
      const config = safeJson(s.config);
      const token = typeof config['token'] === 'string' && (config['token'] as string).length > 0
        ? (config['token'] as string)
        : null;
      return {
        id: s.id,
        kind: s.kind,
        address: s.address,
        enabled: s.enabled,
        urlPath: s.kind === 'webhook' ? `/api/webhooks/${s.id}` : null,
        hasSecret: token !== null,
        secretPreview: token ? `••••${token.slice(-4)}` : null,
        feedUrl: typeof config['feedUrl'] === 'string' ? (config['feedUrl'] as string) : null,
        lastEventAt: s.lastEventAt,
        lastError: s.lastError,
      };
    });
  }

  /** 组织级策略读口（前端与工具面读同一份；写入走 OrganizationService）。 */
  policyOf(orgId: string): ExternalIngressPolicy {
    return this.deps.ingressPolicy?.(orgId) ?? 'off';
  }

  /**
   * C10-F：轮换 webhook 共享密钥（所有权裁决同上）。
   *
   * 为什么需要它：密钥是注册时一次性下发的，丢了今天只能删源重建 —— 而重建要求
   * 地址仍 active 绑给自己，于是「丢了密钥」在无人认领的地址上是个死局。轮换把死局
   * 变成一步操作，并且**不重跑注册闸门**（归属只裁一次，不因密钥变动再判一次）。
   */
  rotateSecret(input: {
    orgId: string; agentId: string; sourceId: string;
  }): { status: string; secret?: string; reason?: string; hint?: string } {
    const source = this.deps.sources.get(input.sourceId);
    if (!source || source.orgId !== input.orgId || source.agentId !== input.agentId) {
      return {
        status: 'forbidden', reason: 'not_your_source',
        hint: 'You can only rotate the secret of your own sources (see external_source_list).',
      };
    }
    if (source.kind !== 'webhook') {
      return {
        status: 'bounced', reason: 'not_a_webhook_source',
        hint: 'Only webhook sources hold a shared secret; RSS sources poll a public feed URL.',
      };
    }
    const next = { ...safeJson(source.config), token: mintWebhookSecret() };
    this.deps.sources.setConfig(source.id, next);
    return {
      status: 'rotated',
      secret: next['token'] as string,
      hint: 'Store this secret now — it is shown once. The previous secret stopped working immediately.',
    };
  }

  /**
   * 持久 kill switch（工具面 + API 共用裁决点）。只能开关**自己的**源；
   * 所有权裁决在此（org-manager 唯一写者），core 工具面只翻译表面语义。
   */
  setSourceEnabled(input: {
    orgId: string; agentId: string; sourceId: string; enabled: boolean;
  }): { status: string; enabled?: boolean; reason?: string; hint?: string } {
    const source = this.deps.sources.get(input.sourceId);
    if (!source || source.orgId !== input.orgId || source.agentId !== input.agentId) {
      return {
        status: 'forbidden', reason: 'not_your_source',
        hint: 'You can only toggle your own sources (see external_source_list).',
      };
    }
    this.deps.sources.setEnabled(input.sourceId, input.enabled);
    return { status: 'toggled', enabled: input.enabled };
  }

  /**
   * webhook 入口（唯一裁决点：源存在/kind/token/翻译/ingest 都在这里，路由层只搬运）。
   * token 是可选共享密钥（config.token）；设了就必须匹配，否则 401。无 token = 公开源。
   * 翻译失败（content 缺失）⇒ payload_invalid 回声（不静默吞）；其余交唯一 ingest 点。
   */
  receiveWebhook(sourceId: string, body: unknown, providedToken: string | null): { http: number; body: Record<string, unknown> } {
    const source = this.deps.sources.get(sourceId);
    if (!source) return { http: 404, body: { status: 'unknown_source' } };
    if (source.kind !== 'webhook') return { http: 400, body: { status: 'bounced', reason: 'not_a_webhook_source' } };
    const config = safeJson(source.config);
    const token = typeof config['token'] === 'string' && (config['token'] as string).length > 0 ? (config['token'] as string) : null;
    // 失败关闭（fail-closed）：没有密钥的源**不接受**入站，而不是「等于放行」。
    // 旧库里的历史行（token 可选时代的产物）因此立即停止接受输入；错误体给可行动提示，
    // 因为「悄悄拒收」会让运维无从下手。
    if (!token) {
      return {
        http: 401,
        body: {
          status: 'secret_required',
          hint:
            'This webhook source has no shared secret, so it cannot accept input. Re-register it ' +
            '(external_source_register) — a secret is minted automatically — or set config.token.',
        },
      };
    }
    if (!secretEquals(providedToken, token)) return { http: 401, body: { status: 'unauthorized' } };
    const event = webhookAdapter.translate(body);
    if (!event || Array.isArray(event)) return { http: 200, body: { status: 'bounced', dropReason: 'payload_invalid' } };
    const out = this.ingest(sourceId, event);
    // 策略拒收是 403（不是 200 + 内部状态）：外部系统看到的是一个明确的「这次没被接受」。
    if (out.status === 'refused') {
      return {
        http: 403,
        body: {
          status: 'refused', reason: out.reason,
          hint: 'External ingress is off for this organization. Enable it in Settings → Connections → External signals (off / observe / accept).',
        },
      };
    }
    return { http: 200, body: out as unknown as Record<string, unknown> };
  }

  /** 轮询单个 RSS 源：现读 enabled → 抓取 → 翻译 → 水位过滤 → ingest → 水位入库。 */
  async pollRss(sourceId: string): Promise<{ fetched: number; ingested: number }> {
    const source = this.deps.sources.get(sourceId);
    if (!source || !source.enabled || source.kind !== 'rss') return { fetched: 0, ingested: 0 };
    const config = safeJson(source.config);
    const feedUrl = typeof config['feedUrl'] === 'string' ? (config['feedUrl'] as string) : null;
    if (!feedUrl) {
      this.deps.sources.recordError(sourceId, 'config.feedUrl missing');
      return { fetched: 0, ingested: 0 };
    }
    let xml: string;
    try {
      xml = await (this.deps.fetchText ?? defaultFetchText)(feedUrl);
      this.deps.sources.recordError(sourceId, null);
    } catch (err) {
      this.deps.sources.recordError(sourceId, String(err));
      return { fetched: 0, ingested: 0 };
    }
    const translated = rssAdapter.translate(xml);
    const events: ExternalEvent[] = Array.isArray(translated) ? translated : translated ? [translated] : [];
    const cursor: RssCursor = source.cursor ? (safeJson(source.cursor) as RssCursor) : {};
    const seen = new Set(cursor.seenIds ?? []);
    const newSeen: string[] = [];
    let ingested = 0;
    for (const ev of events) {
      if (!ev.messageId || seen.has(ev.messageId)) continue;
      const out = this.ingest(sourceId, ev);
      if (out.status === 'ingested') {
        ingested += 1;
        newSeen.push(ev.messageId);
      } else if (out.status === 'bounced' && out.dropReason === 'duplicate_message_id') {
        newSeen.push(ev.messageId); // 已投过（mailbox 幂等裁决）—— 记入水位，不再重投
      } else if (out.status === 'disabled' || out.status === 'unknown_source' || out.status === 'refused') {
        break; // 源被关 / 被删 / 组织策略关闭：立即停（下一轮不再扫，也不空转）
      }
    }
    const merged = [...newSeen, ...(cursor.seenIds ?? [])].slice(0, RSS_SEEN_LIMIT);
    this.deps.sources.updateCursor(
      sourceId,
      JSON.stringify({ seenIds: merged, lastPublishedAt: cursor.lastPublishedAt ?? null }),
      this.nowIso(),
    );
    return { fetched: events.length, ingested };
  }

  /** 单 timer 轮询全部 enabled rss 行（非每源 timer —— 一个机制一个执行点）。 */
  startPolling(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pollAllEnabled();
    }, intervalMs);
    this.timer.unref();
  }

  stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async pollAllEnabled(): Promise<void> {
    for (const source of this.deps.sources.listEnabledByKind('rss')) {
      try {
        await this.pollRss(source.id);
      } catch (err) {
        this.deps.sources.recordError(source.id, String(err));
      }
    }
  }

  private nowIso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}
