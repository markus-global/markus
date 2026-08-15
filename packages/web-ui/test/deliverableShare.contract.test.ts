/**
 * 跨端契约一致性测试（客户端 ↔ Hub）。
 *
 * 背景（见 QA 联调 tsk_84bc6db0ebf59752061dc3e5 报告 §2.3/§2.4）：
 * 双端各自用「自我一致的 mock」单测全绿，却掩盖了真实跨端契约不一致：
 *   - publish 请求字段：客户端曾发 `localId`，而 Hub 只读 `localDeliverableId`
 *   - 响应字段：客户端曾读 `id`/`url`，而 Hub publish 返回 `shareId`/`shareUrl`、
 *     status 返回 { share: publicDto }（含 id/slug，无 url）
 *
 * 本测试以 **Hub 真实响应形状**（取自 markus-hub-wt-billing
 * src/server/routes/deliverables.ts 的 publicDto/返回值）作为契约基准，驱动
 * 客户端 service，验证修复后字段对齐与端到端主流程闭环由这些真实形状成立。
 * 防止「self-consistent mock」再次掩盖跨端不一致。
 */
import { describe, it, expect } from 'vitest';
import { DeliverableShareService, type DeliverableShareRecord } from '../src/lib/deliverableShare.ts';

// 契约基准：Hub 真实响应形状（与 markus-hub-wt-billing deliverables.ts 对齐）。
// publish 成功（201）
const HUB_PUBLISH_RESPONSE = {
  ok: true, alreadyShared: false,
  shareId: 'dlv_share_contract_1',
  slug: 'industry-report-ai-2026',
  status: 'pending_review',
  shareUrl: 'https://hub.example/deliverable/industry-report-ai-2026',
};
// publish 重复（200，去重）
const HUB_PUBLISH_ALREADY = {
  ok: true, alreadyShared: true,
  shareId: 'dlv_share_contract_1',
  slug: 'industry-report-ai-2026',
  status: 'published',
  shareUrl: 'https://hub.example/deliverable/industry-report-ai-2026',
};
// status → { share: publicDto }（publicDto 含 id/slug，无 url）
const HUB_STATUS_PUBLISHED = {
  share: {
    id: 'dlv_share_contract_1', slug: 'industry-report-ai-2026',
    ownerUserId: 'u1', ownerName: 'u1', title: 'x', summary: null, content: null,
    format: 'markdown', tags: [], visibility: 'public', status: 'published',
    producerAgentId: null, producerAgentName: null, producerAgentSource: null,
    createdAt: '2026-01-01T00:00:00Z', publishedAt: '2026-01-01T00:00:00Z',
    fileUrl: 'https://hub.example/api/deliverables/industry-report-ai-2026/file',
  },
};
// revoke → { ok:true, revokedIds:[...] }
const HUB_REVOKE_RESPONSE = { ok: true, revokedIds: ['dlv_share_contract_1'] };

function mockFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return {
      ok: status >= 200 && status < 300, status, statusText: `HTTP ${status}`,
      json: async () => body,
    } as Response;
  }) as typeof fetch & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

const input = {
  localId: 'dlv_local_contract_1',
  title: '行业调研报告：AI Agent 2026',
  summary: '摘要',
  tags: ['AI'],
  visibility: 'public' as const,
  filename: 'report.md',
  format: 'markdown',
  producerAgent: { id: 'agt_1', name: 'agt_1', source: 'local' as const },
};

const HUB = 'https://hub.example';

describe('跨端契约一致性（客户端 ← 真实 Hub 响应形状）', () => {
  it('publish 发送 localDeliverableId 字段（Hub 读取的契约字段）', async () => {
    const fn = mockFetch(HUB_PUBLISH_RESPONSE, 201);
    const s = new DeliverableShareService({ getHubToken: () => 'tok', hubUrl: HUB, fetch: fn });
    const r = await s.publish(input);
    const body = JSON.parse(String(fn.calls[0].init.body));
    expect(body.localDeliverableId).toBe('dlv_local_contract_1');
    expect(r.id).toBe('dlv_share_contract_1');
    expect(r.url).toBe('https://hub.example/deliverable/industry-report-ai-2026');
  });

  it('重复分享去重返回 alreadyShared=true 并回显 shareId/shareUrl', async () => {
    const fn = mockFetch(HUB_PUBLISH_ALREADY, 200);
    const s = new DeliverableShareService({ getHubToken: () => 'tok', hubUrl: HUB, fetch: fn });
    const r = await s.publish(input);
    expect(r.id).toBe('dlv_share_contract_1');
    expect(r.status).toBe('published');
    expect(r.url).toBe('https://hub.example/deliverable/industry-report-ai-2026');
  });

  it('pollStatus 由 {share:{id,slug}} 无 url 的 publicDto 兜底构造公开链接', async () => {
    const fn = mockFetch(HUB_STATUS_PUBLISHED, 200);
    const s = new DeliverableShareService({ getHubToken: () => 'tok', hubUrl: HUB, fetch: fn });
    const r = await s.pollStatus('dlv_local_contract_1');
    expect(r.status).toBe('published');
    expect(r.id).toBe('dlv_share_contract_1');
    expect(r.url).toBe('https://hub.example/deliverable/industry-report-ai-2026');
  });

  it('完整主流程：publish → 去重 → pollStatus 回显 published+链接 → revoke', async () => {
    const responses = [
      HUB_PUBLISH_RESPONSE,     // publish
      HUB_PUBLISH_ALREADY,      // 重复 publish
      HUB_STATUS_PUBLISHED,     // pollStatus
      HUB_REVOKE_RESPONSE,      // revoke
    ];
    let i = 0;
    const fn = (async () => {
      const body = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return { ok: true, status: 200, statusText: 'OK', json: async () => body } as Response;
    }) as typeof fetch;

    const s = new DeliverableShareService({ getHubToken: () => 'tok', hubUrl: HUB, fetch: fn });

    const p1: DeliverableShareRecord = await s.publish(input);
    expect(p1.status).toBe('pending_review');
    expect(p1.url).toBe('https://hub.example/deliverable/industry-report-ai-2026');

    const p2: DeliverableShareRecord = await s.publish(input);
    expect(p2.status).toBe('published');
    expect(p2.url).toBe('https://hub.example/deliverable/industry-report-ai-2026');

    const poll: DeliverableShareRecord = await s.pollStatus(input.localId);
    expect(poll.status).toBe('published');
    expect(poll.id).toBe('dlv_share_contract_1');
    expect(poll.url).toBe('https://hub.example/deliverable/industry-report-ai-2026');

    const rv: DeliverableShareRecord = await s.revoke(input.localId);
    expect(rv.status).toBe('revoked');
    expect(rv.url).toBeNull();
  });
});
