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
import { randomUUID } from 'node:crypto';
import {
  WORK_UNIT_REF,
  mayExternalSignalDemandAction,
  isBounceSignalStatus,
  parseAddress,
  type MailboxIntent,
} from '@markus/shared';
import { rssAdapter, webhookAdapter, type ExternalEvent } from '@markus/comms';
import type { AgentMailbox } from '@markus/core';
import type { SqliteExternalSourceRepo } from '@markus/storage';

export type IngestOutcome =
  | { status: 'ingested'; itemId: string; workUnitRef: string }
  | { status: 'bounced'; itemId: string | null; dropReason: string }
  | { status: 'disabled' }
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
  now?(): Date;
}

/** RSS 水位（入库 JSON）：seenIds 有界（≤200），lastPublishedAt 留痕。 */
interface RssCursor {
  seenIds?: string[];
  lastPublishedAt?: string | null;
}

const RSS_SEEN_LIMIT = 200;

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
  ingest(sourceId: string, event: ExternalEvent, opts?: { intent?: MailboxIntent }): IngestOutcome {
    // 现读 DB：kill switch 与源配置都以库为准（无内存缓存 = 无第二写者）。
    const source = this.deps.sources.get(sourceId);
    if (!source) return { status: 'unknown_source' };
    if (!source.enabled) return { status: 'disabled' };

    const to = parseAddress(source.address);
    if (!to.ok || to.value.kind !== 'markus') {
      return { status: 'bounced', itemId: null, dropReason: 'unresolved_address' };
    }

    // 幂等键：适配器交出的稳定原生 id；缺省生成平台 id（不声称幂等）。
    const messageId = event.messageId ?? `mbx_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const workUnitRef = WORK_UNIT_REF.external(source.id, messageId);

    // 信号级天花板：B 不做认证（fromVerified 恒 false，auth 槽恒 null，C10-D 才写值）。
    const fromVerified = false;
    const requested: MailboxIntent = opts?.intent ?? 'deliver';
    const intent: MailboxIntent = mayExternalSignalDemandAction(fromVerified) ? requested : 'deliver';

    // 路由跟绑定走；无绑定 → 源主 mailbox 收解析器的 no_active_target 退信回声。
    const binding = this.deps.findActive(source.address);
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

    const item = mailbox.enqueue(
      'external_signal',
      {
        summary: event.subject || event.content.slice(0, 120),
        content: event.content,
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
  }): { status: string; source?: { id: string }; reason?: string; hint?: string } {
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
    const out = this.deps.sources.register({ ...input, address: parsed.value.address });
    if (out.status === 'bounced') {
      return { status: 'bounced', reason: out.reason, hint: out.hint };
    }
    return { status: 'registered', source: { id: out.source.id } };
  }

  /** 只列自己的源（orgId + agentId 双限定，唯一写者读口）。 */
  listSources(orgId: string, agentId: string): Array<{ id: string; kind: string; address: string; enabled: boolean }> {
    return this.deps.sources.listByAgent(orgId, agentId).map(s => ({
      id: s.id, kind: s.kind, address: s.address, enabled: s.enabled,
    }));
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
    if (token && providedToken !== token) return { http: 401, body: { status: 'unauthorized' } };
    const event = webhookAdapter.translate(body);
    if (!event || Array.isArray(event)) return { http: 200, body: { status: 'bounced', dropReason: 'payload_invalid' } };
    const out = this.ingest(sourceId, event);
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
      } else if (out.status === 'disabled' || out.status === 'unknown_source') {
        break; // 源在轮询中途被关 / 被删：立刻停（现读 DB 的下一轮自然不再扫）
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
