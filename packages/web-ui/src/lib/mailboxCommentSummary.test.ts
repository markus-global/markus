import { describe, it, expect } from 'vitest';
import { parseCommentSummary } from './mailboxCommentSummary.js';

/**
 * 用**真实形状**的摘要做夹具（取自现网 `mailbox_items.payload.summary` 的形态，
 * 见 task-service.ts 与 requirement 注释的生产方）。
 */
describe('parseCommentSummary —— 注释摘要的唯一解析点', () => {
  it('任务注释：取出实体标题与作者', () => {
    expect(parseCommentSummary('Comment on task "MAU 归因修复" from 后端工程师')).toEqual({
      subject: 'MAU 归因修复',
      author: '后端工程师',
    });
  });

  it('需求注释：同样解析', () => {
    expect(parseCommentSummary('Comment on requirement "发币 M2 收口" from 产品经理')).toEqual({
      subject: '发币 M2 收口',
      author: '产品经理',
    });
  });

  it('旧格式的折叠后缀不再被当作结构吃掉，而是原样留在作者名里', () => {
    // 2026-10-23 实测：现网注释类摘要中该后缀为 0 行。这里锁的是**行为契约**：
    // 真出现旧行时，宁可让「 (+2)」露出来，也不要静默改写用户看到的内容。
    const parsed = parseCommentSummary('Comment on task "X" from Alice (+2)');
    expect(parsed).toEqual({ subject: 'X', author: 'Alice (+2)' });
  });

  it('首尾锚定：作者名后面多出来的话不会被悄悄截断', () => {
    // 上一版正则的 `(.+?)$` 加上可选分组，会把尾巴整段塞进作者名；
    // 这里明确「要么整串匹配，要么不声称自己解析成功」。
    const parsed = parseCommentSummary('Comment on task "X" from Alice and then some');
    expect(parsed).toEqual({ subject: 'X', author: 'Alice and then some' });
  });

  it('不是注释摘要就返回 null，调用方原样展示', () => {
    expect(parseCommentSummary('Task "X" status: pending → in_progress')).toBeNull();
    expect(parseCommentSummary('@mention from Strategy Exec')).toBeNull();
    expect(parseCommentSummary('')).toBeNull();
  });

  it('不把「Comment on tasks」这类近似串误判为任务注释', () => {
    expect(parseCommentSummary('Comment on tasks "X" from Alice')).toBeNull();
  });
});
