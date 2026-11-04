/**
 * S3 接线守卫：日常链路必须真的写 Thread。
 *
 * 这一轮最大的教训是「tsc 通过 ≠ 钩子被调用」。所以这里不只测 helper 的返回值，
 * 还要**证明 createTask 真的触发了建流回调**——否则代码长得再对，流照样是 0 行。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openSqlite, closeSqlite } from '@markus/storage';
import { SqliteThreadRepo, SqliteDispositionRepo, SqliteChatSessionRepo, SqliteTriggerRepo } from '@markus/storage';
import { AgentManager } from '@markus/core';
import { TaskService } from '../src/task-service.js';
import { APIServer } from '../src/api-server.js';
import {
  ensureThread,
  recordThreadEvent,
  reportThreadEnsureFailure,
  taskRef,
  a2aRef,
} from '../src/thread-ensure.js';
import { resetThreadWiringHealth, threadWiringHealth } from '../src/thread-wiring-metrics.js';
import type { StorageBridge } from '../src/storage-bridge.js';

let dir: string;
let db: DatabaseSync;
let storage: StorageBridge;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'markus-wiring-'));
  db = openSqlite(join(dir, 'markus.db'));
  storage = {
    threadRepo: new SqliteThreadRepo(db),
    dispositionRepo: new SqliteDispositionRepo(db),
    chatSessionRepo: new SqliteChatSessionRepo(db),
    triggerRepo: new SqliteTriggerRepo(db),
  } as unknown as StorageBridge;

  // 本测试的命题是「建卡/发消息/投递会不会建流」，不是外键完整性。
  // agents 表自身又挂 org_id / role_id 等父表，逐层造父行只会把夹具变成一个
  // 与命题无关的建图游戏。因此关掉 FK（生产环境一定有真实 agent 行）。
  // 注：这正是那个「假绿」的反面——这里显式写明为什么可以放宽，而不是默默放宽。
  db.exec('PRAGMA foreign_keys = OFF');
});

afterEach(() => {
  closeSqlite();
  rmSync(dir, { recursive: true, force: true });
});

const threadCount = (ref: string) =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM threads WHERE ref = ?`).get(ref) as { n: number }).n);

/**
 * 测试只关心「建卡 → 建流」，不验证治理闸门。
 * 关掉 requireRequirement：否则会被「顶层任务必须关联已批准需求」拦住，
 * 而那条拦截与本节要验证的东西无关。
 */
function makeService(): TaskService {
  const svc = new TaskService();
  svc.setGovernancePolicy({
    enabled: true,
    defaultTier: 'human',
    maxPendingTasksPerAgent: 20,
    maxTotalActiveTasks: 0,
    requireApprovalForPriority: ['critical', 'high'],
    requireRequirement: false,
    rules: [],
  });
  return svc;
}

describe('ensureThread — 唯一收口', () => {
  it('建流并可重复调用（幂等，不新增行）', () => {
    expect(ensureThread(storage, 'tsk_abc')).toBe('ensured');
    expect(ensureThread(storage, 'tsk_abc')).toBe('ensured');
    expect(threadCount('tsk_abc')).toBe(1);
  });

  it('存储未挂 threadRepo 时返回可判定 outcome，且不抛', () => {
    // 2026-11-04：返回值从 boolean 改为 `ThreadEnsureOutcome` —— `false` 把
    // 「装配缺失」与「抛错」合成一个值，调用方无法给出可行动提示（静默降级的根）。
    expect(ensureThread(undefined, 'tsk_abc')).toBe('no-thread-repo');
    expect(ensureThread({} as StorageBridge, 'tsk_abc')).toBe('no-thread-repo');
  });

  it('ref 拼接集中在 helper 里（不散到各调用点）', () => {
    expect(taskRef('abc')).toBe('tsk_abc');
    expect(taskRef('tsk_abc')).toBe('tsk_abc'); // 不重复加前缀
    // 同一次 DM 对话无论谁发起都是同一条流
    expect(a2aRef('agt_b', 'agt_a')).toBe(a2aRef('agt_a', 'agt_b'));
    expect(a2aRef('agt_a', 'agt_b').startsWith('a2a_')).toBe(true);
  });
});

describe('TaskService — 建卡真的触发建流', () => {
  it('createTask 调用注入的 threadEnsurer，ref 落在 tsk_ 命名空间', () => {
    const seen: string[] = [];
    const svc = makeService();
    svc.setThreadEnsurer((taskId) => {
      seen.push(taskId);
      ensureThread(storage, taskRef(taskId));
    });

    const task = svc.createTask({
      orgId: 'org_1',
      title: 'S3 接线验证任务',
      description: '用于断言建卡会建流',
      assignedAgentId: 'agt_1',
      reviewerId: 'agt_2',
      priority: 'medium',
    } as never);

    // ① 钩子被调用（这是 tsc 与 helper 单测都覆盖不到的那一步）
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(task.id);
    // ② 流真的落到存储里
    expect(threadCount(taskRef(task.id))).toBe(1);
  });

  it('未注入时不报错（storage 缺席的测试/嵌入式场景）', () => {
    const svc = makeService();
    expect(() =>
      svc.createTask({
        orgId: 'org_1',
        title: '无 storage 场景',
        description: 'x',
        assignedAgentId: 'agt_1',
        reviewerId: 'agt_2',
        priority: 'medium',
      } as never),
    ).not.toThrow();
  });
});

