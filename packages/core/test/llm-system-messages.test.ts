/**
 * 跨适配器的同一条不变量：**每一条 system 消息的内容都必须到达模型，且保持顺序**。
 *
 * 这条不变量此前在四个适配器上有四种实现，其中两种是错的：
 *   - openai   : 对每条 system 都展开完整 segment 列表 → 段重复注入、第二条内容丢失
 *   - anthropic: `.find()` 只取第一条 → 其余静默丢弃
 *   - google   : 循环拼接（正确，但把后续 system 折到最前）
 *   - codex    : 同上
 *
 * 这里锁住 anthropic 的合并语义。openai 侧的段展开语义在
 * `provider-helpers.test.ts > convertMessagesOpenAI — system 段展开` 中锁定。
 *
 * 已知能力边界：Anthropic / Google 的 `system` 是顶层单数字段，折叠会把后续
 * system 消息移到最前，因此"system 与对话内容交替穿插"的布局在这些 provider 上
 * 无法被忠实表达。跨 provider 可移植的布局必须是"system 连续位于头部"。
 */

import { describe, it, expect } from 'vitest';
import type { LLMMessage } from '@markus/shared';
import { collectSystemText } from '../src/llm/anthropic.js';

describe('collectSystemText — 不丢任何一条 system 消息', () => {
  it('折叠全部 system 消息，并保持顺序', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'L0' },
      { role: 'user', content: 'X' },
      { role: 'system', content: 'ROLE' },
    ];
    // 旧的 `.find()` 实现只会返回 'L0'，ROLE 静默丢失。
    expect(collectSystemText(messages)).toBe('L0\n\nROLE');
  });

  it('跳过空的 system 消息，不产生多余分隔符', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: '' },
      { role: 'system', content: 'A' },
    ];
    expect(collectSystemText(messages)).toBe('A');
  });

  it('没有 system 消息时返回空串（调用方据此不设置 system 字段）', () => {
    expect(collectSystemText([{ role: 'user', content: 'X' }])).toBe('');
  });

  it('单条 system 时行为不变（回归护栏）', () => {
    expect(collectSystemText([{ role: 'system', content: 'A' }])).toBe('A');
  });
});
