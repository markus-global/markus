/**
 * ## 为什么这个文件用源码扫描，而不是行为测试
 *
 * 本文件的断言几乎全是「全仓库不得存在某个写者」——例如「wakeBudget 必须为零」
 * 「enqueue 只允许出现在 agent-delivery.ts」。这类**结构不变量**描述的是代码库的
 * 形状，不是某次调用的返回值：行为测试无法表达「别处不存在第二条写路径」，只能
 * 扫描源码。所以这里的 readFileSync + toContain 不是技术债，而是这类断言**唯一**
 * 正确的工具。
 *
 * 判定口径（新增断言前先问属于哪类）：
 *   · 断言「代码的形状」 → 扫描源码（本文件）
 *   · 断言「某输入下的输出」→ 行为测试（agent-delivery.test.ts：deliver() + 假依赖）
 *
 * 不要为了「看起来更高级」把结构不变量改写成只能覆盖单条路径的行为测试——
 * 那会把守卫变弱，而且是不可逆的：一个测不到的洞比一句会变红的断言安全。
 *
 * A2A delivery invariant —— 机检 + 回归（2026-10-25）。
 *
 * 事故：QA 3 分钟 12 条 DM → channel_messages 12 行、**只唤醒 1 次**、11 条被
 * `a2aCooldowns` 静默丢弃，而 `agent_send_message` 仍回 `{status:'dispatched'}`。
 * 根因：投递被拆成「入库」+「唤醒」，唤醒上有墙钟丢弃闸；同一件事在
 * mailbox 层已有一套「合并」机制（§14），api-server 又叠了一套「丢弃」。
 *
 * 规范（docs/architecture/mailbox-system.md §11.1.1 / §14.5）：
 *   · 唯一投递机制 = enqueueToMailbox('a2a_message')
 *   · 风暴控制 = 因果链 + 合并，**永不**墙钟丢弃
 *   · 不存在 delivered-but-not-awake
 *
 * 本文件先红后绿：删掉丢弃分支之前，前两条断言应当失败。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const apiServer = readFileSync(resolve(ROOT, 'packages/org-manager/src/api-server.ts'), 'utf-8');

/** 去掉注释，避免注释里提到旧机制名时产生假阴性。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

const code = stripComments(apiServer);

describe('A2A 投递不变量（源码机检）', () => {
  it('不存在"丢弃唤醒"的分支（旧 a2aCooldowns continue / suppressed）', () => {
    // 禁止的是**丢弃**，不是限流本身：群聊链路允许"命中窗口 → 仍然投递、
    // 只是不延伸自动回复链"（throttled），那符合规范。
    expect(code).not.toContain('suppressed by cooldown');
    expect(code).not.toContain('DM chain suppressed');
  });

  it('不存在全局唤醒配额丢弃：wakeBudget 必须为零', () => {
    expect(code).not.toContain('wakeBudget');
    expect(code).not.toContain('tryConsume');
  });

  it('投递必须经唯一执行点：enqueue 只允许出现在 agent-delivery.ts', () => {
    // 规范 §11.1.4：任何入口都不得自己 enqueue 到别的 agent
    expect(code).not.toContain("enqueueToMailbox('a2a_message'");
    const deliverySrc = readFileSync(resolve(ROOT, 'packages/org-manager/src/agent-delivery.ts'), 'utf-8');
    expect(deliverySrc).toContain("enqueueToMailbox('a2a_message'");
    // 三个入口（DM / 群聊普通 / @提及）都必须经它
    expect(code.split('this.delivery.deliver(').length - 1).toBeGreaterThanOrEqual(2);
    expect(code).not.toContain('DM send suppressed by cooldown');
  });

  // 「群聊限流只降级投递」用例已删除（2026-10-25）：自动链整体移除后，
  // 限流机制本身不再存在——不是"降级投递"，而是根本不产生链。

  it('deliveryState 是工具契约的一部分（发送方必须知道被合并还是排队）', () => {
    const a2a = readFileSync(resolve(ROOT, 'packages/core/src/tools/a2a.ts'), 'utf-8');
    expect(a2a).toContain('deliveryState');
    expect(a2a).toContain("'queued'");
  });
});
