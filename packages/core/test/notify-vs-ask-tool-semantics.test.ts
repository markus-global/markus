/**
 * 通知 ≠ 提问 —— 两个工具语义边界的机检（2026-10-25 事故回归）。
 *
 * 事故：QA 测试工程师 3 分钟内 12 次 `notify_user`，内容全是"需一行授权"。
 * 它需要的是一**个答复**，而 `notify_user` 不阻塞、不返回答案 —— 于是它永远
 * 等不到答复，下一轮再从零推导"我被卡住"，再发一次。
 *
 * 根因不在模型：两个工具的描述之间**没有一条二选一规则**。
 *   · notify_user 只写"发通知…用户可能会回复"，从没说"不期待回复"；
 *   · request_user_input 只写了单向约束"别拿提问做状态更新"，没写"需要答复就必须用它"。
 *
 * 修法因此是**改提示词（工具描述）**，不是给 notify_user 加判重状态机（那层已回滚）。
 * 本测试锁住这两段描述的关键约束：谁把边界删掉，门禁立刻变红。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src/tool-selector.ts');
const src = readFileSync(SRC, 'utf-8');

/** 取某个工具的定义块（从 `name: '<tool>'` 到下一个 `pushUnique({`）。 */
function blockOf(tool: string): string {
  const start = src.indexOf(`name: '${tool}'`);
  expect(start, `${tool} definition not found`).toBeGreaterThan(-1);
  const next = src.indexOf('pushUnique({', start);
  return src.slice(start, next > start ? next : undefined);
}

describe('工具语义边界：notify_user = 告知，request_user_input = 要答复', () => {
  const notify = blockOf('notify_user');
  const ask = blockOf('request_user_input');

  it('notify_user 明确"不期待回复"', () => {
    expect(notify).toContain('ONE-WAY notification');
    expect(notify.toLowerCase()).toContain('do not expect a reply');
  });

  it('notify_user 把"需要答复"的场景指向 request_user_input', () => {
    expect(notify).toContain('request_user_input');
    // "which blocks and returns the answer" —— 说明为什么不能拿通知代替提问
    expect(notify.toLowerCase()).toMatch(/blocks? and returns the answer/);
  });

  it('notify_user 明确禁止重复发送同一通知', () => {
    expect(notify).toContain('Do NOT repeat a notification');
  });

  it('request_user_input 反向约束齐备：需要答复/授权时必须用它', () => {
    expect(ask).toContain('BLOCK until they respond');
    expect(ask).toContain('CANNOT CONTINUE WITHOUT AN ANSWER');
    // 说清为什么不能用通知代替：`notify_user` does not block ...
    expect(ask).toContain('does not block and will not bring an answer back');
  });

  it('request_user_input 仍保留原有的豁免（审批按钮 / 状态更新）', () => {
    expect(ask).toContain('Do NOT use it for routine status updates');
    expect(ask).toContain('Do NOT use it to approve requirements or tasks');
  });
});
