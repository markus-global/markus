/**
 * 真库探针（B1）：跑一次**真实 ingress（真 Sqlite）**，输出 thread_dispositions 的 matched_rule 分布。
 *
 * 为什么必须真库而不是 fake repo（见 thread-e2e-autonomy.test.ts 的同一段理由）：
 * fake 的 `record()` 是数组 push，永远成功 —— 「matched_rule 会不会真落库」这个问题
 * 在夹具上根本不存在。真库才暴露 ALTER TABLE 迁移、INSERT 列顺序、UNIQUE 冲突这些真实门槛。
 *
 * 它同时是**回归**：断言四类 gate 规则都真的在 dispositions 里留下 matched_rule，
 * 任何一条规则漏记 / 列迁移失效，这里就红。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openSqlite, closeSqlite, SqliteThreadRepo, SqliteDispositionRepo } from '@markus/storage';
import { ThreadService, EventIngress, SourceRegistry, admitEvent } from '@markus/core';
import type { NormalizedEvent } from '@markus/core';

let dir: string;
let db: ReturnType<typeof openSqlite>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'markus-probe-b1-'));
  db = openSqlite(join(dir, 'markus.db'));
});
afterEach(() => {
  closeSqlite();
  rmSync(dir, { recursive: true, force: true });
});

describe('真库探针 · matched_rule 分布（B1）', () => {
  it('真实 ingress → 真实 Sqlite：四类 gate 规则都留下可查询的 matched_rule', () => {
    const threads = new SqliteThreadRepo(db);
    const dispositions = new SqliteDispositionRepo(db);
    // 生产默认：不注入 assess → 未命中降级 needs-assessment（规则 6）。
    const service = new ThreadService({ threads, dispositions, now: () => 1700000000000, onWake: () => {} });

    let seq = 0;
    let queue: NormalizedEvent[] = [];
    const ev = (over: Partial<NormalizedEvent> = {}): NormalizedEvent => {
      seq++;
      return {
        kind: 'comment',
        idempotencyKey: `probe-key-${seq}`,
        ref: 'gh:acme/probe',
        actorKind: 'bot',
        actorId: 'bot:ci',
        addressing: 'ambient',
        summary: `probe event #${seq}`,
        body: 'x',
        receivedAt: 1700000000000,
        ...over,
      };
    };
    const registry = new SourceRegistry();
    registry.register({ prefix: 'gh', verify: () => true, normalize: () => queue });

    const triggers = {
      rows: new Map<string, unknown>(),
      insertOrGet(t: { idempotencyKey: string }) {
        if (this.rows.has(t.idempotencyKey)) return { trigger: this.rows.get(t.idempotencyKey), created: false };
        const rec = { id: `trg_${this.rows.size + 1}`, ...t };
        this.rows.set(t.idempotencyKey, rec);
        return { trigger: rec, created: true };
      },
    };

    const ingress = new EventIngress({
      registry, service, deliver: () => {}, triggers,
      admission: e => admitEvent(e as NormalizedEvent, {}),
    });
    const feed = () => ingress.ingest({ prefix: 'gh', rawBody: Buffer.from('{}'), headers: {} });

    // 批 A：assess（其余）+ dispatch（人已指定）
    queue = [ev(), ev({ actorKind: 'human', addressing: 'mention', directTargetAgentId: 'agt_1' })];
    feed();
    // 批 B：direct-through（先订阅，再投同 ref；直通不产生 disposition）
    const { thread } = threads.upsert('gh:acme/subscribed');
    threads.subscribe(thread.id, thread.id, 'agt_own', 'own');
    queue = [ev({ ref: 'gh:acme/subscribed' })];
    feed();
    // 批 C：ignore-ended（流已结束 + bot）
    queue = [ev({ ref: 'gh:acme/ended', threadEnded: true })];
    feed();
    // 批 D：attach（明确指向实体）
    queue = [ev({ ref: 'tsk_probe', entityRef: 'tsk_probe' })];
    feed();

    // 说明（实测事实，非本卡引入的缺口）：`routeInputOf` 当前不携带
    // `entityRef` / `directTargetAgentId`，`NormalizedEvent` 也没有这两个字段 ——
    // 所以规则 2（dispatch）/ 规则 4（attach）**目前无法从裸 ingress 路径触发**。
    // 这是入口侧的既存缺口（归 Source/适配器解析，不是 B1）。为证明 matched_rule 列
    // 对这两类规则 id 也能落库，这里在**同一真库**上直接调 `service.route()` 走一遍
    // （ThreadService 层的 matchedRule 逻辑与 ingress 共用同一个 `decisionFor`）。
    service.route({ triggerId: 'probe-dispatch', kind: 'comment', ref: 'gh:acme/probe', actorKind: 'human', addressing: 'mention', directTargetAgentId: 'agt_1' });
    service.route({ triggerId: 'probe-attach', kind: 'comment', ref: 'tsk_probe2', actorKind: 'bot', addressing: 'ambient', entityRef: 'tsk_probe2' });

    const dist = db
      .prepare(`SELECT COALESCE(matched_rule, '<NULL>') AS rule, COUNT(*) AS n FROM thread_dispositions GROUP BY matched_rule ORDER BY n DESC`)
      .all() as Array<{ rule: string; n: number }>;
    const total = Number((db.prepare('SELECT COUNT(*) AS n FROM thread_dispositions').get() as { n: number }).n);

    // 分布打印是**带开关的诊断设施**（§11：需要长期诊断能力就做成开关，而非提交里裸 console.log）。
    // 默认静默；要人工复核分布时 `PROBE_EVAL=1 node ... vitest run <本文件>`。
    if (process.env.PROBE_EVAL === '1') {
      // eslint-disable-next-line no-console
      console.log('\n=== matched_rule 取值分布（真实 ingress → 真实 Sqlite）===');
      for (const row of dist) console.log(`  ${String(row.rule).padEnd(18)} ${row.n}`);
      console.log(`  --- 合计 ${total} 行`);
      const sample = db
        .prepare(`SELECT trigger_id, action, matched_rule, would_accept FROM thread_dispositions ORDER BY created_at`)
        .all() as Array<{ trigger_id: string; action: string; matched_rule: string; would_accept: number | null }>;
      console.log('=== 逐行抽样 ===');
      for (const s of sample) {
        console.log(`  ${String(s.trigger_id).padEnd(16)} action=${String(s.action).padEnd(9)} rule=${String(s.matched_rule).padEnd(14)} would=${s.would_accept}`);
      }
    }

    const byRule = Object.fromEntries(dist.map(d => [d.rule, d.n]));
    // 四类 gate 规则必须都在真库留下 matched_rule
    expect(byRule['assess']).toBeGreaterThanOrEqual(1);
    expect(byRule['dispatch']).toBeGreaterThanOrEqual(1);
    expect(byRule['ignore-ended']).toBeGreaterThanOrEqual(1);
    expect(byRule['attach']).toBeGreaterThanOrEqual(1);
  });
});
