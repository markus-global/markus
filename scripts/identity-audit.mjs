#!/usr/bin/env node
/**
 * 身份不变量审计（C8 剩余四条 + C9 各刀新增判据；原判据 4 已删，理由见 GATES 内注释）。
 *
 * 两种模式：
 *   1) `--self-test`  —— CI 用。建一个临时库、**主动塞进每种违规**，断言每条判据都能抓到；
 *                        再修好它们，断言全部归零。这证明的是「判据本身有效」，
 *                        而不是「生产库很干净」——后者不属于 CI 的判断范围。
 *   2) 无参数          —— 运维用。对真实库（默认 ~/.markus/data.db，可用 MARKUS_AUDIT_DB 覆盖）
 *                        跑同样几条查询，任一条 >0 就以非零码退出。
 *
 * 设计口径（2026-11-14 真机教训）：
 *   - 判据 1/5/11 必须带时间下界：老库里有大量修复前的历史行，不带下界的门禁永远红，
 *     而「永远亮着又不可行动」的告警比没有更糟（会训练人忽略它）。
 *   - 判据 3 只看「租约**已过期**」：chat 回合本来就不走租约认领，把 NULL 算违规是假阳性。
 *
 * C9-A 口径（2026-11-15）：facts 的六条门禁（6–11）**故意不把 facts 的触发器与
 * 部分唯一索引建进自检夹具**。理由：那两道守卫会直接把违规样本拒之门外，于是
 * 「门禁能咬人」这件事就永远无法被证明（样本根本进不去）。夹具库是**判据的**
 * 测试面，真实 schema 是**不变量**的执行点，两者不能合成一个。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM_INTERNAL = [
  'heartbeat', 'system_event', 'session_reply',
  'memory_consolidation', 'callback_result', 'workflow_update',
].map(s => `'${s}'`).join(',');

/** since：只审「本次部署之后新增的事实」。默认 7 天，可用 MARKUS_AUDIT_SINCE 覆盖。 */
const SINCE = process.env.MARKUS_AUDIT_SINCE
  ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

/**
 * 谓词闭集的白名单 —— 从**代码**派生，不在这里再抄一份。
 *
 * 两份白名单 = 同一个事实两个写者：代码里新增谓词、这里忘了改，门禁就会把
 * 合法事实判成违规（误报），或者把新增谓词全都放过（漏报）。因此直接读
 * `packages/shared/src/facts/predicates.ts` 里的 `predicate: '…'` 字面量。
 * 读不到就**失败**：一个不知道自己该审什么的门禁必须响亮地报错，不能默认放行。
 */
function readPredicateWhitelist() {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(here, '..', 'packages', 'shared', 'src', 'facts', 'predicates.ts');
  if (!existsSync(file)) {
    console.error(`✗ 无法读取谓词闭集：${file} 不存在 —— 门禁不能默认放行。`);
    process.exit(1);
  }
  const names = [...readFileSync(file, 'utf-8').matchAll(/^\s*predicate:\s*'([^']+)'/gm)].map(m => m[1]);
  if (names.length === 0) {
    console.error('✗ 谓词闭集里解析出 0 个谓词 —— 解析规则可能已失效。');
    process.exit(1);
  }
  return names;
}

