import { describe, it, expect } from 'vitest';
import { shouldInterruptForSend, shouldSettleDetachedSession } from './ChatHelpers.ts';

/**
 * 同一 Agent 的多个 session tab 之间的隔离。
 *
 * 这两个谓词取代了两处「用 Agent 级单例回答会话级问题」的判据，是整个
 * 「tab A 正在输出 → 别的 tab 一动作 A 就断」这一类 bug 的收口点。
 * 具体回归见 `docs/` 里的会话流模型说明。
 */

const NEW_CHAT = '__new_chat__';

describe('shouldInterruptForSend —— 只问「服务端确认这个会话在跑吗」', () => {
  it('服务端确认在跑 → 打断重发（同一会话连发同一句 = 重试）', () => {
    expect(shouldInterruptForSend({
      authorityStreaming: true,
      sendSessionId: 'A',
    })).toBe(true);
  });

  it('【根因回归 2026-11-17】服务端说没在跑 → 绝不打断（哪怕本地登记簿说在跑）', () => {
    // 现场：`sending` 与 membership 都是「记账式」副本，漏销账就永久为真；
    // 旧判据拿它当打断依据 → 发送瞬间 abort 掉刚起的那一轮。
    // runtime log 里 `cancelActiveStream: matched no active stream` 命中 8 次，
    // 全部落在“上一轮已结束、下一轮未开始”= 用户按下发送的那一刻。
    expect(shouldInterruptForSend({
      authorityStreaming: false,
      sendSessionId: 'A',
    })).toBe(false);
  });

  it('别的会话在跑与本会话无关（权威按会话回答）', () => {
    // A 在跑对 B 不是一个事实：调用方传入的 authorityStreaming 已经是**本会话**的值。
    expect(shouldInterruptForSend({
      authorityStreaming: false,
      sendSessionId: 'B',
    })).toBe(false);
  });

  it('拿不到发送会话身份 → 一律不打断（保守：宁可不打断，不可误杀）', () => {
    expect(shouldInterruptForSend({ authorityStreaming: true, sendSessionId: undefined })).toBe(false);
    expect(shouldInterruptForSend({ authorityStreaming: true, sendSessionId: null })).toBe(false);
    expect(shouldInterruptForSend({ authorityStreaming: true, sendSessionId: '' })).toBe(false);
  });
});

describe('shouldSettleDetachedSession —— 只收尾「这个会话」的脱离流', () => {
  it('【根因回归】目标会话仍在输出 → 绝不可收尾', () => {
    expect(shouldSettleDetachedSession({
      liveSessions: new Set(['C']),
      sessionId: 'C',
      placeholderId: NEW_CHAT,
    })).toBe(false);
  });

  it('【根因回归】别的会话在输出，本会话已脱离 → 应当收尾（旧实现因 owned.size>0 而跳过）', () => {
    expect(shouldSettleDetachedSession({
      liveSessions: new Set(['A']),
      sessionId: 'C',
      placeholderId: NEW_CHAT,
    })).toBe(true);
  });

  it('占位流归属未知 → 不得收尾（可能正是本会话未提升的流）', () => {
    expect(shouldSettleDetachedSession({
      liveSessions: new Set([NEW_CHAT]),
      sessionId: 'C',
      placeholderId: NEW_CHAT,
    })).toBe(false);
  });

  it('本地没有任何在途流 → 收尾', () => {
    expect(shouldSettleDetachedSession({ liveSessions: new Set(), sessionId: 'C', placeholderId: NEW_CHAT })).toBe(true);
    expect(shouldSettleDetachedSession({ liveSessions: undefined, sessionId: 'C', placeholderId: NEW_CHAT })).toBe(true);
  });

  it('拿不到目标会话 → 收尾（调用方无会话归属）', () => {
    expect(shouldSettleDetachedSession({ liveSessions: new Set(['C']), sessionId: undefined, placeholderId: NEW_CHAT })).toBe(true);
    expect(shouldSettleDetachedSession({ liveSessions: new Set(['C']), sessionId: null, placeholderId: NEW_CHAT })).toBe(true);
  });
});
