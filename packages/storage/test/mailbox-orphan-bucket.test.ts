/**
 * 「无归属」桶必须能被索引查询读到 —— 否则左边有数字、右边永远是空的。
 *
 * 2026-11-26 实证（Owner 截图）：概览工作记录左栏「历史记录」显示 392 条，右栏却是
 * 「这个实体目前没有记录」。根因不是没数据，是**键的形态**：
 *
 *   'none:'.split(':')  →  kind='none', id=''      ← 空 id 是「判定为无归属」的哨兵
 *   右栏索引查询门槛     →  entKind && entId        ← 空串 falsy，被当成「缺参数」
 *
 * 于是「历史记录」这条通路永远走空数组，而左栏的数字来自 COUNT(*) —— 两个口径各自
 * 正确、合起来撒谎。空 id 是**合法键**，不是缺参数。
 *
 * 这个测试同时钉住两件事：①哨兵行能被索引查到；②工作记录不收的遥测（heartbeat）
 * 即使被标记成同一个哨兵，也不会从这条通路漏出来。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqlite, closeSqlite, SqliteMailboxRepo } from '../src/sqlite-storage.js';

let tempDir: string;
let db: ReturnType<typeof openSqlite>;
let repo: SqliteMailboxRepo;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-orphan-bucket-'));
  db = openSqlite(join(tempDir, 'test.db'));
  repo = new SqliteMailboxRepo(db);
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

function seed(id: string, sourceType: string) {
  repo.save({
    id,
    agentId: 'agt_1',
    sourceType,
    priority: 0,
    status: 'completed',
    payload: { text: 'x' },
    metadata: {},
    queuedAt: new Date().toISOString(),
    workUnitRef: null,
  } as never);
}

describe('工作记录：无归属桶的读路径', () => {
  it('哨兵行（entity_kind=none, entity_id=""）能被 getByEntityKey 查到', () => {
    seed('mbx_chat', 'human_chat');
    seed('mbx_beat', 'heartbeat');

    // 回填把「判定为无归属」写成 kind='none' + 空 id 哨兵；heartbeat 也是同一个哨兵。
    repo.setEntityKeys([
      { id: 'mbx_chat', kind: 'none', entityId: '' },
      { id: 'mbx_beat', kind: 'none', entityId: '' },
    ]);

    // 这就是 UI 右栏发出的那个查询：kind='none'、id=''。空 id 必须被当成键。
    const rows = repo.getByEntityKey('agt_1', 'none', '', 50).map((r) => r.id);
    expect(rows).toContain('mbx_chat');

    // heartbeat 属于「工作记录不收」的遥测：被标记了也不能从这条通路漏出来。
    expect(rows).not.toContain('mbx_beat');
  });

  it('未回填的行不会伪装成有归属（entity_id 仍为 NULL）', () => {
    seed('mbx_pending', 'human_chat');
    // 不回填 → 它不在任何实体桶里，但 countUnindexed 必须看得见它。
    expect(repo.getByEntityKey('agt_1', 'none', '', 50)).toHaveLength(0);
    expect(repo.countUnindexed('agt_1')).toBe(1);
  });
});