describe('chat 链路 — 真实 persistChatTurn 建流', () => {
  /**
   * 用 Object.create 跳过 constructor 副作用（WSBroadcaster / 定时器等），
   * 但方法体是真的 —— 这测的是「persistChatTurn 会不会建流」，不是「代码里有没有这行」。
   */
  const makeServer = () => {
    const srv = Object.create(APIServer.prototype) as APIServer;
    (srv as unknown as { storage: StorageBridge }).storage = storage;
    return srv;
  };

  it('一次真实聊天回合 → threads 出现 cs_* 行', async () => {
    const srv = makeServer();
    await (srv as unknown as {
      persistChatTurn: (a: string, u: string, r: string) => Promise<void>;
    }).persistChatTurn('agt_chat', '你好', '收到');

    const rows = db.prepare(`SELECT ref FROM threads WHERE ref LIKE 'cs_%'`).all() as Array<{ ref: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ref.startsWith('cs_')).toBe(true);
  });

  it('同一个 agent 连聊两次仍只有一条流（会话复用 + 幂等）', async () => {
    const srv = makeServer();
    const call = (srv as unknown as {
      persistChatTurn: (a: string, u: string, r: string) => Promise<void>;
    }).persistChatTurn.bind(srv);
    await call('agt_chat2', '第一句', '回复一');
    await call('agt_chat2', '第二句', '回复二');

    const n = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM threads WHERE ref LIKE 'cs_%'`).get() as { n: number }).n,
    );
    expect(n).toBe(1);
  });

  /**
   * 真实流式路径：线上聊天走的是 persistUserMessage + persistAssistantMessage，
   * 不经过 persistChatTurn。首版把 ensure 只挂在 persistChatTurn 上，
   * 测试全绿但真实使用一条流都不建（实测 cs_* = 0）。这个用例就是那个缺口的守卫。
   */
  it('persistUserMessage（流式真实路径）→ threads 出现 cs_* 行', async () => {
    const srv = makeServer();
    const r = await (
      srv as unknown as {
        persistUserMessage: (
          a: string,
          u: string,
        ) => Promise<{ sessionId: string; messageId: string } | null>;
      }
    ).persistUserMessage('agt_chat3', '流式路径验证');

    expect(r?.sessionId).toBeTruthy();
    const rows = db.prepare(`SELECT ref FROM threads WHERE ref LIKE 'cs_%'`).all() as Array<{ ref: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ref).toBe(r!.sessionId);
  });

  it('流式路径续聊仍只有一条流（幂等）', async () => {
    const srv = makeServer();
    const call = (
      srv as unknown as {
        persistUserMessage: (
          a: string,
          u: string,
          s?: string,
          i?: string[],
          sid?: string | null,
        ) => Promise<{ sessionId: string } | null>;
      }
    ).persistUserMessage.bind(srv);

    // 注意：persistUserMessage 不传 sessionId 时每次都会建新会话（这是它的语义）。
    // 线上续聊会带上同一个 sessionId，所以幂等验证必须显式传回它。
    const a = await call('agt_chat4', '第一条');
    await call('agt_chat4', '第二条', undefined, undefined, a!.sessionId);

    const rows = db.prepare(`SELECT ref FROM threads WHERE ref LIKE 'cs_%'`).all() as Array<{ ref: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ref).toBe(a!.sessionId);
  });
});

describe('a2a 链路 — 投递时建流', () => {
  /**
   * 最小构造：没有真实 agent 可投递，所以 deliverA2AMessage 会在后续抛错。
   * 但我们关心的是「钩子位于投递流程早期且被调用」——恰好这一点能在抛错前验证。
   * 不把「投递成功」写进断言，因为那需要起一整套 runtime，会变成测 LLM 而不是测接线。
   */
  it('deliverA2AMessage 在投递早期调用 threadEnsurer，参数是双方 id', async () => {
    const seen: Array<[string, string]> = [];
    const texts: Array<string | undefined> = [];
    const mgr = new AgentManager({ llmRouter: {} as never });
    mgr.setThreadEnsurer((a, b, _actor, text) => {
      seen.push([a, b]);
      texts.push(text);
      ensureThread(storage, a2aRef(a, b));
    });

    const deliver = (
      mgr as unknown as {
        deliverA2AMessage: (args: {
          targetId: string;
          message: string;
          fromId: string;
          fromName: string;
        }) => Promise<string>;
      }
    ).deliverA2AMessage.bind(mgr);

    // 最小构造下没有真实 agent，投递本身会失败；接线必须在失败之前已经发生
    await expect(
      deliver({ targetId: 'agt_b', message: '你好', fromId: 'agt_a', fromName: 'A' }),
    ).rejects.toThrow();

    expect(seen).toEqual([['agt_a', 'agt_b']]);
    // 正文必须一路传到接线层：时间线要能写「发了什么」，不能只写「发了一条」
    expect(texts).toEqual(['你好']);
    // 且流真的落到存储里，ref 与方向无关
    const rows = db.prepare(`SELECT ref FROM threads WHERE ref LIKE 'a2a_%'`).all() as Array<{ ref: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ref).toBe(a2aRef('agt_a', 'agt_b'));
  });

  it('反方向投递命中同一条流（不会裂成两条）', async () => {
    const mgr = new AgentManager({ llmRouter: {} as never });
    mgr.setThreadEnsurer((a, b) => ensureThread(storage, a2aRef(a, b)));
    const deliver = (
      mgr as unknown as {
        deliverA2AMessage: (args: {
          targetId: string;
          message: string;
          fromId: string;
          fromName: string;
        }) => Promise<string>;
      }
    ).deliverA2AMessage.bind(mgr);

    await expect(deliver({ targetId: 'agt_b', message: 'x', fromId: 'agt_a', fromName: 'A' })).rejects.toThrow();
    await expect(deliver({ targetId: 'agt_a', message: 'y', fromId: 'agt_b', fromName: 'B' })).rejects.toThrow();

    const n = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM threads WHERE ref LIKE 'a2a_%'`).get() as { n: number }).n,
    );
    expect(n).toBe(1);
  });

  /**
   * 与 `start.ts` 的注入实现同款的闭环：建流 + 时间线各一行。
   * 把两者写在一起是因为它们在生产代码里就是同一个回调 —— 只测其中一半，
   * 另一半消失了测试依旧绿。
   */
  it('a2a 接线闭环（与 start.ts 同款）：threads / triggers 各落一行', async () => {
    const mgr = new AgentManager({ llmRouter: {} as never });
    mgr.setThreadEnsurer((a, b, _actor, text) => {
      const ref = a2aRef(a, b);
      const outcome = ensureThread(storage, ref, a);
      recordThreadEvent(storage, ref, { kind: 'a2a', actor: a, actorKind: 'agent', summary: text ?? '' });
      return outcome;
    });
    const deliver = (
      mgr as unknown as {
        deliverA2AMessage: (args: { targetId: string; message: string; fromId: string; fromName: string }) => Promise<string>;
      }
    ).deliverA2AMessage.bind(mgr);

    await expect(deliver({ targetId: 'agt_b', message: 'ni hao', fromId: 'agt_a', fromName: 'A' })).rejects.toThrow();

    expect(threadCount(a2aRef('agt_a', 'agt_b'))).toBe(1);
    const trg = db
      .prepare(`SELECT kind, actor_id FROM triggers WHERE kind = 'a2a'`)
      .all() as Array<{ kind: string; actor_id: string }>;
    expect(trg).toHaveLength(1);
    expect(trg[0]!.actor_id).toBe('agt_a');
  });
});

