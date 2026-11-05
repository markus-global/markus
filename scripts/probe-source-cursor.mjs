#!/usr/bin/env node
/**
 * B2 真库探针 —— 「Source 位点 + 准入」的**可执行证据**（不是转述）。
 *
 * 用与生产完全相同的打开路径（`openSqlite` → SCHEMA_SQL → 迁移 → PRAGMA foreign_keys），
 * 不是测试夹具库：夹具会撒谎。
 *
 * 七步，每步打印**实际读回来的值**：
 *   ① 建库 + 登记来源（带 policy.selfActorIds）
 *   ② 第一批两个事件 → 提交位点 p2，triggers = 2
 *   ③ 第二批一个事件 → 从 p2 继续，提交 p3，triggers = 3（只增不重）
 *   ④ 机器人自己发的消息 → filtered=self，triggers 仍 = 3，位点照常前进到 p4
 *   ⑤ 消费失败（签名错）→ not-committed，位点**一动不动**（仍 p4）
 *   ⑥ 直接查库：event_sources.cursor / last_polled_at、triggers 行数与幂等键
 *   ⑦ PRAGMA foreign_key_check
 *
 * 用法：node scripts/probe-source-cursor.mjs   （需先构建 ts：pnpm --filter @markus/core exec tsc -b）
 * 退出码：0 = 全部符合预期；1 = 有判据不成立。
 */
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const storage = await import(join(ROOT, 'packages/storage/dist/index.js'));
const core = await import(join(ROOT, 'packages/core/dist/index.js'));

const dir = mkdtempSync(join(tmpdir(), 'markus-probe-source-cursor-'));
const dbPath = join(dir, 'probe.db');
const SECRET = 'probe-secret';
const fail = [];
const say = s => console.log(s);
const check = (label, cond, detail) => {
  say(`  ${cond ? '🟩' : '🟥'} ${label}${detail !== undefined ? `  → ${detail}` : ''}`);
  if (!cond) fail.push(label);
};
const sign = body => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

try {
  const db = storage.openSqlite(dbPath);
  say(`① 建库：${dbPath}`);

  const threads = new storage.SqliteThreadRepo(db);
  const dispositions = new storage.SqliteDispositionRepo(db);
  const sources = new storage.SqliteEventSourceRepo(db);
  const triggers = new storage.SqliteTriggerRepo(db);
  const service = new core.ThreadService({ threads, dispositions });

  const src = sources.upsert({
    orgId: 'default',
    prefix: 'rss',
    secret: SECRET,
    config: { policy: { selfActorIds: ['markus-bot'] } },
  });
  say(`   来源 ${src.prefix} (${src.id}) cursor=${src.cursor} policy=${JSON.stringify(src.config.policy)}`);

  const registry = new core.SourceRegistry();
  registry.register(core.createGenericWebhookAdapter('rss'));
  const ingress = new core.EventIngress({
    registry,
    service,
    deliver: () => {},
    admission: ev => core.admitEvent(ev, core.policyOf(src.config), Date.now()),
    triggers,
  });

  /** 喂一批：返回 consumeBatch 的结果 */
  const feed = (events, nextCursor, opts = {}) => {
    const body = Buffer.from(JSON.stringify({ events, nextCursor }), 'utf8');
    const signature = opts.badSignature ? 'sha256=deadbeef' : sign(body);
    return core.consumeBatch(
      { sources, ingress },
      {
        sourceId: src.id,
        raw: { prefix: 'rss', headers: { 'x-markus-signature': signature }, rawBody: body, secret: SECRET },
        nextCursor,
      },
    );
  };

  const ev = (id, over = {}) => ({
    id,
    ref: 'rss:competitor-a',
    kind: 'external',
    actorKind: 'human',
    actorId: 'alice',
    summary: `item ${id}`,
    body: 'x',
    ...over,
  });
  const triggerCount = () => Number(db.prepare('SELECT COUNT(*) AS n FROM triggers').get().n);
  const cursorInDb = () => db.prepare('SELECT cursor, last_polled_at FROM event_sources WHERE id = ?').get(src.id);

  say('② 第一批：i1 + i2 → nextCursor=p2');
  const r1 = feed([ev('i1'), ev('i2')], 'p2');
  check('全部消费成功 → committed', r1.status === 'committed', `${r1.status} / ${r1.reason}`);
  check('位点推进到 p2', cursorInDb().cursor === 'p2', JSON.stringify(cursorInDb()));
  check('triggers = 2', triggerCount() === 2, triggerCount());

  say('③ 第二批：i3 → nextCursor=p3（应从 p2 继续）');
  const r2 = feed([ev('i3')], 'p3');
  check('committed', r2.status === 'committed', r2.reason);
  check('位点 p3', cursorInDb().cursor === 'p3', JSON.stringify(cursorInDb()));
  check('triggers = 3（只增不重）', triggerCount() === 3, triggerCount());

  say('④ 机器人自己发的消息 → 进领域之前丢弃');
  const r3 = feed([ev('self-1', { actorKind: 'bot', actorId: 'markus-bot' })], 'p4');
  const first = r3.results?.[0];
  check('该事件 status=filtered', first?.status === 'filtered', `${first?.status} / ${first?.reason}`);
  check('filteredBy=self', first?.filteredBy === 'self', first?.filteredBy);
  check('triggers 仍 = 3（没有为自激消息留行）', triggerCount() === 3, triggerCount());
  check('这是「消费成功」→ 位点仍要前进到 p4', r3.status === 'committed' && cursorInDb().cursor === 'p4', `${r3.status} / ${JSON.stringify(cursorInDb())}`);

  say('⑤ 消费失败（签名错）→ 位点一动不动');
  const before = cursorInDb();
  const r4 = feed([ev('i4')], 'p5', { badSignature: true });
  check('not-committed', r4.status === 'not-committed', `${r4.status} / ${r4.reason}`);
  check('位点仍是 p4（未被推进）', JSON.stringify(cursorInDb()) === JSON.stringify(before), JSON.stringify(cursorInDb()));
  check('triggers 仍 = 3（失败那批没有留行）', triggerCount() === 3, triggerCount());

  say('⑥ 直接查库');
  const rows = db.prepare('SELECT idempotency_key, kind FROM triggers ORDER BY received_at').all();
  for (const row of rows) say(`   trigger ${row.idempotency_key} kind=${row.kind}`);
  const health = sources.getById(src.id).health;
  // 探针直连 `consumeBatch`（不经 HTTP 层），所以 health 里不会有 lastFiltered ——
  // 那一项由 `event-routes` 在批量入口写，见 event-source-pull.test.ts 的同名用例。
  say(`   探针直连 consumeBatch（不经 HTTP 层）→ health=${JSON.stringify(health)}`);
  check('triggers 的幂等键全部来自 rss: 前缀', rows.every(r => String(r.idempotency_key).startsWith('rss:')));

  say('⑦ PRAGMA foreign_key_check');
  const fk = db.prepare('PRAGMA foreign_key_check').all();
  check('无外键违规', fk.length === 0, fk.length);

  storage.closeSqlite();
  say(fail.length === 0 ? '\n✅ 全部判据成立' : `\n❌ ${fail.length} 项不成立：${fail.join(' / ')}`);
} catch (e) {
  console.error('探针异常：', e);
  fail.push('exception');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(fail.length === 0 ? 0 : 1);
