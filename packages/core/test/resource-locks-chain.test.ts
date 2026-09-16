import { describe, it, expect } from 'vitest';
import {
  ResourceLockRegistry,
  GLOBAL_LOCK_DOMAIN,
  LockNestingConflictError,
  locksConflict,
} from '../src/resource-locks.js';

// ── 资源域锁：链内嵌套冲突（潜在自死锁）回归 ─────────────────────────────────
// `pump()` 用「当前持有集合」判冲突。旧实现把**本调用链自己已持有的锁**也算进去，
// 于是链内先取细粒度锁、再取与之冲突的 `'*'`（或整域独占）时会永远等自己。
// 本文件不变量：「无死锁」必须对**链内嵌套**也成立 —— 手段是**快速失败**
// （抛 LockNestingConflictError）而不是放行，后者会削弱 `'*'` 的独占语义。

describe('ResourceLockRegistry — 链内嵌套冲突（自死锁）', () => {
  it("链内先取细分域再取 '*'：不得挂起，必须快速失败", async () => {
    const reg = new ResourceLockRegistry();
    let caught: unknown;
    const done = await Promise.race([
      reg.withLock({ domain: 'fs', sub: '/a.txt' }, async () => {
        try {
          await reg.withLock({ domain: GLOBAL_LOCK_DOMAIN }, async () => 'should-not-run');
        } catch (err) {
          caught = err;
        }
        return 'handled';
      }),
      new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 800)),
    ]);
    // 旧实现在此永久挂起（timeout）；现在必须返回且给出明确错误
    expect(done).toBe('handled');
    expect(caught).toBeInstanceOf(LockNestingConflictError);
    expect((caught as LockNestingConflictError).held).toEqual({ domain: 'fs', sub: '/a.txt' });
    expect((caught as LockNestingConflictError).requested).toEqual({ domain: GLOBAL_LOCK_DOMAIN });
    // 失败后不得泄漏锁
    expect(reg.snapshotHeld()).toEqual([]);
  });

  it('链内重复申请**同域同细分键**仍可重入（不算嵌套冲突）', async () => {
    const reg = new ResourceLockRegistry();
    const out = await Promise.race([
      reg.withLock({ domain: 'notebook' }, async () => {
        return reg.withLock({ domain: 'notebook' }, async () => 'reentrant-ok');
      }),
      new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 800)),
    ]);
    expect(out).toBe('reentrant-ok');
  });

  it('链内申请**互不冲突**的另一域：正常放行（非嵌套冲突）', async () => {
    const reg = new ResourceLockRegistry();
    const out = await Promise.race([
      reg.withLock({ domain: 'fs', sub: '/a' }, async () => {
        return reg.withLock({ domain: 'memory' }, async () => 'parallel-ok');
      }),
      new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 800)),
    ]);
    expect(out).toBe('parallel-ok');
  });

  it('多级嵌套冲突只影响冲突那一层，外层与后续申请不受影响', async () => {
    const reg = new ResourceLockRegistry();
    const out = await Promise.race([
      reg.withLocks([{ domain: 'task', sub: 't1' }, { domain: 'memory' }], async () => {
        // 与已持有的 task:t1 / memory 都冲突 → 必须抛
        await expect(reg.withLock({ domain: GLOBAL_LOCK_DOMAIN }, async () => 'x'))
          .rejects.toBeInstanceOf(LockNestingConflictError);
        return 'outer-still-ok';
      }),
      new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 800)),
    ]);
    expect(out).toBe('outer-still-ok');
    expect(reg.snapshotHeld()).toEqual([]);
  });

  it('跨链互斥不得放松：另一条链的冲突请求仍被阻塞', async () => {
    const reg = new ResourceLockRegistry();
    const order: string[] = [];
    let releaseA: () => void = () => {};
    const gate = new Promise<void>(r => { releaseA = r; });

    const chainA = reg.withLock({ domain: GLOBAL_LOCK_DOMAIN }, async () => {
      order.push('A-in');
      await gate;
      order.push('A-out');
    });
    // 让 A 先拿到锁
    await new Promise(r => setTimeout(r, 20));

    const chainB = reg.withLock({ domain: 'fs', sub: '/x' }, async () => {
      order.push('B-in');
    });
    await new Promise(r => setTimeout(r, 20));
    // B 与 A 的 '*' 冲突 → 必须仍在等待（不同链，不能豁免）
    expect(order).toEqual(['A-in']);

    releaseA();
    await Promise.all([chainA, chainB]);
    expect(order).toEqual(['A-in', 'A-out', 'B-in']);
  });

  it('同 worker 的并行工具调用是两条独立链 → 仍严格串行', async () => {
    const reg = new ResourceLockRegistry();
    let running = 0;
    let max = 0;
    const work = () => reg.withLock({ domain: 'memory' }, async () => {
      running += 1;
      max = Math.max(max, running);
      await new Promise(r => setTimeout(r, 60));
      running -= 1;
    });

    // Promise.all 的两个调用各自是顶层 withLocks → 不同上下文 → 必须互斥
    await Promise.all([work(), work()]);
    expect(max).toBe(1);
  });

  it('snapshotHeld() 仍返回 LockRequest 形状', async () => {
    const reg = new ResourceLockRegistry();
    let snap: unknown;
    await reg.withLock({ domain: 'fs', sub: '/f' }, async () => {
      snap = reg.snapshotHeld();
    });
    expect(snap).toEqual([{ domain: 'fs', sub: '/f' }]);
    expect(reg.snapshotHeld()).toEqual([]);
  });

  it('locksConflict 语义不变（细分域并行、全局域独占）', () => {
    expect(locksConflict({ domain: 'fs', sub: 'a' }, { domain: 'fs', sub: 'a' })).toBe(true);
    expect(locksConflict({ domain: 'fs', sub: 'a' }, { domain: 'fs', sub: 'b' })).toBe(false);
    expect(locksConflict({ domain: GLOBAL_LOCK_DOMAIN }, { domain: 'fs', sub: 'a' })).toBe(true);
  });

  it('抛出异常也不会泄漏锁（后续申请可继续）', async () => {
    const reg = new ResourceLockRegistry();
    await expect(
      reg.withLock({ domain: 'notebook' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(reg.snapshotHeld()).toEqual([]);
    const ok = await Promise.race([
      reg.withLock({ domain: 'notebook' }, async () => 'ok'),
      new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 500)),
    ]);
    expect(ok).toBe('ok');
  });
});
