/**
 * 红线动作闸门 —— 执行路径上的**唯一**判定点。
 *
 * ── 它修的是什么 ──────────────────────────────────────────────
 * `gateAction(scope, autonomy)`（shared/types/thread.ts）语义完备，但生产代码
 * **零调用** —— 删除、对外发布、支付实际完全裸奔。更刺眼的是 `delete_project`
 * 的工具描述写着 "Always requires user approval"，而代码里没有任何东西兑现它。
 * 所以问题不是「忘了调用」，而是「动作分级不存在 → 闸门没有输入 → 想守规矩也守不了」。
 * 本文件与 `shared/types/action-class.ts` 一起把这个缺口补上。
 *
 * ── 判据为什么是「查 trusted」 ─────────────────────────────────
 * 红线的定义是「**任何**自主档位都不可自主」。于是判据可以写成一句可执行的话：
 *     gateAction(scope, 'trusted') === 'deny'
 * trusted 是最高档 —— 连它都被拒，说明拒绝来自 scope（admin），而不是来自授权不足。
 * 这样「红线」不需要成为新概念，它是既有闸门语义的一个推论。
 * 反过来，如果某天有人给 admin 开了口子，这里会自动跟着放开 —— 单一事实源，
 * 不会出现「闸门改了、红线表没改」的双写漂移。
 *
 * ── 为什么是「要人批」而不是「硬失败」 ─────────────────────────
 * 红线 = 不可**自主**，不等于永远做不到。人依然有权批准。
 * 硬失败会把 Agent 逼进死胡同（它无法求助），也会逼人把整个机制关掉 ——
 * 那是这类安全设施最常见的死法。所以拒绝路径必须通向人：
 *   有审批通道 → 发人工审批卡，批了就执行
 *   没有审批通道 → 明确拒绝 + 给出可行动的替代（用 request_user_input 问人）
 */

import { createLogger, classifyToolAction, gateAction, authorizeAction, type ActionClass, type AuthorizationResult, type Autonomy, type MandateState, type ResourceScope } from '@markus/shared';

const log = createLogger('action-gate');

/**
 * 一次工具调用的授权结论。
 *
 * `authz === null` **不是「放行」**，它的意思是「这次调用没有点名资源，资源域授权不适用」——
 * 平台实体（`tsk_…` / `proj_…`）由任务/需求/审查那条链授权，不是责任域。
 * 把两者混成一个 `allow` 会让「没有绑定」看起来像「已批准」。
 */
export interface ToolAuthorization {
  action: ActionClass;
  redLine: boolean;
  authz: AuthorizationResult | null;
}

/**
 * 工具调用的授权判定 —— 把「动作多难撤回」与「逐资源绑定 + 逐件事审批」合到一处。
 *
 * 为什么必须在这里合，而不是各自在调用点判：
 * `isRedLineTool()`（本文件）只看工具名，**完全不知道绑定**；`gateAction()` 只看
 * autonomy，**不看绑定授予的 scope 上限**。于是两个方向都能被绕过（A4）：
 *   ① 绑定 admin / autonomy=trusted 被当成「这件事批了」；
 *   ② 绑定只到 read、autonomy=auto 时，publish 动作被放行。
 * 合并后两者共用同一个 `authorizeAction()`（唯一判定点），本函数只负责把工具名翻译成
 * `actionScope`、把资源键翻译成绑定 + 审批状态。
 */
export function authorizeToolCall(params: {
  toolName: string;
  /** 这次调用点名的资源键；`undefined` = 不适用资源域授权 */
  resource?: string;
  /** 该 agent 在该资源上的绑定；`null` = 点名了资源但没有任何绑定 */
  binding?: { scope: ResourceScope; autonomy: Autonomy } | null;
  /** 逐件事审批状态的读取器（缺省 = none：不知道就是没批，不猜成已批） */
  mandateFor?: (resource: string, actionScope: ResourceScope) => MandateState;
  approver?: string;
}): ToolAuthorization {
  const action = classifyToolAction(params.toolName);
  // 红线 = 连最高档都过不去 ⟺ 拒绝来自动作本身（admin）。判据与 gateAction 同源。
  const redLine = gateAction(action.scope, 'trusted') === 'deny';

  if (params.resource === undefined) return { action, redLine, authz: null };

  const authz = authorizeAction({
    binding: params.binding ?? null,
    actionScope: action.scope,
    mandate: params.mandateFor?.(params.resource, action.scope) ?? 'none',
    resource: params.resource,
    approver: params.approver,
  });
  return { action, redLine, authz };
}

