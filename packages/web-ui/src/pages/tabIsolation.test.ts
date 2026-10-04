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

describe('shouldInterruptForSend —— 「要发的那个会话」自己有没有在途流', () => {
  it('【根因回归】A 在跑，在 B 发消息 → 不打断（旧实现会杀 A）', () => {
    // 旧判据是 "activeSessionId 是真 id" → B 是真 id → 判成「打断当前流」，
    // 于是 abort 掉 A 的 SSE 并 cancelProcessing(A)。
    expect(shouldInterruptForSend({
      liveSessions: new Set(['A']),
      sendSessionId: 'B',
    })).toBe(false);
  });

  it('要发的会话自身在跑 → 打断并重发', () => {
    expect(shouldInterruptForSend({
      liveSessions: new Set(['A']),
      sendSessionId: 'A',
    })).toBe(true);
  });

  it('新 tab（占位 id）自身有流 → 打断（同一条 tab 重复发送）', () => {
    expect(shouldInterruptForSend({
      liveSessions: new Set([NEW_CHAT]),
      sendSessionId: NEW_CHAT,
    })).toBe(true);
  });

  it('别的 tab 在跑，但目标会话是占位 → 不打断', () => {
    expect(shouldInterruptForSend({
      liveSessions: new Set(['A']),
      sendSessionId: NEW_CHAT,
    })).toBe(false);
  });

  it('没有任何在途流 → 不打断', () => {
    expect(shouldInterruptForSend({ liveSessions: new Set(), sendSessionId: 'A' })).toBe(false);
    expect(shouldInterruptForSend({ liveSessions: undefined, sendSessionId: 'A' })).toBe(false);
    expect(shouldInterruptForSend({ liveSessions: null, sendSessionId: 'A' })).toBe(false);
  });

  it('拿不到发送会话身份 → 一律不打断（保守：宁可不打断，不可误杀）', () => {
    expect(shouldInterruptForSend({ liveSessions: new Set(['A']), sendSessionId: undefined })).toBe(false);
    expect(shouldInterruptForSend({ liveSessions: new Set(['A']), sendSessionId: null })).toBe(false);
    expect(shouldInterruptForSend({ liveSessions: new Set(['A']), sendSessionId: '' })).toBe(false);
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
