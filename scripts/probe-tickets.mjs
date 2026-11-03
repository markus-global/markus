#!/usr/bin/env node
/**
 * Ticket 真库探针 —— C1 的**可执行证据**（不是转述）。
 *
 * 做五件事，每一步都打印实际读回来的值：
 *   建库 → 建票（无任务）→ 建任务并挂票 → 删任务 → 查票
 * 末尾再跑 `PRAGMA foreign_key_check`。
 *
 * 为什么需要它：单元测试用的是测试夹具库，而 C1 要证明的是**真实打开路径**
 * （`openSqlite` → SCHEMA_SQL → FK 引擎）下「删任务不删票」。夹具会撒谎，
 * 这里用与生产完全相同的 `openSqlite` 建库，跑完即删。
 *
 * 用法：node scripts/probe-tickets.mjs      （需先 pnpm build:ts）
 * 退出码：0 = 全部符合预期；1 = 有判据不成立。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { openSqlite, closeSqlite, SqliteTicketRepo, SqliteTaskRepo, SqliteOrgRepo, SqliteAgentRepo } = await import(
  join(ROOT, 'packages/storage/dist/index.js')
);

const dir = mkdtempSync(join(tmpdir(), 'markus-probe-tickets-'));
const dbPath = join(dir, 'probe.db');
const out = [];
const fail = [];
const say = (s) => {
  out.push(s);
  console.log(s);
};
const check = (label, cond, detail) => {
  say(`  ${cond ? '🟩' : '🟥'} ${label}${detail ? `  → ${detail}` : ''}`);
  if (!cond) fail.push(label);
};

try {
  const db = openSqlite(dbPath);
  say(`① 建库：${dbPath}`);

  new SqliteOrgRepo(db).createOrg({ id: 'default', name: 'Default', ownerId: 'u1' });
  new SqliteAgentRepo(db).create({ id: 'agt_1', name: 'W', orgId: 'default', roleId: 'r1', roleName: 'Dev' });
  const taskRepo = new SqliteTaskRepo(db);
  const tickets = new SqliteTicketRepo(db);

  // ② 无任务的票（任何事件都能挂票）
  const noTask = tickets.create({ orgId: 'default', kind: 'message', sourceRef: 'msg_1', subject: '客户问发货时间' });
  say(`② 建票（无任务）：${noTask.id}  task_id=${noTask.taskId}  status=${noTask.status}`);
  check('票可以不带 task 存在', noTask.taskId === null);

  // ③ 建任务 → 挂票
  await taskRepo.create({ id: 'tsk_probe', orgId: 'default', title: '探针任务', assignedAgentId: 'agt_1', reviewerId: 'agt_2' });
  const linked = tickets.create({ orgId: 'default', kind: 'comment', sourceRef: 'cmt_1', subject: '验收意见', taskId: 'tsk_probe' });
  say(`③ 建任务 tsk_probe → 挂票 ${linked.id}  task_id=${linked.taskId}`);
  check('票可以挂 task', linked.taskId === 'tsk_probe');
  check('按任务列票查得到', tickets.listByTask('tsk_probe').length === 1);

  // ④ 删任务
  db.prepare('DELETE FROM tasks WHERE id = ?').run('tsk_probe');
  const taskGone = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE id = ?').get('tsk_probe');
  say(`④ 删任务：tasks 里剩 ${taskGone.n} 行`);

  // ⑤ 查票
  const after = tickets.getById(linked.id);
  say(`⑤ 查票：${after ? `${after.id}  task_id=${after.taskId}  status=${after.status}  subject=${after.subject}` : '（票没了！）'}`);
  check('删 task 后票仍在', after !== null);
  check('删 task 后 task_id 置空（ON DELETE SET NULL，不是级联删）', after?.taskId === null);
  check('票的状态不跟随 task', after?.status === 'open');

  const fkRows = db.prepare('PRAGMA foreign_key_check').all();
  say(`⑥ PRAGMA foreign_key_check → ${fkRows.length} 行违规`);
  check('外键检查无违规行', fkRows.length === 0);

  closeSqlite();
} catch (err) {
  say(`🟥 探针异常：${String(err?.stack ?? err)}`);
  fail.push('exception');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

say(fail.length === 0 ? '\n结论：全部达标。' : `\n结论：${fail.length} 条不达标 → ${fail.join(' / ')}`);
process.exit(fail.length === 0 ? 0 : 1);
