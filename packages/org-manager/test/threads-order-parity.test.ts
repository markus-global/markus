/**
 * `GET /api/threads` 的**排序契约**（行为测试，不是源码文本断言）。
 *
 * 判据（卡 2 交付条件）：API 返回的 id 序列 == 概览首屏渲染的 id 序列，逐条相等。
 * 这个文件负责其中一半（服务端）；另一半在
 * `packages/web-ui/src/lib/actionItems.parity.test.ts`。两侧读**同一份**夹具
 * `packages/shared/src/types/__fixtures__/todo-order-parity.json` 并断言同一条
 * `expectedIds` —— 如果任何一侧自己长出第二套排序，两侧必然分叉，至少一侧红。
 *
 * 为什么用真实 SqliteRepo 而不是假仓库：`withStage()` 的 stage 是**从真实 tasks/approvals
 * 行派生**的（status → stage），假仓库会让「status 到 stage 的映射」这段被测逻辑根本不执行。
 *
 * ⚠️ 这个文件在修复前是红的：改前 `buildInboxRows` 按 `lastActivity` 降序返回，
 * 于是 `tsk_f_blocked`（刚发生）排第一、`tsk_a_appr`（等 200 分钟的审批）排最后。
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openSqlite, closeSqlite, SqliteThreadRepo, SqliteDispositionRepo, SqliteResourceBindingRepo, SqliteEventSourceRepo, SqliteTaskRepo, SqliteApprovalRepo, SqliteTriggerRepo } from '@markus/storage';
import { handleEventRoutes } from '../src/event-routes.js';
import { recordThreadEvent } from '../src/thread-ensure.js';

interface Fixture {
  todos: Array<{ id: string; stage: string; priority: string | null; lastActivity: number; title: string; ownerAgent: string }>;
  expectedIds: string[];
}

const FIXTURE: Fixture = JSON.parse(
  readFileSync(new URL('../../shared/src/types/__fixtures__/todo-order-parity.json', import.meta.url), 'utf-8'),
);

let dir: string;
let db: ReturnType<typeof openSqlite>;
let repos: any;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'markus-threads-order-'));
  db = openSqlite(join(dir, 'markus.db'));
  db.exec('PRAGMA foreign_keys = OFF');
  repos = {
    threadRepo: new SqliteThreadRepo(db),
    dispositionRepo: new SqliteDispositionRepo(db),
    resourceBindingRepo: new SqliteResourceBindingRepo(db),
    eventSourceRepo: new SqliteEventSourceRepo(db),
    triggerRepo: new SqliteTriggerRepo(db),
    taskRepo: new SqliteTaskRepo(db),
    approvalRepo: new SqliteApprovalRepo(db),
  };
});

afterEach(() => {
  closeSqlite();
  rmSync(dir, { recursive: true, force: true });
});

function fakeReq(): IncomingMessage {
  return { method: 'GET', url: '/api/threads', headers: {} } as unknown as IncomingMessage;
}

async function getThreads(): Promise<any[]> {
  const res: any = {
    writeHead(s: number) { res.status = s; return res; },
    end(payload?: string) { res.body = payload ? JSON.parse(payload) : undefined; },
  };
  const handled = await handleEventRoutes(
    {
      orgId: 'default',
      repos,
      deliver: null,
      recordEvent: (ref: string, event: any) => recordThreadEvent({ triggerRepo: repos.triggerRepo } as any, ref, event),
      now: () => FIXTURE.todos[0]!.lastActivity,
    } as any,
    fakeReq(),
    res as ServerResponse,
    '/api/threads',
  );
  expect(handled).toBe(true);
  return res.body.threads;
}

const insertTask = (id: string, status: string, priority: string, updatedAt: number, title: string, owner: string) => {
  db.prepare(
    `INSERT INTO tasks (id, org_id, title, description, status, priority, assigned_agent_id, reviewer_agent_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, 'default', title, '夹具描述', status, priority, owner, owner,
    new Date(updatedAt).toISOString(), new Date(updatedAt).toISOString());
};

const insertApproval = (id: string, taskId: string, requestedAt: number, agentId: string) => {
  db.prepare(
    `INSERT INTO approvals (id, agent_id, agent_name, type, title, description, details, status, requested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, agentId, agentId, 'action', `审批 ${id}`, '夹具描述', JSON.stringify({ taskId }), 'pending',
    new Date(requestedAt).toISOString());
};

/** 按夹具把「同一条待办」还原成业务行：审批靠 approvals，验收/阻塞靠 task.status。 */
function seedFromFixture() {
  for (const t of FIXTURE.todos) {
    if (t.stage === 'person:approval') {
      // 审批是「这条流在等人批」，挂载对象本身还在跑（in_progress）
      insertTask(t.id, 'in_progress', t.priority ?? 'medium', t.lastActivity, t.title, t.ownerAgent);
      insertApproval(`apr_${t.id}`, t.id, t.lastActivity, t.ownerAgent);
    } else if (t.stage === 'person:review') {
      insertTask(t.id, 'review', t.priority ?? 'medium', t.lastActivity, t.title, t.ownerAgent);
    } else if (t.stage === 'person:blocked') {
      insertTask(t.id, 'blocked', t.priority ?? 'medium', t.lastActivity, t.title, t.ownerAgent);
    } else {
      throw new Error(`夹具里出现了本用例不覆盖的 stage：${t.stage}（非 person:* 不该进待办语料）`);
    }
  }
}

describe('GET /api/threads — 待办排序契约', () => {
  it('返回序 == 契约期望序（stage → 优先级 → 等得久 → id）', async () => {
    seedFromFixture();
    const threads = await getThreads();
    expect(threads.map((t: any) => t.id)).toEqual(FIXTURE.expectedIds);
  });

  it('审批压过「紧急阻塞」：紧急不是无条件的先手（2026-11-04 的分叉现场）', async () => {
    seedFromFixture();
    const ids: string[] = (await getThreads()).map((t: any) => t.id);
    const firstApproval = ids.indexOf('tsk_b_appr');
    const firstBlocked = ids.indexOf('tsk_e_blocked');
    expect(firstApproval).toBe(0);
    expect(firstApproval).toBeLessThan(firstBlocked);
  });

  it('同 stage 内等得久的在前：最新的那条阻塞排在最后（旧口径里它排第一）', async () => {
    seedFromFixture();
    const ids: string[] = (await getThreads()).map((t: any) => t.id);
    expect(ids.indexOf('tsk_e_blocked')).toBeLessThan(ids.indexOf('tsk_f_blocked'));
    expect(ids.indexOf('tsk_f_blocked')).toBe(ids.length - 1);
  });

  it('确定性：同样的输入连取两次，序列一致（没有随机/时间噪声进排序键）', async () => {
    seedFromFixture();
    const a: string[] = (await getThreads()).map((t: any) => t.id);
    const b: string[] = (await getThreads()).map((t: any) => t.id);
    expect(b).toEqual(a);
  });
});
