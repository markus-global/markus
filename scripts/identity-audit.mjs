#!/usr/bin/env node
/**
 * 身份不变量审计（C8 剩余四条 + C9 / C10-0B 各刀新增判据；原判据 4 已删，理由见门禁定义处）。
 *
 * 两种模式：
 *   1) `--self-test`  —— CI 用。建一个临时库、**主动塞进每种违规**，断言每条判据都能抓到；
 *                        再塞进**纪元前**的同形违规，断言计数一条都不变（历史是档案，不是
 *                        违规）；最后修好，断言全部归零。
 *   2) `--epoch <ts> [--db <path>]` —— Owner 本地实例的定时任务用（C10-0G）。
 *                        对真实库（--db > MARKUS_AUDIT_DB > ~/.markus/data.db）跑同样几条查询，
 *                        任一条 >0 就以非零码退出。纪元是部署参数，必须显式传入；
 *                        缺纪元 = exit 2（epoch-unset，绝不静默绿）。
 *                        退出码：0=pass，1=fail/error，2=epoch-unset。
 *
 * ── 判据从哪来（C10-0B §3.4）────────────────────────────────────────────────
 * 判据**不在本文件定义**：`@markus/shared` 的 `identity-audit` 模块是唯一写者
 * （`makeIdentityGates`），CI 自检与本脚本 import 同一份。
 * 本文件只保留「怎么执行」：临时库自检 / 真库只读跑。
 *
 * ⚠️ **构建前置条件**：判据来自 `packages/shared/dist`，所以本脚本必须先
 * `pnpm --filter @markus/shared build`（CI 在 self-test 步骤前跑 `tsc -b`）。
 * 读不到 dist 就**失败退出**——一个不知道自己该审什么的门禁必须响亮报错，不能默认放行。
 *
 * ── 时间下界（C10-0B 删滚动窗口；C10-0G 纪元本地化）──────────────────────────────────────────
 * 只有一个下界：`--epoch` 显式传入的纪元。旧实现的滚动窗口
 * `MARKUS_AUDIT_SINCE = now - 7d` 已删除——两个下界就是同一件事的两个度量。
 * 产品纪元常量也已删除（C10-0G）：纪元的正确值属于部署现场（Owner 本地
 * 实例的修复构建进程启动时刻，见 docs/records/identity-backlog-disposition-2026-11-22.md
 * 的 dated 更正注），不随产品发货，也不从任何常量读取。
 *
 * C9-A 口径（2026-11-15）：facts 的六条门禁（6–11）**故意不把 facts 的触发器与
 * 部分唯一索引建进自检夹具**。理由：那两道守卫会直接把违规样本拒之门外，于是
 * 「门禁能咬人」这件事就永远无法被证明（样本根本进不去）。夹具库是**判据的**
 * 测试面，真实 schema 是**不变量**的执行点，两者不能合成一个。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED_DIST_ENTRY = join(HERE, '..', 'packages', 'shared', 'dist', 'identity-audit.js');

let makeIdentityGates;
try {
  ({ makeIdentityGates } = await import(SHARED_DIST_ENTRY));
} catch (err) {
  console.error(
    `✗ 无法从 shared dist 读取门禁定义：${SHARED_DIST_ENTRY}\n` +
    '  先跑 `pnpm --filter @markus/shared build`（CI 在 self-test 前跑 `tsc -b`）。\n' +
    `  原因：${String(err)}`,
  );
  process.exit(1);
}

/**
 * 自检夹具的纪元（**显式注入**）：自检证明的是「判据逻辑有效」，
 * 与真库纪元（部署参数，--epoch）无关 —— CI 没有真库也必须能跑自检。
 */
const FIXTURE_EPOCH = '2026-11-15T00:00:00.000Z';
const GATES = makeIdentityGates({ epoch: FIXTURE_EPOCH });

/**
 * 自检夹具的两个时间点（相对夹具纪元，**不跟墙钟走**）。
 *
 * 双向咬人：纪元**后**的违规必须咬住，纪元**前**的违规必须闭嘴。
 * 写死成「纪元 ±1h」而不是「今天 ±N 天」：这条自检要在任何一天跑出同一个答案。
 */
