/**
 * 心跳去重 + 会话按天滚动 —— core 层验收测试
 *
 * 背景（老板 2026-09-18 反馈：心跳过密 / 大量垃圾会话）。两条根因与对策：
 *
 *   C · 心跳入队折叠
 *       心跳项不带任何实体维度（无 taskId / requirementId / senderId / sessionId /
 *       channelKey），`resolveEntityKeys` 会退化成 `system:<agentId>` —— 一把**全局单键**。
 *       并发模式下所有 worker 抢同一把锁，抢不到就 putBack + 退避重试
 *       （attention.ts concurrentWorkerLoop 的 conflict 分支）。实测同一分钟内堆 3 条心跳
 *       即产生 16 次 conflict，且每次成功处理都新开一个会话。
 *       对策：入队时若队里已有一条**未处理**的心跳，直接折叠（丢弃新触发，不合并内容）。
 *
 *   D · 心跳会话按天滚动
 *       原实现 `hb_<agentId>_<Date.now()>` 每次心跳都是全新 sessionId → 每次都新建并落盘
 *       一个会话文件。单 agent 累积 3268 个 hb_*.json（占其全部会话 76%，约 88 MiB），
 *       内容基本只有一句 HEARTBEAT_OK；且全库**没有任何**会话文件清理逻辑，只增不减。
 *       对策：改为按 UTC 天滚动，增长口径从「跟触发次数」变成「跟日历天数」。
 *       配套：`getLatestMainSession` 排除 hb_，避免滚动后心跳会话被重启路径当成主会话。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentMailbox } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';
import { heartbeatSessionId } from '../src/agent.js';
import { MemoryStore } from '../src/memory/store.js';

const HB = (content = 'Heartbeat triggered at T0') => ({
  summary: 'Scheduled heartbeat check-in',
  content,
});

function makeMailbox(agentId = 'agt_hb'): AgentMailbox {
  return new AgentMailbox(agentId, new EventBus());
}

// ─── C · 心跳入队折叠 ─────────────────────────────────────────────────────────

describe('C · 心跳入队折叠（消除并发 worker 抢 system 锁空转）', () => {
  it('队里已有一条未处理心跳时，第二条被折叠、不再入队', () => {
    const mailbox = makeMailbox();
    const first = mailbox.enqueue('heartbeat', HB());

    const second = mailbox.enqueue('heartbeat', HB('Heartbeat triggered at T1'));

    expect(mailbox.depth).toBe(1);
    // 返回的是**既有那条**，而不是新建的 item —— 折叠语义（不是合并语义）。
    expect(second.id).toBe(first.id);
  });

  it('折叠是「丢弃」而非「合并」：content 不被追加噪声', () => {
    const mailbox = makeMailbox();
    const first = mailbox.enqueue('heartbeat', HB('Heartbeat triggered at T0'));

    mailbox.enqueue('heartbeat', HB('Heartbeat triggered at NOISE'));

    expect(mailbox.depth).toBe(1);
    expect(first.payload.content).not.toContain('NOISE');
  });

  it('连续多条心跳始终只占一个队列位', () => {
    const mailbox = makeMailbox();
    for (let i = 0; i < 5; i++) mailbox.enqueue('heartbeat', HB(`burst ${i}`));
    expect(mailbox.depth).toBe(1);
  });

  it('已有心跳被取走后（processing），新心跳照常入队 —— 不会永久吞掉巡检', () => {
    const mailbox = makeMailbox();
    mailbox.enqueue('heartbeat', HB());

    const taken = mailbox.dequeue();
    expect(taken?.sourceType).toBe('heartbeat');

    mailbox.enqueue('heartbeat', HB('next patrol'));
    expect(mailbox.depth).toBe(1);
  });

  it('折叠只作用于 heartbeat：同类型的其他来件不受影响', () => {
    const mailbox = makeMailbox();
    mailbox.enqueue('human_chat', { summary: 'a', content: 'a' });
    mailbox.enqueue('human_chat', { summary: 'b', content: 'b' });
    expect(mailbox.depth).toBe(2);
  });

  it('心跳与其它类型共存时互不干扰', () => {
    const mailbox = makeMailbox();
    mailbox.enqueue('heartbeat', HB());
    mailbox.enqueue('human_chat', { summary: 'hi', content: 'hi' });
    mailbox.enqueue('heartbeat', HB('dup'));

    expect(mailbox.depth).toBe(2);
  });
});

// ─── D · 心跳会话按天滚动 ─────────────────────────────────────────────────────

describe('D · 心跳会话按天滚动', () => {
  it('同一天内的多次心跳 → 同一个 sessionId', () => {
    const morning = Date.UTC(2026, 8, 19, 0, 5);
    const night = Date.UTC(2026, 8, 19, 23, 55);
    expect(heartbeatSessionId('agt_x', morning)).toBe(heartbeatSessionId('agt_x', night));
  });

  it('跨天 → 不同 sessionId（增长与天数成正比，而非触发次数）', () => {
    const d1 = Date.UTC(2026, 8, 19, 12, 0);
    const d2 = Date.UTC(2026, 8, 20, 12, 0);
    expect(heartbeatSessionId('agt_x', d1)).not.toBe(heartbeatSessionId('agt_x', d2));
  });

  it('形如 hb_<agentId>_<YYYY-MM-DD>', () => {
    expect(heartbeatSessionId('agt_x', Date.UTC(2026, 8, 19, 12, 0))).toBe('hb_agt_x_2026-09-19');
  });

  it('按 UTC 分桶：跨 UTC 午夜即换桶（不随宿主时区漂移）', () => {
    expect(heartbeatSessionId('a', Date.UTC(2026, 8, 19, 23, 59, 59))).toBe('hb_a_2026-09-19');
    expect(heartbeatSessionId('a', Date.UTC(2026, 8, 20, 0, 0, 1))).toBe('hb_a_2026-09-20');
  });

  it('不同 agent 的心跳会话互不相同', () => {
    const t = Date.UTC(2026, 8, 19, 12, 0);
    expect(heartbeatSessionId('agt_a', t)).not.toBe(heartbeatSessionId('agt_b', t));
  });

  it('一天内重复调用不会产生新 id（即不再每次心跳新建文件）', () => {
    const t = Date.UTC(2026, 8, 19, 3, 0);
    const ids = new Set([
      heartbeatSessionId('agt_x', t),
      heartbeatSessionId('agt_x', t + 1000 * 60 * 60),
      heartbeatSessionId('agt_x', t + 1000 * 60 * 60 * 20),
    ]);
    expect(ids.size).toBe(1);
  });
});

// ─── D · 心跳会话不被误选为主会话 ─────────────────────────────────────────────

describe('D · getLatestMainSession 排除心跳会话', () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-session-rollover-'));
    store = new MemoryStore(tmp);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('心跳会话即使“最近活跃”，也不会被当作主会话', () => {
    const main = store.createSession('agt_x');
    const hb = store.getOrCreateSession('agt_x', heartbeatSessionId('agt_x', Date.UTC(2026, 8, 19)));

    // 让心跳会话成为最近活跃的那一个 —— 这正是按天滚动后最容易出现的局面。
    store.appendMessage(hb.id, {
      role: 'assistant',
      content: 'HEARTBEAT_OK',
      timestamp: new Date(Date.now() + 60_000).toISOString(),
    } as never);

    const picked = store.getLatestMainSession('agt_x');
    expect(picked?.id).toBe(main.id);
    expect(picked?.id.startsWith('hb_')).toBe(false);
  });

  it('只有心跳会话时返回 undefined（而不是把巡检当主会话）', () => {
    store.getOrCreateSession('agt_y', heartbeatSessionId('agt_y', Date.UTC(2026, 8, 19)));
    expect(store.getLatestMainSession('agt_y')).toBeUndefined();
  });

  it('a2a_ / channel_ 仍被排除（回归守卫）', () => {
    const main = store.createSession('agt_z');
    store.getOrCreateSession('agt_z', 'a2a_agt_z_1');
    store.getOrCreateSession('agt_z', 'channel_dm_x_agt_z');
    expect(store.getLatestMainSession('agt_z')?.id).toBe(main.id);
  });
});
