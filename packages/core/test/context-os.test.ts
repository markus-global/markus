import { describe, it, expect, vi } from 'vitest';
import { ContextEngine } from '../src/context-engine.js';
import { MemoryStore } from '../src/memory/store.js';
import { createSessionTool, normalizeSessionArgs } from '../src/tools/session.js';
import type { SessionToolContext } from '../src/tools/session.js';
import { buildSlotSegment } from '../src/context-slot.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'contextos-'));
  return dir;
}

function makeMsg(role: string, content: string, i: number): MessageLike {
  return { role, content, toolCallId: `t${i}` };
}
type Role = 'system' | 'user' | 'assistant' | 'tool';
interface MessageLike { role: string; content: string; toolCallId?: string }

function storeWithMessages(msgs: MessageLike[]): MemoryStore {
  const dir = tempDir();
  const store = new MemoryStore(dir);
  const session = store.createSession('agt-A');
  for (const m of msgs) store.appendMessage(session.id, m as never);
  return store;
}

describe('context-engine — ContextOS usage hint & slot preservation', () => {
  it('prepareMessages 高占用时返回 [CONTEXT] hint，超 WARN 阈值含 WARN', async () => {
    const engine = new ContextEngine();
    const store = storeWithMessages([]);
    // Force high usage: large history relative to a small window
    const bigHistory: MessageLike[] = [];
    for (let i = 0; i < 60; i++) {
      bigHistory.push(
        { role: 'user', content: `Long user turn with repeated text padding ${'x'.repeat(600)} #${i}` },
        { role: 'tool', content: `Result ${'y'.repeat(800)} ${i}` },
      );
    }
    const prepared = await engine.prepareMessages({
      systemPrompt: 'You are an agent.',
      sessionMessages: bigHistory as never,
      memory: store,
      sessionId: 'sess_x',
      modelContextWindow: 8000,
      toolDefinitions: [],
    });
    expect(prepared.contextHint).toBeDefined();
    expect(prepared.contextHint).toContain('[CONTEXT');
  });

  it('低占用时不触发 WARN（usage below warning threshold）', async () => {
    const engine = new ContextEngine();
    const store = storeWithMessages([]);
    const prepared = await engine.prepareMessages({
      systemPrompt: 'You are an agent.',
      sessionMessages: [{ role: 'user', content: 'hi' }] as never,
      memory: store,
      sessionId: 'sess_x',
      modelContextWindow: 200_000,
      toolDefinitions: [],
    });
    expect(prepared.contextHint).toContain('[CONTEXT');
  });

  it('slotsSegment（固定段 C）注入 system 且不混入可变段 history', async () => {
    const engine = new ContextEngine();
    const store = storeWithMessages([]);
    const slots = '[SLOTS] (agent-managed, not compacted)\n· goal: land context-os';
    const prepared = await engine.prepareMessages({
      systemPrompt: 'You are an agent.',
      sessionMessages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
      ] as never,
      memory: store,
      sessionId: 'sess_x',
      modelContextWindow: 100_000,
      slotsSegment: slots,
      toolDefinitions: [],
    });
    // Slot appears in the system message (fixed段), NOT as a standalone variable message
    const sysMsg = prepared.messages[0] as { role: string; content: string };
    expect(sysMsg.role).toBe('system');
    expect(sysMsg.content).toContain('goal: land context-os');
    // Slots must not leak into non-system messages
    for (const m of prepared.messages.slice(1)) {
      const c = (m as { content?: string }).content;
      if (typeof c === 'string') expect(c).not.toContain('[SLOTS] (agent-managed');
    }
  });

  it('8/20 复现：压缩/截断后 pin 锚点仍保留（可变段被压缩但固定槽位不丢）', async () => {
    const engine = new ContextEngine();
    const store = storeWithMessages([]);
    const session = store.createSession('agt-A');
    // A long history that will exceed a tight budget → triggers compaction
    for (let i = 0; i < 80; i++) {
      store.appendMessage(session.id, { role: 'user', content: `turn ${i} ${'z'.repeat(500)}` } as never);
    }
    // Pin a goal anchor via slotStore (survives compaction because it's outside messages)
    store.setSlot(session.id, 'goal', 'land ContextOS anchor');
    const slots = store.serializeSlots(session.id);
    expect(slots).toContain('goal: land ContextOS anchor');

    const prepared = await engine.prepareMessages({
      systemPrompt: 'You are an agent.',
      sessionMessages: store.getRecentMessages(session.id, 1000),
      memory: store,
      sessionId: session.id,
      agentId: 'agt-A',
      modelContextWindow: 6000, // very tight → forces compaction/trim
      slotsSegment: slots,
      toolDefinitions: [],
    });

    // The anchor must remain in the fixed system segment even after compaction
    const sysMsg = prepared.messages[0] as { role: string; content: string };
    expect(sysMsg.content).toContain('goal: land ContextOS anchor');
    // And the slot must still be readable from the store (not deleted)
    expect(store.serializeSlots(session.id)).toContain('goal: land ContextOS anchor');
  });
});

