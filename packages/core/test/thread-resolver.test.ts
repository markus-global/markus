/**
 * 解析点回归：只允许一个地方产出「这条事件属于哪条流」。
 *
 * 这里锁的是最难查的一类 bug：**静默退化**。
 * 少读一个 sessionId 字段不会报错，只会让同一会话里两条消息并行跑
 * （看起来「快了一点」，实际互相覆盖）。
 */
import { describe, it, expect } from 'vitest';
import { resolveThreadRef, threadEntityKeys, isExternalRef } from '../src/thread-resolver.js';
import type { ResolvableItem } from '../src/thread-resolver.js';

const item = (over: Partial<ResolvableItem> = {}): ResolvableItem => ({
  sourceType: 'human_chat',
  payload: { summary: 's', content: 'c', ...(over.payload ?? {}) },
  metadata: { ...(over.metadata ?? {}) },
});

describe('resolveThreadRef — 顺序即语义', () => {
  it('适配器给的外部资源键最优先（压过 taskId）', () => {
    const r = resolveThreadRef(
      item({ payload: { summary: 's', content: 'c', taskId: 'tsk_1', extra: { threadRef: 'gh:owner/repo' } } }),
      'agt_1',
    );
    expect(r.ref).toBe('gh:owner/repo');
    expect(r.axis).toBe('explicit');
  });

  it('任务 > 需求 > 渠道 > 会话', () => {
    const all = resolveThreadRef(
      item({
        payload: {
          summary: 's',
          content: 'c',
          taskId: 'tsk_1',
          requirementId: 'req_1',
          extra: { channelKey: 'group:9', sessionId: 'ses_1' },
        },
      }),
      'agt_1',
    );
    expect(all.ref).toBe('tsk_1');
    expect(all.axis).toBe('task');
  });

  it('没有 taskId 时落到 requirement', () => {
    const r = resolveThreadRef(item({ payload: { summary: 's', content: 'c', requirementId: 'req_9' } }), 'agt_1');
    expect(r.ref).toBe('req_9');
    expect(r.axis).toBe('requirement');
  });

  it('渠道键：同群/同仓只允许一个回合', () => {
    const r = resolveThreadRef(item({ payload: { summary: 's', content: 'c', extra: { channelKey: 'feishu:oc_1' } } }), 'agt_1');
    expect(r.ref).toBe('channel:feishu:oc_1');
    expect(r.axis).toBe('channel');
  });

  it('会话 id 只出现在 payload.extra 里也必须被读到（静默退化的老坑）', () => {
    const r = resolveThreadRef(item({ payload: { summary: 's', content: 'c', extra: { sessionId: 'ses_extra' } } }), 'agt_1');
    expect(r.ref).toBe('ses_extra');
    expect(r.axis).toBe('session');
  });

  it('dbSessionId 优先于 sessionId（DB 会话才是真边界）', () => {
    const r = resolveThreadRef(item({ metadata: { sessionId: 'sess_ui', dbSessionId: 'ses_db' } }), 'agt_1');
    expect(r.ref).toBe('ses_db');
  });

  it('全部缺失 → 退化为 agent 级串行，而不是完全并发', () => {
    const r = resolveThreadRef(item(), 'agt_7');
    expect(r.ref).toBe('agent:agt_7');
    expect(r.axis).toBe('agent');
  });

  it('空字符串不算命中（不会产出空 ref）', () => {
    const r = resolveThreadRef(item({ payload: { summary: 's', content: 'c', taskId: '   ' } }), 'agt_7');
    expect(r.ref).toBe('agent:agt_7');
  });
});

describe('threadEntityKeys — 主轴在前，旧维度不删', () => {
  it('第一键是流标识，旧 task: 键仍保留（两个维度是「与」关系）', () => {
    const keys = threadEntityKeys(item({ payload: { summary: 's', content: 'c', taskId: 'tsk_1' } }), 'agt_1');
    expect(keys[0]).toBe('tsk_1');
    expect(keys).toContain('task:tsk_1');
  });

  it('不产生重复键', () => {
    const keys = threadEntityKeys(item({ metadata: { taskId: 'tsk_1' } }), 'agt_1');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('isExternalRef 只认带前缀的资源键', () => {
    expect(isExternalRef('gh:o/r')).toBe(true);
    expect(isExternalRef('tsk_1')).toBe(false);
  });
});
