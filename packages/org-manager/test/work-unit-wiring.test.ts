/**
 * 第七刀 C7 —— WorkUnit 装配顺序（真实事故的回归守卫）。
 *
 * 事故（2026-11-14 现场）：`work_units` 表建好了，但线上**一行数据都没有**，
 * 而且没有任何报错。链条是：
 *
 *   1. `start.ts` 在 `setStorage(storage)`（:1435）**之前**就读了一次
 *      `apiServer.workUnits`（:1148）；
 *   2. 那个 getter 把「这会儿还没有 storage」的答案 **`null`** 也缓存了
 *      （`if (this._workUnits !== undefined) return this._workUnits`）；
 *   3. 于是 storage 接入后仍然永远返回 null →
 *      C7-B 的 taskService/agentManager 端口没接、chat 生产者跳过、
 *      A2A 投递器拿到 `NULL_WORK_UNITS` 空实现 → 静默无数据。
 *
 * 判据：**「暂时没有」不是事实，不能落缓存**。依赖晚到是常态（惰性装配），
 * 一个依赖的缺席不应被冻结成永久属性。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openSqlite, closeSqlite, SqliteWorkUnitRepo } from '../../storage/src/sqlite-storage.js';
import { APIServer } from '../src/api-server.js';
import { TaskService } from '../src/task-service.js';

let tempDir: string;
let db: DatabaseSync;

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-wu-wiring-'));
  db = openSqlite(join(tempDir, 'data.db')) as unknown as DatabaseSync;
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * 递归桩：`APIServer` 构造期会拿 orgService 做一串装配（模板注册表、群聊 handler 等），
 * 本测试只关心 storage → workUnits 的时序，所以对这些协作者给一个「任何属性都是自己、
 * 调用也返回自己」的桩，避免用 `{}` 半成品把失败原因变成 TypeError。
 */
const deepStub: unknown = new Proxy(function () {} as unknown as object, {
  get: () => deepStub,
  apply: () => deepStub,
});

function server(): APIServer {
  return new APIServer(deepStub as never, new TaskService());
}

function bridge() {
  return { workUnitRepo: new SqliteWorkUnitRepo(db) } as never;
}

describe('WorkUnit 装配顺序：storage 晚于首次读取接入', () => {
  it('首次读到 null 之后，storage 接入仍必须拿到服务（不得缓存「没有」）', () => {
    const api = server();
    // start.ts:1148 的真实动作：storage 还没接时先读一次
    expect(api.workUnits).toBeNull();

    // start.ts:1435 的真实动作：接 storage
    api.setStorage(bridge());

    expect(api.workUnits).not.toBeNull();
  });

  it('接线后 ensure 真的落库（不是空实现）', () => {
    const api = server();
    api.workUnits; // 先读一次，复现事故顺序
    api.setStorage(bridge());

    const wu = api.workUnits!.ensure({ ref: 'session:probe_sess:r1', agentId: 'agt_probe' });

    expect(wu).not.toBeNull();
    const row = new SqliteWorkUnitRepo(db).getByRef('session:probe_sess:r1');
    expect(row?.agentId).toBe('agt_probe');
  });

  it('没有 storage 的装配路径（CLI 无存储）仍然安静返回 null，不报错', () => {
    const api = server();
    expect(api.workUnits).toBeNull();
    expect(api.workUnits).toBeNull();
  });
});
