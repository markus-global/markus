/**
 * C10-0B §3.5 / §4-7 —— 每日真库审计：**一天一条记录**（独占创建），只对纪元后违规告警。
 *
 * 判据（真实文件系统 + 真实 SQLite，零 mock 的持久层）：
 *   ① 同一天第二次调用 → 不再写第二条记录（`wx` 独占创建：第一个 agent 赢，其余跳过）；
 *   ② 纪元**前**的违规行 → 门禁计数为 0、不告警（历史是档案，不是违规）；
 *   ③ 纪元**后**的违规行 → 门禁计数 > 0、告警（否则这台仪器看不见本卡的 leak）；
 *   ④ 哨兵期（纪元未定值）→ 独立 epoch-unset 状态 + 告警，绝不静默绿（CTO 裁决 A ③）。
 *
 * ②③ 就是「双向咬人」：只咬后一半的门禁会漏掉真的 leak，只咬前一半的门禁会永远红。
 *
 * 基线上本文件立刻红：`identity-audit-runner` 模块不存在。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createIdentityAuditPort } from '../src/identity-audit-runner.js';
import { makeIdentityGates } from '@markus/shared';

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * 夹具纪元（显式注入）：产品常量在哨兵期是 null（CTO 裁决 A），
 * 行为测试必须自带一个已定值的纪元才能验「纪元前沉默 / 纪元后咬人」。
 */
const TEST_EPOCH = '2026-11-15T00:00:00.000Z';
const EPOCH_MS = Date.parse(TEST_EPOCH);

let home: string;

/** 门禁要读的四张表 —— 与 scripts/identity-audit.mjs 的夹具同形（无触发器，违规样本能塞进去）。 */
const DDL = `
CREATE TABLE mailbox_items (
  id TEXT PRIMARY KEY, agent_id TEXT, source_type TEXT, status TEXT,
  queued_at TEXT, work_unit_ref TEXT, envelope TEXT, completed_at TEXT
);
CREATE TABLE work_units (id TEXT PRIMARY KEY, ref TEXT UNIQUE, status TEXT, lease_until TEXT);
CREATE TABLE facts (
  id TEXT PRIMARY KEY, subject_kind TEXT, subject_id TEXT, predicate TEXT,
  value_json TEXT, work_unit_ref TEXT, asserted_by TEXT, source_refs_json TEXT,
  verification_json TEXT, confidence REAL DEFAULT 1.0, created_at TEXT,
  superseded_by TEXT, superseded_at TEXT
);
CREATE TABLE agent_decisions (id TEXT PRIMARY KEY, agent_id TEXT, work_unit_ref TEXT, created_at TEXT);
`;

function makeDb(rows: { decisions?: Array<{ id: string; createdAt: string }> }): string {
  const dbPath = join(home, 'data.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(DDL);
    for (const d of rows.decisions ?? []) {
      db.prepare('INSERT INTO agent_decisions (id, agent_id, work_unit_ref, created_at) VALUES (?, ?, NULL, ?)')
        .run(d.id, 'agt_x', d.createdAt);
    }
  } finally {
    db.close();
  }
  return dbPath;
}

function recordsDir(): string {
  return join(home, 'records', 'identity-audit');
}

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function readRecord(file: string): {
  date: string; ranAt: string; agentId: string; epoch: string | null; state: string; dbPath: string;
  gates: Array<{ id: number; name: string; count: number }>;
} {
  return JSON.parse(readFileSync(join(recordsDir(), file), 'utf-8'));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'markus-identity-audit-runner-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('C10-0B §3.5：每日真库审计（独占一天一条）', () => {
  it('同一天第二次调用跳过：目录里只有一条当天记录', () => {
    const dbPath = makeDb({});
    const log = makeLog();
    const now = () => new Date(EPOCH_MS + 10 * DAY_MS);
    const port = createIdentityAuditPort({ agentId: 'agt_a', markusHome: home, dbPath, log, now, epoch: TEST_EPOCH });

    port.runDaily();
    port.runDaily();

    const files = readdirSync(recordsDir());
    expect(files, '一天只能有一条记录（第二个 agent 必须跳过，不得覆盖）').toEqual([
      `${now().toISOString().slice(0, 10)}.json`,
    ]);

    const record = readRecord(files[0]!);
    expect(record.date).toBe(now().toISOString().slice(0, 10));
    expect(record.agentId).toBe('agt_a');
    expect(record.epoch).toBe(TEST_EPOCH);
    expect(record.state).toBe('pass');
    expect(record.dbPath).toBe(dbPath);
    expect(record.gates.length).toBe(makeIdentityGates({ epoch: TEST_EPOCH }).length);
    expect(log.error, '干净库不得告警').not.toHaveBeenCalled();
  });

  it('纪元前的违规行不算违规：门禁为 0、不告警', () => {
    const dbPath = makeDb({
      decisions: [{ id: 'dec_pre_epoch', createdAt: new Date(EPOCH_MS - DAY_MS).toISOString() }],
    });
    const log = makeLog();
    const port = createIdentityAuditPort({
      agentId: 'agt_a', markusHome: home, dbPath, log,
      now: () => new Date(EPOCH_MS + 5 * DAY_MS), epoch: TEST_EPOCH,
    });
    port.runDaily();

    const [file] = readdirSync(recordsDir());
    const record = readRecord(file!);
    expect(record.gates.find(g => g.id === 11)!.count, '纪元前的历史行是档案，不是违规').toBe(0);
    expect(record.state).toBe('pass');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('纪元后的违规行必须咬住：门禁计数 > 0 且告警', () => {
    const dbPath = makeDb({
      decisions: [
        { id: 'dec_pre_epoch', createdAt: new Date(EPOCH_MS - DAY_MS).toISOString() },
        { id: 'dec_post_epoch', createdAt: new Date(EPOCH_MS + DAY_MS).toISOString() },
      ],
    });
    const log = makeLog();
    const port = createIdentityAuditPort({
      agentId: 'agt_a', markusHome: home, dbPath, log,
      now: () => new Date(EPOCH_MS + 6 * DAY_MS), epoch: TEST_EPOCH,
    });
    port.runDaily();

    const [file] = readdirSync(recordsDir());
    const record = readRecord(file!);
    expect(record.state).toBe('fail');
    expect(record.gates.find(g => g.id === 11)!.count).toBe(1);
    expect(log.error, '有纪元后违规就必须告警').toHaveBeenCalled();
  });

  it('哨兵期（纪元未定值）：独立 epoch-unset 状态 + 告警，绝不静默绿', () => {
    const dbPath = makeDb({});
    const log = makeLog();
    const port = createIdentityAuditPort({
      agentId: 'agt_a', markusHome: home, dbPath, log,
      now: () => new Date(EPOCH_MS + 7 * DAY_MS), epoch: null,
    });
    const record = port.runDaily();
    expect(record?.state, '未定值不是「通过」——必须是独立状态').toBe('epoch-unset');
    expect(record?.epoch).toBeNull();
    expect(log.error, '哨兵期必须告警（否则这段窗口是假绿）').toHaveBeenCalled();
    const [file] = readdirSync(recordsDir());
    expect(readRecord(file!).state, '每日记录必须原样贴出哨兵状态').toBe('epoch-unset');
  });
});