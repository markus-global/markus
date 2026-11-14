/**
 * C8 —— 本轮 WorkUnit 的 ref 必须落在**正在跑的那个会话**上。
 *
 * 2026-11-14 真机根因（两个解析器算同一个事实）：
 *   `prepareChatTurnWorkUnit` 在入口没传 `knownSessionId` 时，用
 *   `getSessionsByAgent(..., 1)[0]` 自己猜会话；而那个查询按 `is_main DESC` 排序，
 *   主会话永远排第一，哪怕它是几小时前的。结果每轮 ref 都算到主会话上（如 r322），
 *   那一行早已 idle，`ensure()` 对已存在的行不改状态 → 「正在运行」永远 0。
 *
 * 两条不变量，各自单独会咬人：
 *   1. 拿不到 id 时取**最近活跃**（last_message_at），不是主会话；
 *   2. 回合正在开始 ⇒ 该 ref 必须是 running（撞上已收口的 idle 行要拉回来）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import {
  openSqlite,
  closeSqlite,
  SqliteWorkUnitRepo,
  SqliteChatSessionRepo,
} from '../../storage/src/sqlite-storage.js';
import { WorkUnitService } from '../src/work-unit-service.js';
import { APIServer } from '../src/api-server.js';

let tempDir: string;
let db: DatabaseSync;
let repo: SqliteWorkUnitRepo;
let units: WorkUnitService;

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-chatref-'));
  db = openSqlite(join(tempDir, 'data.db')) as unknown as DatabaseSync;
  db.prepare('INSERT INTO organizations (id, name, owner_id) VALUES (?, ?, ?)')
    .run('org_1', 'Probe Org', 'owner_1');
  db.prepare('INSERT INTO agents (id, name, org_id, role_id, role_name) VALUES (?, ?, ?, ?, ?)')
    .run('agt_a', 'A', 'org_1', 'role_worker', 'Worker');
  repo = new SqliteWorkUnitRepo(db);
  units = new WorkUnitService({ repo, onEvent: () => {} });
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

function seedSession(id: string, isMain: 0 | 1, lastMessageAt: string): void {
  db.prepare(
    `INSERT INTO chat_sessions (id, agent_id, user_id, title, created_at, last_message_at, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, 'agt_a', 'user_1', id, lastMessageAt, lastMessageAt, isMain);
}

/** 只装 storage + workUnits 两个依赖，直接驱动那个私有派生点（它就是唯一执行点）。 */
function prepare(server: { storage: unknown }): (agentId: string, senderId: string, known?: string | null) => Promise<string | null> {
  const svc = Object.create(APIServer.prototype) as unknown as {
    storage: unknown;
    _workUnits: unknown;
    prepareChatTurnWorkUnit: (a: string, s: string, k?: string | null) => Promise<string | null>;
  };
  svc.storage = { chatSessionRepo: new SqliteChatSessionRepo(db), workUnitRepo: repo };
  svc._workUnits = units;
  return (a, s, k) => svc.prepareChatTurnWorkUnit(a, s, k);
}

describe('C8：本轮 ref 必须落在正在跑的会话上', () => {
  it('主会话更旧时，取最近活跃的那个（不是 is_main）', async () => {
    seedSession('cs_main_old', 1, '2026-11-14T08:00:00.000Z');
    seedSession('cs_live', 0, '2026-11-14T12:30:00.000Z');
    const ref = await prepare({ storage: null })('agt_a', 'user_1');
    expect(ref).toBe('session:cs_live:r1');
    expect(repo.getByRef('session:cs_live:r1')!.status).toBe('running');
  });

  it('入口给了 id，就用它（不信排序、不猜）', async () => {
    seedSession('cs_main_old', 1, '2026-11-14T08:00:00.000Z');
    seedSession('cs_live', 0, '2026-11-14T12:30:00.000Z');
    const ref = await prepare({ storage: null })('agt_a', 'user_1', 'cs_main_old');
    expect(ref).toBe('session:cs_main_old:r1');
  });

  it('ref 撞上已收口的 idle 行 → 必须拉回 running（否则台账说没在跑）', async () => {
    seedSession('cs_live', 0, '2026-11-14T12:30:00.000Z');
    const call = prepare({ storage: null });
    const ref = await call('agt_a', 'user_1');
    expect(ref).toBe('session:cs_live:r1');
    units.transition(ref!, 'idle');
    expect(repo.getByRef(ref!)!.status).not.toBe('running');
    // 同轮重入（重试 / 重发）：仍必须显示在跑
    await call('agt_a', 'user_1');
    expect(repo.getByRef(ref!)!.status).toBe('running');
  });
});
