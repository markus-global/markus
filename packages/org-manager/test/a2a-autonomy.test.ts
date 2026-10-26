/**
 * ## 断言分类（不要混为一谈）
 *
 * 1. **结构不变量**：「不存在 processGroupChatReply 调用」「回复只有一个写点」此类。
 *    它们描述代码库的形状，源码扫描是唯一正确工具；行为测试无法表达「不存在」。
 * 2. **行为**：能被「给某输入、看输出」描述的，一律写成行为测试（见
 *    agent-delivery.test.ts 用假依赖跑真的 deliver()）。
 *
 * 两类都合法。判据：断言的是「代码的形状」还是「某输入下的输出」。
 * 硬把第 1 类改成行为测试会丢失「全局唯一」这个维度，而不是提升质量。
 *
 * A2A 自主回复模型 —— 平台不得替 agent 决定"要回复"（2026-10-25 所有者裁定）。
 *
 * 裁定原文：人类发的，agent 应该会回，但**也有权不回**；agent 发给 agent 的，
 * 发送者和接收者**都可以自行决定**要不要回复、要不要继续下一轮。
 *
 * 结论：平台的"自动回复链"本身就是错的，不是"需要限流的机制"。
 * 因此防环三件套（DM_MAX_DEPTH / respondedAgents 每轮去重 / shouldChainDmReply
 * 正则）与两个丢弃闸（a2aCooldowns / wakeBudget）在新模型下**没有对象**。
 *
 * 本测试先红后绿：删掉自动链调用之前，前两条断言应当失败。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const raw = readFileSync(resolve(ROOT, 'packages/org-manager/src/api-server.ts'), 'utf-8');
const code = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/[^\n]*/g, '$1');

describe('A2A 自主回复：平台不自动产生下一轮', () => {
  it('不存在自动回复链的调用（processGroupChatReply / triggerAgentToAgentChain）', () => {
    expect(code).not.toContain('this.processGroupChatReply(');
    expect(code).not.toContain('this.triggerAgentToAgentChain(');
  });

  it('不存在"猜语义"的链控判据（shouldChainDmReply 正则）', () => {
    expect(code).not.toContain('shouldChainDmReply');
  });

  it('不存在防环深度与自动链的判据使用（新模型下链不存在）', () => {
    // 常量与"猜语义"判据已删；两个旧方法只剩不可达的方法体（下一提交清除）
    expect(code).not.toContain('DM_MAX_DEPTH =');
    expect(code).not.toContain('shouldChainDmReply(');
    expect(code).not.toContain('this.processGroupChatReply(');
  });

  it('回复只有一个写点：postReply', () => {
    expect(code).toContain('this.delivery.postReply(');
  });

  it('投递只有一个入口：delivery.deliver', () => {
    expect(code).not.toContain("enqueueToMailbox('a2a_message'");
    expect(code).toContain('this.delivery.deliver(');
  });
});
