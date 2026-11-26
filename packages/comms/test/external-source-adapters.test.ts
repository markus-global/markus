/**
 * C10-B —— 适配器契约：只翻译信封，不做路由决策（计划 §B）。
 *
 * 判据：
 *   · translate 输出是 ExternalEvent（messageId/from/subject/content/threadRef），
 *     **没有** to/agentId/kind 等路由或身份字段 —— 路由归 L2 地址簿 + 唯一解析器，
 *     身份归唯一构造器与装配点；
 *   · webhook：content 缺失 → null（ingest 落 payload_invalid 回声）；
 *     from 是原始外部字符串，长得像内部地址也原样交出（伪造 From 规则：
 *     命名空间由到达通道决定，字符串相似度永不决定身份）；
 *   · RSS：guid/link 派生稳定 messageId（幂等输入），无稳定 id 的 item 跳过；
 *     RSS 2.0 与 Atom 两种方言都翻译。
 *
 * base（37c817aa）上必须红：模块不存在。
 */
import { describe, it, expect } from 'vitest';
import { webhookAdapter, rssAdapter, type ExternalEvent } from '../src/external-source.js';

const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Example News</title><link>https://example.com</link>
  <item>
    <title>Item One</title><link>https://example.com/1</link>
    <guid>https://example.com/1</guid>
    <description>First item body</description>
    <pubDate>Sat, 22 Nov 2026 10:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Item Two</title><link>https://example.com/2</link>
    <description>Second item body</description>
  </item>
</channel></rss>`;

const ATOM_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Atom</title><link href="https://example.org"/>
  <entry>
    <title>Atom Entry</title><link href="https://example.org/a1"/>
    <id>urn:uuid:a1</id><updated>2026-11-22T10:00:00Z</updated>
    <summary>Atom body</summary>
  </entry>
</feed>`;

function eventsOf(out: ExternalEvent | ExternalEvent[] | null): ExternalEvent[] {
  if (out === null) return [];
  return Array.isArray(out) ? out : [out];
}

describe('C10-B：webhook 适配器（只翻译）', () => {
  it('合法 payload → ExternalEvent；输出不含任何路由/身份字段', () => {
    const ev = webhookAdapter.translate({
      messageId: 'wh-1', from: 'sender@external.example', subject: 'Hello',
      content: 'body text', threadRef: 'thread-9',
    }) as ExternalEvent;
    expect(ev).not.toBeNull();
    expect(ev.messageId).toBe('wh-1');
    expect(ev.from).toBe('sender@external.example');
    expect(ev.subject).toBe('Hello');
    expect(ev.content).toBe('body text');
    expect(ev.externalThreadRef).toBe('thread-9');
    for (const forbidden of ['to', 'agentId', 'kind', 'workUnitRef', 'verified']) {
      expect(ev, `适配器不得做路由/身份决策：${forbidden}`).not.toHaveProperty(forbidden);
    }
  });

  it('content 别名 text/body 都接受；全缺 → null（payload_invalid 由 ingest 落回声）', () => {
    expect((webhookAdapter.translate({ text: 't' }) as ExternalEvent).content).toBe('t');
    expect((webhookAdapter.translate({ body: 'b' }) as ExternalEvent).content).toBe('b');
    expect(webhookAdapter.translate({ subject: 'no content' })).toBeNull();
    expect(webhookAdapter.translate(null)).toBeNull();
    expect(webhookAdapter.translate('not an object')).toBeNull();
  });

  it('messageId 缺省 = null（无幂等声明，ingest 用平台 id；绝不编造稳定键）', () => {
    expect((webhookAdapter.translate({ content: 'c' }) as ExternalEvent).messageId).toBeNull();
  });

  it('伪造 From：长得像内部地址也原样交出 raw 字符串（分类是 ingest 的结构决定）', () => {
    const ev = webhookAdapter.translate({ content: 'c', from: 'cto.acme@markus.global' }) as ExternalEvent;
    expect(ev.from).toBe('cto.acme@markus.global');
    expect(ev).not.toHaveProperty('kind');
  });
});

describe('C10-B：RSS 适配器（只翻译，guid/link 派生稳定 messageId）', () => {
  it('RSS 2.0：每个 item 一个事件，messageId=guid（缺 guid 退 link），threadRef=link', () => {
    const events = eventsOf(rssAdapter.translate(RSS_SAMPLE));
    expect(events).toHaveLength(2);
    expect(events[0]!.messageId).toBe('https://example.com/1');
    expect(events[0]!.subject).toBe('Item One');
    expect(events[0]!.content).toBe('First item body');
    expect(events[0]!.externalThreadRef).toBe('https://example.com/1');
    expect(events[1]!.messageId).toBe('https://example.com/2');
  });

  it('Atom：entry 翻译，messageId=id（缺 id 退 link）', () => {
    const events = eventsOf(rssAdapter.translate(ATOM_SAMPLE));
    expect(events).toHaveLength(1);
    expect(events[0]!.messageId).toBe('urn:uuid:a1');
    expect(events[0]!.subject).toBe('Atom Entry');
    expect(events[0]!.content).toBe('Atom body');
  });

  it('无 guid 且无 link 的 item 跳过（没有稳定 id 就不声称幂等）', () => {
    const xml = '<rss version="2.0"><channel><item><title>orphan</title><description>x</description></item></channel></rss>';
    expect(eventsOf(rssAdapter.translate(xml))).toHaveLength(0);
  });

  it('坏 XML / 空 feed → 空数组（不抛，ingest 记 lastError）', () => {
    expect(eventsOf(rssAdapter.translate('this is not xml'))).toEqual([]);
    expect(eventsOf(rssAdapter.translate('<rss version="2.0"><channel></channel></rss>'))).toEqual([]);
  });

  it('同 guid 重复出现 → 同 messageId（幂等输入稳定）', () => {
    const a = eventsOf(rssAdapter.translate(RSS_SAMPLE))[0]!;
    const b = eventsOf(rssAdapter.translate(RSS_SAMPLE))[0]!;
    expect(a.messageId).toBe(b.messageId);
  });
});
