/**
 * ResourceLockRegistry — 资源域互斥锁（并发处理的共享状态一致性基石）。
 *
 * ## 为什么需要它
 *
 * 并发模式下多个 worker 同时跑在同一个 Agent 实例里。实体亲和锁（mailbox
 * `entityKeyOf`）已经保证「同一任务/需求/会话/用户」不会被两个 worker 同时处理，
 * 但**跨实体共享资源**仍然可能被并发写：文件系统、记忆文件、笔记本、全局配置。
 *
 * 早期实现用「一把 Agent 级全局写锁」串行化所有写工具 —— 正确但过于粗暴：
 * 一个 worker 跑 `shell_execute` 时，其他 worker 连 `task_update` 都写不了，
 * 并发收益被抹平。
 *
 * 本模块把它升级为**资源域（domain）锁**：
 *
 * | 域 | 语义 | 例子 |
 * |---|---|---|
 * | `'*'` | 全局独占 —— 与**任何**请求冲突 | `shell_execute`（可触及任意资源）、安装、未知写工具 |
 * | `'fs'` + `sub` | 同一文件互斥，不同文件并行 | `file_write {path}` |
 * | `'memory'` / `'notebook'` / … | 单体资源互斥 | `memory_save` |
 * | `'task'` + `sub` | 同一实体互斥，不同实体并行 | `task_update {task_id}` |
 *
 * ## 关键性质
 *
 * 1. **可重入**：同一调用链（AsyncLocalStorage 维度）重复申请已持有的域会立即放行，
 *    避免工具内部嵌套调用同域写工具造成自死锁；但同一 worker 的**并行**工具调用
 *    （`Promise.all`）不共享该上下文，因此仍会被正确串行化。
 * 2. **无死锁**：多域申请按域名字典序排序后依次获取（全局一致的加锁顺序）。
 * 3. **域内 FIFO**：同一域的等待者严格先到先得，不会饥饿；域之间互不阻塞
 *    （跨域无队头阻塞）。
 * 4. **失败安全**：未分类的写工具落到 `'*'`，宁可串行不可竞态。
 *
 * 已知取舍：`'*'` 请求在已被其他域占用时需等待，期间其他域仍可继续获取
 * （非写者优先），理论上 `'*'` 可能被短暂推迟。因为每次持锁都很短，实际可忽略。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** 全局独占域：与任何其他请求冲突。 */
export const GLOBAL_LOCK_DOMAIN = '*';

/**
 * 一次加锁请求。
 *
 * `sub` 是域内的细分键（如文件绝对路径、task id）。
 * - 带 `sub` 的请求之间：`sub` 相同 → 冲突；不同 → 不冲突（可并行）。
 * - 不带 `sub` 的请求 = 整个域独占：与该域内任何请求冲突。
 */
export interface LockRequest {
  domain: string;
  sub?: string;
}

/** 两个请求是否互相冲突。 */
export function locksConflict(a: LockRequest, b: LockRequest): boolean {
  if (a.domain === GLOBAL_LOCK_DOMAIN || b.domain === GLOBAL_LOCK_DOMAIN) return true;
  if (a.domain !== b.domain) return false;
  if (a.sub === undefined || b.sub === undefined) return true;
  return a.sub === b.sub;
}

/** 稳定的域键（用于 ALS 重入判定与排序）。 */
function lockKey(req: LockRequest): string {
  return req.sub === undefined ? req.domain : `${req.domain}\u0000${req.sub}`;
}

interface Waiter {
  req: LockRequest;
  resolve: () => void;
}

/** 当前调用链已持有的锁键集合（可重入判定）。 */
const heldLocksStore = new AsyncLocalStorage<ReadonlySet<string>>();

export class ResourceLockRegistry {
  /** domain → 该域的 FIFO 等待队列。 */
  private readonly queues = new Map<string, Waiter[]>();
  /** 当前已被授予、尚未释放的请求。 */
  private readonly active: LockRequest[] = [];

  /**
   * 依次获取一组锁，执行 `fn`，然后逆序释放。
   * 请求按域键排序获取，保证全局一致的加锁顺序（无死锁）。
   */
  async withLocks<T>(requests: readonly LockRequest[], fn: () => Promise<T>): Promise<T> {
    const sorted = dedupeRequests(requests).sort((a, b) => (lockKey(a) < lockKey(b) ? -1 : lockKey(a) > lockKey(b) ? 1 : 0));
    return this.acquireChain(sorted, 0, fn);
  }

  /** 单域便捷形式。 */
  withLock<T>(request: LockRequest, fn: () => Promise<T>): Promise<T> {
    return this.withLocks([request], fn);
  }

  /** 当前已被持有的请求（观测/测试用）。 */
  snapshotHeld(): LockRequest[] {
    return [...this.active];
  }

  private async acquireChain<T>(
    requests: readonly LockRequest[],
    index: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (index >= requests.length) return fn();

    const req = requests[index];
    const key = lockKey(req);
    const outerHeld = heldLocksStore.getStore();

    // 可重入：本调用链已持有该域 → 直接进入下一层。
    if (outerHeld?.has(key)) {
      return this.acquireChain(requests, index + 1, fn);
    }

    await this.acquireOne(req);
    const nextHeld = new Set(outerHeld ?? []);
    nextHeld.add(key);
    try {
      return await heldLocksStore.run(nextHeld, () => this.acquireChain(requests, index + 1, fn));
    } finally {
      this.releaseOne(req);
    }
  }

  private acquireOne(req: LockRequest): Promise<void> {
    return new Promise<void>(resolve => {
      const queue = this.queues.get(req.domain);
      const waiter: Waiter = { req, resolve };
      if (queue) queue.push(waiter);
      else this.queues.set(req.domain, [waiter]);
      this.pump();
    });
  }

  private releaseOne(req: LockRequest): void {
    const idx = this.active.findIndex(a => a.domain === req.domain && a.sub === req.sub);
    if (idx >= 0) this.active.splice(idx, 1);
    this.pump();
  }

  /**
   * 冲突感知的授予循环：只要某域队头不与当前持有集合冲突就授予它。
   * 域内 FIFO（队头未授予则后续等待），域间互不阻塞。
   */
  private pump(): void {
    const emptied: string[] = [];
    let progress = true;
    while (progress) {
      progress = false;
      for (const [domain, queue] of this.queues) {
        const head = queue[0];
        if (!head) {
          if (queue.length === 0) emptied.push(domain);
          continue;
        }
        if (this.active.some(held => locksConflict(held, head.req))) continue;
        queue.shift();
        this.active.push(head.req);
        // 先登记再唤醒：被唤醒的 fn 可能在微任务里立即再次申请锁。
        head.resolve();
        progress = true;
      }
    }
    for (const domain of emptied) this.queues.delete(domain);
  }
}

function dedupeRequests(requests: readonly LockRequest[]): LockRequest[] {
  const seen = new Set<string>();
  const out: LockRequest[] = [];
  for (const req of requests) {
    const key = lockKey(req);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(req);
  }
  return out;
}
