/**
 * C9 相邻路径 · 停机复用回队（`reuseItemId`）的身份裁决 —— **复用 = 继承既有行的身份**，
 * 不在回队调用点重新表态。
 *
 * 背景（2026-11-15，卡 tsk_804c3f67235acca464742519）：
 * `attention.ts` 停机分支用 `enqueue(..., { reuseItemId: item.id })` 把在飞项送回队列，
 * 但不传 `workUnitRef` / 不传 `refOrigin`。C8-P0 守卫（`mailbox.ts` 的 `enqueue`）判据是
 * `!workUnitRef && !refOrigin && !PLATFORM_INTERNAL_SOURCES.has(sourceType)`，于是这条路径
 * 在严格模式下直接抛错 —— 而它恰恰是「身份本来就有」的那种情况。
 *
 * 语义（机制证据）：`SqliteMailboxRepo.requeueItem()` 的 UPDATE 只改
 * `status / queued_at / started_at / completed_at / claimed_by / lease_until /
 * drop_reason / bounce_target`，**不碰 `work_unit_ref`** ⇒ 回队后行仍带着原来的身份。
 * 所以在回队调用点再算一个 ref 就是第二个写者；正确做法是「交还调用方手里已有的 ref +
 * 显式声明身份不由本处决定」。
 *
 * 本文件三段，缺一段就会退化成 fail-open 或「只测 options 能传值」：
 *
 *   1. 正向（真实装配链 + 真实 SQLite + `MARKUS_STRICT_IDENTITY=1`）：先按生产形态入队
 *      （C10-0B：入队**即带** ref，内存 + DB 同源）→ `dequeue()` 认领 →
 *      `reEnqueueOnShutdown()`。断言不抛、回队后行仍是 `queued`、`work_unit_ref` **继承原值**。
 *      删掉 `reEnqueueOnShutdown` 里的 ref 交还/表态 ⇒ 本例变红（守卫抛错）。
 *   2. 负向：同类型事实**未表态**（非回队路径）必须抛错。删掉守卫里的 `throw` ⇒ 本例变红。
 *   3. 契约：回队只有**一处**实现（`attention.ts` 不得再内联 `reuseItemId`）——
 *      否则「继承身份」的表态就又变成两份，迟早只改一份。
 *
 * C10-0B：身份没有第二个建造点。旧用例「先入队（`pending-link`），再用唯一写者
 * `linkMailboxItem()` 补 DB 列」已删除——那个后补写者已不存在；回队继承的是
 * **入队那一刻**就已存在的 ref。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { AgentMailbox, takeUnclaimedIdentityCount, type MailboxPersistence } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';
import { openSqlite, closeSqlite, SqliteMailboxRepo } from '../../storage/src/sqlite-storage.js';

const AGENT = 'agt_identity_reuse';
const TASK = 'tsk_identity_reuse';
const REF = `task_${TASK}_r2`;
// 严格是默认；LENIENT=1 才是豁免。全局夹具设了 LENIENT，所以这里要**清掉**它。
const LENIENT = 'MARKUS_LENIENT_IDENTITY';

let tempDir: string;
let db: ReturnType<typeof openSqlite>;
let repo: SqliteMailboxRepo;

/** 与 `cli/start.ts` 的 `wireMailboxPersistence` 同形（含 P1.x 最小 API + 信封投影）。 */
function makePersistence(r: SqliteMailboxRepo): MailboxPersistence {
  return {
    save: (item, dedupKey) => {
      const { responsePromise: _rp, ...metadata } = (item.metadata ?? {}) as Record<string, unknown>;
      return r.save({
        id: item.id, agentId: item.agentId, sourceType: item.sourceType, priority: item.priority,
        status: item.status, payload: item.payload as unknown as Record<string, unknown>,
        metadata, queuedAt: item.queuedAt, dedupKey,
        envelope: item.envelope ? JSON.stringify(item.envelope) : null,
        messageId: item.envelope?.messageId ?? null,
        signalClass: item.envelope?.signalClass ?? null,
        intent: item.envelope?.intent ?? null,
        workUnitRef: item.workUnitRef ?? null,
      });
    },
    updateStatus: (itemId, status, extra) => r.updateStatus(itemId, status, extra as Record<string, unknown>),
    markStaleProcessingAsBounced: (aid) => r.markStaleProcessingAsBounced(aid),
    loadQueued: (aid) => r.getByAgent(aid, { status: 'queued' }).map(row => ({
      id: row.id, agentId: row.agentId, sourceType: row.sourceType as never,
      priority: row.priority as never, status: row.status as never,
      payload: row.payload as never, metadata: row.metadata as never, queuedAt: row.queuedAt,
    })),
    claimItem: (id, ownerId, leaseUntil, nowIso) => r.claimItem(id, ownerId, leaseUntil, nowIso),
    releaseClaim: (id, ownerId) => r.releaseClaim(id, ownerId),
    requeueItem: (id, opts) => r.requeueItem(id, opts),
    findByDedupKey: (aid, dedupKey) => r.findByDedupKey(aid, dedupKey),
  } as MailboxPersistence;
}