describe('context-slot — buildSlotSegment', () => {
  it('序列化槽位为固定段文本', () => {
    const seg = buildSlotSegment([
      { key: 'goal', text: 'land it', updatedAt: 0 },
      { key: 'done', text: 'step 1', updatedAt: 0 },
    ]);
    expect(seg).toContain('[SLOTS]');
    expect(seg).toContain('goal: land it');
    expect(seg).toContain('done: step 1');
  });
  it('空槽返回空串', () => {
    expect(buildSlotSegment([])).toBe('');
  });
});

// =============================================================================
// tools-session — 6-op family (pin/unpin/retrieve/include/purge/status)
// =============================================================================

function makeSession(over: Record<string, unknown> = {}): { id: string; agentId: string; [k: string]: unknown } {
  return { id: 'cs-1', agentId: 'agt-A', title: 'Main', ...over };
}

function makeCtx(over: Partial<SessionToolContext> = {}): SessionToolContext {
  return {
    agentId: 'agt-A',
    chatSessionRepo: {
      listSessionsPaginated: vi.fn(() => ({ sessions: [makeSession()], total: 1, page: 1, pageSize: 20, hasMore: false })),
      getSession: vi.fn(() => makeSession()),
      listMessagesPaginated: vi.fn(() => ({ messages: [], total: 0, page: 1, pageSize: 50, hasMore: false })),
      countMessagesByAgent: vi.fn(() => 0),
    } as never,
    ...over,
  };
}

describe('session normalize — ContextOS ops', () => {
  it('识别 pin/unpin/include/retrieve/purge/status', () => {
    expect(normalizeSessionArgs({ operation: 'pin', session_id: 'cs-1', key: 'goal', content: 'x' })).toMatchObject({ operation: 'pin', sessionId: 'cs-1', key: 'goal', content: 'x' });
    expect(normalizeSessionArgs({ operation: 'unpin', session_id: 'cs-1', key: 'goal' })).toMatchObject({ operation: 'unpin', sessionId: 'cs-1', key: 'goal' });
    expect(normalizeSessionArgs({ operation: 'retrieve', session_id: 'cs-1', query: 'file' })).toMatchObject({ operation: 'retrieve', sessionId: 'cs-1', query: 'file' });
    expect(normalizeSessionArgs({ operation: 'include', session_id: 'cs-1', fragment_id: 'frag_1' })).toMatchObject({ operation: 'include', fragmentId: 'frag_1' });
    expect(normalizeSessionArgs({ operation: 'purge', session_id: 'cs-1' })).toMatchObject({ operation: 'purge', sessionId: 'cs-1' });
    expect(normalizeSessionArgs({ operation: 'status', session_id: 'cs-1' })).toMatchObject({ operation: 'status', sessionId: 'cs-1' });
  });
});

