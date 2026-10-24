/**
 * 任务执行「停止原因」单一事实源（SSOT）—— 回归测试
 *
 * 事故（2026-10-24，老板实测，契约③ 卡 tsk_3f3d66ab781d177d8c419a84）：
 *   agent 正常 `task_submit_review` → 任务 `in_progress → review` →
 *   `cleanupOnLeaveStatus` 置位 cancelToken（平台自身收尾）→ agent 循环 emit
 *   `status:'cancelled'` + 写死文案「Task execution was stopped externally」→
 *   task-service 无条件写注记「Task execution cancelled externally … Will auto-resume」。
 *   结果：**已完成的任务上出现"被外部取消、将自动恢复"的幽灵提示**，而"恢复"
 *   根本不会发生（重放回调里 status!=='in_progress' 直接丢弃）。
 *
 * 修复口径：停止原因由**取消发起方**用 `cancelExecutionToken` 写在 token 上，
 * 消费端（agent 事件 → task-service `handleExecutionStopped`）只读、不推断。
 * 只有真外部中断（preempted/user_stop/user_cancel/disconnect/timeout）才允许
 * 产生用户可见注记并尝试重放。
 *
 * 本文件锁三件事：
 *   ① helper 语义（首个原因胜出 / 分类 / 文案）；
 *   ② 结构机检 —— `.cancelled = true` 全仓只能出现在 helper 内部（负控：
 *      任何人绕过 helper 直接置位都会让这条测试变红）；
 *   ③ 行为回归 —— lifecycle 停止**不得**产生任何用户可见注记。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cancelExecutionToken,
  createCancelToken,
  isExternalStopReason,
  stopReasonLabel,
  type ExecutionStopReason,
} from '@markus/shared';
import { TaskService } from '../src/task-service.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function readSrc(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf-8');
}

/** 递归收集 packages/<pkg>/src 下所有 .ts 源文件（不含 dist/测试）。 */
function collectPackageSources(): string[] {
  const out: string[] = [];
  const packagesDir = join(REPO_ROOT, 'packages');
  for (const pkg of readdirSync(packagesDir)) {
    const srcDir = join(packagesDir, pkg, 'src');
    try {
      if (!statSync(srcDir).isDirectory()) continue;
    } catch { continue; }
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
      }
    };
    walk(srcDir);
  }
  return out;
}

describe('执行停止原因 helper', () => {
  it('cancelExecutionToken 写入原因；首个原因胜出（不被后续覆盖成误报）', () => {
    const token = createCancelToken();
    expect(token.cancelled).toBe(false);
    expect(token.stopReason).toBeUndefined();

    cancelExecutionToken(token, 'lifecycle');
    expect(token.cancelled).toBe(true);
    expect(token.stopReason).toBe('lifecycle');

    // 幂等：正常收尾之后到来的用户停止，不得把它改写成「用户停止」。
    cancelExecutionToken(token, 'user_stop', { userStopped: true });
    expect(token.stopReason).toBe('lifecycle');
    // userStopped 是独立的用户意图标记，仍然如实记录。
    expect(token.userStopped).toBe(true);
  });

  it('undefined token 不抛错（可安全用于可选令牌）', () => {
    expect(() => cancelExecutionToken(undefined, 'lifecycle')).not.toThrow();
  });

  it('只有真外部中断才允许写用户可见注记 / 重放', () => {
    for (const reason of ['preempted', 'user_stop', 'user_cancel', 'disconnect', 'timeout'] as ExecutionStopReason[]) {
      expect(isExternalStopReason(reason), reason).toBe(true);
    }
    for (const reason of ['lifecycle', 'superseded', 'unknown', undefined] as Array<ExecutionStopReason | undefined>) {
      expect(isExternalStopReason(reason), String(reason)).toBe(false);
    }
  });

  it('文案映射唯一且有区分度', () => {
    expect(stopReasonLabel('lifecycle')).not.toBe(stopReasonLabel('user_stop'));
    expect(stopReasonLabel('unknown')).toBeTruthy();
  });
});

