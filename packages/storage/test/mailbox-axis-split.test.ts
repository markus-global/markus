/**
 * C2：`mailbox_items` 拆轴（执行态 / 内容 / 引用）的行为测试 —— 真 Sqlite，不是夹具。
 *
 * 每条用例都对应卡面的一条验收判据；其中「历史行回落」那条刻意做成**
 * 把回落逻辑删掉就必须变红**的形态（不是断言「有这个函数」，而是断言行为）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openSqlite, closeSqlite, SqliteMailboxRepo, SqliteTriggerRepo } from '../src/index.js';
import { MAILBOX_CONTENT_KEYS } from '../src/mailbox-content.js';

const ROOT = join(__dirname, '..', '..', '..');
let tempDir: string;
let dbPath: string;

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-c2-'));
  dbPath = join(tempDir, 'c2.db');
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

function item(over: Partial<{
  id: string; agentId: string; sourceType: string; priority: number; status: string;
  payload: Record<string, unknown>; metadata: Record<string, unknown>;
  queuedAt: string; dedupKey: string;
}> = {}) {
  return {
    id: 'mbx_1',
    agentId: 'agt_1',
    sourceType: 'human_chat',
    priority: 2,
    status: 'queued',
    payload: { summary: '问一句', content: '完整的问题正文', extra: { sessionId: 'cs_1' } },
    metadata: { senderId: 'u1', senderName: '老板' },
    queuedAt: '2026-11-03T08:00:00.000Z',
    ...over,
  };
}

// ─── 判据 1：新写入不再复制内容 ───────────────────────────────────────────────

describe('C2 · 判据1 新写入的 mailbox 行不含内容副本', () => {
  it('payload 里没有 summary/content，正文只在 triggers；行上有 trigger_id', () => {
    const db = openSqlite(dbPath);
    const repo = new SqliteMailboxRepo(db);
    expect(repo.save(item())).toBe(true);

    const raw = db.prepare("SELECT payload, trigger_id FROM mailbox_items WHERE id='mbx_1'").get() as
      { payload: string; trigger_id: string };
    const stored = JSON.parse(raw.payload) as Record<string, unknown>;

    expect(Object.keys(stored)).not.toContain('summary');
    expect(Object.keys(stored)).not.toContain('content');
    expect(stored).toMatchObject({ extra: { sessionId: 'cs_1' } }); // 执行提示留在执行态轴
    expect(raw.trigger_id).toBeTruthy();

    const trg = db.prepare('SELECT summary, body, kind FROM triggers WHERE id = ?').get(raw.trigger_id) as
      { summary: string; body: string; kind: string };
    expect(trg.summary).toBe('问一句');
    expect(trg.body).toBe('完整的问题正文');
    expect(trg.kind).toBe('mailbox'); // 来源标记，不复制 source_type 的分类法
  });

  it('内容键清单只有一处定义，且它列出的键一个都不落 mailbox payload', () => {
    const db = openSqlite(dbPath);
    const repo = new SqliteMailboxRepo(db);
    const payload: Record<string, unknown> = { taskId: 'tsk_1' };
    for (const k of MAILBOX_CONTENT_KEYS) payload[k] = `value-of-${k}`;
    repo.save(item({ payload }));

    const raw = db.prepare("SELECT payload FROM mailbox_items WHERE id='mbx_1'").get() as { payload: string };
    const stored = JSON.parse(raw.payload) as Record<string, unknown>;
    for (const k of MAILBOX_CONTENT_KEYS) expect(Object.keys(stored), `${k} 不应落 mailbox`).not.toContain(k);
  });
});

// ─── 判据 2：读路径 + 历史行回落 ─────────────────────────────────────────────

describe('C2 · 判据2 读路径与历史行回落', () => {
  it('有 trigger 引用 → 正文取自 triggers（读回来和写进去一致）', () => {
    const db = openSqlite(dbPath);
    const repo = new SqliteMailboxRepo(db);
    repo.save(item());

    const row = repo.getById('mbx_1')!;
    expect(row.payload['content']).toBe('完整的问题正文');
    expect(row.payload['summary']).toBe('问一句');
    expect(row.triggerId).toBeTruthy();
    // 列表与历史两条读路径都经同一 hydrate 点
    expect((repo.getByAgent('agt_1')[0]!.payload as { content: string }).content).toBe('完整的问题正文');
    expect((repo.getHistory('agt_1')[0]!.payload as { content: string }).content).toBe('完整的问题正文');
  });

  it('历史行（trigger_id IS NULL）回落自身 payload 列 —— 删掉回落分支即红', () => {
    const db = openSqlite(dbPath);
    // 直接按拆轴之前的形态写一行：正文在 payload 里，没有 trigger_id
    db.prepare(
      `INSERT INTO mailbox_items (id, agent_id, source_type, priority, status, payload, metadata, queued_at)
       VALUES ('mbx_legacy','agt_1','human_chat',2,'queued',?,'{}','2026-10-01T00:00:00.000Z')`
    ).run(JSON.stringify({ summary: '老摘要', content: '老正文（拆轴之前写入）' }));

    const repo = new SqliteMailboxRepo(db);
    const row = repo.getById('mbx_legacy')!;
    expect(row.triggerId ?? null).toBeNull();
    expect(row.payload['content']).toBe('老正文（拆轴之前写入）');
    expect(row.payload['summary']).toBe('老摘要');
    // 升级没有偷偷回填：历史行仍然没有 trigger_id
    const n = db.prepare('SELECT COUNT(*) AS n FROM triggers').get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('正文真的是空 ≠ 没有正文：有 trigger 引用时不被自身 payload 污染', () => {
    const db = openSqlite(dbPath);
    const repo = new SqliteMailboxRepo(db);
    repo.save(item({ payload: { summary: '只有摘要', content: '' } }));
    const row = repo.getById('mbx_1')!;
    expect(row.payload['content']).toBe('');
    expect(row.payload['summary']).toBe('只有摘要');
  });
});

// ─── 判据 1b：同一事件只有一行正文 ───────────────────────────────────────────

describe('C2 · 事件键复用：一个事件一行正文', () => {
  it('带 extra.idempotencyKey 时复用 ingress 写的那行，不再复制第二份', () => {
    const db = openSqlite(dbPath);
    const triggers = new SqliteTriggerRepo(db);
    // 模拟 event-ingress 先登记了事件
    const first = triggers.insertOrGet({
      kind: 'external', idempotencyKey: 'gh:delivery:42',
      summary: '新 issue', body: 'issue 正文', threadRefs: ['gh:o/r#1'],
    }).trigger as { id: string };

    const repo = new SqliteMailboxRepo(db);
    repo.save(item({ id: 'mbx_evt', sourceType: 'system_event', payload: { summary: '新 issue', content: 'issue 正文', extra: { idempotencyKey: 'gh:delivery:42' } } }));

    const cnt = db.prepare('SELECT COUNT(*) AS n FROM triggers').get() as { n: number };
    expect(cnt.n).toBe(1); // 事件正文只有一行
    const row = db.prepare("SELECT trigger_id FROM mailbox_items WHERE id='mbx_evt'").get() as { trigger_id: string };
    expect(row.trigger_id).toBe(first.id);
    expect(repo.getById('mbx_evt')!.payload['content']).toBe('issue 正文');
  });

  it('同一行重复 save 不产生第二份正文', () => {
    const db = openSqlite(dbPath);
    const repo = new SqliteMailboxRepo(db);
    repo.save(item());
    repo.save(item()); // 重复（id 冲突被拒）
    const cnt = db.prepare('SELECT COUNT(*) AS n FROM triggers').get() as { n: number };
    expect(cnt.n).toBe(1);
  });

  it('dedup 冲突被拒时整体回滚：不留没人引用的正文行', () => {
    const db = openSqlite(dbPath);
    const repo = new SqliteMailboxRepo(db);
    expect(repo.save(item({ id: 'mbx_a', dedupKey: 'review_request:tsk_1:1' }))).toBe(true);
    expect(repo.save(item({ id: 'mbx_b', dedupKey: 'review_request:tsk_1:1' }))).toBe(false);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM mailbox_items').get() as { n: number };
    const trgs = db.prepare('SELECT COUNT(*) AS n FROM triggers').get() as { n: number };
    expect(rows.n).toBe(1);
    expect(trgs.n).toBe(1); // 被拒的那次没有留下正文
  });
});

// ─── 判据 3：执行态状态机不受影响 ────────────────────────────────────────────

describe('C2 · 判据3 执行态状态机不受拆轴影响', () => {
  it('queued→processing→completed 全程可用，且完成后正文仍可读', () => {
    const db = openSqlite(dbPath);
    const repo = new SqliteMailboxRepo(db);
    repo.save(item());

    expect(repo.claimItem('mbx_1', 'ownerA', '2026-11-03T09:00:00.000Z', '2026-11-03T08:00:01.000Z')).toBe(true);
    expect(repo.getById('mbx_1')!.status).toBe('processing');
    expect(repo.claimItem('mbx_1', 'ownerB', '2026-11-03T09:00:00.000Z', '2026-11-03T08:00:02.000Z')).toBe(false); // 唯一胜者
    expect(repo.renewLease('mbx_1', 'ownerA', '2026-11-03T09:05:00.000Z')).toBe(true);

    // 回队（P1.x）：processing → queued，仍按原语义工作，且不产生第二份正文
    expect(repo.requeueItem('mbx_1', { queuedAt: '2026-11-03T08:05:00.000Z' })).toBe(true);
    expect(repo.getById('mbx_1')!.status).toBe('queued');
    expect(repo.getById('mbx_1')!.payload['content']).toBe('完整的问题正文');
    expect((db.prepare('SELECT COUNT(*) AS n FROM triggers').get() as { n: number }).n).toBe(1);

    // 再跑完一轮：queued → processing → completed，收口后正文不丢
    expect(repo.claimItem('mbx_1', 'ownerC', '2026-11-03T09:30:00.000Z', '2026-11-03T08:06:00.000Z')).toBe(true);
    repo.updateStatus('mbx_1', 'completed', { completedAt: '2026-11-03T08:10:00.000Z' });
    const done = repo.getById('mbx_1')!;
    expect(done.status).toBe('completed');
    expect(done.payload['content']).toBe('完整的问题正文');
  });

  it('dropped 与终态清理也不动正文的单一写者', () => {
    const db = openSqlite(dbPath);
    const repo = new SqliteMailboxRepo(db);
    repo.save(item({ id: 'mbx_d' }));
    repo.updateStatus('mbx_d', 'dropped');
    expect(repo.getStatusCounts('agt_1')['dropped']).toBe(1);
    expect(repo.getById('mbx_d')!.payload['content']).toBe('完整的问题正文');
  });
});

// ─── 判据 4：I9 —— 升级不改旧表任何一行 ─────────────────────────────────────

describe('C2 · 判据4 I9 旧库升级一行未动', () => {
  /** 拆轴之前的 schema（没有 trigger_id 列）。 */
  const OLD_SCHEMA = `
    CREATE TABLE mailbox_items (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, source_type TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 2, status TEXT NOT NULL DEFAULT 'queued',
      payload TEXT NOT NULL DEFAULT '{}', metadata TEXT DEFAULT '{}',
      queued_at TEXT NOT NULL DEFAULT (datetime('now')), started_at TEXT, completed_at TEXT,
      deferred_until TEXT, merged_into TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
      claimed_by TEXT, lease_until TEXT, dedup_key TEXT
    );`;

  const OLD_COLUMNS = [
    'id', 'agent_id', 'source_type', 'priority', 'status', 'payload', 'metadata',
    'queued_at', 'started_at', 'completed_at', 'deferred_until', 'merged_into',
    'retry_count', 'claimed_by', 'lease_until', 'dedup_key',
  ];

  function dump(db: DatabaseSync, table: string, columns: string[]): string {
    const h = createHash('sha256');
    for (const row of db.prepare(`SELECT ${columns.join(',')} FROM ${table} ORDER BY rowid`).all()) {
      h.update(JSON.stringify(row));
    }
    return h.digest('hex');
  }

  it('升级前后「旧列」全表 dump 哈希一致，且 trigger_id 全为 NULL（没回填）', () => {
    // 1) 造一个拆轴之前的库，塞进真实形态的行
    const legacy = new DatabaseSync(dbPath);
    legacy.exec('PRAGMA journal_mode = WAL');
    legacy.exec(OLD_SCHEMA);
    const ins = legacy.prepare(
      `INSERT INTO mailbox_items (id, agent_id, source_type, priority, status, payload, metadata, queued_at)
       VALUES (?,?,?,?,?,?,?,?)`
    );
    for (let i = 0; i < 12; i++) {
      ins.run(
        `mbx_old_${i}`, 'agt_1', i % 2 ? 'human_chat' : 'heartbeat', 2, 'completed',
        JSON.stringify({ summary: `s${i}`, content: `老正文 ${i}` }), JSON.stringify({ senderId: 'u1' }),
        `2026-09-0${(i % 9) + 1}T00:00:0${i % 10}.000Z`,
      );
    }
    const before = dump(legacy, 'mailbox_items', OLD_COLUMNS);
    legacy.close();

    // 2) 用生产打开路径升级（ALTER TABLE ADD COLUMN + 建 triggers）
    const db = openSqlite(dbPath);
    const after = dump(db, 'mailbox_items', OLD_COLUMNS);
    expect(after, '旧列的值必须逐行一致（I9：升级不改旧表任何一行）').toBe(before);

    // 3) 新列存在且没有被回填 —— 历史行就是历史行
    const cols = db.prepare('PRAGMA table_info(mailbox_items)').all() as Array<{ name: string }>;
    expect(cols.some(c => c.name === 'trigger_id')).toBe(true);
    const filled = db.prepare('SELECT COUNT(*) AS n FROM mailbox_items WHERE trigger_id IS NOT NULL').get() as { n: number };
    expect(filled.n).toBe(0);

    // 4) 老行照旧可读（回落），且没有为此生成 triggers
    const repo = new SqliteMailboxRepo(db);
    expect(repo.getById('mbx_old_3')!.payload['content']).toBe('老正文 3');
    expect((db.prepare('SELECT COUNT(*) AS n FROM triggers').get() as { n: number }).n).toBe(0);
  });
});