describe('session pin/unpin', () => {
  it('pin 写入槽位并返回 ok；unpin 移除', async () => {
    const slots = new Map<string, string>();
    const slotStore = {
      getSlots: () => [...slots.entries()].map(([key, text]) => ({ key, text })),
      setSlot: (sid: string, k: string, v: string) => { slots.set(k, v); },
      removeSlot: (sid: string, k: string) => { slots.delete(k); },
      serialize: () => '',
    };
    const ctx = makeCtx({ slotStore: slotStore as never });
    const tool = createSessionTool(ctx);
    const pinRes = JSON.parse(await tool.execute({ operation: 'pin', session_id: 'cs-1', key: 'goal', content: 'land anchor' }));
    expect(pinRes.status).toBe('ok');
    expect(slots.get('goal')).toBe('land anchor');
    const unpinRes = JSON.parse(await tool.execute({ operation: 'unpin', session_id: 'cs-1', key: 'goal' }));
    expect(unpinRes.status).toBe('ok');
    expect(slots.has('goal')).toBe(false);
  });

  it('pin 他人 session → forbidden', async () => {
    const repo = { getSession: vi.fn(() => makeSession({ agentId: 'agt-OTHER' })) } as never;
    const slotStore = { setSlot: vi.fn(), getSlots: vi.fn(() => []), removeSlot: vi.fn(), serialize: vi.fn(() => '') } as never;
    const ctx = makeCtx({ chatSessionRepo: repo, slotStore });
    const res = JSON.parse(await createSessionTool(ctx).execute({ operation: 'pin', session_id: 'cs-other', key: 'goal', content: 'x' }));
    expect(res.status).toBe('forbidden');
  });

  it('无 slotStore 注入时报错', async () => {
    const ctx = makeCtx();
    const res = JSON.parse(await createSessionTool(ctx).execute({ operation: 'pin', session_id: 'cs-1', key: 'goal', content: 'x' }));
    expect(res.status).toBe('error');
  });
});

describe('session compact with anchor (compactWithAnchor)', () => {
  it('compact 带 goal/done/next → 走 compactWithAnchor 并回传 anchorKey', async () => {
    const repo = { getSession: vi.fn(() => makeSession()) } as never;
    const compactor = {
      compactOnDemand: vi.fn(() => ({ summary: 's', flushedCount: 1 })),
      compactWithAnchor: vi.fn(() => ({ summary: 's', flushedCount: 2, anchorKey: 'goal,next' })),
    };
    const ctx = makeCtx({ chatSessionRepo: repo as never, compactor: compactor as never });
    const res = JSON.parse(await createSessionTool(ctx).execute({ operation: 'compact', session_id: 'cs-1', goal: 'g', next: 'n' }));
    expect(res.status).toBe('ok');
    expect(compactor.compactWithAnchor).toHaveBeenCalledWith(
      'cs-1', 40, { goal: 'g', done: undefined, next: 'n' },
    );
    expect(res.anchored_as).toBe('goal,next');
  });

  it('compact 无 anchor → 回退 compactOnDemand', async () => {
    const repo = { getSession: vi.fn(() => makeSession()) } as never;
    const compactor = {
      compactOnDemand: vi.fn(() => ({ summary: 's', flushedCount: 1 })),
      compactWithAnchor: vi.fn(),
    };
    const ctx = makeCtx({ chatSessionRepo: repo as never, compactor: compactor as never });
    const res = JSON.parse(await createSessionTool(ctx).execute({ operation: 'compact', session_id: 'cs-1', keep_last: 10 }));
    expect(res.status).toBe('ok');
    expect(compactor.compactOnDemand).toHaveBeenCalledWith('cs-1', 10);
    expect(compactor.compactWithAnchor).not.toHaveBeenCalled();
  });
});

