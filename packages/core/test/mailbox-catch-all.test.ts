/**
 * 第六刀 C3 —— I3 / V4 / V5 / V6：**没有第三种「悄悄丢掉」**。
 *
 * 这些断言回答的问题是旧系统答不出来的那一个：
 * 「一条投不进去的信号，最后在哪儿、为什么、有几个人能看到？」
 *
 * 三条硬性质（每一条都能被实现改坏）：
 *  1. 构造无收件人信号 → 恰一行 `catch_all`，带 `drop_reason` 与 `bounce_target`，
 *     且在 catch-all 概览里**恰好出现一次**；
 *  2. 同一 messageId 连投两次 → 恰一条 queued + 一条 `duplicate_message_id` 退信；
 *  3. **任何路径都不再写 `dropped`** —— 用记录型持久层逐次断言，这是行为守卫，
 *     不是源码文本守卫（重命名不会让它失效）。
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentMailbox, type MailboxPersistence } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';
import { createMailboxTools, type MailboxToolContext } from '../src/tools/mailbox-tools.js';
import { imAddressRef, agentAddressRef, type MailboxItem } from '@markus/shared';

/** 记录每一次状态写入的持久层：既做存储，也做取证。 */
class RecordingStore implements MailboxPersistence {
  queued = new Map<string, MailboxItem>();
  /** 所有落过库的行（含退信行）—— 取证要看它们。 */
  all = new Map<string, MailboxItem>();
  rows = new Map<string, { status: string; dropReason?: string; bounceTarget?: string }>();
  writes: Array<{ id: string; status: string; dropReason?: string }> = [];

  save(item: MailboxItem): boolean {
    if (this.queued.has(item.id)) return false;
    this.queued.set(item.id, item);
    this.all.set(item.id, item);
    this.rows.set(item.id, { status: item.status });
    return true;
  }

  getStatus(itemId: string) {
    return this.rows.get(itemId)?.status as never;
  }

  updateStatus(itemId: string, status: any, extra?: Partial<MailboxItem>): void {
    this.writes.push({ id: itemId, status, dropReason: extra?.dropReason as string | undefined });
    const row = this.rows.get(itemId) ?? { status: 'queued' };
    row.status = status;
    if (extra?.dropReason) row.dropReason = extra.dropReason as string;
    if (extra?.bounceTarget) row.bounceTarget = extra.bounceTarget as string;
    this.rows.set(itemId, row);
  }

  findByMessageId(_agentId: string, messageId: string) {
    for (const [id, item] of this.queued) {
      const row = this.rows.get(id);
      if (row && (row.status === 'bounced' || row.status === 'catch_all')) continue;
      if (item.envelope?.messageId === messageId) {
        return { id, status: row?.status ?? 'queued', claimedBy: null, leaseUntil: null, queuedAt: item.queuedAt };
      }
    }
    return undefined;
  }

  saveBounced(item: MailboxItem, dropReason: string): void {
    this.all.set(item.id, item);
    this.rows.set(item.id, { status: 'bounced', dropReason, bounceTarget: undefined });
  }

  loadQueued(): MailboxItem[] { return []; }
  loadDeferred(): MailboxItem[] { return []; }
  requeueItem(itemId: string): boolean {
    const row = this.rows.get(itemId);
    if (!row) return false;
    row.status = 'queued';
    row.dropReason = undefined;
    row.bounceTarget = undefined;
    return true;
  }

  /** catch-all 概览：按 bounce_target 取，且同一 messageId 只算一条。 */
  listCatchAll(agentId: string) {
    const seen = new Set<string>();
    const items: Array<{ id: string; status: string; dropReason: string | null; bounceTarget: string | null }> = [];
    for (const [id, row] of this.rows) {
      if (!row.bounceTarget) continue;
      const item = this.all.get(id);
      const key = item?.envelope?.messageId ?? id;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ id, status: row.status, dropReason: row.dropReason ?? null, bounceTarget: row.bounceTarget });
    }
    return { items, legacyDropped: 0 };
  }

  findRouteByMessageId(_agentId: string, messageId: string) {
    const out: Array<Record<string, unknown>> = [];
    for (const [id, item] of this.all) {
      if (item.envelope?.messageId !== messageId) continue;
      const row = this.rows.get(id);
      out.push({
        id,
        status: row?.status ?? 'queued',
        dropReason: row?.dropReason ?? null,
        bounceTarget: row?.bounceTarget ?? null,
        messageId,
      });
    }
    return out;
  }
}

function makeBox() {
  const store = new RecordingStore();
  const bus = new EventBus();
  const box = new AgentMailbox('agt_a', bus, store);
  return { box, store, bus };
}

/** 没有任何 active 绑定的地址簿：所有 markus 地址都解析失败。 */
const emptyBook = { findActive: () => undefined };

