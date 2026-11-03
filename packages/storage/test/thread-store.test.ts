/**
 * Thread / 处置 / 责任域 / 来源 的持久层回归（真实 SQLite，不是 fake repo）。
 *
 * 这一层锁的是设计文档 §2.3 的**存储级不变量**：
 *   I1 一个 ref 只有一条 thread（并发 upsert 也不许出两条）
 *   I3 同一 (trigger, thread) 只产生一条 disposition（webhook 重试 50 次也是 1 行）
 *   I4 disposition.reason 永远非空 —— 空理由直接拒绝写入
 *   I8 同一资源的 admin 档全局唯一，且拒绝时必须给可行动提示
 *
 * 为什么用真库：夹具会撒谎。上面四条全部由 UNIQUE 约束和 `ON CONFLICT DO NOTHING`
 * 保证，fake repo 里手写的「查找 + 抛错」逻辑看着一样，实际根本测不到索引。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openSqlite, closeSqlite } from '../src/sqlite-storage.js';
import {
  SqliteThreadRepo,
  SqliteDispositionRepo,
  SqliteResourceBindingRepo,
  SqliteEventSourceRepo,
  SqliteTriggerRepo,
} from '../src/thread-store.js';

let dir: string;
let db: DatabaseSync;
let threads: SqliteThreadRepo;
let triggers: SqliteTriggerRepo;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'markus-thread-'));
  db = openSqlite(join(dir, 'markus.db'));
  threads = new SqliteThreadRepo(db);
  triggers = new SqliteTriggerRepo(db);
});

afterEach(() => {
  closeSqlite();
  rmSync(dir, { recursive: true, force: true });
});

describe('绑定即订阅 — 一个事实一个写者', () => {
  it('bind 后立刻有 own 订阅（不需要调用方补）', () => {
    // 这条守的是实测踩到的 R1：`resource_bind` 工具补订阅、
    // `POST /api/resources/bindings` 不补 → 走 API 绑的资源事件落到 needs-assessment，
    // 四档闸门根本不触发。把订阅放进 bind() 之后，两条路径自动一致。
    const repo = new SqliteResourceBindingRepo(db);
    const r = repo.bind({
      holder: { kind: 'agent', id: 'agt_1' },
      resource: 'gh:acme/repo',
      scope: 'draft',
      autonomy: 'observe',
      grantedBy: 'human:owner',
    });
    expect(r.ok).toBe(true);

    const thread = threads.getByRef('gh:acme/repo');
    expect(thread).not.toBeNull();
    const subs = threads.listSubscriptions(thread!.id);
    expect(subs.filter(s => s.purpose === 'own').map(s => s.agentId)).toContain('agt_1');
  });

  it('对已存在的绑定再次 bind → 自愈补订阅（存量数据不必写迁移脚本）', () => {
    const repo = new SqliteResourceBindingRepo(db);
    // 先绕开 bind 直接造一条「绑了但没订阅」的存量
    const { thread } = threads.upsert('gh:legacy/repo');
    expect(threads.listSubscriptions(thread.id)).toHaveLength(0);

    repo.bind({
      holder: { kind: 'agent', id: 'agt_2' },
      resource: 'gh:legacy/repo',
      scope: 'draft',
      autonomy: 'observe',
      grantedBy: 'human:owner',
    });
    repo.bind({
      holder: { kind: 'agent', id: 'agt_2' },
      resource: 'gh:legacy/repo',
      scope: 'draft',
      autonomy: 'auto',
      grantedBy: 'human:owner',
    });

    expect(threads.listSubscriptions(thread.id).filter(s => s.purpose === 'own')).toHaveLength(1);
  });

  it('unbind 同步退订 —— 解除责任后不该还被叫醒', () => {
    const repo = new SqliteResourceBindingRepo(db);
    const r = repo.bind({
      holder: { kind: 'agent', id: 'agt_3' },
      resource: 'gh:acme/other',
      scope: 'draft',
      autonomy: 'observe',
      grantedBy: 'human:owner',
    });
    expect(r.ok).toBe(true);
    const thread = threads.getByRef('gh:acme/other')!;
    expect(threads.listSubscriptions(thread.id).filter(s => s.purpose === 'own')).toHaveLength(1);

    expect(repo.unbind(r.ok ? r.binding.id : '')).toBe(true);
    expect(threads.listSubscriptions(thread.id).filter(s => s.purpose === 'own')).toHaveLength(0);
  });
});

describe('triggers — I2 幂等身份（而不是靠 disposition 兼职）', () => {
  it('首次登记返回 created=true，重投返回既有行且 created=false', () => {
    const a = triggers.insertOrGet({ kind: 'external', idempotencyKey: 'gh:delivery:1' });
    expect(a.created).toBe(true);
    expect(a.trigger.id.startsWith('trg_')).toBe(true);

    const b = triggers.insertOrGet({ kind: 'external', idempotencyKey: 'gh:delivery:1' });
    expect(b.created).toBe(false);
    expect(b.trigger.id).toBe(a.trigger.id);
  });

  it('同一 key 重投 50 次 → 只有 1 行（UNIQUE(idempotency_key) 是执行点）', () => {
    for (let i = 0; i < 50; i++) {
      triggers.insertOrGet({ kind: 'im', idempotencyKey: 'im:feishu:msg_9' });
    }
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM triggers WHERE idempotency_key = ?`)
      .get('im:feishu:msg_9') as { n: number };
    expect(Number(row.n)).toBe(1);
    expect(triggers.count()).toBe(1);
  });

  it('不同 key → 两条独立触发', () => {
    triggers.insertOrGet({ kind: 'chat', idempotencyKey: 'chat:cs_1:1' });
    triggers.insertOrGet({ kind: 'chat', idempotencyKey: 'chat:cs_1:2' });
    expect(triggers.count()).toBe(2);
  });

  it('重投不覆盖已有内容（trigger 不可变，没有 UPDATE 路径）', () => {
    triggers.insertOrGet({
      kind: 'external',
      idempotencyKey: 'k1',
      summary: '第一条',
      body: '正文 A',
    });
    // 同一 key，但内容不同 —— 必须保留第一次的
    const again = triggers.insertOrGet({
      kind: 'external',
      idempotencyKey: 'k1',
      summary: '后来者',
      body: '正文 B',
    });
    expect(again.created).toBe(false);
    expect(again.trigger.summary).toBe('第一条');
    expect(again.trigger.body).toBe('正文 A');
  });

  it('threadRefs 往返（JSON 数组，不丢不混）', () => {
    triggers.insertOrGet({
      kind: 'task',
      idempotencyKey: 'tsk_abc:evt_1',
      threadRefs: ['tsk_abc', 'req_xyz'],
    });
    expect(triggers.getByIdempotencyKey('tsk_abc:evt_1')?.threadRefs).toEqual(['tsk_abc', 'req_xyz']);
  });

  it('可选字段缺省不报错（外部事件常缺 actor）', () => {
    const r = triggers.insertOrGet({ kind: 'system', idempotencyKey: 'sys:1' });
    expect(r.trigger.orgId).toBeNull();
    expect(r.trigger.actorId).toBeNull();
    expect(r.trigger.threadRefs).toEqual([]);
  });
});

describe('threads — I1 一个 ref 一条流', () => {
  it('首次 upsert 建流，重复 upsert 复用同一条', () => {
    const a = threads.upsert('tsk_abc');
    expect(a.created).toBe(true);
    const b = threads.upsert('tsk_abc');
    expect(b.created).toBe(false);
    expect(b.thread.id).toBe(a.thread.id);
    expect(threads.getByRef('tsk_abc')?.ref).toBe('tsk_abc');
  });

  it('连续 upsert 100 次仍然只有一行（UNIQUE(ref) 是执行点）', () => {
    for (let i = 0; i < 100; i++) threads.upsert('xhs:brand_01');
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM threads WHERE ref = ?`).get('xhs:brand_01') as { n: number };
    expect(Number(rows.n)).toBe(1);
  });

  it('同一实体名空间键不同 → 两条独立流（大小写/空格不做魔法归一）', () => {
    threads.upsert('gh:owner/repo');
    threads.upsert('gh:owner/repo2');
    expect(threads.list().length).toBe(2);
  });

  // 「归属可设置/可清空、owner_since 只在设置时写」已删除：
  // owner 三列不存在了。“谁负责”由 subscriptions(purpose='own') 表达（多值），
  // 下一个用例（订阅可增删）就是它的守卫。

  it('订阅可增删，按 agent 反查', () => {
    const { thread } = threads.upsert('tsk_abc');
    threads.subscribe(thread.id, 'tkt_1', 'agt_1', 'own');
    threads.subscribe(thread.id, 'tkt_2', 'agt_2', 'context');
    // 同一 ticket 再订阅 = 更新而不是多一行
    threads.subscribe(thread.id, 'tkt_1', 'agt_1', 'context');
    const subs = threads.listSubscriptions(thread.id);
    expect(subs).toHaveLength(2);
    expect(subs.find(s => s.ticketId === 'tkt_1')?.purpose).toBe('context');
    expect(threads.listSubscriptionsByAgent('agt_2')).toHaveLength(1);

    threads.unsubscribe(thread.id, 'tkt_1');
    expect(threads.listSubscriptions(thread.id)).toHaveLength(1);
  });
});

describe('thread_dispositions — I3 幂等 / I4 理由必填', () => {
  it('同一 (trigger, thread) 重投 50 次只留一行', () => {
    const { thread } = threads.upsert('tsk_abc');
    const repo = new SqliteDispositionRepo(db);
    let accepted = 0;
    for (let i = 0; i < 50; i++) {
      if (repo.record({ triggerId: 'trg_x', threadId: thread.id, action: 'accept', reason: '新事件，建流' })) accepted++;
    }
    expect(accepted).toBe(1);
    expect(repo.countByTrigger('trg_x')).toBe(1);
    expect(repo.listByThread(thread.id)).toHaveLength(1);
  });

  it('空理由/纯空白理由直接抛错，不写半条审计', () => {
    const { thread } = threads.upsert('tsk_abc');
    const repo = new SqliteDispositionRepo(db);
    expect(() => repo.record({ triggerId: 't1', threadId: thread.id, action: 'accept', reason: '' })).toThrow(
      /DISPOSITION_REASON_REQUIRED/,
    );
    expect(() => repo.record({ triggerId: 't2', threadId: thread.id, action: 'ignore', reason: '   ' })).toThrow(
      /DISPOSITION_REASON_REQUIRED/,
    );
    expect(repo.listByThread(thread.id)).toHaveLength(0);
  });

  it('wouldAccept 三态回环：true→1 / false→0 / 不适用→NULL，读回语义一致', () => {
    // 为什么断言三态而不是「布尔不泄漏」：这条列曾经把 undefined 压成 0，
    // 于是 dispatch / attach / stop 这些**没问过**「若放行会不会接」的处置
    // 被读成 false，UI 对着它们说「当时判定不该来」。
    // 把任一方向的映射写反（encode 反过来 / decode 用 `!== 0`），这个用例必红。
    const { thread } = threads.upsert('tsk_abc');
    const repo = new SqliteDispositionRepo(db);

    repo.record({ triggerId: 'trg_accept', threadId: thread.id, action: 'ignore', reason: 'observe：本会接', wouldAccept: true });
    repo.record({ triggerId: 'trg_reject', threadId: thread.id, action: 'ignore', reason: '流已结束，本不会接', wouldAccept: false });
    repo.record({ triggerId: 'trg_dispatch', threadId: thread.id, action: 'dispatch', reason: '人已指定处理者，不问「会不会接」' });

    const raw = db
      .prepare(`SELECT trigger_id, would_accept FROM thread_dispositions`)
      .all() as Array<{ trigger_id: string; would_accept: number | null }>;
    const fromDb = Object.fromEntries(raw.map(r => [r.trigger_id, r.would_accept]));
    // DB 快照名：三态各自可辨认（1 / 0 / NULL）
    expect(fromDb).toEqual({ trg_accept: 1, trg_reject: 0, trg_dispatch: null });

    const readBack = repo.listByThread(thread.id);
    const fromApi = Object.fromEntries(readBack.map(d => [d.triggerId, d.wouldAccept]));
    // TS 字段名：与 DB 列语义一致——NULL 不许变成 false
    expect(fromApi).toEqual({ trg_accept: true, trg_reject: false, trg_dispatch: null });
  });
});

describe('resource_bindings — I8 同一资源只能有一个 admin', () => {
  it('不同档位可并存，但第二个 admin 被拒且给出可行动提示', () => {
    const repo = new SqliteResourceBindingRepo(db);
    const first = repo.bind({
      holder: { kind: 'agent', id: 'agt_a' },
      resource: 'gh:owner/repo',
      scope: 'admin',
      grantedBy: 'human:owner',
    });
    expect(first.ok).toBe(true);

    const second = repo.bind({
      holder: { kind: 'agent', id: 'agt_b' },
      resource: 'gh:owner/repo',
      scope: 'admin',
      grantedBy: 'human:owner',
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toContain('agt_a');
      expect(second.reason).toMatch(/transfer|接管/);
    }

    const reader = repo.bind({
      holder: { kind: 'agent', id: 'agt_b' },
      resource: 'gh:owner/repo',
      scope: 'read',
      grantedBy: 'human:owner',
    });
    expect(reader.ok).toBe(true);
  });

  it('同一 holder 同一资源重复绑定 = 更新档位，不新增行', () => {
    const repo = new SqliteResourceBindingRepo(db);
    repo.bind({ holder: { kind: 'agent', id: 'agt_a' }, resource: 'xhs:brand_01', scope: 'draft', grantedBy: 'human:o' });
    repo.bind({
      holder: { kind: 'agent', id: 'agt_a' },
      resource: 'xhs:brand_01',
      scope: 'publish',
      autonomy: 'auto',
      grantedBy: 'human:o',
    });
    const rows = repo.listByHolder('agent', 'agt_a');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scope).toBe('publish');
    expect(rows[0]?.autonomy).toBe('auto');
  });

  it('granted_by 保留「谁给的」——agent 自绑与人授权可区分', () => {
    const repo = new SqliteResourceBindingRepo(db);
    repo.bind({ holder: { kind: 'agent', id: 'agt_a' }, resource: 'rss:a', scope: 'read', grantedBy: 'agent:agt_a' });
    repo.bind({ holder: { kind: 'team', id: 'team_x' }, resource: 'rss:b', scope: 'read', grantedBy: 'human:owner' });
    expect(repo.listByResource('rss:a')[0]?.grantedBy).toEqual({ kind: 'agent', id: 'agt_a' });
    expect(repo.listByResource('rss:b')[0]?.grantedBy).toEqual({ kind: 'human', id: 'owner' });
  });

  it('解绑后资源可再次被他人以 admin 接管', () => {
    const repo = new SqliteResourceBindingRepo(db);
    const a = repo.bind({ holder: { kind: 'agent', id: 'agt_a' }, resource: 'gh:o/r', scope: 'admin', grantedBy: 'human:o' });
    expect(a.ok).toBe(true);
    if (a.ok) expect(repo.unbind(a.binding.id)).toBe(true);
    const b = repo.bind({ holder: { kind: 'agent', id: 'agt_b' }, resource: 'gh:o/r', scope: 'admin', grantedBy: 'human:o' });
    expect(b.ok).toBe(true);
  });
});

describe('event_sources — 来源配置与健康位', () => {
  it('同一 org 同一前缀 upsert = 合并 config/health，不新增行', () => {
    const repo = new SqliteEventSourceRepo(db);
    repo.upsert({ orgId: 'org_1', prefix: 'gh', config: { repos: ['a/b'] }, secret: 's3cr3t' });
    repo.upsert({ orgId: 'org_1', prefix: 'gh', config: { events: ['push'] }, health: { fails: 0 } });
    const src = repo.getByPrefix('org_1', 'gh')!;
    expect(src.config).toEqual({ repos: ['a/b'], events: ['push'] });
    expect(src.health).toEqual({ fails: 0 });
    // secret 未被第二次 upsert 抹掉
    expect(src.secret).toBe('s3cr3t');
    expect(repo.listByOrg('org_1')).toHaveLength(1);
  });

  it('updateHealth 增量合并，历史观测不丢', () => {
    const repo = new SqliteEventSourceRepo(db);
    // 刻意**不**用 `cursor` 当健康位示例：它是 `event_sources.cursor` 这两列的专名，
    // 放进 health 就是同一个事实两个位置（B2 要治的正是这个病）。
    const src = repo.upsert({ orgId: 'org_1', prefix: 'xhs', health: { fails: 1 } });
    repo.updateHealth(src.id, { fails: 2, lastError: 'boom' });
    const after = repo.getById(src.id)!;
    expect(after.health).toEqual({ fails: 2, lastError: 'boom' });
  });
});
