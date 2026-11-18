/**
 * 无主信号的目的地：每个 agent **一条**永久 Loop 会话（M2）。
 *
 * 旧行为：`resolveTarget` 无主时回退成 `sys_<agent>_<ts>`（或 `comment_unknown_<ts>`）——
 * 每来一条就开一条谁都不认的会话，既让 agent 「失忆」，又让「这件事该由谁判断」
 * 这个问题永远没人回答。现在所有无主信号落同一条会话，由 Loop 在下一轮醒来统一裁决。
 *
 * 它是**会话身份**的扩展，不是新机制：仍然是 `resolveTarget` 的 `null` 分支，
 * 只是落点从「新开一条」变成「固定的那条」。
 */
export const LOOP_SESSION_PREFIX = 'loop_';

export function loopSessionId(agentId: string): string {
  return `${LOOP_SESSION_PREFIX}${agentId}`;
}

export function isLoopSession(sessionId: string | undefined): boolean {
  return !!sessionId && sessionId.startsWith(LOOP_SESSION_PREFIX);
}

/**
 * 会话去向的**唯一判定点**（Forever Loop 重构 · M1）。
 *
 * ─── 这个模块解决什么问题 ───────────────────────────────────────────────
 *
 * 一条信号该落进哪条会话？
 *
 * 在 M1 之前，这个答案散落在 `agent.ts` 的 dispatch switch 里 —— 八处各自拼
 * `sessionId` 模板（`mention` / `requirement_update` / `requirement_comment` /
 * `workflow_update` / `task_comment` / `review_request` / `a2a_message` / 各类
 * `sys_` 系统信号）。同一条信号因此有多个「去向」认知，改一处漏一处。
 *
 * 更贵的是：其中一半模板是 **凭空开一条会话** —— `sys_<agentId>_<ts>` 这种。
 * 它就是两类长期病症的共同根因：
 *   1. **agent 失忆**：同一个来源的消息因为时间戳不同而各开一条会话，多轮往来
 *      读不到上文（`a2a_<agentId>_<ts>` 曾让每次 a2a 都失忆，已有历史修正记录）。
 *   2. **Loop 无事可做 / 又有无穷杂事**：没有归属的信号被塞进一条谁都不认的会话，
 *      于是「这件事该由谁判断」这个问题从来没人回答过。
 *
 * 现在只有一个纯函数回答它。返回 `null` = **这条信号没有归属** = 交给 Loop 判断。
 *
 * ─── 为什么必须是纯函数 ─────────────────────────────────────────────────
 *
 * 纯函数才能被穷举测试，也才不会偷偷变成第二写者。所有 I/O 事实（正在跑的回合、
 * a2a 对话是否在等待回复、频道键）都由**调用方**解析后作为入参传进来。
 *
 * 这同时是缓存友好的前提：同一个信号在任何时刻、任何调用点，产出的 `sessionId`
 * **字节完全一致**（时间戳由调用方给一次，不在函数内自取）。
 */

import { WORK_UNIT_REF, type MailboxItemType } from '@markus/shared';

/**
 * 一条信号里与「去向」有关的全部结构事实。
 *
 * 只放**结构字段**，不放从载荷文本推断出来的东西 —— 从载荷推断结构是一类反复
 * 重犯的错误（R3'）。`a2aConversationId` 由调用方从载荷里解析 `[conversation:x]`
 * 后传入，属于「解析结果作为结构事实」，不是本函数再去推断。
 */
export interface SignalTargetInput {
  sourceType: MailboxItemType;
  /** 信封意图。`trigger_execution` = 真的要让 agent 动起来；`deliver` = 默认。 */
  intent?: 'deliver' | 'trigger_execution' | 'action_required';
  agentId: string;

  /**
   * 「启动 = rest 刚结束」的显式声明：这条唤醒归 Loop 判断，不进 `sys_` 一次性会话。
   *
   * 为什么不靠 sourceType 区分：同样是 `system_event`，平台告警要落 sys 会话，
   * 而启动唤醒要落 Loop。形状一样、去向不同 —— 所以必须由**生产者显式表态**，
   * 不能由类型名替它猜。
   */
  forceLoopSession?: boolean;

  /** 结构性实体 —— 三者之一存在，这条信号才算「有归属」。 */
  taskId?: string;
  requirementId?: string;
  /** a2a 对话身份（`[conversation:x]` 里的 x）。同一条对话必须落同一会话。 */
  conversationId?: string;

  /** 评审轮次。同 (agent, task, round) 必须复用同一会话（缓存友好 + 不失忆）。 */
  round?: number;
  /** workflow 事件名（`completed` / `started` …）。仅用于会话 id 的稳定命名。 */
  workflowEvent?: string;

