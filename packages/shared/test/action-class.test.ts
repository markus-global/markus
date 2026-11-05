import { describe, it, expect } from 'vitest';
import { classifyToolAction, isRedLineAction, registeredActionTools } from '../src/types/action-class.js';
import { gateAction } from '../src/types/thread.js';

// ── 动作分级：红线判据的单一事实源 ────────────────────────────────────────────
// 这组测试守的是「删除 / 对外发布 / 支付 不可自主」这条平台不变量。
// 断言写成了**行为**（给定工具名 → 给定等级），不是源码文本匹配：
// 改坏分类器、或有人删掉某条豁免、或动词表被误改，这里都会红。

describe('classifyToolAction — 显式登记', () => {
  it('删数据的工具判为 admin（不可撤回）', () => {
    for (const name of ['delete_project', 'workflow_delete', 'task_cleanup_duplicates']) {
      const a = classifyToolAction(name);
      expect(a.scope, name).toBe('admin');
      expect(isRedLineAction(name), name).toBe(true);
    }
  });

  it('每个等级都带人话理由（拒绝时 Agent 只能靠这个建模）', () => {
    for (const name of [...registeredActionTools(), 'some_unknown_tool']) {
      const a = classifyToolAction(name);
      expect(a.why.length, name).toBeGreaterThan(0);
    }
  });
});

describe('classifyToolAction — 未登记工具靠动词推断', () => {
  it('新增的支付/发布类工具无需登记也自动成为红线', () => {
    // 这些工具在今天的代码里都不存在 —— 测的正是「未来新增也不能逃逸」。
    const cases = [
      'pay_invoice', 'payment_checkout', 'refund_order', 'withdraw_funds',
      'transfer_money', 'purchase_item', 'charge_card',
      'publish_article', 'publish_to_xhs', 'deploy_prod', 'release_version',
      'delete_bucket', 'purge_cache', 'wipe_disk', 'truncate_table',
    ];
    for (const name of cases) {
      expect(classifyToolAction(name).scope, `${name} 应为 admin`).toBe('admin');
      expect(isRedLineAction(name), `${name} 应为红线`).toBe(true);
    }
  });

  it('camelCase 工具名同样能识别（MCP 工具常见写法）', () => {
    for (const name of ['payInvoice', 'publishArticle', 'deleteAccount']) {
      expect(isRedLineAction(name), name).toBe(true);
    }
  });

  it('读工具不被误判为红线', () => {
    for (const name of ['list_projects', 'get_task', 'search_deliverables', 'kb_read', 'recall_context']) {
      expect(classifyToolAction(name).scope, name).toBe('read');
      expect(isRedLineAction(name), name).toBe(false);
    }
  });

  it('普通写工具是可撤回的 draft，不是红线', () => {
    for (const name of ['task_create', 'file_write', 'memory_save', 'workflow_run', 'deliverable_create']) {
      expect(classifyToolAction(name).scope, name).toBe('draft');
      expect(isRedLineAction(name), name).toBe(false);
    }
  });

  it('`update` 里的碎片不得命中 `date` 类误判，`default` 不得命中动词', () => {
    // 早期实现用 `includes` 全文匹配，`update` 会命中 `date`、`default` 会被切碎。
    // 这条测试锁住「按词切分」这个决定。
    expect(classifyToolAction('update_project').scope).toBe('draft');
    expect(classifyToolAction('llm_switch_default_provider').scope).toBe('draft');
    expect(classifyToolAction('defer_mailbox_item').scope).toBe('draft');
  });
});

describe('classifyToolAction — 显式豁免（爆炸半径限于自身）', () => {
  it('删自己的记忆不是红线：记忆卫生是日常动作', () => {
    expect(classifyToolAction('memory_delete').scope).toBe('draft');
    expect(isRedLineAction('memory_delete')).toBe(false);
  });

  it('解除自己的责任绑定不是红线：不删除任何已有产出', () => {
    expect(classifyToolAction('resource_release').scope).toBe('draft');
    expect(isRedLineAction('resource_release')).toBe(false);
  });

  it('丢自己的邮箱条目不是红线：可重新投递', () => {
    expect(classifyToolAction('drop_mailbox_item').scope).toBe('draft');
    expect(isRedLineAction('drop_mailbox_item')).toBe(false);
  });
});

describe('isRedLineAction — 与 gateAction 同源', () => {
  it('红线在任何自主档位都不可自主（用最高档 trusted 反证）', () => {
    // 判据是「连 trusted 都过不去」。若有人给 admin 开口子，这里会立刻红。
    for (const name of ['delete_project', 'pay_invoice', 'publish_article']) {
      expect(gateAction(classifyToolAction(name).scope, 'trusted')).toBe('deny');
    }
  });

  it('纯函数：同一输入永远同一输出', () => {
    const a = classifyToolAction('delete_project');
    const b = classifyToolAction('delete_project');
    expect(a).toEqual(b);
  });
});
