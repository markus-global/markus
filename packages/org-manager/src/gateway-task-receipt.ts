/**
 * Gateway `createTask` delivery record — the enqueue shape as **one production function**.
 *
 * 第六刀 C2 / §2.3 投递点 2：外部网关建任务时同时写一条**带信封**的投递记录。
 * 形状选 `task_status_update` + `intent='deliver'`：它是 record 类（`invokesLLM=false`），
 * 不会凭空多烧一个 LLM 回合；但它把“谁建了这活、发给谁”落成可查的一行（I4 任务链路）。
 *
 * 为什么抽成函数（C9 相邻路径）：
 * 这条入队的身份裁决（`refOrigin: 'platform-internal'`）原先写死在 `api-server.ts` 的
 * 闭包里，只能靠**阅读**判定它对不对，没有可执行契约。抽成导出函数后，测试直接调用
 * **生产代码**（而不是复制一份 options 形状）—— 夹具才咬得住：删掉那句表态，用例变红。
 *
 * 身份裁决（为何是 `platform-internal` 而不是 `pending-link`）：
 * - 创建瞬间还没有 WorkUnit；第一份 WU（`task_<id>_r1`）是执行开始时创建、并挂到**执行那条
 *   item** 上的，与本回执行记录无关；
 * - 没有任何路径会回链这一行（`linkMailboxItem` 的调用方只认执行 / 投递链路）；
 * - 任务实体的关联是**结构承载**的：`envelope.messageId = gateway-task:<id>` + `metadata.taskId`。
 * 声明 `pending-link` 等于承诺一个没人履行的链接 —— 那是谎报，不是表态。
 */
import { agentAddressRef, type MailboxItemType, type MailboxPayload } from '@markus/shared';
import type { EnqueueOptions } from '@markus/core';

/** 回执行投递记录只需要 assignee 的这一个能力（`Agent.enqueueToMailbox` 的形状）。 */
export interface GatewayTaskReceiptTarget {
  enqueueToMailbox(
    sourceType: MailboxItemType,
    payload: MailboxPayload,
    options?: EnqueueOptions,
  ): unknown;
}

export interface GatewayCreatedTask {
  id: string;
  title: string;
}

export interface GatewayCreateTaskRequest {
  description?: string | null;
  createdBy?: string;
}

/**
 * 写一条「网关创建了任务 X」的投递记录。
 *
 * @param assignee 被指派的 agent（未解析到时为 `undefined` → 不写记录，调用方不因此失败）
 * @returns `true` = 已入队；`false` = 没有 assignee（无记录可写）
 */
export function enqueueGatewayTaskReceipt(
  assignee: GatewayTaskReceiptTarget | undefined,
  task: GatewayCreatedTask,
  req: GatewayCreateTaskRequest,
): boolean {
  if (!assignee) return false;
  assignee.enqueueToMailbox(
    'task_status_update',
    {
      summary: `Task created via gateway: ${task.title}`,
      content: req.description ?? task.title,
      taskId: task.id,
    },
    {
      intent: 'deliver',
      metadata: { taskId: task.id },
      // 见文件头：这一行是回执，不是待链接事实。
      refOrigin: 'platform-internal',
      origin: {
        from: agentAddressRef(req.createdBy ?? 'gateway'),
        // 任务创建事件的身份 = 该任务本身（同一任务重投不产生第二条记录）。
        messageId: `gateway-task:${task.id}`,
        subject: `Task created: ${task.title}`,
      },
    },
  );
  return true;
}
