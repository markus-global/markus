#!/usr/bin/env node
/**
 * 身份不变量审计（C8 四条判据；C9-B 删掉了原判据 4，理由见 GATES 里的注释）。
 *
 * 两种模式：
 *   1) `--self-test`  —— CI 用。建一个临时库、**主动塞进每种违规**，断言每条判据都能抓到；
 *                        再修好它们，断言全部归零。这证明的是「判据本身有效」，
 *                        而不是「生产库很干净」——后者不属于 CI 的判断范围。
 *   2) 无参数          —— 运维用。对真实库（默认 ~/.markus/data.db，可用 MARKUS_AUDIT_DB 覆盖）
 *                        跑同样几条查询，任一条 >0 就以非零码退出。
 *
 * 设计口径（2026-11-14 真机教训）：
 *   - 判据 1/5 必须带时间下界：老库里有大量修复前的历史行，不带下界的门禁永远红，
 *     而「永远亮着又不可行动」的告警比没有更糟（会训练人忽略它）。
 *   - 判据 3 只看「租约**已过期**」：chat 回合本来就不走租约认领，把 NULL 算违规是假阳性。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const PLATFORM_INTERNAL = [
  'heartbeat', 'system_event', 'session_reply',
  'memory_consolidation', 'callback_result', 'workflow_update',
].map(s => `'${s}'`).join(',');

/** since：只审「本次部署之后新增的事实」。默认 7 天，可用 MARKUS_AUDIT_SINCE 覆盖。 */
const SINCE = process.env.MARKUS_AUDIT_SINCE
  ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

