/**
 * 守卫：`status_changed_at` = 「这张卡**何时**进入当前状态」，而且**只被真实的状态转移推进**。
 *
 * 为什么需要独立于 `updated_at`：Overview 的「待你处理」队列要按**真实等待时长**排序，
 * 而 `updated_at` 会被任何一次编辑（改标题、加备注、挂交付物）刷新 —— 一张等了三天没人管的
 * 卡，只要有人碰一下备注就会排到队尾。所以「等了多久」必须是一个只随状态转移前进的事实。
 *
 * 因此这里测三件事，且必须跑真的 SQLite（不是 mock repo）：
 *   (a) 一次真实转移会写入新的 `status_changed_at`；
 *   (b) 同状态的 no-op 调用一动都不动它（既不在内存里、也不在库里）；
 *   (c) 旧库升级：存量行由 updated_at 回填、且重复打开不会把后来的值覆盖回去。
 * 一个只写不读、或者被顺手刷新的列，等这个队列上线后就会变成「按有人点过排序」。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskService } from '../src/task-service.js';
// 用 storage 的**源码**实现（与 production 同一份 SCHEMA_SQL / 迁移清单）：
// 这条守卫断言的是「落库的行确实带着这一列」，只有真库能证明。
import {
  openSqlite,
  closeSqlite,
  SqliteOrgRepo,
  SqliteAgentRepo,
  SqliteTaskRepo,
} from '../../storage/src/sqlite-storage.js';

const ORG = 'org-1';
const AGENT = 'agent-a';

/** 一个「很久以前就进入当前状态」的时刻 —— 任何新写入都必须能盖过它。 */
const ANCIENT = '2020-01-01T00:00:00.000Z';

let tempDir: string;
let dbPath: string;
let db: ReturnType<typeof openSqlite>;
let taskRepo: SqliteTaskRepo;
let svc: TaskService;
let taskId: string;

function readColumn(id: string): string | null {
  const row = db
    .prepare('SELECT status_changed_at FROM tasks WHERE id = ?')
    .get(id) as { status_changed_at?: string | null } | undefined;
  return row?.status_changed_at ?? null;
}

function forceColumn(id: string, value: string): void {
  db.prepare('UPDATE tasks SET status_changed_at = ? WHERE id = ?').run(value, id);
}

/** 落库是 fire-and-forget（`.catch` 挂在不 await 的 promise 上），所以轮询等它落地。 */
async function waitForColumn(id: string, pred: (v: string | null) => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (pred(readColumn(id))) return;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`status_changed_at 始终没满足等待条件（当前值=${readColumn(id)}）`);
}

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-status-changed-at-'));
  dbPath = join(tempDir, 'test.db');
  db = openSqlite(dbPath);
  new SqliteOrgRepo(db).createOrg({ id: ORG, name: 'Test Org', ownerId: 'user-1' });
  new SqliteAgentRepo(db).create({
    id: AGENT, name: 'Worker', orgId: ORG, roleId: 'role-1', roleName: 'Developer',
  });
  taskRepo = new SqliteTaskRepo(db);

  svc = new TaskService();
  svc.setGovernancePolicy({
    enabled: false,
    defaultTier: 'auto',
    maxPendingTasksPerAgent: 100,
    maxTotalActiveTasks: 100,
    requireApprovalForPriority: [],
    requireRequirement: false,
    rules: [],
  });
  svc.setTaskRepo(taskRepo as never);

  // creatorRole: 'human' → 初始状态就是 pending，于是「approve 后开始执行」是一条真实转移。
  const task = svc.createTask({
    orgId: ORG,
    title: 'Card',
    description: '',
    assignedAgentId: AGENT,
    reviewerId: AGENT,
    creatorRole: 'human',
  } as never);
  taskId = task.id;
});