// ─── 判据 5：轴清单可核对（文档 ↔ 真实 schema / 类型）──────────────────────────

describe('C2 · 判据5 轴清单与实现逐项对账', () => {
  const doc = (): string => readFileSync(join(ROOT, 'docs/architecture/mailbox.md'), 'utf8');

  it('mailbox_items 的每个真实列都在文档轴表里登记了归属', () => {
    const db = openSqlite(dbPath);
    const cols = (db.prepare('PRAGMA table_info(mailbox_items)').all() as Array<{ name: string }>).map(c => c.name);
    const text = doc();
    const missing = cols.filter(c => !text.includes(`\`${c}\``));
    expect(missing, `这些列没在 docs/architecture/mailbox.md 里登记轴归属: ${missing.join(', ')}`).toEqual([]);
  });

  it('MailboxPayload 的每个键都在文档里被判了轴', () => {
    const src = readFileSync(join(ROOT, 'packages/shared/src/types/mailbox.ts'), 'utf8');
    const body = /export interface MailboxPayload \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? '';
    const keys = [...body.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map(m => m[1]!);
    expect(keys.length, '没能从类型里解析出 payload 键（解析器过期？）').toBeGreaterThan(3);
    const text = doc();
    const missing = keys.filter(k => !text.includes(`payload.${k}`));
    expect(missing, `这些 payload 键没在文档里判轴: ${missing.join(', ')}`).toEqual([]);
  });

  it('内容键清单与文档声明一致（唯一事实源不能被悄悄改）', () => {
    const text = doc();
    for (const k of MAILBOX_CONTENT_KEYS) expect(text).toContain(`payload.${k}`);
  });
});

// ─── 结构守卫：内容只有一个写者 ──────────────────────────────────────────────

describe('C2 · 结构守卫 内容只有一个写函数', () => {
  it('全仓 `INSERT INTO triggers` 只出现在 thread-store.ts（mailbox 只调用不复制 SQL）', () => {
    const files = [
      'packages/storage/src/sqlite-storage.ts',
      'packages/storage/src/mailbox-content.ts',
      'packages/storage/src/db-maintenance.ts',
      'packages/storage/src/thread-store.ts',
      'packages/core/src/mailbox.ts',
    ];
    // 只核对**代码**，不核对注释：注释里提到这句 SQL 是说明，不是第二写者。
    const codeOnly = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
    const offenders = files.filter(f => {
      const text = codeOnly(readFileSync(join(ROOT, f), 'utf8'));
      return /INSERT\s+INTO\s+triggers/i.test(text) && f !== 'packages/storage/src/thread-store.ts';
    });
    expect(offenders, `这些文件自己写了 INSERT INTO triggers（第二写者）: ${offenders.join(', ')}`).toEqual([]);
  });

  it('mailbox 仓储不自己拼正文列（splitMailboxContent 是唯一出口）', () => {
    const text = readFileSync(join(ROOT, 'packages/storage/src/sqlite-storage.ts'), 'utf8');
    expect(text).toContain('splitMailboxContent');
    expect(text).toContain('hydrateMailboxContent');
    // 写入路径的 INSERT 里不允许再出现 payload.summary/content 的直写
    expect(/INSERT INTO mailbox_items[\s\S]{0,400}summary/.test(text)).toBe(false);
  });
});

// ─── 保留策略：拆轴后清理不再空转 ───────────────────────────────────────────

describe('C2 · 保留策略 终态行与其正文一起回收', () => {
  it('删终态行时回收 mbx:* 正文，但不动外部事件的 trigger', async () => {
    const db = openSqlite(dbPath);
    const repo = new SqliteMailboxRepo(db);
    const triggers = new SqliteTriggerRepo(db);

    // 外部事件（不归保留策略管）
    const ext = triggers.insertOrGet({ kind: 'external', idempotencyKey: 'gh:delivery:9', summary: 'x', body: 'y', receivedAt: 1 }).trigger as { id: string };

    const OLD = '2020-01-01T00:00:00.000Z';
    repo.save(item({ id: 'mbx_term', queuedAt: OLD, payload: { summary: 's', content: 'old body' } }));
    repo.updateStatus('mbx_term', 'completed');
    repo.save(item({ id: 'mbx_live', payload: { summary: 's2', content: 'live body' } }));

    const { pruneTerminalMailboxItems } = await import('../src/db-maintenance.js');
    const res = pruneTerminalMailboxItems(db, { dryRun: false, olderThanDays: 30, vacuum: false });

    expect(res.deleted).toBe(1);
    expect(res.triggersDeleted).toBe(1);
    const left = db.prepare("SELECT idempotency_key FROM triggers ORDER BY idempotency_key").all() as Array<{ idempotency_key: string }>;
    expect(left.map(r => r.idempotency_key)).toEqual(['gh:delivery:9', 'mbx:mbx_live']);
    expect((db.prepare("SELECT COUNT(*) AS n FROM triggers WHERE id = ?").get(ext.id) as { n: number }).n).toBe(1);
  });
});
