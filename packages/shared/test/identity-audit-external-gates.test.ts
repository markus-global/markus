/**
 * C10-B —— 流量门禁搭 C10-0G 的同一套审计（不建第二套机制）。
 *
 * 新判据（makeIdentityGates 唯一写者）：
 *   · 14：未验证外部信号带权威 intent（天花板违规）—— 读信封 JSON（事实源），
 *         不读 intent 投影列（夹具没有该列；投影是读侧便利，不是第二事实源）。
 *   · 15：external_signal 行的 ref 不是唯一构造器形状（第二建造点的库内证据）。
 *
 * base（37c817aa）上必须红：两条判据不存在。
 * 咬人/纪元前沉默/修好归零的三段自检在 scripts/identity-audit.mjs --self-test
 * （同一夹具扩展，CI 层 1 门禁）。
 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { makeIdentityGates } from '../src/identity-audit.js';

const EPOCH = '2026-11-22T12:18:34.000Z';
const POST = '2026-11-22T13:00:00.000Z';
const PRE = '2026-11-22T11:00:00.000Z';

function fixtureDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE mailbox_items (
    id TEXT PRIMARY KEY, agent_id TEXT, source_type TEXT, status TEXT,
    queued_at TEXT, work_unit_ref TEXT, envelope TEXT, completed_at TEXT
  );`);
  return db;
}

describe('C10-B：审计判据 14/15（搭 0G 同一套门禁）', () => {
  it('判据 14/15 存在于唯一门禁清单', () => {
    const gates = makeIdentityGates({ epoch: EPOCH });
    const ids = gates.map(g => g.id);
    expect(ids).toContain(14);
    expect(ids).toContain(15);
  });

  it('判据 14 咬人：未验证外部 + 权威 intent = 违规；验证过 / deliver / 纪元前 = 沉默', () => {
    const db = fixtureDb();
    const env = (verified: boolean, intent: string) => JSON.stringify({
      from: { kind: 'external', address: 'x@y.z' }, fromVerified: verified, intent,
    });
    db.prepare('INSERT INTO mailbox_items VALUES (?,?,?,?,?,?,?,?)').run(
      'm14_bad', 'a', 'external_signal', 'queued', POST, 'external:s:m', env(false, 'trigger_execution'), null);
    const gate14 = makeIdentityGates({ epoch: EPOCH }).find(g => g.id === 14)!;
    expect(gate14).toBeDefined();
    expect((db.prepare(gate14!.sql).get() as { c: number }).c).toBe(1);
    // 合法样本不计数。
    db.prepare('INSERT INTO mailbox_items VALUES (?,?,?,?,?,?,?,?)').run(
      'm14_ok1', 'a', 'external_signal', 'queued', POST, 'external:s:m2', env(false, 'deliver'), null);
    db.prepare('INSERT INTO mailbox_items VALUES (?,?,?,?,?,?,?,?)').run(
      'm14_ok2', 'a', 'external_signal', 'queued', POST, 'external:s:m3', env(true, 'trigger_execution'), null);
    db.prepare('INSERT INTO mailbox_items VALUES (?,?,?,?,?,?,?,?)').run(
      'm14_hist', 'a', 'external_signal', 'queued', PRE, 'external:s:m4', env(false, 'action_required'), null);
    expect((db.prepare(gate14!.sql).get() as { c: number }).c).toBe(1);
    db.close();
  });

  it('判据 15 咬人：external_signal 行 ref 非构造器形状 = 违规；合形状 / 纪元前 = 沉默', () => {
    const db = fixtureDb();
    db.prepare('INSERT INTO mailbox_items VALUES (?,?,?,?,?,?,?,?)').run(
      'm15_bad', 'a', 'external_signal', 'queued', POST, 'hand-built-ref', null, null);
    const gate15 = makeIdentityGates({ epoch: EPOCH }).find(g => g.id === 15)!;
    expect(gate15).toBeDefined();
    expect((db.prepare(gate15!.sql).get() as { c: number }).c).toBe(1);
    db.prepare('INSERT INTO mailbox_items VALUES (?,?,?,?,?,?,?,?)').run(
      'm15_ok', 'a', 'external_signal', 'queued', POST, 'external:src_x:m-1', null, null);
    db.prepare('INSERT INTO mailbox_items VALUES (?,?,?,?,?,?,?,?)').run(
      'm15_hist', 'a', 'external_signal', 'queued', PRE, 'hand-built-old', null, null);
    // 非 external_signal 类型不受 15 管辖（判据 1/2 管所有类型的缺失/悬空）。
    db.prepare('INSERT INTO mailbox_items VALUES (?,?,?,?,?,?,?,?)').run(
      'm15_other', 'a', 'human_chat', 'queued', POST, 'session:cs_x:r1', null, null);
    expect((db.prepare(gate15!.sql).get() as { c: number }).c).toBe(1);
    db.close();
  });
});