  /**
   * 调用方已解析出的「已有会话」事实（I/O 结果传进来，保持本函数纯）。
   * 命中即直通，优先级高于本函数自己拼的模板。
   */
  /** 正在跑的任务回合的会话 id（来自在飞登记，不是在飞的就没有）。 */
  liveTaskSessionId?: string;
  /** a2a 回复应落回的原会话（`reply_in_session` 的发起线程）。 */
  a2aOriginSessionId?: string;
  /** 频道会话 id（群聊/DM 的稳定频道键派生）。 */
  channelSessionId?: string;
  /** `session_reply` 的来处会话。 */
  originSessionId?: string;

  /** 单调时间戳（毫秒）。**由调用方给一次**，函数内不自取 —— 保证同输入同输出。 */
  ts: number;
}

/** 会话的种类。决定提示词场景（scenario）与是否复用/新开。 */
export type SessionTargetKind =
  /** 任务执行回合（在飞时注入，不新开） */
  | 'task_execution'
  /** 任务的评论回复回合 */
  | 'task_comment'
  /** 任务评审回合 */
  | 'task_review'
  /** 需求相关回合（动作请求 / 评论回复） */
  | 'requirement'
  /** workflow 动作回合 */
  | 'workflow'
  /** agent 间对话回合 */
  | 'a2a'
  /** 人机会话（由会话绑定层解析，不在本函数拼 id） */
  | 'human_chat'
  /** 会话内回复（落回原会话） */
  | 'session_reply'
  /** 异步回调 */
  | 'callback'
  /** 平台内部系统动作 */
  | 'system';

export interface SessionTarget {
  kind: SessionTargetKind;
  /** 会话 id。同一信号的稳定结论（时间戳由调用方固定）。 */
  sessionId: string;
  /** 有归属时，它归属的实体 id（便于上游做台账与去重）。 */
  entityId?: string;
  /** 任务类会话携带的 taskId（评审/执行/评论共用）。 */
  taskId?: string;
  round?: number;
}

/**
 * 唯一去向判据。
 *
 * 返回 `SessionTarget` = 有明确去向；返回 `null` = 没有归属，交给 Loop。
 *
 * 今天返回 `null` 的情形（全部是「没有实体」）：
 *   - `mention`：@ 一条任务评论但信封里没有 taskId
 *   - `task_comment`：评论不带 taskId
 *   - `workflow_update`：没有可命名的 workflow 事件
 *   - `a2a_message`：既无对话身份、也无原会话、也无频道
 *   - `heartbeat`：物理巡逻，不产生会话
 *
 * 注意 `human_chat` / `session_reply` / `callback_result` 是**有归属**的：它们的
 * 会话由绑定层给出（人 ↔ 会话是一对一，回调 ↔ 发起者是一对一），不是凭空开的。
 * 调用方拿不到绑定 = 数据不一致，应当报错而不是在这里编一个。
 */