const POST_EPOCH = new Date(Date.parse(FIXTURE_EPOCH) + 3600_000).toISOString();
const PRE_EPOCH = new Date(Date.parse(FIXTURE_EPOCH) - 3600_000).toISOString();

const DDL = `
CREATE TABLE mailbox_items (
  id TEXT PRIMARY KEY, agent_id TEXT, source_type TEXT, status TEXT,
  queued_at TEXT, work_unit_ref TEXT, envelope TEXT, completed_at TEXT
);
CREATE TABLE work_units (
  id TEXT PRIMARY KEY, ref TEXT UNIQUE, status TEXT, lease_until TEXT
);
-- C9-A：facts 的夹具表。**故意不建触发器与 ux_facts_active** —— 它们会直接把
-- 违规样本拒之门外，于是「门禁能咬人」永远无法被证明（见文件头 C9-A 口径）。
CREATE TABLE facts (
  id TEXT PRIMARY KEY, subject_kind TEXT, subject_id TEXT, predicate TEXT,
  value_json TEXT, work_unit_ref TEXT, asserted_by TEXT, source_refs_json TEXT,
  verification_json TEXT, confidence REAL DEFAULT 1.0, created_at TEXT,
  superseded_by TEXT, superseded_at TEXT
);
-- C9-A：G11 的夹具表（带 work_unit_ref，因为门禁要求它）。
CREATE TABLE agent_decisions (
  id TEXT PRIMARY KEY, agent_id TEXT, work_unit_ref TEXT, created_at TEXT
);`;

/** 每种违规各塞一条（**纪元之后**）—— 判据抓不到它们就是判据写错了。 */
const SEED_VIOLATIONS = `
INSERT INTO mailbox_items VALUES
  ('mbx_g1','a','human_chat','queued','${POST_EPOCH}',NULL,NULL,NULL),
  ('mbx_g2','a','a2a_message','queued','${POST_EPOCH}','session:dangling:r1',NULL,NULL),
  ('mbx_g5','a','task_status_update','completed','${POST_EPOCH}',NULL,'{"invalidatesPremise":true}','${POST_EPOCH}');
INSERT INTO work_units VALUES ('wu_g3','task_g3_r1','running','2000-01-01T00:00:00.000Z');
-- C9-A：六条 facts 门禁各一条违规样本（夹具无触发器/唯一索引，故能塞进去）。
INSERT INTO facts (id, subject_kind, subject_id, predicate, value_json, work_unit_ref, asserted_by, source_refs_json, verification_json, created_at) VALUES
  ('fact_g6','task','t1','task.completion_evidence','{}',NULL,'a1','["d1"]',NULL,'${POST_EPOCH}'),
  ('fact_g7','task','t1','work.defect_class','{}','task:t1:r1','a1','[]',NULL,'${POST_EPOCH}'),
  ('fact_g8','task','t2','task.completion_evidence','{}','task:t2:r1','a1','["d1"]','{"result":"pass","verified_by":"a1"}','${POST_EPOCH}'),
  ('fact_g9a','task','t3','task.completion_evidence','{}','task:t3:r1','a1','["d1"]',NULL,'${POST_EPOCH}'),
  ('fact_g9b','task','t3','task.completion_evidence','{}','task:t3:r2','a1','["d2"]',NULL,'${POST_EPOCH}'),  ('fact_g10','task','t4','custom.made_up','{}','task:t4:r1','a1','["d1"]',NULL,'${POST_EPOCH}'),
  -- C9-E：G12（无证据的验证）/ G13（无作者的验证）
  ('fact_g12','task','t5','task.completion_evidence','{}','task:t5:r1','a1','["d1"]','{"result":"pass","verified_by":"a2","evidence_refs":[]}','${POST_EPOCH}'),
  ('fact_g13','task','t6','task.completion_evidence','{}','task:t6:r1','a1','["d1"]','{"result":"pass","verified_by":"","evidence_refs":["c1"]}','${POST_EPOCH}');
INSERT INTO agent_decisions VALUES ('dec_g11','a1',NULL,'${POST_EPOCH}');
-- C10-B：G14（未验证外部带权威 intent）/ G15（external_signal ref 非构造器形状）各一条。
-- mbx_g14 的 ref 合形状（G15 不咬）、envelope 违规（G14 咬）；mbx_g15 反之。
INSERT INTO mailbox_items VALUES
  ('mbx_g14','a','external_signal','queued','${POST_EPOCH}','external:src_x:m14','{"from":{"kind":"external","address":"x@y.z"},"fromVerified":false,"intent":"trigger_execution"}',NULL),
  ('mbx_g15','a','external_signal','queued','${POST_EPOCH}','hand-built-ref',NULL,NULL);`;