/**
 * 授权拒绝/只记录的结构化返回 —— Agent 看不到日志，只能靠返回值建模。
 *
 * 与 `redLineRefusal` 的分工：那个回答「这个动作类型永远要人批」，这个回答
 * 「**你**现在对**这块地**没这个权」。两者可以同时成立，但提示不同、解法不同，
 * 所以不合并 —— 合并后的提示只能写一半，agent 会照着错的半边去试。
 */
export function authorizationRefusal(
  toolName: string,
  action: ActionClass,
  authz: AuthorizationResult,
): string {
  const recordedOnly = authz.verdict === 'record-only';
  return JSON.stringify({
    status: recordedOnly ? 'recorded-only' : 'denied',
    code: recordedOnly ? 'AUTHORIZATION_OBSERVE' : 'AUTHORIZATION_DENIED',
    blockedTool: toolName,
    reasonCode: authz.code,
    scope: action.scope,
    reason: authz.reason,
    hint: authz.hint,
    note: recordedOnly
      ? 'observe 档的语义是「看得到、提建议、不代你动手」：判断已记录，动作未执行。'
      : '这是授权边界（谁有权做、做到哪一步），不是动作类型限制。换工具名 / 拆成多条命令都属于绕过。',
  });
}

/** 一次闸门判定的结果。 */
export interface GateDecision {
  /** 是否放行（true = 继续执行） */
  allow: boolean;
  /** 动作分级结果（放行时也有，供审计/日志使用） */
  action: ActionClass;
  /** 是否红线动作 */
  redLine: boolean;
}

/**
 * 纯判定：这个工具的动作是不是红线。
 *
 * 不做任何 IO、不碰审批通道 —— 便于单测与在任意上下文里复用。
 * 判定口径：**连 trusted 档都过不去** ⟺ 红线。
 */
export function isRedLineTool(toolName: string): GateDecision {
  const action = classifyToolAction(toolName);
  // 用最高档去探：若仍被判 deny，说明拒绝源自 scope 本身（admin），而非授权不足。
  const redLine = gateAction(action.scope, 'trusted') === 'deny';
  return { allow: !redLine, action, redLine };
}

/** 拒绝时返回给 Agent 的结构化结果 —— Agent 看不到日志，只能靠返回值建模。 */
export function redLineRefusal(toolName: string, action: ActionClass, opts?: {
  /** 是否已经尝试过人工审批且被拒 */
  deniedByHuman?: boolean;
  /** 人类拒绝时的备注 */
  comment?: string;
  /** 平台是否存在审批通道 */
  hasApprovalChannel?: boolean;
}): string {
  const deniedByHuman = opts?.deniedByHuman === true;
  const reason = deniedByHuman
    ? `人类明确拒绝了这次操作${opts?.comment ? `：${opts.comment}` : ''}。`
    : action.why;

  const hint = deniedByHuman
    ? '不要换个写法重试同一件事。如果确实需要，请先向人说明新的理由，再重新请求授权。'
    : opts?.hasApprovalChannel === false
      ? '当前会话没有人工审批通道。请用 request_user_input 向人说明你要做什么、为什么、影响范围，'
        + '由人决定是否亲自执行；不要试图绕过（换工具名、拆成多条命令都属于绕过）。'
      : '该动作需要人工确认。请用 request_user_input 说明你要做什么、为什么、影响范围。';

  return JSON.stringify({
    status: 'denied',
    code: 'RED_LINE_ACTION',
    blockedTool: toolName,
    scope: action.scope,
    reason,
    hint,
    note: '删除 / 对外发布 / 支付属于不可撤回动作，任何自主档位都不能自行执行。',
  });
}

/**
 * 记录一次红线判定。
 *
 * 单独抽出来是为了让「记录」与「判定」解耦：判定是纯函数，
 * 记录是副作用。审计要能回答「谁在什么时候想删什么」，
 * 而这个问题必须在**动手之前**就能答，事后补记等于没记。
 */
export function logRedLineDecision(params: {
  toolName: string;
  action: ActionClass;
  agentId: string;
  sessionId?: string;
  outcome: 'requested-approval' | 'approved' | 'denied-by-human' | 'no-channel';
}): void {
  log.warn('Red-line action intercepted', {
    tool: params.toolName,
    scope: params.action.scope,
    agentId: params.agentId,
    sessionId: params.sessionId,
    outcome: params.outcome,
    why: params.action.why,
  });
}