export function resolveTarget(input: SignalTargetInput): SessionTarget | null {
  const { agentId, ts } = input;
  const systemSessionId = `sys_${agentId}_${ts}`;

  // 「启动 = rest 刚结束」—— 启动唤醒显式声明归 Loop 判断，不进 sys_ 一次性会话。
  // 这是 Loop 的**真实入口**：否则它只能等一条罕见信号（无归属 mention / 孤儿 a2a），
  // 而那些形态在生产里根本不出现 —— “永久 Loop”就成了纸面设计。
  if (input.forceLoopSession) return null;

  switch (input.sourceType) {
    // ── 人机 / 会话内回复 / 回调：身份来自绑定层，本函数只标注 kind ──────────
    case 'human_chat':
      // 会话 id 由 `resolveTurnSession()`（绑定层）决定；这里不自拼 id。
      // 用 agent 的当前会话占位，调用方必须以绑定层结果为准。
      return {
        kind: 'human_chat',
        sessionId: input.channelSessionId ?? systemSessionId,
      };

    case 'session_reply':
      return {
        kind: 'session_reply',
        sessionId: input.originSessionId ?? systemSessionId,
      };

    case 'callback_result':
      return {
        kind: 'callback',
        sessionId: input.originSessionId ?? systemSessionId,
      };

    // ── 任务执行 ────────────────────────────────────────────────────────────
    case 'task_status_update': {
      const taskId = input.taskId;
      if (!taskId) return null;
      // 执行回合的会话 id = 执行身份，**唯一建造者**是 `WORK_UNIT_REF.task()`。
      // 在飞登记有值就直接用它；没登记时用那个建造者重建。
      // 轮次的唯一合法缺省点在派发侧（TaskService「从未执行过 = 第 1 轮」）——
      // 这里替它猜 `round ?? 1` 就是第二个写者，所以缺轮次时**明确不猜**：
      // 拿不到执行身份就不开新会话，交给 Loop 裁决。
      const live = input.liveTaskSessionId;
      const round = input.round;
      if (live) {
        return {
          kind: 'task_execution',
          sessionId: live,
          entityId: `task:${taskId}`,
          taskId,
          round,
        };
      }
      if (round === undefined) return null;
      return {
        kind: 'task_execution',
        sessionId: WORK_UNIT_REF.task(taskId, round),
        entityId: `task:${taskId}`,
        taskId,
        round,
      };
    }

    // ── 任务评论：在飞则注入同一会话，否则为这条任务开评论回合 ────────────────
    case 'task_comment': {
      const taskId = input.taskId;
      if (!taskId) return null; // 没 taskId = 评论没有归属 → Loop
      if (input.liveTaskSessionId) {
        return {
          kind: 'task_execution',
          sessionId: input.liveTaskSessionId,
          entityId: `task:${taskId}`,
          taskId,
          round: input.round,
        };
      }
      return {
        kind: 'task_comment',
        sessionId: `comment_${taskId}_${ts}`,
        entityId: `task:${taskId}`,
        taskId,
      };
    }

    // ── 任务评审：同 (agent, task, round) 稳定复用会话 ────────────────────────
    case 'review_request': {
      const taskId = input.taskId;
      if (!taskId) return null;
      const roundSuffix = input.round === undefined ? '' : `_r${input.round}`;
      return {
        kind: 'task_review',
        sessionId: `review_${agentId}_${taskId}${roundSuffix}`,
        entityId: `task:${taskId}`,
        taskId,
        round: input.round,
      };
    }

    case 'mention': {
      // @ 到一条任务评论：带了 taskId 才是有归属的（落该任务的评论回合）。
      const taskId = input.taskId;
      if (!taskId) return null;
      return {
        kind: 'task_comment',
        sessionId: `comment_${taskId}_${ts}`,
        entityId: `task:${taskId}`,
        taskId,
      };
    }

    // ── 需求 ────────────────────────────────────────────────────────────────
    case 'requirement_update': {
      const requirementId = input.requirementId;
      if (!requirementId) return null;
      // 「要不要真的跑一个回合」是**策略**（`routeMailboxItem` 的 `invokesLLM` +
      // 信封 `intent`），不是「去向」。本函数只回答会话身份 —— 把两者混在一起，
      // `null` 就会同时表示「没归属」和「不需要回合」两件事，而那正是要消灭的
      // 「一个信号答两个问题」。调用方按 intent 决定用不用这个会话。
      return {
        kind: 'requirement',
        sessionId: `requirement_${requirementId}_${ts}`,
        entityId: `req:${requirementId}`,
      };
    }

    case 'requirement_comment': {
      const requirementId = input.requirementId;
      if (!requirementId) return null;
      return {
        kind: 'requirement',
        sessionId: `comment_${requirementId}_${ts}`,
        entityId: `req:${requirementId}`,
      };
    }

    // ── workflow ────────────────────────────────────────────────────────────
    case 'workflow_update': {
      // 同上：是否开回合由调用方按 intent 判定；这里只给会话身份。
      const event = input.workflowEvent;
      if (!event) return null;
      return {
        kind: 'workflow',
        sessionId: `workflow_${event}_${ts}`,
        entityId: `workflow:${event}`,
      };
    }

    // ── agent 间 ────────────────────────────────────────────────────────────
    case 'a2a_message': {
      // 优先级：回复原会话 > 频道 > 对话身份 > 无归属。
      // 对话身份必须优先于时间戳兜底 —— 否则多轮协作彼此失忆（历史事故）。
      if (input.a2aOriginSessionId) {
        return {
          kind: 'a2a',
          sessionId: input.a2aOriginSessionId,
          entityId: input.conversationId ? `a2a:${input.conversationId}` : undefined,
        };
      }
      if (input.channelSessionId) {
        return {
          kind: 'a2a',
          sessionId: input.channelSessionId,
          entityId: input.conversationId ? `a2a:${input.conversationId}` : undefined,
        };
      }
      if (input.conversationId) {
        return {
          kind: 'a2a',
          sessionId: `a2a_${agentId}_${input.conversationId}`,
          entityId: `a2a:${input.conversationId}`,
        };
      }
      return null; // 孤立 a2a 消息：没有对话身份 → Loop 决定（而不是凭空开一条）
    }

    // ── 平台内部 ────────────────────────────────────────────────────────────
    case 'heartbeat':
      return null; // 物理巡逻：不产生会话，也永远不该唤醒 Loop

    case 'system_event':
    case 'daily_report':
    case 'memory_consolidation':
      return {
        kind: 'system',
        sessionId: systemSessionId,
      };

    default:
      // 未知类型：保守 —— 当作无归属，交给 Loop（绝不静默丢弃，也不瞎猜会话）。
      return null;
  }
}