/**
 * 纪元**前**的同形违规：它们必须**不被计数**。
 *
 * 历史行是档案，不是违规。判据若没有纪元下界，这本台账就永远红着 ——
 * 而「永远亮着又不可行动」的告警比没有更糟。
 */
const SEED_HISTORY = `
INSERT INTO mailbox_items VALUES
  ('mbx_hist_1','a','human_chat','completed','${PRE_EPOCH}',NULL,NULL,NULL),
  ('mbx_hist_2','a','a2a_message','completed','${PRE_EPOCH}','session:gone:r1',NULL,NULL),
  ('mbx_hist_5','a','task_status_update','completed','${PRE_EPOCH}',NULL,'{"invalidatesPremise":true}','${PRE_EPOCH}');
INSERT INTO agent_decisions VALUES ('dec_hist_11','a1',NULL,'${PRE_EPOCH}');
-- C10-B：纪元前的同形违规（G14/G15 必须沉默）。
INSERT INTO mailbox_items VALUES
  ('mbx_hist_14','a','external_signal','completed','${PRE_EPOCH}','external:src_x:h14','{"from":{"kind":"external","address":"x@y.z"},"fromVerified":false,"intent":"action_required"}',NULL),
  ('mbx_hist_15','a','external_signal','completed','${PRE_EPOCH}','hand-built-old',NULL,NULL);`;

const FIX_VIOLATIONS = `
UPDATE mailbox_items SET work_unit_ref='session:ok:r1'
 WHERE id IN ('mbx_g1','mbx_g2','mbx_g5');
INSERT INTO work_units VALUES ('wu_ok','session:ok:r1','idle',NULL);
UPDATE work_units SET lease_until=NULL WHERE id='wu_g3';
-- C9-A：修好 facts 的六条违规 —— 每条只改它自己违规的那个字段。
UPDATE facts SET work_unit_ref='task:audit:r1' WHERE id='fact_g6';
UPDATE facts SET source_refs_json='["audit"]' WHERE id='fact_g7';
UPDATE facts SET verification_json=NULL WHERE id='fact_g8';
UPDATE facts SET superseded_by='fact_g9b', superseded_at='${POST_EPOCH}' WHERE id='fact_g9a';
UPDATE facts SET predicate='work.defect_class' WHERE id='fact_g10';
-- C9-E：修好验证两条 —— 只改它自己违规的那个子字段。
UPDATE facts SET verification_json='{"result":"pass","verified_by":"a2","evidence_refs":["c1"]}' WHERE id='fact_g12';
UPDATE facts SET verification_json='{"result":"pass","verified_by":"a2","evidence_refs":["c1"]}' WHERE id='fact_g13';
UPDATE agent_decisions SET work_unit_ref='task:audit:r1' WHERE id='dec_g11';
-- C10-B：修好 G14/G15 —— 每条只改它自己违规的那个字段；并补 external ref 的实体（G2 悬空）。
UPDATE mailbox_items SET envelope='{"from":{"kind":"external","address":"x@y.z"},"fromVerified":false,"intent":"deliver"}' WHERE id='mbx_g14';
UPDATE mailbox_items SET work_unit_ref='external:src_x:m15' WHERE id='mbx_g15';
INSERT INTO work_units VALUES ('wu_g14','external:src_x:m14','idle',NULL),('wu_g15','external:src_x:m15','idle',NULL);`;

function runGates(db) {
  return GATES.map(g => ({ ...g, count: db.prepare(g.sql).get().c }));
}

