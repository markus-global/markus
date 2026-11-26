/**
 * 回合开始 ⇒ 台账必须说 running（唯一执行点：claimItem）
 *
 * 实测根因（2026-11-26 活探针 razor-verify-0006）：外部信号的回合真的跑了
 * 7 次模型调用 + 7 组工具调用，但 `work_units` 那行仍是 `idle`、`claimed_by` 空。
 * 于是 `work_status` 把「正在输出的回合」报成「没人在干活」——台账撒谎。
 *
 * 为什么修在 `claimItem` 而不是某个 sourceType 的分支里：它是「这个回合开始了」的
 * **唯一写者**（同时写 status='processing' / started_at / claimed_by / lease_until）。
 * 认领成功即回合开始，所以拉回 running 属于同一个事实、同一个执行点，覆盖**所有**
 * 邮箱类型，而不是给外部信号补一处特例。
 *
 * 口径与 chat 路径一致（api-server 的 prepareChatTurnWorkUnit）：
 * 「回合正在开始 ⇒ 这一行必须是 running；ensure() 对已存在的行什么都不做，
 *   所以撞上已收口的 idle 行时必须显式拉回」。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  openSqlite,
  closeSqlite,
  SqliteMailboxRepo,
  SqliteWorkUnitRepo,
} from '../src/sqlite-storage.js';

let tempDir: string;
let db: ReturnType<typeof openSqlite>;
let repo: SqliteMailboxRepo;
let units: SqliteWorkUnitRepo;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-wu-claim-'));
  db = openSqlite(join(tempDir, 'test.db'));
  repo = new SqliteMailboxRepo(db);
  units = new SqliteWorkUnitRepo(db);
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

function seedItem(id: string, workUnitRef: string | null) {
  repo.save({
    id,
    agentId: 'agt_1',
    sourceType: 'external_signal',
    priority: 1,
    status: 'queued',
    payload: { summary: 'world fact', content: 'deploy finished' },
    metadata: {},
    queuedAt: new Date().toISOString(),
    workUnitRef,
  } as never);
}

describe('claiming a turn makes its work unit running', () => {
  it('pulls an idle work unit back to running when the turn is claimed', () => {
    const ref = 'external:src_test:probe-1';
    seedItem('mbx_1', ref);
    // 入站时建的是 idle 行（外部信号先落库、后被认领）。
    units.ensure({ ref, agentId: 'agt_1', status: 'idle' } as never);
    expect(units.getByRef(ref)?.status).toBe('idle');

    const won = repo.claimItem('mbx_1', 'agt_1', iso(60_000), new Date().toISOString());
    expect(won).toBe(true);

    // 回合已开始 ⇒ 台账不能说「没在跑」。
    expect(units.getByRef(ref)?.status).toBe('running');
  });

  it('does not touch the ledger when the claim is lost (unique winner)', () => {
    const ref = 'external:src_test:probe-2';
    seedItem('mbx_2', ref);
    units.ensure({ ref, agentId: 'agt_1', status: 'idle' } as never);

    const nowIso = new Date().toISOString();
    expect(repo.claimItem('mbx_2', 'agt_1', iso(60_000), nowIso)).toBe(true);
    // 第二次认领必败（有效租约持有中）——败者不得改写台账。
    expect(repo.claimItem('mbx_2', 'agt_other', iso(60_000), nowIso)).toBe(false);
    expect(units.getByRef(ref)?.claimedBy ?? null).not.toBe('agt_other');
  });

  it('leaves items without a work unit ref alone (record-only signals)', () => {
    seedItem('mbx_3', null);
    expect(repo.claimItem('mbx_3', 'agt_1', iso(60_000), new Date().toISOString())).toBe(true);
    expect(repo.getById('mbx_3')?.status).toBe('processing');
  });
});