/**
 * 「谁可以让一个 Agent 启动」—— 唯一判据。
 *
 * ── 为什么需要这一层（Owner 2026-11-08）───────────────────────────────────
 * 要求：**停止之后，除非人类手动启动、或 Agent 自己发了审批等人回答，否则不得自行启动。**
 *
 * 旧实现里「停止」有两个事实源，而只有开机恢复读了持久化的那一个：
 *   · 运行时 `state.status === 'offline'` —— 崩溃、未启动、被停止，三者长得一模一样；
 *   · 持久 `agents.disabled` —— 只有人类按下停止按钮才写。
 * 于是 12 条启动路径里 11 条只看前者 —— Agent 之间一条 A2A 消息就能把人类刚停掉的
 * Agent 拉起来（`tools/a2a.ts`），或者管理 Agent 用 `agent_start` 工具做同样的事。
 *
 * 本模块把判据收敛成一个**纯函数**，让「能不能启动」这件事只有一个执行点、
 * 一种度量，并且可以在不构造 AgentManager 的情况下被表驱动测试覆盖。
 *
 * ── 判据契约（S0）────────────────────────────────────────────────────────
 * 只有两个动词（停止 / 启动）、两个作用域（单个 agent / 整个团队），没有第三态：
 *
 * | 目标状态                   | 含义           | 人启动（含启动整个团队） | boot | creation | agent-a2a | agent-tool | 未声明 |
 * |--------------------------|----------------|-------------------------|------|----------|-----------|------------|--------|
 * | `stoppedByHuman = true`  | **被人停掉的**  | ✅                      | ⛔   | ✅       | ⛔        | ⛔         | ⛔     |
 * | `stoppedByHuman = false` | **崩溃/未启动** | ✅                      | ✅   | ✅       | ✅（自愈）| ✅（自愈） | ✅     |
 *
 * 一句话：**Agent 可以把「坏掉的」拉回来，不能把「人类关掉的」打开；
 * 而人类自己（单个或整个团队）随时可以启动任何东西。**
 */

/**
 * 谁发起的启动。
 *
 * 必填（不是可选参数）：新增调用点若忘记声明原因，**编译失败** —— 这类
 * 「某个新路径悄悄绕过人类决定」的 bug 从此在结构上无法表达。
 */
export type StartCause =
  /** 人类在界面上点了启动/恢复 */
  | 'human'
  /** 服务重启后恢复（调用方必须已按 `disabled` 过滤） */
  | 'boot'
  /** 新建 Agent 后上线 */
  | 'creation'
  /** A2A 消息带 `wake_recipient` 触发的唤醒 */
  | 'agent-a2a'
  /** `agent_start` 工具（管理 Agent 拉起同团队成员） */
  | 'agent-tool'
  /**
   * 调用点没有声明原因。
   *
   * **故意归入「不允许启动人类停掉的 Agent」一侧（fail-closed）**：这比反过来安全得多 ——
   * 未来新增一条启动路径时，就算作者忘了声明原因，它也不可能静默推翻人类的停止决定；
   * 它只会被拒绝并给出可行动提示。
   */
  | 'unattributed';

/**
 * 允许启动「人类明确停止」的 Agent 的原因。
 *
 * 只有两种：人类自己点（`human`），以及新建（`creation`，新建的 Agent 不可能同时
 * 是「人类停掉的」）。
 *
 * `boot` **故意不在此列**：开机恢复必须自己先按 `disabled` 过滤。若某天它漏了过滤，
 * 这里会抛错而不是安静地推翻人类的决定 —— 错得响，好过错得静。
 */
const MAY_START_HUMAN_STOPPED: ReadonlySet<StartCause> = new Set<StartCause>(['human', 'creation']);

export type StartDecision =
  | { allowed: true; clearsHumanStop: boolean }
  | { allowed: false; code: 'AGENT_STOPPED_BY_HUMAN' };

/**
 * 判定一次启动是否被允许。
 *
 * @param cause          谁发起的
 * @param stoppedByHuman `agents.disabled === 1` 的读穿（人类意图，**不是**运行时 offline）
 * @param force          显式覆盖（UI 二次确认后的「连我停过的也启动」）
 */
export function decideStart(input: {
  cause: StartCause;
  stoppedByHuman: boolean;
  force?: boolean;
}): StartDecision {
  const { cause, stoppedByHuman, force } = input;

  // 没被人类停过：任何路径都可以启动。这正是要保留的自愈能力（崩溃/未启动）。
  if (!stoppedByHuman) {
    return { allowed: true, clearsHumanStop: cause === 'human' || cause === 'creation' };
  }

  // 被人类停过：只有人类自己、新建、或显式 force 可以。
  if (force || MAY_START_HUMAN_STOPPED.has(cause)) {
    return { allowed: true, clearsHumanStop: true };
  }

  return { allowed: false, code: 'AGENT_STOPPED_BY_HUMAN' };
}

/**
 * 被拒绝时抛出的错误。
 *
 * 带 `code` 供调用方分支（A2A 要把它翻译成结构化结果而不是 500），并带**可行动提示** ——
 * 越界时必须告诉 Agent 下一步能做什么，而不是让它猜为什么失败。
 */
export class AgentStoppedByHumanError extends Error {
  readonly code = 'AGENT_STOPPED_BY_HUMAN' as const;
  constructor(
    readonly agentId: string,
    readonly cause: StartCause,
  ) {
    super(
      `Agent ${agentId} was stopped by the human (cause: ${cause}). ` +
        'It will not start again unless a human starts it. ' +
        'If you need it running, ask the human with request_user_input.',
    );
    this.name = 'AgentStoppedByHumanError';
  }
}

/** 给人看的说明：停止按钮的 tooltip 与提示文案共用这一句，避免两处措辞漂移。 */
export const HUMAN_STOP_MEANING =
  'Stopped by the human. Only a human start (or answering its own approval/question) resumes it.';
