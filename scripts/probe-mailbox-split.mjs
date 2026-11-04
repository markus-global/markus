#!/usr/bin/env node
/**
 * C2 真库探针 —— 「mailbox 拆轴」的**可执行证据**（不是转述）。
 *
 * 用的是与生产完全相同的打开路径（`openSqlite` → SCHEMA_SQL → 迁移 → PRAGMA foreign_keys），
 * 不是测试夹具库：夹具会撒谎。
 *
 * 跑八步，每步都打印**实际读回来的值**：
 *   ① 建库
 *   ② 投递一条新事件 → mailbox 行 payload 里还有没有内容副本？正文在哪？
 *   ③ 读回（getHistory，走 hydrate）→ 正文是否完整
 *   ④ 历史行（拆轴之前的形态）→ 回落是否可读
 *   ⑤ 同一事件重复投递（带 extra.idempotencyKey）→ 正文是否只有一行
 *   ⑥ 执行态状态机（claim → completed）→ 是否不受影响
 *   ⑦ 保留策略：终态行 + 它的正文一起回收，外部事件的 trigger 不动
 *   ⑧ PRAGMA foreign_key_check
 *
 * 用法：node scripts/probe-mailbox-split.mjs      （需先 pnpm build:ts）
 * 退出码：0 = 全部符合预期；1 = 有判据不成立。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { openSqlite, closeSqlite, SqliteMailboxRepo, SqliteTriggerRepo } = await import(
  join(ROOT, 'packages/storage/dist/index.js')
);

const dir = mkdtempSync(join(tmpdir(), 'markus-probe-mailbox-split-'));
const dbPath = join(dir, 'probe.db');
const fail = [];
const say = (s) => console.log(s);
const check = (label, cond, detail) => {
  say(`  ${cond ? '🟩' : '🟥'} ${label}${detail ? `  → ${detail}` : ''}`);
  if (!cond) fail.push(label);
};

try {
  const db = openSqlite(dbPath);
  say(`① 建库：${dbPath}`);

  const triggers = new SqliteTriggerRepo(db);
  const mailbox = new SqliteMailboxRepo(db);

  // ② 投递一条新事件（参数与 cli 装配层一致）
  mailbox.save({
    id: 'mbx_probe_1',
    agentId: 'agt_probe',
    sourceType: 'human_chat',
    priority: 2,
    status: 'queued',
    payload: {
      summary: '客户问发货时间',
      content: '订单 #A17 什么时候发货？',
      extra: { sessionId: 'cs_probe' },
    },
    metadata: { senderId: 'u1', senderName: '老板' },
    queuedAt: '2026-11-03T08:00:00.000Z',
  });

  const raw = db.prepare("SELECT payload, trigger_id FROM mailbox_items WHERE id='mbx_probe_1'").get();
  const stored = JSON.parse(raw.payload);
  say(`② 投递一条新事件 → mailbox_items.payload = ${JSON.stringify(stored)}`);
  say(`   trigger_id = ${raw.trigger_id}`);
  check('mailbox 行不含 summary', !('summary' in stored));
  check('mailbox 行不含 content', !('content' in stored));
  check('执行态提示仍在 payload（extra）', 'extra' in stored, JSON.stringify(stored.extra));

  const trg = db.prepare('SELECT summary, body, kind FROM triggers WHERE id = ?').get(raw.trigger_id);
  say(`   triggers 行：kind=${trg.kind}  summary=${JSON.stringify(trg.summary)}  body=${JSON.stringify(trg.body)}`);
  check('正文只在 triggers', trg.body === '订单 #A17 什么时候发货？');

  // ③ 读回
  const back = mailbox.getHistory('agt_probe')[0];
  say(`③ 读回全文：${JSON.stringify(back.payload.content)}`);
  check('读路径把正文装回来了', back.payload.content === '订单 #A17 什么时候发货？');

  // ④ 历史行（拆轴之前写入的形态：正文在 payload，没有 trigger_id）
  db.prepare(
    `INSERT INTO mailbox_items (id, agent_id, source_type, priority, status, payload, metadata, queued_at)
     VALUES ('mbx_legacy','agt_probe','human_chat',2,'queued',?,'{}','2026-09-01T00:00:00.000Z')`
  ).run(JSON.stringify({ summary: '老摘要', content: '老正文（拆轴之前写入）' }));
  const legacy = mailbox.getById('mbx_legacy');
  say(`④ 历史行 trigger_id=${legacy.triggerId ?? null} 读回=${JSON.stringify(legacy.payload.content)}`);
  check('历史行回落自身列（不搬不回填）', legacy.payload.content === '老正文（拆轴之前写入）');
  check(
    '没有替历史行凭空建 trigger',
    db.prepare('SELECT COUNT(*) n FROM triggers').get().n === 1,
    `triggers 行数=${db.prepare('SELECT COUNT(*) n FROM triggers').get().n}`,
  );

  // ⑤ 同一个外部事件只留一行正文
  triggers.insertOrGet({
    kind: 'external', idempotencyKey: 'gh:delivery:42',
    summary: '新 issue', body: 'issue 正文', threadRefs: ['gh:o/r#1'],
  });
  const before = db.prepare('SELECT COUNT(*) n FROM triggers').get().n;
  mailbox.save({
    id: 'mbx_probe_evt', agentId: 'agt_probe', sourceType: 'system_event', priority: 2, status: 'queued',
    payload: { summary: '新 issue', content: 'issue 正文', extra: { idempotencyKey: 'gh:delivery:42' } },
    queuedAt: '2026-11-03T08:05:00.000Z',
  });
  const after = db.prepare('SELECT COUNT(*) n FROM triggers').get().n;
  say(`⑤ 事件投递前 triggers=${before} → 投递后=${after}（复用事件自身的行，不再复制正文）`);
  check('同一事件只一行正文', after === before);

  // ⑥ 执行态状态机
  const claimed = mailbox.claimItem('mbx_probe_1', 'workerA', '2026-11-03T09:00:00.000Z', '2026-11-03T08:00:01.000Z');
  mailbox.updateStatus('mbx_probe_1', 'completed', { completedAt: '2026-11-03T08:10:00.000Z' });
  const done = mailbox.getById('mbx_probe_1');
  say(`⑥ 执行态：claim=${claimed}  status=${done.status}  正文=${JSON.stringify(done.payload.content)}`);
  check('queued→processing 认领成功', claimed === true);
  check('queued→processing→completed 收口', done.status === 'completed');
  check('收口后正文仍可读', done.payload.content === '订单 #A17 什么时候发货？');

  // ⑦ 保留策略：终态行 + 它的 mbx:* 正文一起回收，外部事件不动
  db.prepare("UPDATE mailbox_items SET queued_at='2020-01-01T00:00:00.000Z' WHERE id='mbx_probe_1'").run();
  const { pruneTerminalMailboxItems } = await import(join(ROOT, 'packages/storage/dist/index.js'));
  const pruned = pruneTerminalMailboxItems(db, { dryRun: false, olderThanDays: 30, vacuum: false });
  const left = db.prepare("SELECT idempotency_key FROM triggers ORDER BY idempotency_key").all().map((r) => r.idempotency_key);
  say(`⑦ 保留策略：删行=${pruned.deleted} 回收正文=${pruned.triggersDeleted} 剩余 triggers=${JSON.stringify(left)}`);
  check('终态行被清理', pruned.deleted === 1);
  check('它的正文被一起回收（否则保留策略空转）', pruned.triggersDeleted === 1);
  check('外部事件的 trigger 不动', left.includes('gh:delivery:42'));

  // ⑧ 外键完整性
  const fk = db.prepare('PRAGMA foreign_key_check').all();
  say(`⑧ PRAGMA foreign_key_check → ${fk.length} 行违规`);
  check('外键检查无违规', fk.length === 0);

  say('');
  if (fail.length) {
    say(`🟥 有 ${fail.length} 条判据不成立：${fail.join(' / ')}`);
    closeSqlite();
    process.exitCode = 1;
  } else {
    say('结论：全部达标。');
    closeSqlite();
  }
} catch (err) {
  console.error('探针异常：', err);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
