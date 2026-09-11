import { describe, it, expect } from 'vitest';
import {
  ResourceLockRegistry,
  GLOBAL_LOCK_DOMAIN,
  locksConflict,
  type LockRequest,
} from '../src/resource-locks.js';

// ── 资源域锁单元测试 ────────────────────────────────────────────────────────
// 覆盖：冲突语义、域内 FIFO、跨域并行、子键细分、全局独占、多域无死锁、可重入。

const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));

/** 观测某段临界区内的并发峰值。 */
function makeProbe() {
  let running = 0;
  const state = { max: 0, order: [] as string[] };
  return {
    state,
    async enter<T>(label: string, fn: () => Promise<T>): Promise<T> {
      running += 1;
      state.max = Math.max(state.max, running);
      state.order.push(`+${label}`);
      try {
        return await fn();
      } finally {
        state.order.push(`-${label}`);
        running -= 1;
      }
    },
  };
}

describe('locksConflict', () => {
  it('全局域与任何请求冲突', () => {
    expect(locksConflict({ domain: GLOBAL_LOCK_DOMAIN }, { domain: 'fs', sub: '/a' })).toBe(true);
    expect(locksConflict({ domain: 'memory' }, { domain: GLOBAL_LOCK_DOMAIN })).toBe(true);
    expect(locksConflict({ domain: GLOBAL_LOCK_DOMAIN }, { domain: GLOBAL_LOCK_DOMAIN })).toBe(true);
  });

  it('不同域不冲突', () => {
    expect(locksConflict({ domain: 'memory' }, { domain: 'notebook' })).toBe(false);
    expect(locksConflict({ domain: 'task', sub: 't1' }, { domain: 'requirement', sub: 'r1' })).toBe(false);
  });

  it('同域：子键相同冲突，不同不冲突；无子键则整域独占', () => {
    expect(locksConflict({ domain: 'fs', sub: '/a' }, { domain: 'fs', sub: '/a' })).toBe(true);
    expect(locksConflict({ domain: 'fs', sub: '/a' }, { domain: 'fs', sub: '/b' })).toBe(false);
    expect(locksConflict({ domain: 'fs' }, { domain: 'fs', sub: '/b' })).toBe(true);
    expect(locksConflict({ domain: 'fs' }, { domain: 'fs' })).toBe(true);
  });
});

