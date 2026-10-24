/**
 * 「指针只能钉在有会话概念的 key 上」—— 2026-10-24 事故的回归测试。
 *
 * 现象：用户发到群里的消息，出现在与 agent 的主会话（私聊）末尾；刷新即消失。
 * 根因：视图切换时那句 `setActiveSession(prevKey, activeSessionId)` 对频道 key 也执行，
 * 把 `ch:group:…` 的 buffer id 变成了上一个 direct 会话的 `cs_…`。于是之后每一条群聊
 * 写入（乐观气泡 / WS 群回复）都落进那个会话的 buffer —— DB 里从来没有这条。
 *
 * 不变量：`ch:*` / `dm:*` / `_direct` 没有会话概念，钉指针必须是**无操作**。
 */
import { describe, it, expect } from 'vitest';
import { ConversationBufferManager, isSessionScopedConvKey } from './ConversationBufferManager.ts';
import type { ChatMsg } from '../pages/ChatHelpers.ts';

const msg = (id: string, text: string): ChatMsg => ({
  id,
  sender: 'user',
  text,
  time: '00:00',
  rawCreatedAt: '2026-10-24T00:00:00.000Z',
});

describe('isSessionScopedConvKey — 「这个 key 有没有会话概念」的唯一判据', () => {
  it('只有 direct 的会话 key 是有会话概念的', () => {
    expect(isSessionScopedConvKey('cs_abc123')).toBe(true);
    expect(isSessionScopedConvKey('sess_1')).toBe(true);
    expect(isSessionScopedConvKey('ch:group:custom:gc_1')).toBe(false);
    expect(isSessionScopedConvKey('dm:u_1')).toBe(false);
    expect(isSessionScopedConvKey('_direct')).toBe(false);
    expect(isSessionScopedConvKey('')).toBe(false);
  });
});

describe('setActiveSession — 频道 key 上钉指针是无操作', () => {
  it('钉在群聊 key 上之后，群聊写入仍落在它自己的 buffer（绝不进会话 buffer）', () => {
    const mgr = new ConversationBufferManager();
    mgr.currentConvKey = 'ch:group:custom:gc_1';

    // 事故现场：切离群聊时拿上一个 direct 会话的 id 去钉频道 key
    mgr.setActiveSession('ch:group:custom:gc_1', 'cs_secretary');

    // 群聊写入（乐观气泡 / WS 群回复都走这一条）
    mgr.updateMessages('ch:group:custom:gc_1', prev => [...prev, msg('m1', '发到群里的消息')]);

    expect(mgr.getMessages('ch:group:custom:gc_1')?.map(m => m.text)).toEqual(['发到群里的消息']);
    // 那个私聊会话的 buffer 必须保持干净
    expect(mgr.getMessages('cs_secretary')).toBeUndefined();
  });

  it('dm / _direct 同理：不产生跨会话写入', () => {
    const mgr = new ConversationBufferManager();
    for (const key of ['dm:u_1', '_direct']) {
      mgr.currentConvKey = key;
      mgr.setActiveSession(key, 'cs_x');
      mgr.updateMessages(key, prev => [...prev, msg(`m_${key}`, 'hi')]);
      expect(mgr.getMessages(key)?.length).toBe(1);
      expect(mgr.getMessages('cs_x')).toBeUndefined();
    }
  });

  it('direct 会话 key 的钉指针行为保持不变（钉上之后写入落在该会话 buffer）', () => {
    const mgr = new ConversationBufferManager();
    mgr.currentConvKey = 'agt_a';

    mgr.setActiveSession('agt_a', 'cs_real');
    mgr.updateMessages('agt_a', prev => [...prev, msg('p1', '新对话第一句')]);

    // 指针是唯一路由：direct 视图钉到哪里，后续写入就落在哪个会话的 buffer
    expect(mgr.getMessages('agt_a')?.map(m => m.text)).toEqual(['新对话第一句']);
  });
});
