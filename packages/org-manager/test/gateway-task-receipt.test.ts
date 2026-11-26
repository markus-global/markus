/**
 * C9 相邻路径 · 网关 `createTask` 投递记录的身份契约（最小夹具）。
 *
 * 背景：`api-server.ts` 里「外部网关建任务 → 写一条回执行投递记录」原先是一个闭包，
 * 它的身份裁决（`refOrigin: 'platform-internal'`）只能靠**阅读**判定（卡 tsk_4459e401
 * 评审时确认的相邻缺口）。本夹具直调**生产函数** `enqueueGatewayTaskReceipt()`，
 * 把那条裁决变成可执行契约：
 *
 *   ① 严格模式（`MARKUS_STRICT_IDENTITY=1`）下入队**不抛**；
 *   ② 该行 `work_unit_ref` **恒为 NULL** —— 而且身份确实落到**执行那条 item** 上
 *      （`task_<id>_r1`），证明这里是 `platform-internal`（回执，没人回链），
 *      C10-0B 已删除「身份稍后补上」那一档（`pending-link`）：回执不是待链接的占位。
 *
 * 咬人方向：删掉 `gateway-task-receipt.ts` 里的 `refOrigin: 'platform-internal'` ⇒ ① 变红。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentMailbox, takeUnclaimedIdentityCount, type MailboxPersistence } from '../../core/src/mailbox.js';
import { EventBus } from '../../core/src/events.js';
import { openSqlite, closeSqlite, SqliteMailboxRepo } from '../../storage/src/sqlite-storage.js';
import { enqueueGatewayTaskReceipt, type GatewayTaskReceiptTarget } from '../src/gateway-task-receipt.js';

const AGENT = 'agt_gateway_receipt';
const TASK = 'tsk_gateway_receipt';
// 严格是默认；LENIENT=1 才是豁免。全局夹具设了 LENIENT，所以这里要**清掉**它。
const LENIENT = 'MARKUS_LENIENT_IDENTITY';

let tempDir: string;
let db: ReturnType<typeof openSqlite>;
let repo: SqliteMailboxRepo;

/** 与 `cli/start.ts` 的 `wireMailboxPersistence` 同形（含信封投影，回执要用 messageId 取证）。 */
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

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-gateway-receipt-'));
  db = openSqlite(join(tempDir, 'receipt.db'));
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

describe('C9 相邻路径：网关建任务回执行投递记录', () => {
  it('严格模式下不抛错，回执行行 ref 恒 NULL，而执行行在入队时即拿到 task_<id>_r1', () => {
    const mb = newMailbox();
    const target: GatewayTaskReceiptTarget = {
      enqueueToMailbox: (sourceType, payload, options) => mb.enqueue(sourceType, payload, options),
    };

    // 生产函数直调（不是复制一份 options 形状）：删掉表态 ⇒ 这里抛错。
    expect(
      enqueueGatewayTaskReceipt(target, { id: TASK, title: 'Gateway task' }, {
        description: 'created by an external gateway',
        createdBy: 'user_external',
      }),
    ).toBe(true);
    expect(takeUnclaimedIdentityCount(), 'platform-internal 是表态，不是遗漏').toBe(0);

    const receipt = repo.getByAgent(AGENT).find(r => r.sourceType === 'task_status_update')!;
    expect(receipt, '回执行必须落库').toBeDefined();
    expect(receipt.workUnitRef, '回执行没有身份，且不该有人回链').toBeNull();
    expect(receipt.intent, 'record 类：不触发 LLM 回合').toBe('deliver');
    expect(receipt.messageId, '任务实体的关联由结构承载').toBe(`gateway-task:${TASK}`);

    // 执行侧对照：同一 task 真开始执行时，身份落在**执行那条 item** 上——
    // C10-0B：它由 `sendTaskExecution` 的**必填** `workUnitRef` 参数带入，
    // 在入队那一刻写入内存 + DB（唯一写者 = mailbox INSERT），不再有事后补列。
    const ref = `task_${TASK}_r1`;
    const exec = mb.enqueue('task_status_update', {
      summary: 'Task: Gateway task', content: 'go', taskId: TASK,
    } as never, { intent: 'trigger_execution', workUnitRef: ref, refOrigin: 'entity', round: 1, metadata: { taskId: TASK } });
    expect(exec.workUnitRef, '执行 item 在入队时即带身份').toBe(ref);

    const rows = repo.getByAgent(AGENT);
    expect(rows.find(r => r.id === receipt.id)!.workUnitRef, '回执行不得被写成待链接').toBeNull();
    expect(rows.find(r => r.id === exec.id)!.workUnitRef, '身份属于执行行').toBe(ref);
    expect(rows.filter(r => r.workUnitRef !== null).length, '整个 task 只有执行行带身份').toBe(1);
  });

  it('没有 assignee（外部 agent 未解析到）→ 不写记录，也不抛错', () => {
    expect(() => enqueueGatewayTaskReceipt(undefined, { id: TASK, title: 'x' }, {})).not.toThrow();
    expect(enqueueGatewayTaskReceipt(undefined, { id: TASK, title: 'x' }, {})).toBe(false);
    expect(repo.getByAgent(AGENT)).toHaveLength(0);
  });
});