describe('静默降级必须消灭 — outcome 可判定 + 计数可见', () => {
  it('缺 threadRepo → no-thread-repo（不是不声不响的 false）', () => {
    resetThreadWiringHealth();
    expect(ensureThread(undefined, 'tsk_no_repo')).toBe('no-thread-repo');
    expect(threadWiringHealth().ensure['no-thread-repo']).toBe(1);
    // 上报本身不得抛（业务不能因为派生视图失败而中断）
    expect(() => reportThreadEnsureFailure('no-thread-repo', 'tsk_no_repo', 'task.create')).not.toThrow();
  });

  it('缺 triggerRepo → no-trigger-repo，且计数可见', () => {
    resetThreadWiringHealth();
    const bare = { threadRepo: storage.threadRepo } as unknown as StorageBridge;
    expect(recordThreadEvent(bare, 'tsk_bare', { kind: 'comment', summary: 'x' })).toBe('no-trigger-repo');
    expect(threadWiringHealth().event['no-trigger-repo']).toBe(1);
  });

  it('重复登记同一个 eventId → duplicate（重投是正常情况，不是失败）', () => {
    resetThreadWiringHealth();
    const e = { kind: 'comment', summary: 'same', eventId: 'evt_fixed_1' };
    expect(recordThreadEvent(storage, 'tsk_dup', e)).toBe('recorded');
    expect(recordThreadEvent(storage, 'tsk_dup', e)).toBe('duplicate');
    expect(threadWiringHealth().event).toMatchObject({ recorded: 1, duplicate: 1 });
  });
});