const GATES = [
  {
    id: 1,
    name: '身份缺失（非平台内部事实没有 work_unit_ref）',
    sql: `SELECT COUNT(*) AS c FROM mailbox_items
           WHERE work_unit_ref IS NULL AND queued_at >= '${SINCE}'
             AND source_type NOT IN (${PLATFORM_INTERNAL})`,
  },
  {
    id: 2,
    name: '悬空引用（ref 指向不存在的 work_unit）',
    sql: `SELECT COUNT(*) AS c FROM mailbox_items m
            LEFT JOIN work_units w ON w.ref = m.work_unit_ref
           WHERE m.work_unit_ref IS NOT NULL AND w.id IS NULL`,
  },
  {
    id: 3,
    name: '租约已过期的 running（僵尸在跑）',
    sql: `SELECT COUNT(*) AS c FROM work_units
           WHERE status = 'running' AND lease_until IS NOT NULL
             AND lease_until <= strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  },
  // ── 原判据 4（「触发行已终态但 ended_at 仍为空」）在 C9-B 删除 ──────────────
  // 它测的是一条**由扫库机制维持**的不变量：`agent_activities.ended_at` 必须补齐。
  // C9-B 删掉了那个机制（`closeOrphansAgainstTerminalMailbox`）：「在跑」只认
  // `work_units`，一行 activity 没有结束时间就是「没记到结束」，不是状态、也不是违规。
  // 留着这条判据有两个后果，都不可接受：
  //   1. 真机上有 3269 行历史僵尸行、且没有时间下界 → 门禁**永远红**（本文件自己的
  //      口径：「永远亮着又不可行动的告警比没有更糟」）；
  //   2. 要让它变绿，只能重新引入「替事件编造结束时间」的写者 —— 正是本轮删掉的东西。
  // 同一个事实（「回合已收口，却留下悬挂的工作单元」）在**权威对象**上已有判据 3
  // （租约过期的 running），所以这里不需要第二个度量。
  {
    id: 5,
    name: '撤销型事实无身份（无法反查「谁撤销了哪一轮」）',
    sql: `SELECT COUNT(*) AS c FROM mailbox_items
           WHERE envelope LIKE '%"invalidatesPremise":true%'
             AND work_unit_ref IS NULL AND queued_at >= '${SINCE}'`,
  },
];

const DDL = `
CREATE TABLE mailbox_items (
  id TEXT PRIMARY KEY, agent_id TEXT, source_type TEXT, status TEXT,
  queued_at TEXT, work_unit_ref TEXT, envelope TEXT, completed_at TEXT
);
CREATE TABLE work_units (
  id TEXT PRIMARY KEY, ref TEXT UNIQUE, status TEXT, lease_until TEXT
);
`;

/** 每种违规各塞一条 —— 判据抓不到它们就是判据写错了。 */
const SEED_VIOLATIONS = `
INSERT INTO mailbox_items VALUES
  ('mbx_g1','a','human_chat','queued','${SINCE}',NULL,NULL,NULL),
  ('mbx_g2','a','a2a_message','queued','${SINCE}','session:dangling:r1',NULL,NULL),
  ('mbx_g5','a','task_status_update','completed','${SINCE}',NULL,'{"invalidatesPremise":true}','${SINCE}');
INSERT INTO work_units VALUES ('wu_g3','task_g3_r1','running','2000-01-01T00:00:00.000Z');`;

const FIX_VIOLATIONS = `
UPDATE mailbox_items SET work_unit_ref='session:ok:r1'
 WHERE id IN ('mbx_g1','mbx_g2','mbx_g5');
INSERT INTO work_units VALUES ('wu_ok','session:ok:r1','idle',NULL);
UPDATE work_units SET lease_until=NULL WHERE id='wu_g3';
`;

function runGates(db) {
  return GATES.map(g => ({ ...g, count: db.prepare(g.sql).get().c }));
}

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'markus-identity-audit-'));
  const db = new DatabaseSync(join(dir, 'audit.db'));
  let failed = 0;
  try {
    db.exec(DDL);
    db.exec(SEED_VIOLATIONS);

    const dirty = runGates(db);
    for (const g of dirty) {
      const ok = g.count > 0;
      if (!ok) failed += 1;
      console.log(`${ok ? '✓' : '✗'} 判据 ${g.id} 能抓到违规样本  ${g.name}  [count=${g.count}]`);
    }

    // 修好违规 → 每条必须归零（否则判据会误报，误报等于没有）
    db.exec(FIX_VIOLATIONS);

    const clean = runGates(db);
    for (const g of clean) {
      const ok = g.count === 0;
      if (!ok) failed += 1;
      console.log(`${ok ? '✓' : '✗'} 判据 ${g.id} 修好后归零          ${g.name}  [count=${g.count}]`);
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
  if (failed > 0) {
    console.error(`\n身份不变量自检失败：${failed} 条判据没有按预期咬人。`);
    process.exit(1);
  }
  console.log('\n身份不变量自检通过：每条判据都能咬人、且修好后归零。');
}

function openReadOnly(path) {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    // 旧 node 不支持 readOnly 选项时退化：审计只跑 SELECT，不写
    return new DatabaseSync(path);
  }
}

function auditRealDb() {
  const path = process.env.MARKUS_AUDIT_DB ?? join(homedir(), '.markus', 'data.db');
  if (!existsSync(path)) {
    console.log(`未找到库 ${path} —— 跳过（这不是失败：CI 环境本来就没有生产库）。`);
    return;
  }
  const db = openReadOnly(path);
  let bad = 0;
  try {
    console.log(`审计库：${path}\n时间下界（判据 1/5）：${SINCE}\n`);
    for (const g of runGates(db)) {
      const ok = g.count === 0;
      if (!ok) bad += 1;
      console.log(`${ok ? '✓' : '✗'} 判据 ${g.id} [count=${g.count}]  ${g.name}`);
    }
  } finally {
    db.close();
  }
  if (bad > 0) {
    console.error(`\n${bad} 条身份不变量被违反。`);
    process.exit(1);
  }
  console.log('\n身份不变量全部为 0。');
}

if (process.argv.includes('--self-test')) selfTest();
else auditRealDb();