describe('I3 / V4 — 无收件人信号必须退信并归集（不再静默丢弃）', () => {
  it('to 解析不到绑定 → bounced(no_active_target) → catch_all，概览里恰好一次', () => {
    const { box, store } = makeBox();
    box.setAddressLookup(emptyBook);

    const item = box.enqueue('human_chat', { summary: 'hi', content: 'hello?' }, {
      origin: {
        from: imAddressRef('feishu', 'u1'),
        messageId: 'native-ghost',
        to: { kind: 'markus', address: 'ghost.acme@markus.global', local: 'ghost', orgSlug: 'acme' },
      },
    });

    // 终态是归集态，而不是“消失了”
    expect(item.status).toBe('catch_all');
    expect(item.dropReason).toBe('no_active_target');
    expect(item.bounceTarget).toBe('catchall:agt_a');

    // 队列里没有它（不是悄悄变成 queued 等着被处理）
    expect(box.depth).toBe(0);

    // 概览里恰好可见一次，且原因可查
    const overview = box.catchAll() as { items: Array<{ dropReason: string | null }> };
    expect(overview.items).toHaveLength(1);
    expect(overview.items[0]!.dropReason).toBe('no_active_target');

    // 迁移路径真实经过 bounced → catch_all（不是一步跳到终态）
    const statuses = store.writes.filter(w => w.id === item.id).map(w => w.status);
    expect(statuses).toEqual(['bounced', 'catch_all']);
  });

  it('to 是外部域/IM 身份 → unresolved_address（不是猜一个收件人）', () => {
    const { box } = makeBox();
    const item = box.enqueue('human_chat', { summary: 'x', content: 'y' }, {
      origin: { from: imAddressRef('feishu', 'u2'), messageId: 'native-ext', to: { kind: 'external', address: 'a@b.com' } },
    });
    expect(item.status).toBe('catch_all');
    expect(item.dropReason).toBe('unresolved_address');
  });

  it('to 指向别的 agent → 本邮箱不是收件人，同样退信（不允许错投给能收的人）', () => {
    const { box } = makeBox();
    const item = box.enqueue('human_chat', { summary: 'x', content: 'y' }, {
      origin: { from: imAddressRef('feishu', 'u3'), messageId: 'native-other', to: agentAddressRef('agt_b') },
    });
    expect(item.status).toBe('catch_all');
    expect(item.dropReason).toBe('no_active_target');
  });

  it('I2 回归：改 payload.extra 内容 / 换 sourceType，解析结果不变（只读信封）', () => {
    const { box } = makeBox();
    box.setAddressLookup(emptyBook);
    const to = { kind: 'markus' as const, address: 'ghost.acme@markus.global', local: 'ghost', orgSlug: 'acme' };

    const a = box.enqueue('human_chat', {
      summary: 'x', content: 'y',
      extra: { triggerExecution: true, actionRequired: true, round: 7, round2: 9 },
    }, { origin: { from: imAddressRef('feishu', 'u4'), messageId: 'i2-a', to } });

    const b = box.enqueue('task_status_update', {
      summary: 'x', content: 'y',
      extra: { triggerExecution: false, actionRequired: false, round: 0 },
    }, { origin: { from: imAddressRef('feishu', 'u5'), messageId: 'i2-b', to } });

    // 载荷喊得再响也不改变「投不进去」这个事实
    expect(a.status).toBe('catch_all');
    expect(b.status).toBe('catch_all');
    expect(a.dropReason).toBe(b.dropReason);
    expect(a.bounceTarget).toBe(b.bounceTarget);
  });

  it('V6 归属可解析：地址被撤销后投递进 catch-all（no_active_target）', () => {
    const { box, store } = makeBox();
    const addr = 'alice.acme@markus.global';
    let active: { agentId: string; targetRef: string } | undefined = { agentId: 'agt_a', targetRef: 'agent:agt_a' };
    box.setAddressLookup({ findActive: (a) => (a === addr ? active : undefined) });

    const ok = box.enqueue('human_chat', { summary: 'ok', content: 'delivered' }, {
      origin: { from: imAddressRef('feishu', 'u6'), messageId: 'v6-ok', to: { kind: 'markus', address: addr, local: 'alice', orgSlug: 'acme' } },
    });
    expect(ok.status).toBe('queued');
    expect(box.depth).toBe(1);

    // 撤销后：同一个地址不再解析
    active = undefined;
    const bounced = box.enqueue('human_chat', { summary: 'gone', content: 'lost?' }, {
      origin: { from: imAddressRef('feishu', 'u7'), messageId: 'v6-gone', to: { kind: 'markus', address: addr, local: 'alice', orgSlug: 'acme' } },
    });
    expect(bounced.status).toBe('catch_all');
    expect(bounced.dropReason).toBe('no_active_target');
    expect(store.rows.get(bounced.id)!.bounceTarget).toBe('catchall:agt_a');
  });
});

