/**
 * `mailbox_items` 入队 INSERT —— **列/占位符/实参三方对齐**的真实 SQLite 行为测试。
 *
 * 为什么需要它（C7-A 复核提出）：
 *   enqueue 的 INSERT 曾经是 16 列 / 16 占位符 / **15 实参**，而 `node:sqlite` 在实参少于
 *   占位符时**不抛错、静默绑 NULL**。也就是说「`work_unit_ref` 只有一个写者」这件事，
 *   一直靠一个静默失败在维持 —— 没人看得见。
 *   删掉多余列名后形状变成 15/15/15，但**隐式对齐**仍然脆弱：明天有人往中间插一列、
 *   少传一个实参，同一个 bug 会换个记号再犯一次，而所有测试依然绿。
 *
 * 所以这里锁的不是「这次没漏」，而是「**错位会被看见**」：
 *   ① 15 个互不相同的哨兵值写入 → 逐列读回，断言各归其位；
 *   ② 反向对照：用同一条语句、把两个实参**故意交换**再写一行 → 断言读回时确实错位。
 *      ② 存在的意义是证明 ① 的断言对错位敏感；没有 ②，① 只是「这次刚好对」。
 *
 * 不用 `readFileSync + toContain` 那种文本栅栏 —— 那种断言不会因为错位而变红。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqlite, closeSqlite, SqliteMailboxRepo } from '../src/sqlite-storage.js';

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-mbx-align-'));
  dbPath = join(tempDir, 'data.db');
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * 15 个哨兵值：每一个都能唯一反查到自己应该落在哪一列。
 * 只要任意两列被交换 / 平移，断言就会指向具体列名而失败。
 */
const S = {
  id: 'mbx_align_sentinel_id',
  agentId: 'agt_align_sentinel_agent',
  sourceType: 'src_align_sentinel',
  priority: 7,
  status: 'paused',
  payload: { summary: 'sum_sentinel', content: 'content_sentinel' },
  metadata: { mk: 'meta_sentinel' },
  queuedAt: '2026-11-14T00:00:07.000Z',
  dedupKey: 'dedup_sentinel',
  envelope: '{"envelope_sentinel":true}',
  messageId: 'msg_sentinel',
  signalClass: 'signal_sentinel',
  intent: 'action_required',
  dropReason: 'drop_sentinel',
  bounceTarget: 'bounce_sentinel',
} as const;

type Row = Record<string, unknown>;

function readRow(id: string): Row | undefined {
  const db = openSqlite(dbPath);
  return db
    .prepare(
      `SELECT id, agent_id, source_type, priority, status, payload, metadata, queued_at,
              dedup_key, envelope, message_id, signal_class, intent, drop_reason, bounce_target
         FROM mailbox_items WHERE id = ?`,
    )
    .get(id) as Row | undefined;
}

describe('mailbox_items 入队 INSERT — 列 / 占位符 / 实参对齐', () => {
  it('15 个互不相同的哨兵值写入后逐列读回，各归其位', () => {
    const repo = new SqliteMailboxRepo(openSqlite(dbPath));
    expect(repo.save({ ...S })).toBe(true);

    const row = readRow(S.id);
    expect(row, 'row must exist').toBeTruthy();

    // 逐列断言：任何一列被错位，这里就会指名道姓地失败。
    expect(row!['id']).toBe(S.id);
    expect(row!['agent_id']).toBe(S.agentId);
    expect(row!['source_type']).toBe(S.sourceType);
    expect(row!['priority']).toBe(S.priority);
    expect(row!['status']).toBe(S.status);
    expect(JSON.parse(String(row!['payload']))).toEqual(S.payload);
    expect(JSON.parse(String(row!['metadata']))).toEqual(S.metadata);
    expect(row!['queued_at']).toBe(S.queuedAt);
    expect(row!['dedup_key']).toBe(S.dedupKey);
    expect(row!['envelope']).toBe(S.envelope);
    expect(row!['message_id']).toBe(S.messageId);
    expect(row!['signal_class']).toBe(S.signalClass);
    expect(row!['intent']).toBe(S.intent);
    expect(row!['drop_reason']).toBe(S.dropReason);
    expect(row!['bounce_target']).toBe(S.bounceTarget);
  });

  it('反向对照：故意交换两个实参 ⇒ 读回时确实错位（证明上面的断言对错位敏感）', () => {
    const db = openSqlite(dbPath);
    const repo = new SqliteMailboxRepo(db);
    // 先建库（save 会跑 SCHEMA_SQL 的初始化路径）。
    expect(repo.save({ ...S, id: 'mbx_align_warmup' })).toBe(true);

    // 与生产代码**同一条**语句；唯一区别是 message_id 与 signal_class 两个实参被交换。
    // 这不是在测生产代码，而是在测「错位能否被看见」——若这里也读不出错位，
    // 上面那条测试就是假绿。
    const swappedId = 'mbx_align_swapped';
    db.prepare(
      `INSERT INTO mailbox_items (id, agent_id, source_type, priority, status, payload, metadata, queued_at, dedup_key,
                                  envelope, message_id, signal_class, intent, drop_reason, bounce_target)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).run(
      swappedId, S.agentId, S.sourceType, S.priority,
      S.status, JSON.stringify(S.payload), JSON.stringify(S.metadata),
      // dedup_key 必须与热身行不同：`uq_mailbox_dedup` 会让重复键命中
      // `ON CONFLICT DO NOTHING`，整行被静默吞掉 —— 这一行要真的存在才谈得上「看错位」。
      S.queuedAt, 'dedup_sentinel_swapped',
      S.envelope,
      S.signalClass, // ← 故意：本该是 message_id
      S.messageId,   // ← 故意：本该是 signal_class
      S.intent, S.dropReason, S.bounceTarget,
    );

    const row = readRow(swappedId);
    expect(row, 'swapped row must exist').toBeTruthy();
    // 错位必须**可见**：交换后 message_id 拿到 signal 哨兵、signal_class 拿到 message 哨兵。
    expect(row!['message_id']).toBe(S.signalClass);
    expect(row!['signal_class']).toBe(S.messageId);
    // 未参与交换的列不受影响 —— 说明错位是局部的、可定位的，不是整行崩坏。
    expect(row!['intent']).toBe(S.intent);
    expect(row!['drop_reason']).toBe(S.dropReason);
    expect(row!['bounce_target']).toBe(S.bounceTarget);
  });
});