afterEach(() => {
  svc.stopTimeoutChecker();
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('tasks.status_changed_at — 只在真实状态转移时推进', () => {
  it('真实转移写入新的 status_changed_at（旧值被盖过，内存与库都不再是旧值）', async () => {
    expect(svc.getTask(taskId)!.status).toBe('pending');
    forceColumn(taskId, ANCIENT);
    expect(readColumn(taskId)).toBe(ANCIENT);

    svc.updateTaskStatus(taskId, 'in_progress', 'user-1', true, true);

    await waitForColumn(taskId, v => v !== null && v !== ANCIENT);
    const written = readColumn(taskId)!;
    const inMemory = svc.getTask(taskId)!.statusChangedAt;

    expect(svc.getTask(taskId)!.status).toBe('in_progress');
    expect(written).not.toBe(ANCIENT);
    expect(inMemory).toBeDefined();
    expect(inMemory).not.toBe(ANCIENT);
    // 两个时刻是同一次转移写下的（内存走 validateAndApplyTransition，库走 updateStatus），
    // 允许几毫秒的表观偏差，但必须是「现在」而不是历史值。
    expect(Date.now() - new Date(written).getTime()).toBeLessThan(5000);
    expect(Date.now() - new Date(inMemory!).getTime()).toBeLessThan(5000);
  });

  it('同状态重复调用（no-op transition）既不写库也不改内存', async () => {
    svc.updateTaskStatus(taskId, 'in_progress', 'user-1', true, true);
    await waitForColumn(taskId, v => v !== null);

    // 把库里和内存里都钉成一个已知时刻，再发一次同状态调用
    forceColumn(taskId, ANCIENT);
    const inMemoryBefore = svc.getTask(taskId)!.statusChangedAt;

    const returned = svc.updateTaskStatus(taskId, 'in_progress', 'user-1', true, true);
    // 早期返回发生在任何持久化之前；给它充足的落地时间，证明「什么都没发生」
    await new Promise<void>(resolve => setTimeout(resolve, 80));

    expect(returned.status).toBe('in_progress');
    expect(svc.getTask(taskId)!.statusChangedAt).toBe(inMemoryBefore);
    expect(readColumn(taskId)).toBe(ANCIENT);
  });

  it('持久层的兜底：直接用同状态调 updateStatus 也不会移动它', async () => {
    // 服务层的早期返回之外还有一道保证 —— 任何绕过 updateTaskStatus 的同状态写入
    // （重复 settle、恢复流程）都不能让「等待时长」倒退。
    db.prepare('UPDATE tasks SET status = ?, status_changed_at = ? WHERE id = ?')
      .run('blocked', ANCIENT, taskId);

    await taskRepo.updateStatus(taskId, 'blocked');

    expect(readColumn(taskId)).toBe(ANCIENT);
  });
});

describe('旧库升级 — 存量行由 updated_at 回填，且重复打开不覆盖后来的真实值', () => {
  /** 造一个「本列还不存在」的历史库（含一行 2021 年就进入 blocked 的卡）。 */
  async function seedLegacyDb(legacyPath: string, updatedAt: string): Promise<void> {
    closeSqlite();
    const { DatabaseSync } = await import('node:sqlite');
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        priority TEXT NOT NULL DEFAULT 'medium',
        assigned_agent_id TEXT NOT NULL,
        reviewer_agent_id TEXT NOT NULL,
        blocked_by TEXT DEFAULT '[]',
        subtasks TEXT DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    legacy
      .prepare(
        `INSERT INTO tasks (id, org_id, title, status, assigned_agent_id, reviewer_agent_id, blocked_by, created_at, updated_at)
         VALUES ('tsk-legacy', 'org-1', 'Legacy', 'blocked', 'agent-a', 'agent-a', '[]', ?, ?)`,
      )
      .run('2020-03-03T00:00:00.000Z', updatedAt);
    legacy.close();
  }

  it('补列后旧行不为 NULL —— 取 updated_at（否则队列里这些卡的等待时长无法计算）', async () => {
    const legacyPath = join(tempDir, 'legacy.db');
    await seedLegacyDb(legacyPath, '2021-04-04T00:00:00.000Z');

    const reopened = openSqlite(legacyPath);
    const row = reopened
      .prepare("SELECT status_changed_at FROM tasks WHERE id = 'tsk-legacy'")
      .get() as { status_changed_at?: string | null };
    expect(row.status_changed_at).toBe('2021-04-04T00:00:00.000Z');

    // 读路径同样能把这个事实交给上层
    const mapped = new SqliteTaskRepo(reopened).listByOrg('org-1').find(r => r.id === 'tsk-legacy');
    expect(mapped?.statusChangedAt).toEqual(new Date('2021-04-04T00:00:00.000Z'));
  });

  it('重复打开是 no-op —— 已经写入的真实转移时刻不会被回填覆盖回去', async () => {
    const legacyPath = join(tempDir, 'legacy.db');
    await seedLegacyDb(legacyPath, '2021-04-04T00:00:00.000Z');

    const first = openSqlite(legacyPath);
    first
      .prepare("UPDATE tasks SET status_changed_at = '2022-02-02T00:00:00.000Z' WHERE id = 'tsk-legacy'")
      .run();
    closeSqlite();

    const second = openSqlite(legacyPath);
    const row = second
      .prepare("SELECT status_changed_at FROM tasks WHERE id = 'tsk-legacy'")
      .get() as { status_changed_at?: string | null };
    // 迁移只在「这一次刚好补上这列」时回填；第二次打开什么都不做
    expect(row.status_changed_at).toBe('2022-02-02T00:00:00.000Z');
  });
});