describe('session retrieve/include/purge', () => {
  const fragments = [
    { id: 'frag_1', content: 'file_read of RightPanel.tsx showed line 42', metadata: { sessionId: 'cs-1' } },
    { id: 'frag_2', content: 'DeliverableShareModal width fixed', metadata: { sessionId: 'cs-1' } },
  ];
  const fragmentStore = {
    retrieveFragments: vi.fn((q: string) => fragments.filter((f) => f.content.toLowerCase().includes(q.toLowerCase()))),
    includeFragment: vi.fn((sid: string, fid: string) => ({ ok: true, message: `reinjected ${fid}` })),
    purgeSessionFragments: vi.fn(() => 2),
    sessionStats: vi.fn(() => ({ messageCount: 10, slotKeys: ['goal'], fragmentCount: 2 })),
  };
  const repo = { getSession: vi.fn(() => makeSession()) } as never;

  it('retrieve 按关键词命中', async () => {
    const ctx = makeCtx({ chatSessionRepo: repo, fragmentStore: fragmentStore as never });
    const res = JSON.parse(await createSessionTool(ctx).execute({ operation: 'retrieve', session_id: 'cs-1', query: 'RightPanel' }));
    expect(res.status).toBe('ok');
    expect(res.hits.length).toBe(1);
    expect(res.hits[0].id).toBe('frag_1');
  });

  it('include 需要有 session_id + fragment_id，且校验归属', async () => {
    const ctx = makeCtx({ chatSessionRepo: repo, fragmentStore: fragmentStore as never });
    const res = JSON.parse(await createSessionTool(ctx).execute({ operation: 'include', session_id: 'cs-1', fragment_id: 'frag_1' }));
    expect(res.status).toBe('ok');
  });

  it('purge 移除归档', async () => {
    const ctx = makeCtx({ chatSessionRepo: repo, fragmentStore: fragmentStore as never });
    const res = JSON.parse(await createSessionTool(ctx).execute({ operation: 'purge', session_id: 'cs-1' }));
    expect(res.status).toBe('ok');
    expect(res.purgedFragments).toBe(2);
  });

  it('status 返回快照（只读，归属即可）', async () => {
    const slotStore = { getSlots: vi.fn(() => [{ key: 'goal', text: 'x' }]), setSlot: vi.fn(), removeSlot: vi.fn(), serialize: vi.fn(() => '') } as never;
    const ctx = makeCtx({ chatSessionRepo: repo, fragmentStore: fragmentStore as never, slotStore });
    const res = JSON.parse(await createSessionTool(ctx).execute({ operation: 'status', session_id: 'cs-1' }));
    expect(res.status).toBe('ok');
    expect(res.messageCount).toBe(10);
    expect(res.fragmentCount).toBe(2);
    expect(res.slots).toContain('goal');
  });
});

describe('MemoryStore — slot + fragment integrity', () => {
  it('pin 后 compaction 不冲掉 slot；unpin 才移除', () => {
    const store = storeWithMessages([
      { role: 'user', content: 'start' },
      { role: 'tool', content: 'res' },
    ]);
    const session = store.getLatestSession('agt-A')!;
    store.setSlot(session.id, 'goal', 'keep me');
    // Force a compaction via compactSession
    for (let i = 0; i < 60; i++) store.appendMessage(session.id, { role: 'user', content: `pad ${i} ${'p'.repeat(300)}` } as never);
    store.compactSession(session.id, 10);
    // Slot survives compaction (stored outside messages)
    expect(store.serializeSlots(session.id)).toContain('keep me');
    // unpin removes it
    store.removeSlot(session.id, 'goal');
    expect(store.serializeSlots(session.id)).not.toContain('keep me');
  });

  it('compactSession 落 conversation_fragment 存档（不删除原始数据）', () => {
    const store = storeWithMessages([]);
    const session = store.createSession('agt-A');
    for (let i = 0; i < 30; i++) store.appendMessage(session.id, { role: 'user', content: `turn ${i} content` } as never);
    store.compactSession(session.id, 5);
    const fragments = store.retrieveFragments('turn', 20);
    expect(fragments.length).toBeGreaterThan(0);
    expect(fragments[0].content).toContain('turn');
  });

  it('retrieveFragments 命中关键词', () => {
    const store = storeWithMessages([]);
    const session = store.createSession('agt-A');
    for (let i = 0; i < 20; i++) store.appendMessage(session.id, { role: 'user', content: `final ${i}` } as never);
    store.compactSession(session.id, 2);
    const hits = store.retrieveFragments('final 5', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain('final');
  });
});
