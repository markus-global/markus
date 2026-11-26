/**
 * C10-B —— 外部源适配器契约（计划 §B）。
 *
 * **只翻译信封，不做路由决策。** 适配器把外部原始载荷（webhook body / RSS XML）
 * 翻成 `ExternalEvent`（messageId/from/subject/content/threadRef）——没有 to/agentId/
 * kind 等路由或身份字段。路由归 L2 地址簿 + mailbox 唯一解析器；身份归唯一构造器
 * `WORK_UNIT_REF.external` + 唯一装配点 ensureIdentity（都在 ingest 点之后）。
 *
 * 伪造 From 规则：`from` 是原始外部字符串，长得像内部地址也原样交出 —— 命名空间由
 * **到达通道**决定（webhook/RSS ⇒ external/unverified），字符串相似度永不决定身份。
 *
 * RSS 解析手写（RSS 2.0 + Atom），零新依赖。messageId 由 guid/link 稳定派生（幂等输入）；
 * 无稳定 id 的 item 跳过（不声称幂等）。
 */

/** 适配器交出的结构化事件（纯信封内容，无路由/身份字段）。 */
export interface ExternalEvent {
  /** 稳定幂等键（RSS=guid/link；webhook=发送方声明）。null = 无声明，ingest 生成平台 id。 */
  messageId: string | null;
  /** 原始外部发送者字符串（不分类、不验证；分类是 ingest 的结构决定）。 */
  from: string;
  subject: string;
  content: string;
  /** 外部线程引用（仅留痕，永不路由/去重）。 */
  externalThreadRef: string | null;
}

export type ExternalSourceKind = 'webhook' | 'rss';

export interface ExternalSourceAdapter {
  readonly kind: ExternalSourceKind;
  /** 翻译原始载荷。webhook → 单事件 | null；RSS → 事件数组（坏 XML/空 → []）。 */
  translate(raw: unknown): ExternalEvent | ExternalEvent[] | null;
}

// ─── webhook ────────────────────────────────────────────────────────────────

export const webhookAdapter: ExternalSourceAdapter = {
  kind: 'webhook',
  translate(raw: unknown): ExternalEvent | null {
    if (!raw || typeof raw !== 'object') return null;
    const body = raw as Record<string, unknown>;
    const content = firstString(body['content'], body['text'], body['body']);
    // content 缺失 → null（ingest 落 payload_invalid 回声，不静默吞）。
    if (content === null) return null;
    const messageId = typeof body['messageId'] === 'string' && body['messageId'].length > 0
      ? body['messageId']
      : null;
    return {
      messageId,
      from: typeof body['from'] === 'string' ? body['from'] : '',
      subject: typeof body['subject'] === 'string' ? body['subject'] : '',
      content,
      externalThreadRef: typeof body['threadRef'] === 'string' ? body['threadRef'] : null,
    };
  },
};

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

// ─── RSS / Atom（手写解析，零依赖）──────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();
}

/** 取块内第一个 <tag>…</tag> 的文本（解码 CDATA/实体）；无则 null。 */
function tagText(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(block);
  return m ? decodeEntities(m[1]!) : null;
}

/** Atom 的 <link href="…"/>（取 href 属性）；RSS 的 <link>…</link> 走 tagText。 */
function atomLink(block: string): string | null {
  const m = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i.exec(block);
  return m ? decodeEntities(m[1]!) : null;
}

function matchBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]!);
  return out;
}

export const rssAdapter: ExternalSourceAdapter = {
  kind: 'rss',
  translate(raw: unknown): ExternalEvent[] {
    if (typeof raw !== 'string' || raw.trim().length === 0) return [];
    const xml = raw;
    const events: ExternalEvent[] = [];
    // RSS 2.0 <item>
    for (const item of matchBlocks(xml, 'item')) {
      const link = tagText(item, 'link');
      const guid = tagText(item, 'guid');
      const messageId = guid ?? link;
      if (!messageId) continue; // 无稳定 id ⇒ 不声称幂等，跳过
      events.push({
        messageId,
        from: '',
        subject: tagText(item, 'title') ?? '',
        content: tagText(item, 'description') ?? '',
        externalThreadRef: link,
      });
    }
    // Atom <entry>
    for (const entry of matchBlocks(xml, 'entry')) {
      const link = atomLink(entry) ?? tagText(entry, 'link');
      const id = tagText(entry, 'id');
      const messageId = id ?? link;
      if (!messageId) continue;
      events.push({
        messageId,
        from: '',
        subject: tagText(entry, 'title') ?? '',
        content: tagText(entry, 'summary') ?? tagText(entry, 'content') ?? '',
        externalThreadRef: link,
      });
    }
    return events;
  },
};
