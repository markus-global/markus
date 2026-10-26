/**
 * A2A 投递契约 —— `docs/architecture/mailbox-system.md` §11.1.4 的
 * 「Machine-checkable」那句话的可执行版本。
 *
 * 文档原文：
 *   "`enqueueToMailbox('a2a_message'` may appear only inside `agent-delivery.ts`;
 *    a direct `handleMessage`/`processGroupChatReply` used to hand a message to
 *    another agent is a regression."
 *
 * 为什么要有这个文件：这句话如果只存在于 Markdown 里，时间一长必然与代码脱节，
 * 而脱节的后果不是「文档过期」这么轻 —— 它意味着存在一条不经过 `deliver()` 的
 * 投递路径，于是来源标记（[FROM HUMAN] / [FROM AGENT]）、被点名标记（[MENTIONED]）
 * 和统一投递日志统统失效，且没有任何地方会报错。
 *
 * 扫描范围：`packages/org-manager/src`。`deliver()` 定义在这一层，所以这一层
 * 只能有一个 A2A 投递出口。`packages/core` 的 `agent.sendMessage` 是更底层的
 * agent 内部通道（peer_query / manager 协作），不属于本契约的范围 —— 它无法
 * 反向依赖 org-manager 的 deliver()，否则就是循环依赖。
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walkTs(full, acc);
    } else if (extname(entry.name) === '.ts' && !entry.name.endsWith('.d.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * 去掉注释，只留代码。否则解释性文字（"每条消息都作为 a2a_message 进对方 mailbox"）
 * 会被当成违规，测试就变成了对注释措辞的约束。
 *
 * 用状态机而不是正则：必须正确跳过字符串字面量，否则 `'https://…'` 里的 `//`
 * 会吞掉这一行剩下的代码。
 */
function stripComments(code: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;

  while (i < code.length) {
    const ch = code[i]!;
    const next = code[i + 1];

    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
        // 保留换行：注释被删掉但行号必须不变，否则失败信息指向错误的行，
        // 测试就从「可行动的信号」退化成「要人再去猜的信号」。
        if (code[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** org-manager/src 下所有文件的「代码部分」。 */
const sources = walkTs(SRC_DIR).map(file => ({
  file: relative(SRC_DIR, file),
  code: stripComments(readFileSync(file, 'utf8')),
}));

/** 把出现位置格式化成 `file:line`，失败信息才可行动。 */
function locate(needle: RegExp): string[] {
  const hits: string[] = [];
  for (const { file, code } of sources) {
    const lines = code.split('\n');
    lines.forEach((line, idx) => {
      needle.lastIndex = 0;
      if (needle.test(line)) hits.push(`${file}:${idx + 1}`);
    });
  }
  return hits;
}

describe('A2A delivery contract (§11.1.4 machine-checkable)', () => {
  it('只有 agent-delivery.ts 可以把 a2a_message 作为投递 sourceType', () => {
    const offenders = locate(/sourceType\s*:\s*['"]a2a_message['"]|enqueueToMailbox\s*\(\s*['"]a2a_message['"]/);
    // 断言到文件名，不断言行号：行号不是契约的一部分，写死它只会让无关的
    // 增删行触发假失败（第一次写这个测试时就是这么红了一次）。违规位置仍然
    // 会出现在失败信息里，因为失败的是 `file:line` 数组。
    expect([...new Set(offenders.map(o => o.split(':')[0]))]).toEqual(['agent-delivery.ts']);
    expect(offenders.some(o => o.startsWith('agent-delivery.ts:'))).toBe(true);
  });

  it('deliver() 仍是唯一投递点（存在且只被本层调用）', () => {
    const definers = locate(/^\s*deliver\(req: DeliveryRequest\)/);
    expect(definers).toHaveLength(1);
    expect(definers[0]).toMatch(/^agent-delivery\.ts:/);
  });

  it('HTTP 的 a2a 动作经 deliver() 投递，而不是直接 sendMessage', () => {
    // 精确到那个动作，而不是「全文件不许出现 sendMessage」—— 同一个文件里
    // 人类聊天（human_chat）也必须用 sendMessage，那条路径与 A2A 契约无关。
    // 过宽的断言会逼人把正确的代码改错，最后只能被删掉。
    const apiServer = sources.find(s => s.file === 'api-server.ts');
    expect(apiServer, 'api-server.ts 必须存在').toBeDefined();
    const src = apiServer!.code;
    const start = src.indexOf("if (action === 'a2a')");
    expect(start, "api-server 里应有 action === 'a2a' 分支").toBeGreaterThan(-1);
    const block = src.slice(start, start + 1200);

    expect(block).toContain('this.delivery.deliver(');
    expect(block).not.toContain('.sendMessage(');
  });
});