describe('结构机检：取消只能有一个写者', () => {
  it('`.cancelled = true` 只允许出现在 shared/src/types/execution.ts（helper 内部）', () => {
    const offenders: string[] = [];
    for (const file of collectPackageSources()) {
      if (file.endsWith('packages/shared/src/types/execution.ts')) continue;
      const src = readFileSync(file, 'utf-8');
      // 只看赋值（`= true`），注释里的说明文字不算。
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/\.cancelled\s*=\s*true/.test(code)) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    // 负控：本断言存在时，任何绕过 helper 直接 `token.cancelled = true` 的
    // 新代码都会让这条测试变红 —— 原因就永远不会再被"丢失"。
    expect(offenders, `These writes bypass cancelExecutionToken:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('task-service 不再自己编造「外部取消」文案，也不再有内联的 cancelled 分支', () => {
    const src = readSrc('packages/org-manager/src/task-service.ts');
    expect(src).not.toContain('Task execution cancelled externally');
    expect(src).not.toContain('Task preempted by higher-priority item');
    // 处置点唯一：preempted / cancelled 都路由到 handleExecutionStopped。
    expect(src).toContain('handleExecutionStopped');
  });

  it('状态迁移导致的收尾标记为 lifecycle（而非“外部取消”）', () => {
    const src = readSrc('packages/org-manager/src/task-service.ts');
    expect(src).toContain("cancelExecutionToken(token, 'lifecycle')");
    expect(src).toContain("cancelExecutionToken(liveExec.cancelToken, 'superseded')");
  });

  it('打回只写一处：requestRevision 不再往 task.notes 里写正文副本', () => {
    const src = readSrc('packages/org-manager/src/task-service.ts');
    // 旧实现的原文（notes 全文 + 硬编码 Review System 署名）不得再出现。
    expect(src).not.toContain('Revision requested (round ${task.executionRound}): ${reason}');
    expect(src).not.toContain("authorName: 'Review System'");
  });
});

// ── 行为回归：lifecycle 收尾不得产生用户可见注记 ────────────────────────────

const AGENT = 'agent-a';
const REVIEWER = 'reviewer-1';

function createAgentManager(stopReason: ExecutionStopReason | null) {
  const agent = {
    config: { name: 'Worker Agent', orgId: 'org-1', agentRole: 'worker' },
    enqueueToMailbox: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    injectUserMessage: vi.fn(),
    sendSessionReply: vi.fn().mockResolvedValue('ok'),
    dropStaleStatusUpdates: vi.fn(),
    getState: vi.fn(() => ({ status: 'busy', activeTaskCount: 1 })),
    sendTaskExecution: vi.fn(async (
      _taskId: string,
      _desc: string,
      logFn: (entry: { type: string; content: string; persist?: boolean; metadata?: unknown }) => Promise<void>,
    ) => {
      await logFn({ type: 'status', content: 'started', persist: true });
      if (stopReason) {
        await logFn({ type: 'status', content: 'cancelled', persist: true, metadata: { stopReason } });
      } else {
        await logFn({ type: 'status', content: 'execution_finished', persist: true });
      }
    }),
  };
  const reviewer = {
    ...agent,
    config: { name: 'Reviewer Agent', orgId: 'org-1', agentRole: 'manager' },
  };
  return {
    hasAgent: vi.fn((id: string) => id === AGENT || id === REVIEWER),
    getAgent: vi.fn((id: string) => (id === AGENT ? agent : reviewer)),
    listAgents: vi.fn(() => [{ id: AGENT }]),
  };
}

function createService(stopReason: ExecutionStopReason | null) {
  const agentManager = createAgentManager(stopReason);
  const svc = new TaskService();
  svc.setGovernancePolicy({
    enabled: false,
    defaultTier: 'auto',
    maxPendingTasksPerAgent: 100,
    maxTotalActiveTasks: 100,
    requireApprovalForPriority: [],
    requireRequirement: false,
    rules: [],
  } as never);
  svc.setAgentManager(agentManager as never);
  svc.setWSBroadcaster({ broadcast: vi.fn(), broadcastTaskCreate: vi.fn(), broadcastTaskUpdate: vi.fn() } as never);
  return { svc, agentManager };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('行为回归：执行停止的原因决定注记', () => {
  let svc: TaskService;

  afterEach(() => {
    svc?.stopTimeoutChecker();
    vi.restoreAllMocks();
  });

  it('lifecycle 收尾（提交评审 / 状态迁移）不写任何"外部取消/将自动恢复"注记', async () => {
    ({ svc } = createService('lifecycle'));
    const task = svc.createTask({
      orgId: 'org-1', title: 'T', description: 'd',
      assignedAgentId: AGENT, reviewerId: REVIEWER, creatorRole: 'human',
    } as never);
    svc.approveTask(task.id, 'user-1');
    await sleep(150);

    const notes = (svc.getTask(task.id)!.notes ?? []).join('\n');
    expect(notes).not.toContain('cancelled externally');
    expect(notes).not.toContain('自动恢复');
  });

  it('user_stop（真外部中断）仍然如实记录，并说明恢复计划', async () => {
    ({ svc } = createService('user_stop'));
    const task = svc.createTask({
      orgId: 'org-1', title: 'T', description: 'd',
      assignedAgentId: AGENT, reviewerId: REVIEWER, creatorRole: 'human',
    } as never);
    svc.approveTask(task.id, 'user-1');
    await sleep(150);

    const notes = (svc.getTask(task.id)!.notes ?? []).join('\n');
    expect(notes).toContain('用户手动停止');
  });
});