const PREDICATE_WHITELIST = readPredicateWhitelist();
const PREDICATE_SQL_LIST = PREDICATE_WHITELIST.map(p => `'${p}'`).join(',');

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
  // ── C9-A：facts 层六条（方案 §8.3）───────────────────────────────────────────
  {
    id: 6,
    name: '事实无来源身份（work_unit_ref 缺失/空串）',
    sql: `SELECT COUNT(*) AS c FROM facts
           WHERE work_unit_ref IS NULL OR TRIM(work_unit_ref) = ''`,
  },
  {
    id: 7,
    name: '事实不可追溯（source_refs_json 为空或不是非空数组）',
    sql: `SELECT COUNT(*) AS c FROM facts
           WHERE source_refs_json IS NULL
              OR json_valid(source_refs_json) = 0
              OR json_array_length(source_refs_json) = 0`,
  },
  {
    id: 8,
    name: '自证通过（verified_by 与 asserted_by 同一人）',
    sql: `SELECT COUNT(*) AS c FROM facts
           WHERE json_valid(verification_json)
             AND json_extract(verification_json, '$.result') = 'pass'
             AND json_extract(verification_json, '$.verified_by') = asserted_by`,
  },
  {
    id: 9,
    name: '同一 subject+predicate 多条 active（结论有两个当前值）',
    sql: `SELECT COUNT(*) AS c FROM (
            SELECT subject_kind, subject_id, predicate, COUNT(*) AS n
              FROM facts WHERE superseded_by IS NULL
             GROUP BY 1, 2, 3 HAVING n > 1)`,
  },
  {
    id: 10,
    name: '谓词不在闭集内（白名单从代码派生）',
    sql: `SELECT COUNT(*) AS c FROM facts
           WHERE predicate NOT IN (${PREDICATE_SQL_LIST})`,
  },
  {
    id: 11,
    name: '新纪元观测行无身份（agent_decisions 缺 work_unit_ref）',    sql: `SELECT COUNT(*) AS c FROM agent_decisions
           WHERE created_at >= '${SINCE}' AND work_unit_ref IS NULL`,
    // 依赖 C9-B 加的列：列未迁移时跳过（而不是永远红）。
    requiresColumn: { table: 'agent_decisions', column: 'work_unit_ref' },
  },
  // ── C9-E：验证事实的两条（验证也是一种事实，但它必须可核）────────────────────
  {
    id: 12,
    name: '验证结论无证据（pass/fail 都没有 evidence_refs）',
    sql: `SELECT COUNT(*) AS c FROM facts
           WHERE json_valid(verification_json)
             AND json_extract(verification_json, '$.result') IN ('pass','fail')
             AND (json_extract(verification_json, '$.evidence_refs') IS NULL
                  OR json_array_length(json_extract(verification_json, '$.evidence_refs')) = 0)`,
  },
  {
    id: 13,
    name: '验证结论无作者（verified_by 缺失/空串）',
    sql: `SELECT COUNT(*) AS c FROM facts
           WHERE json_valid(verification_json)
             AND (json_extract(verification_json, '$.verified_by') IS NULL
                  OR TRIM(json_extract(verification_json, '$.verified_by')) = '')`,
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

/** 每种违规各塞一条 —— 判据抓不到它们就是判据写错了。 */
const SEED_VIOLATIONS = `
INSERT INTO mailbox_items VALUES
  ('mbx_g1','a','human_chat','queued','${SINCE}',NULL,NULL,NULL),
  ('mbx_g2','a','a2a_message','queued','${SINCE}','session:dangling:r1',NULL,NULL),
  ('mbx_g5','a','task_status_update','completed','${SINCE}',NULL,'{"invalidatesPremise":true}','${SINCE}');
<<<<<<< HEAD
INSERT INTO work_units VALUES ('wu_g3','task_g3_r1','running','2000-01-01T00:00:00.000Z');
-- C9-A：六条 facts 门禁各一条违规样本（夹具无触发器/唯一索引，故能塞进去）。
INSERT INTO facts (id, subject_kind, subject_id, predicate, value_json, work_unit_ref, asserted_by, source_refs_json, verification_json, created_at) VALUES
  ('fact_g6','task','t1','task.completion_evidence','{}',NULL,'a1','["d1"]',NULL,'${SINCE}'),
  ('fact_g7','task','t1','work.defect_class','{}','task:t1:r1','a1','[]',NULL,'${SINCE}'),
  ('fact_g8','task','t2','task.completion_evidence','{}','task:t2:r1','a1','["d1"]','{"result":"pass","verified_by":"a1"}','${SINCE}'),
  ('fact_g9a','task','t3','task.completion_evidence','{}','task:t3:r1','a1','["d1"]',NULL,'${SINCE}'),
  ('fact_g9b','task','t3','task.completion_evidence','{}','task:t3:r2','a1','["d2"]',NULL,'${SINCE}'),  ('fact_g10','task','t4','custom.made_up','{}','task:t4:r1','a1','["d1"]',NULL,'${SINCE}'),
  -- C9-E：G12（无证据的验证）/ G13（无作者的验证）
  ('fact_g12','task','t5','task.completion_evidence','{}','task:t5:r1','a1','["d1"]','{"result":"pass","verified_by":"a2","evidence_refs":[]}','${SINCE}'),
  ('fact_g13','task','t6','task.completion_evidence','{}','task:t6:r1','a1','["d1"]','{"result":"pass","verified_by":"","evidence_refs":["c1"]}','${SINCE}');
INSERT INTO agent_decisions VALUES ('dec_g11','a1',NULL,'${SINCE}');`;

const FIX_VIOLATIONS = `
UPDATE mailbox_items SET work_unit_ref='session:ok:r1'
 WHERE id IN ('mbx_g1','mbx_g2','mbx_g5');
INSERT INTO work_units VALUES ('wu_ok','session:ok:r1','idle',NULL);
UPDATE work_units SET lease_until=NULL WHERE id='wu_g3';
<<<<<<< HEAD
-- C9-A：修好 facts 的六条违规 —— 每条只改它自己违规的那个字段。
UPDATE facts SET work_unit_ref='task:audit:r1' WHERE id='fact_g6';
UPDATE facts SET source_refs_json='["audit"]' WHERE id='fact_g7';
UPDATE facts SET verification_json=NULL WHERE id='fact_g8';
UPDATE facts SET superseded_by='fact_g9b', superseded_at='${SINCE}' WHERE id='fact_g9a';
UPDATE facts SET predicate='work.defect_class' WHERE id='fact_g10';
-- C9-E：修好验证两条 —— 只改它自己违规的那个子字段。
UPDATE facts SET verification_json='{"result":"pass","verified_by":"a2","evidence_refs":["c1"]}' WHERE id='fact_g12';
UPDATE facts SET verification_json='{"result":"pass","verified_by":"a2","evidence_refs":["c1"]}' WHERE id='fact_g13';
UPDATE agent_decisions SET work_unit_ref='task:audit:r1' WHERE id='dec_g11';
`;

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
  console.log(`\n身份不变量自检通过：${GATES.length} 条判据都能咬人、且修好后归零。`);
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
    console.log(`审计库：${path}\n时间下界（判据 1/5/11）：${SINCE}\n`);
    for (const g of GATES) {
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
    console.error(`\n${bad} 条身份不变量被违反。`);
    process.exit(1);
  }
  console.log(`\n${GATES.length} 条身份不变量全部为 0（已跳过未迁移的列）。`);
}

if (process.argv.includes('--self-test')) selfTest();
else auditRealDb();