function newMailbox(): AgentMailbox {
  return new AgentMailbox(AGENT, new EventBus(), makePersistence(repo));
}

/** 生产形态的 task 执行指令：C10-0B 之后身份在入队那一刻就是事实（sendTaskExecution 的形状）。 */
function enqueueTaskExecution(mb: AgentMailbox, round: number, workUnitRef: string) {
  return mb.enqueue('task_status_update', {
    summary: 'Task: identity reuse', content: 'do it', taskId: TASK,
  } as never, {
    intent: 'trigger_execution',
    workUnitRef,
    refOrigin: 'entity',
    round,
    metadata: { taskId: TASK },
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-identity-reuse-'));
  db = openSqlite(join(tempDir, 'reuse.db'));
  repo = new SqliteMailboxRepo(db);
  delete process.env[LENIENT];
  takeUnclaimedIdentityCount();
});

afterEach(() => {
  process.env[LENIENT] = '1';
  takeUnclaimedIdentityCount();
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('C9 相邻路径：停机复用回队继承行身份', () => {
  it('正向：复用回队不抛错，行身份继承原值（不是 NULL），且状态真的回到 queued', () => {
    const mb = newMailbox();
    const enq = enqueueTaskExecution(mb, 2, REF);
    // C10-0B：身份在**入队那一刻**就写进内存 item 与 DB 行（同一个写者 = 入队）。
    expect(enq.workUnitRef, '入队即带 ref').toBe(REF);
    expect(repo.getById(enq.id)!.workUnitRef, '入队 INSERT 写同一列').toBe(REF);

    const inflight = mb.dequeue()!;               // 停机那一刻：已被本实例取走（processing）
    expect(inflight.id).toBe(enq.id);
    expect(repo.getById(enq.id)!.status).toBe('processing');
    expect(repo.getById(enq.id)!.workUnitRef).toBe(REF);

    // 修复前这一行就是红点：守卫在严格模式下抛
    // `mailbox.enqueue(task_status_update) has no workUnitRef and no refOrigin`。
    const requeued = mb.reEnqueueOnShutdown(inflight);

    expect(requeued.status, '回队不得返回 dropped/processing').toBe('queued');
    expect(requeued.id).toBe(enq.id);
    expect(requeued.round, '轮次是结构字段，回队不得丢').toBe(2);
    expect(requeued.workUnitRef, '内存项必须交还入队时的 ref').toBe(REF);
    expect(takeUnclaimedIdentityCount(), '表态后不应再计入未声明身份').toBe(0);

    const row = repo.getById(enq.id)!;            // 断言一律回读持久层，不看内存态
    expect(row.status).toBe('queued');
    expect(row.claimedBy).toBeNull();
    expect(row.leaseUntil).toBeNull();
    expect(row.workUnitRef, '复用 = 继承原行身份（requeueItem 不写这一列）').toBe(REF);
  });

  it('正向：入队时就带着 ref 的项（review_request）回队后仍带着同一个 ref', () => {
    const mb = newMailbox();
    const reviewRef = `task_${TASK}_r1`;
    const enq = mb.enqueue('review_request', {
      summary: 'Review', content: 'please review', taskId: TASK,
    } as never, { round: 1, workUnitRef: reviewRef, refOrigin: 'entity' });

    const inflight = mb.dequeue()!;
    const requeued = mb.reEnqueueOnShutdown(inflight);

    expect(requeued.workUnitRef, '内存项不得丢掉投递时带的身份').toBe(reviewRef);
    expect(repo.getById(enq.id)!.workUnitRef).toBe(reviewRef);
    expect(takeUnclaimedIdentityCount()).toBe(0);
  });

  it('负向：同类型事实若未表态（非回队路径）→ 严格模式必须抛错（防 fail-open 回归）', () => {
    const mb = newMailbox();
    expect(() =>
      mb.enqueue('task_status_update', {
        summary: 'Task created via gateway', content: 'rec', taskId: TASK,
      } as never, { intent: 'deliver', metadata: { taskId: TASK } }),
    ).toThrow(/has no workUnitRef and no refOrigin/);
  });
});

describe('C9 相邻路径：回队只有一处实现', () => {
  it('attention.ts 不得再内联 reuseItemId（否则「继承身份」的表态存在第二份）', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '..', 'src', 'attention.ts'), 'utf8');
    expect(
      source.includes('reuseItemId:'),
      '停机回队必须走 mailbox.reEnqueueOnShutdown()：内联 enqueue({reuseItemId}) 会漏掉身份表态，' +
        '在 MARKUS_STRICT_IDENTITY=1 下抛错（见本文件正向用例）',
    ).toBe(false);
    expect(source, '回队的唯一入口').toContain('this.mailbox.reEnqueueOnShutdown(');
  });
});