describe('V5 — 同一 messageId 连投两次：恰一条 queued + 一条 duplicate_message_id 退信', () => {
  it('第二次投递不再静默 suppressed，而是写一条可查的退信行', () => {
    const { box } = makeBox();
    const first = box.enqueue('human_chat', { summary: 'a', content: 'one' }, {
      origin: { from: imAddressRef('feishu', 'u8'), messageId: 'dup-1' },
    });
    const second = box.enqueue('human_chat', { summary: 'a', content: 'two' }, {
      origin: { from: imAddressRef('feishu', 'u8'), messageId: 'dup-1' },
    });

    expect(first.status).toBe('queued');
    expect(second.status).toBe('bounced');
    expect(second.dropReason).toBe('duplicate_message_id');
    expect(box.depth).toBe(1);
  });
});

describe('唯一执行点 —— 任何路径都不写 dropped，且原因必填', () => {
  it('一次生命周期里的所有状态写入都在矩阵取值域内，且没有 dropped', () => {
    const { box, store } = makeBox();
    const keep = box.enqueue('human_chat', { summary: 'k', content: 'k' }, {
      origin: { from: imAddressRef('feishu', 'u9'), messageId: 'life-1' },
    });
    box.complete(keep.id);

    const drop = box.enqueue('task_status_update', { summary: 'd', content: 'd', taskId: 'tsk_1' }, {
      origin: { from: imAddressRef('feishu', 'u10'), messageId: 'life-2' },
    });
    box.drop(drop.id, 'stale');

    const statuses = store.writes.map(w => w.status);
    expect(statuses).not.toContain('dropped');
    expect(new Set(statuses)).toEqual(new Set(['completed', 'bounced', 'catch_all']));
    // 退信那次写入必须带原因（同一次写入，不留“终态无原因”的中间态）
    const bounceWrite = store.writes.find(w => w.status === 'bounced')!;
    expect(bounceWrite.dropReason).toBe('stale_signal');
  });

  it('drop 的终态是 catch_all + stale_signal（决策有回声，不是无声归档）', () => {
    const { box } = makeBox();
    const item = box.enqueue('task_status_update', { summary: 'd', content: 'd', taskId: 'tsk_2' });
    const out = box.drop(item.id, 'redundant');
    expect(out!.status).toBe('catch_all');
    expect(out!.dropReason).toBe('stale_signal');
    expect(out!.bounceTarget).toBe('catchall:agt_a');
  });
});

describe('message_route / catch_all 工具面（Agent 自助取证）', () => {
  function toolCtx(box: AgentMailbox): MailboxToolContext {
    return {
      agentId: 'agt_a',
      getMindState: () => ({ attentionState: 'idle', mailboxDepth: 0, queuedItems: [], deferredItems: [], recentDecisions: [] } as never),
      deferItem: () => false,
      dropItem: () => false,
      prioritizeItem: () => false,
      updateWorkingMemory: () => ({ status: 'ok', key: 'k' }),
      clearWorkingMemory: () => ({ status: 'ok', cleared: 0 }),
      getWorkingMemorySnapshot: () => [],
      routeOfMessage: (id) => box.routeOfMessage(id),
      catchAll: () => box.catchAll(),
    };
  }

  it('message_route 能回答「这条消息到哪了/为什么没到」', async () => {
    const { box } = makeBox();
    box.setAddressLookup(emptyBook);
    box.enqueue('human_chat', { summary: 'x', content: 'y' }, {
      origin: {
        from: imAddressRef('feishu', 'u11'),
        messageId: 'route-1',
        to: { kind: 'markus', address: 'ghost.acme@markus.global', local: 'ghost', orgSlug: 'acme' },
      },
    });

    const tool = createMailboxTools(toolCtx(box)).find(t => t.name === 'message_route')!;
    const out = JSON.parse(await tool.execute({ message_id: 'route-1' }));
    expect(out.status).toBe('ok');
    expect(out.count).toBeGreaterThanOrEqual(1);
    expect(out.routes[0].dropReason).toBe('no_active_target');
    expect(out.routes[0].status).toBe('catch_all');
  });

  it('message_route 对不存在的 messageId 诚实回 not_found（不编造）', async () => {
    const { box } = makeBox();
    const tool = createMailboxTools(toolCtx(box)).find(t => t.name === 'message_route')!;
    const out = JSON.parse(await tool.execute({ message_id: 'nope' }));
    expect(out.status).toBe('not_found');
    expect(out.count).toBe(0);
  });

  it('catch_all 工具返回概览（含 legacyDropped 计数，不把旧行伪装成有原因的行）', async () => {
    const { box } = makeBox();
    box.setAddressLookup(emptyBook);
    box.enqueue('human_chat', { summary: 'x', content: 'y' }, {
      origin: {
        from: imAddressRef('feishu', 'u12'),
        messageId: 'ov-1',
        to: { kind: 'markus', address: 'ghost.acme@markus.global', local: 'ghost', orgSlug: 'acme' },
      },
    });
    const tool = createMailboxTools(toolCtx(box)).find(t => t.name === 'catch_all')!;
    const out = JSON.parse(await tool.execute({}));
    expect(out.status).toBe('ok');
    expect(out.items).toHaveLength(1);
    expect(out.legacyDropped).toBe(0);
  });

  it('未接线时两个工具不注册（不造空能力）', () => {
    const ctx: MailboxToolContext = {
      agentId: 'agt_a',
      getMindState: () => ({ attentionState: 'idle', mailboxDepth: 0, queuedItems: [], deferredItems: [], recentDecisions: [] } as never),
      deferItem: () => false,
      dropItem: () => false,
      prioritizeItem: () => false,
      updateWorkingMemory: () => ({ status: 'ok', key: 'k' }),
      clearWorkingMemory: () => ({ status: 'ok', cleared: 0 }),
      getWorkingMemorySnapshot: () => [],
    };
    const names = createMailboxTools(ctx).map(t => t.name);
    expect(names).not.toContain('message_route');
    expect(names).not.toContain('catch_all');
  });
});

