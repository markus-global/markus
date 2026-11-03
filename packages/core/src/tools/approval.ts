/**
 * 审批闸门：不可逆动作前必须过的一道关。
 *
 * 为什么需要这个函数，而不是让每处自己写 `if (ctx.requestApproval) { ... }`：
 * 那个写法在回调缺失时**静默放行**——于是「配置漏了」等价于「静默提权」。
 * 同一个结构错误曾在 5 个工具里各写了一遍：
 *   create_project / update_project / delete_project / package_install / hub_install
 * 这正是要收敛成单一实现的原因（同一不变量只能有一个执行点）。
 *
 * 语义：**fail-closed**。没有审批通道 ≠ 免于审批，而是「这个动作此刻无法被批准」，
 * 所以拒绝，并告诉调用方怎么才能做成。拒绝而不解释，只是又一条无解的报错。
 */

export interface ApprovalRequest {
  toolName: string;
  toolArgs: Record<string, unknown>;
  reason: string;
}

export interface ApprovalOutcome {
  approved: boolean;
  comment?: string;
}

export type ApprovalFn = (request: ApprovalRequest) => Promise<ApprovalOutcome>;

/**
 * 关闭时的提示必须能让人知道下一步做什么。
 * 只说「未配置审批通道」对调用方没有用——它不知道这是环境问题还是自己权限不够。
 */
export const NO_APPROVAL_CHANNEL_HINT =
  '此部署未接入审批通道（approvalHandler 未设置），该动作需要人批准才能执行，因此被拒绝（fail-closed）。' +
  '怎么办：① 在 Web UI 中由人直接操作；② 或为该 agent 配置 HITL 审批通道后重试。';

/**
 * 请求审批。返回 `approved: false` 时调用方必须**终止动作**。
 *
 * 唯一允许放行的来源是审批回调本身；本函数绝不会因为"没配回调"而放行。
 */
export async function requireApproval(
  fn: ApprovalFn | undefined,
  request: ApprovalRequest,
): Promise<ApprovalOutcome> {
  if (!fn) {
    return {
      approved: false,
      comment: `${NO_APPROVAL_CHANNEL_HINT}（动作：${request.toolName}）`,
    };
  }
  return fn(request);
}

/**
 * 把审批结果转成工具返回值。
 *
 * 返回 `null` = 允许继续执行；返回字符串 = 该字符串就是最终工具输出（已被拒）。
 * 存在的意义：让 5 处调用点的形状一致，避免有人回退成 `if (fn)` 那套。
 */
export async function approvalBlock(
  fn: ApprovalFn | undefined,
  request: ApprovalRequest,
  fallbackDeniedReason: string,
): Promise<string | null> {
  const { approved, comment } = await requireApproval(fn, request);
  if (approved) return null;
  return JSON.stringify({ status: 'rejected', reason: comment || fallbackDeniedReason });
}