describe('ResourceLockRegistry', () => {
  it('同域同子键 → 严格串行', async () => {
    const locks = new ResourceLockRegistry();
    const probe = makeProbe();
    const req: LockRequest = { domain: 'fs', sub: '/x' };

    await Promise.all([
      locks.withLock(req, () => probe.enter('a', () => tick())),
      locks.withLock(req, () => probe.enter('b', () => tick())),
    ]);

    expect(probe.state.max).toBe(1);
  });

  it('同域不同子键 → 可并行（不同文件不互相阻塞）', async () => {
    const locks = new ResourceLockRegistry();
    const probe = makeProbe();

    await Promise.all([
      locks.withLock({ domain: 'fs', sub: '/a' }, () => probe.enter('a', () => tick())),
      locks.withLock({ domain: 'fs', sub: '/b' }, () => probe.enter('b', () => tick())),
    ]);

    expect(probe.state.max).toBe(2);
  });

  it('不同域 → 完全并行', async () => {
    const locks = new ResourceLockRegistry();
    const probe = makeProbe();

    await Promise.all([
      locks.withLock({ domain: 'memory' }, () => probe.enter('mem', () => tick())),
      locks.withLock({ domain: 'notebook' }, () => probe.enter('nb', () => tick())),
      locks.withLock({ domain: 'task', sub: 't1' }, () => probe.enter('t1', () => tick())),
    ]);

    expect(probe.state.max).toBe(3);
  });

  it('全局独占域阻塞所有其他域', async () => {
    const locks = new ResourceLockRegistry();
    const probe = makeProbe();
    const order: string[] = [];

    const wide = locks.withLock({ domain: GLOBAL_LOCK_DOMAIN }, () =>
      probe.enter('wide', async () => {
        await tick(80);
        order.push('wide-done');
      }));
    await tick(5); // 确保 wide 先拿到锁
    const narrow = locks.withLock({ domain: 'memory' }, () =>
      probe.enter('narrow', async () => {
        order.push('narrow-start');
      }));

    await Promise.all([wide, narrow]);
    expect(probe.state.max).toBe(1); // 二者绝不重叠
    expect(order).toEqual(['wide-done', 'narrow-start']);
  });

  it('全局域不会插队（宽锁排队期间已有持有者先完成）', async () => {
    const locks = new ResourceLockRegistry();
    const order: string[] = [];

    const first = locks.withLock({ domain: 'fs', sub: '/a' }, async () => {
      await tick(60);
      order.push('fs-a');
    });
    const wide = locks.withLock({ domain: GLOBAL_LOCK_DOMAIN }, async () => {
      order.push('wide');
    });

    await Promise.all([first, wide]);
    expect(order).toEqual(['fs-a', 'wide']);
  });

  it('域内 FIFO：先到先得，不饥饿', async () => {
    const locks = new ResourceLockRegistry();
    const order: string[] = [];
    const req: LockRequest = { domain: 'memory' };

    await locks.withLock(req, async () => {
      const p1 = locks.withLock(req, async () => { order.push('1'); });
      const p2 = locks.withLock(req, async () => { order.push('2'); });
      const p3 = locks.withLock(req, async () => { order.push('3'); });
      await tick(30); // 让三个等待者都入队
      await Promise.all([p1, p2, p3]);
    });

    expect(order).toEqual(['1', '2', '3']);
  });

  it('多域申请按域键排序获取 —— 交叉申请不死锁', async () => {
    const locks = new ResourceLockRegistry();

    const a = locks.withLocks([{ domain: 'x' }, { domain: 'y' }], async () => {
      await tick(40);
      return 'a';
    });
    const b = locks.withLocks([{ domain: 'y' }, { domain: 'x' }], async () => {
      await tick(40);
      return 'b';
    });

    // 若加锁顺序不一致，这里会永久挂起 → 测试超时失败。
    await expect(Promise.all([a, b])).resolves.toEqual(['a', 'b']);
  });

  it('可重入：同一调用链内重复申请已持有的域不会自死锁', async () => {
    const locks = new ResourceLockRegistry();
    const req: LockRequest = { domain: 'memory' };

    const result = await locks.withLock(req, async () => {
      // 模拟「写工具内部又调用同域写工具」
      return locks.withLock(req, async () => 'nested-ok');
    });

    expect(result).toBe('nested-ok');
  });

  it('可重入不破坏并行语义：同一 worker 的并行调用仍被串行化', async () => {
    const locks = new ResourceLockRegistry();
    const probe = makeProbe();
    const req: LockRequest = { domain: 'memory' };

    await locks.withLock({ domain: 'outer' }, async () => {
      // 同一 ALS 上下文下发起两个并行同域请求 —— 它们不共享「已持有」集合，
      // 因此必须互相等待（这正是不同 worker/并行工具调用需要的行为）。
      await Promise.all([
        locks.withLock(req, () => probe.enter('a', () => tick())),
        locks.withLock(req, () => probe.enter('b', () => tick())),
      ]);
    });

    expect(probe.state.max).toBe(1);
  });

  it('释放后不残留：锁表不随调用次数无界增长', async () => {
    const locks = new ResourceLockRegistry();
    for (let i = 0; i < 50; i++) {
      await locks.withLock({ domain: `d${i}`, sub: `s${i}` }, async () => undefined);
    }
    expect(locks.snapshotHeld()).toHaveLength(0);
  });

  it('fn 抛错时锁仍被释放', async () => {
    const locks = new ResourceLockRegistry();
    await expect(
      locks.withLock({ domain: 'memory' }, async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');

    expect(locks.snapshotHeld()).toHaveLength(0);
    // 后续获取不该被卡住
    await expect(locks.withLock({ domain: 'memory' }, async () => 'ok')).resolves.toBe('ok');
  });
});
