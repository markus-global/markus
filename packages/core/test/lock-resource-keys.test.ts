import { describe, it, expect } from 'vitest';
import { Agent } from '../src/agent.js';
import { ResourceLockRegistry } from '../src/resource-locks.js';
import {
  AGENT_MEMORY_RESOURCE_DOMAIN,
  memoryResourceForPath,
  memoryResourceLock,
} from '../src/lock-resources.js';

/**
 * 锁的粒度必须是**资源**，不是工具名。
 *
 * 回归背景（P0-1 / P0-2，见 docs/CONCURRENT-PROCESSING.md §4.9）：
 *   - `update_notebook` 记在域 `notebook`，别名 `update_working_memory` 记在域
 *     `working-memory` —— 写**同一个 Map**，却因域名不同被判「不冲突」，锁形同虚设；
 *   - `file_write knowledge.md` 走 `fs:<path>`，而 `memory_update` 走 `memory` ——
 *     同一个文件有两条互不互斥的写入路径，外部编辑会被下一次内存落盘静默覆盖。
 *
 * 这组测试把「同一资源 ⇒ 同一锁键」钉成不变式。
 */
const cls = Agent as unknown as {
  WRITE_TOOL_DOMAINS: Record<string, { domain: string; arg?: readonly string[]; resource?: string }>;
  resourceLocksFor: (
    tc: { name: string; arguments?: Record<string, unknown> },
    dataDir?: string,
  ) => Array<{ domain: string; sub?: string }>;
};

const lockKey = (name: string, args: Record<string, unknown> = {}, dataDir?: string): string => {
  const requests = cls.resourceLocksFor({ name, arguments: args }, dataDir);
  expect(requests, `${name} 应至少解析出一个锁请求`).toHaveLength(1);
  const { domain, sub } = requests[0]!;
  return sub === undefined ? domain : `${domain}:${sub}`;
};

describe('锁资源键解析（lock-resources）', () => {
  it('记忆文件 basename → 资源键', () => {
    expect(memoryResourceForPath('/x/agent/knowledge.md')).toBe('knowledge');
    expect(memoryResourceForPath('/x/agent/NOTEBOOK.md')).toBe('notebook');
    expect(memoryResourceForPath('/x/agent/state.md')).toBe('state');
    expect(memoryResourceForPath('/x/agent/role/ROLE.md')).toBe('identity');
    expect(memoryResourceForPath('/x/agent/role/HEARTBEAT.md')).toBe('identity');
    expect(memoryResourceForPath('/x/agent/notes.md')).toBeUndefined();
    expect(memoryResourceForPath('')).toBeUndefined();
  });

  it('给定 dataDir 时只有目录内的同名文件算记忆资源', () => {
    const root = '/tmp/ag-home';
    expect(memoryResourceForPath(`${root}/knowledge.md`, root)).toBe('knowledge');
    expect(memoryResourceForPath('/tmp/some-repo/knowledge.md', root)).toBeUndefined();
  });

  it('memoryResourceLock 收敛到统一域', () => {
    expect(memoryResourceLock('notebook')).toEqual({
      domain: AGENT_MEMORY_RESOURCE_DOMAIN,
      sub: 'notebook',
    });
  });
});

describe('同一资源 ⇒ 同一锁键（P0-1 / P0-2 回归守卫）', () => {
  it('notebook 正式名与兼容别名不再分裂成两个域', () => {
    const a = lockKey('update_notebook');
    const b = lockKey('update_working_memory');
    const c = lockKey('clear_working_memory');
    expect(a).toBe(`${AGENT_MEMORY_RESOURCE_DOMAIN}:notebook`);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('knowledge 工具族共用一个锁键', () => {
    const keys = ['memory_save', 'memory_update', 'memory_update_longterm', 'memory_delete']
      .map((n) => lockKey(n));
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(`${AGENT_MEMORY_RESOURCE_DOMAIN}:knowledge`);
  });

  it('通用文件工具写 agent 记忆文件时改用记忆资源锁（外部编辑不再被静默覆盖）', () => {
    const root = '/tmp/ag-home';
    const viaFileWrite = lockKey('file_write', { path: `${root}/knowledge.md` }, root);
    const viaMemoryTool = lockKey('memory_update');
    expect(viaFileWrite).toBe(viaMemoryTool);

    const viaEdit = lockKey('file_edit', { path: `${root}/NOTEBOOK.md` }, root);
    expect(viaEdit).toBe(lockKey('update_notebook'));

    // 非记忆文件仍是普通 fs 锁，不被误并入记忆资源
    const other = lockKey('file_write', { path: `${root}/src/app.ts` }, root);
    expect(other.startsWith('fs:')).toBe(true);
  });

  it('不同资源互不冲突（并发度不被无谓牺牲）', () => {
    expect(lockKey('update_notebook')).not.toBe(lockKey('memory_update'));
  });

  it('写域表不变式：resource 与 domain 至少有一个，fs 域必须声明路径参数', () => {
    for (const [name, spec] of Object.entries(cls.WRITE_TOOL_DOMAINS)) {
      expect(spec.domain, `${name} 缺少 domain`).toBeTruthy();
      if (spec.domain === 'fs') {
        expect(spec.arg, `${name} 应声明路径参数`).toBeTruthy();
      }
      if (spec.resource) {
        // 声明了资源键就必须真的解析到它（避免表与解析器漂移）
        expect(lockKey(name)).toBe(`${AGENT_MEMORY_RESOURCE_DOMAIN}:${spec.resource}`);
      }
    }
  });
});

describe('别名互斥实际生效（并发）', () => {
  it('update_notebook 与 update_working_memory 并发时严格串行', async () => {
    const registry = new ResourceLockRegistry();
    let active = 0;
    let max = 0;
    const run = (name: string) =>
      registry.withLocks(cls.resourceLocksFor({ name, arguments: {} }), async () => {
        active++;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 30));
        active--;
      });
    await Promise.all([run('update_notebook'), run('update_working_memory')]);
    expect(max).toBe(1);
  });

  it('notebook 与 knowledge 并发时可并行（不同资源）', async () => {
    const registry = new ResourceLockRegistry();
    let active = 0;
    let max = 0;
    const run = (name: string) =>
      registry.withLocks(cls.resourceLocksFor({ name, arguments: {} }), async () => {
        active++;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 30));
        active--;
      });
    await Promise.all([run('update_notebook'), run('memory_update')]);
    expect(max).toBe(2);
  });
});