describe('非法迁移被执行点拒绝（而不是默默写出一个矩阵里没有的边）', () => {
  it('completed 行不会再被写回 queued', () => {
    const { box, store } = makeBox();
    const item = box.enqueue('human_chat', { summary: 'c', content: 'c' }, {
      origin: { from: imAddressRef('feishu', 'u13'), messageId: 'illegal-1' },
    });
    box.complete(item.id);
    const before = store.writes.length;

    // 走公开面把已收口的项再 drop：执行点必须拒绝（completed → bounced 不在矩阵里）
    box.drop(item.id, 'too-late');
    const illegal = store.writes.slice(before).map(w => w.status);
    expect(illegal).not.toContain('bounced');
    expect(store.rows.get(item.id)!.status).toBe('completed');
  });

  /**
   * 下面两条是「ghost 盲写」家族的第二、第三条出口。
   *
   * 第一条（`drop()`）已在 C3 修过；`complete()` / `requeue()` 当时仍然**不读真实状态**就写
   * 终态，于是一条已归集（catch_all）的行可以被“完成”、一条 completed 的行可以被“重试”。
   * 同一个根因（不读 from 就写终态）的三个出口——统一走 `updateSignalStatus(from)` 之后，
   * 矩阵才是真正拦得住它们的地方。
   */
  it('complete() 在行不在内存时用持久层真实状态：catch_all 行不会被改写成 completed', () => {
    const { box, store } = makeBox();
    store.rows.set('mbx_ghost', { status: 'catch_all', bounceTarget: 'catchall:agt_a' });

    box.complete('mbx_ghost');

    expect(store.rows.get('mbx_ghost')!.status).toBe('catch_all');
    expect(store.writes.some(w => w.id === 'mbx_ghost')).toBe(false);
  });

  it('requeue() 不复活已收口行：completed 行不会被写回 queued，也不入队', () => {
    const { box, store } = makeBox();
    store.rows.set('mbx_done', { status: 'completed' });
    const done: MailboxItem = {
      id: 'mbx_done',
      agentId: 'agt_a',
      sourceType: 'human_chat',
      priority: 5,
      status: 'completed' as MailboxItem['status'],
      payload: { summary: 'done', content: 'done' },
      queuedAt: new Date().toISOString(),
    };

    box.requeue(done);

    expect(store.rows.get('mbx_done')!.status).toBe('completed');
    expect(box.depth).toBe(0);
    expect(store.writes.some(w => w.id === 'mbx_done')).toBe(false);
  });

  it('正向对照：processing 行仍能被 complete() 正常收口（守卫不误杀合法路径）', () => {
    const { box, store } = makeBox();
    const item = box.enqueue('human_chat', { summary: 'x', content: 'y' }, {
      origin: { from: imAddressRef('feishu', 'u14'), messageId: 'ok-1' },
    });
    expect(item.status).toBe('queued');

    const dequeued = box.dequeue();
    expect(dequeued?.id).toBe(item.id);
    expect(store.rows.get(item.id)!.status).toBe('processing');

    box.complete(item.id);
    expect(store.rows.get(item.id)!.status).toBe('completed');
  });
});

// 避免未使用告警：vi 在本文件里保留给未来断言使用
void vi;