/** 该库是否已经具备某列（C9-B 的列晚到，门禁要能“跳过”而不是“永远红”）。 */
function hasColumn(db, table, column) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return cols.some(c => c.name === column);
  } catch {
    return false;
  }
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

    // ── 双向咬人：纪元**前**的同形违规不得改变任何计数 ──────────────────────
    // 只验「能咬人」的门禁有两种失效方式：①永远红（历史行也算违规）②只咬旧账。
    // 这一轮把「纪元前的违规样本」塞进去，计数必须与刚才**逐条相等**。
    db.exec(SEED_HISTORY);
    const withHistory = runGates(db);
    for (const g of withHistory) {
      const before = dirty.find(d => d.id === g.id)?.count;
      const ok = g.count === before;
      if (!ok) failed += 1;
      console.log(`${ok ? '✓' : '✗'} 判据 ${g.id} 对纪元前历史沉默    ${g.name}  [count=${g.count}, 期望=${before}]`);
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
    console.error(`\n身份不变量自检失败：${failed} 条断言没有按预期咬人。`);
    process.exit(1);
  }
  console.log(
    `\n身份不变量自检通过：${GATES.length} 条判据都能咬人、对纪元前历史沉默、且修好后归零。`,
  );
}

function openReadOnly(path) {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    // 旧 node 不支持 readOnly 选项时退化：审计只跑 SELECT，不写
    return new DatabaseSync(path);
  }
}

/** CLI 旗标值（--epoch <ts> / --db <path>）：缺则返回 undefined。 */
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function auditRealDb() {
  // 纪元本地化（C10-0G）：纪元是部署参数，必须显式传入；缺 = 独立状态，绝不静默绿。
  // 退出码三态：0=pass，1=fail/error，2=epoch-unset（未显式传入）。
  const epoch = argValue('--epoch');
  if (epoch === undefined || epoch.trim() === '') {
    console.error(
      'state: epoch-unset\n' +
      '纪元未显式传入：真库审计需要 --epoch <ts>（部署参数，C10-0G 本地化）。\n' +
      'Owner 本地实例的本机线记录在 docs/records/identity-backlog-disposition-2026-11-22.md 的 dated 更正注。\n' +
      '这不是「通过」——没有下界，审计无法区分历史与活漏。',
    );
    process.exit(2);
  }
  const path = argValue('--db') ?? process.env.MARKUS_AUDIT_DB ?? join(homedir(), '.markus', 'data.db');
  if (!existsSync(path)) {
    console.log(`未找到库 ${path} —— 跳过（这不是失败：CI 环境本来就没有生产库）。`);
    return;
  }
  // ── C10-0G：缺纪元的 epoch-unset 检查在函数开头（部署参数，绝不静默绿） ──────────────
  let gates;
  try {
    gates = makeIdentityGates({ epoch });
  } catch (err) {
    console.error(`state: error\n无法建门禁：${String(err)}`);
    process.exit(1);
  }
  const db = openReadOnly(path);
  let bad = 0;
  try {
    console.log(`审计库：${path}\n纪元下界（判据 1/2/5/11）：${epoch}\n`);
    for (const g of gates) {
      if (g.requiresColumn && !hasColumn(db, g.requiresColumn.table, g.requiresColumn.column)) {
        console.log(`– 判据 ${g.id} 跳过（${g.requiresColumn.table}.${g.requiresColumn.column} 尚未迁移）  ${g.name}`);
        continue;
      }
      const count = db.prepare(g.sql).get().c;
      const ok = count === 0;
      if (!ok) bad += 1;
      console.log(`${ok ? '✓' : '✗'} 判据 ${g.id} [count=${count}]  ${g.name}`);
    }
  } finally {
    db.close();
  }
  if (bad > 0) {
    console.error(`\nstate: fail\n${bad} 条身份不变量被违反。`);
    process.exit(1);
  }
  console.log(`\nstate: pass\n${gates.length} 条身份不变量全部为 0（已跳过未迁移的列）。`);
}

if (process.argv.includes('--self-test')) selfTest();
else auditRealDb();
