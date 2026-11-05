/**
 * 工具动作分级 —— 「这个动作有多难撤回」的唯一事实源。
 *
 * ── 它修的是什么 ──────────────────────────────────────────────
 * `gateAction(scope, autonomy)`（thread.ts）语义完备，但**生产代码零调用**。
 * 根因不是「忘了调用」：它要一个 `scope`，而系统里从来没有「工具 → 动作分级」
 * 的映射 —— 闸门没有输入，等于闸门不存在。`delete_project` 的工具描述甚至
 * 写着 "Always requires user approval"，但没有任何代码兑现它。
 *
 * ── 为什么复用 ResourceScope，而不是新加一列 ──────────────────
 * 「不可撤回」和 scope 的 `admin` 是同一件事。`gateAction` 已经写明
 * 「admin → 任何档位都 deny」，于是红线不需要新机制：它是既有语义的推论。
 *
 * **scope 是本文件唯一的事实源**：红线不单独存一个布尔值。
 * 若同时存 `scope` 和 `redLine`，两者迟早不一致，而那时没人知道信哪个。
 * 要改变某个工具的等级，只改 `scope` 一处。
 *
 * ── 未登记工具：动it推断，而不是一刀切 ───────────────────────
 * 不能「未登记 = 红线」（会打死所有 MCP 工具），也不能「未登记 = 放行」
 * （新增的 `pay_invoice` 会静默逃逸）。取中间：按名字里的动词推断。
 * 这样新增红线能力**无法因为被遗忘而绕过** —— 该 bug 在结构上不可表达。
 */

import type { ResourceScope } from './thread.js';
import { gateAction } from './thread.js';

export interface ActionClass {
  /** 动作的可撤回等级；决定 gateAction 的判定。**唯一事实源**。 */
  scope: ResourceScope;
  /** 人话理由，拒绝时直接告诉 Agent 为什么，而不是让它猜 */
  why: string;
}

/**
 * 显式登记表 —— 已知工具的动作等级。
 *
 * 只登记**需要偏离默认推断**的工具；其余走下面的动词推断。
 * 这张表保持短小，是为了让「这里没有的东西」一眼可见。
 */
const REGISTERED: Readonly<Record<string, ActionClass>> = {
  // ── 删数据：不可撤回 → admin ──
  delete_project: {
    scope: 'admin',
    why: '删除项目会同时解除其下全部任务的关联，无法撤回',
  },
  workflow_delete: {
    scope: 'admin',
    why: '删除工作流定义后，进行中的运行将失去定义，无法撤回',
  },
  task_cleanup_duplicates: {
    scope: 'admin',
    why: '批量清理重复任务，删除后无法还原',
  },

  // ── 名含红线动词、但爆炸半径只在本 Agent 自身的：显式豁免 ──
  // 这三条是**故意**偏离动词推断的，理由必须留在这里，否则下一个人会以为漏登记：
  //   · memory_delete 删的是本 Agent 自己的观察记录 —— 记忆卫生是日常动作，
  //     每次都要人批，Agent 会退化成「不敢记也不敢清」，最后必然有人把闸门关掉。
  //   · resource_release 的文档写明「只停止新事件路由，不删除任何已有产出」，
  //     名字里的 release 指的也不是「发版」。
  //   · drop_mailbox_item 只丢自己邮箱里的条目，可重新投递。
  memory_delete: {
    scope: 'draft',
    why: '只删本 Agent 自己的观察记录，爆炸半径限于自身',
  },
  resource_release: {
    scope: 'draft',
    why: '只解除自己持有的责任绑定，不删除任何已有产出',
  },
  drop_mailbox_item: {
    scope: 'draft',
    why: '丢弃自己邮箱里的条目，可重新投递',
  },
};

/**
 * 红线动词 —— 未登记工具的兜底识别。
 *
 * 这些词一旦出现在工具名里，就默认不可撤回：
 *   删除 / 销毁 / 清空  → 数据消失
 *   支付 / 付款 / 转账  → 钱离开
 *   发布 / 上线 / 发版  → 内容到了外面的世界
 *
 * `publish` 与 `release` 都在内：一条发出去的推文无法收回，
 * 一个发出去的 npm 版本无法真正撤回。它们和「删库」是同一类风险。
 */
const RED_LINE_VERBS = [
  'delete', 'remove', 'destroy', 'drop', 'purge', 'truncate', 'erase', 'wipe',
  'pay', 'payment', 'charge', 'purchase', 'refund', 'transfer', 'withdraw', 'checkout',
  'publish', 'deploy', 'release', 'forcepush',
] as const;

/** 只读动词 —— 用于把明显的读工具判为 read，避免误伤。 */
const READ_VERBS = [
  'list', 'get', 'search', 'read', 'status', 'describe', 'inspect',
  'show', 'find', 'count', 'check', 'query', 'recall', 'view', 'fetch',
] as const;

/** 按 `_` / camelCase 切词，避免 `update` 里的碎片、`deleted_at` 里的误命中。 */
function tokensOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function matchVerb(tokens: string[], verbs: readonly string[]): string | undefined {
  for (const verb of verbs) {
    if (tokens.includes(verb)) return verb;
    // 合成词如 `payinvoice`：整词包含也算，宁可误伤不可漏放
    if (verb.length >= 4 && tokens.some((t) => t.includes(verb))) return verb;
  }
  return undefined;
}

/**
 * 判定一个工具的动作等级。
 *
 * @param toolName 工具名（内建 / 技能 / MCP 均可）
 * @returns 分级结果；同一输入永远同一输出（纯函数，无 IO）
 */
export function classifyToolAction(toolName: string): ActionClass {
  const registered = REGISTERED[toolName];
  if (registered) return registered;

  const tokens = tokensOf(toolName);

  const redVerb = matchVerb(tokens, RED_LINE_VERBS);
  if (redVerb) {
    return {
      scope: 'admin',
      why: `工具名包含不可撤回动作「${redVerb}」，需人工确认后才能执行`,
    };
  }

  if (matchVerb(tokens, READ_VERBS)) {
    return { scope: 'read', why: '只读' };
  }

  // 未登记的写工具：默认可撤回的写入（draft）。
  // 不判红线 —— 否则任何新 MCP 工具都会立刻不可用。
  return { scope: 'draft', why: '未登记的写操作，视为可撤回' };
}

/**
 * 是否红线动作。
 *
 * 判据与 `enforceRedLine` 完全同源：**连最高档 trusted 都过不去** ⟺ 红线。
 * 这样「红线」不是一张独立的表，而是 `gateAction` 的推论 ——
 * 闸门语义改了，这里自动跟着改，不会出现两个说法。
 */
export function isRedLineAction(toolName: string): boolean {
  return gateAction(classifyToolAction(toolName).scope, 'trusted') === 'deny';
}

/** 全部显式登记的工具名（供测试断言登记表与真实工具集不漂移）。 */
export function registeredActionTools(): string[] {
  return Object.keys(REGISTERED);
}
