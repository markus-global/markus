/**
 * 「概览首屏待办」的唯一派生函数：`GET /api/threads` 的行 → 行动台条目。
 *
 * ── 为什么从 Home.tsx 里搬出来 ────────────────────────────────────────────
 *
 * 判据「API 返回序 == 概览首屏渲染序」需要一个**可直接断言的中间量**。当这段映射
 * 埋在 1400 行的页面组件里时，唯一能验的办法是整页渲染（要 mock 十几个接口），
 * 于是没人会写这个断言，而不写断言的契约等于不存在。搬成纯函数后，
 * `actionItems.parity.test.ts` 可以把同一份 `/api/threads` 响应同时喂给两侧，
 * 逐条比对 id 序列。
 *
 * ── 两条纪律 ────────────────────────────────────────────────────────────
 *
 *  1. **顺序不是这里决定的**：本函数按输入顺序产出（`threads` 已经由 `orderTodos`
 *     排好），不得再排一次 —— 排序的唯一写者是 `lib/todoOrder.ts`。
 *  2. **stage 原样带出**：行动项把 `stage` 一起交给行动台，排序才不必从 `kind`
 *     反推（那是同一事实的第二份映射）。
 */
import type { ApprovalInfo, ThreadAPI } from '../api.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';
import { STAGE_LABEL } from './threadPresentation.ts';
import { navigateForApproval } from './notifyNavigate.ts';
import type { ActionItem } from '../components/ActionCenter.tsx';

/** 只有 `person:*` 才是「在等我」。判据同 `InboxCard.isWaitingOnPerson`（不另写一份）。 */
const isWaitingOnPerson = (t: ThreadAPI): boolean => t.stage.startsWith('person:');

/**
 * `GET /api/threads` 的行 → 概览「要我动手」的条目，**保持输入顺序**。
 *
 * @param threads 已按 `orderTodos` 排好的流（顺序原样保留，本函数不排序）
 * @param agentNameMap agentId → 显示名，用于副标题
 */
export function buildActionItems(
  threads: readonly ThreadAPI[],
  agentNameMap: ReadonlyMap<string, string> = new Map(),
): ActionItem[] {
  const out: ActionItem[] = [];

  for (const th of threads.filter(isWaitingOnPerson)) {
    const owner = th.ownerAgent ? (agentNameMap.get(th.ownerAgent) ?? th.ownerAgent) : null;
    const title = th.title ?? th.ref;

    if (th.stage === 'person:approval') {
      // 跳转语义统一交给 lib/notifyNavigate：提问类会自动落到 Team Chat，
      // 而不是把它当成普通审批丢到任务页（那就是之前“跳得不对”的根因）。
      const pseudo = {
        id: th.approvalId ?? th.id,
        agentId: th.ownerAgent ?? undefined,
        agentName: owner ?? undefined,
        title,
        description: th.detail ?? '',
        requestedAt: new Date(th.lastActivity).toISOString(),
        details: th.ref.startsWith('tsk_')
          ? { taskId: th.ref }
          : th.ref.startsWith('req_')
            ? { requirementId: th.ref }
            : {},
      } as unknown as ApprovalInfo;
      out.push({
        id: th.id,
        ref: th.ref,
        kind: 'approval',
        title,
        meta: [owner, '待你批准'].filter(Boolean).join(' · '),
        detail: th.detail ?? undefined,
        // 优先级要**每一种**行动项都带上：排序的第 2 段键对四类待办一视同仁。
        // 曾经只有 review/blocked 带 priority，于是「同 stage 内紧急优先」这条契约
        // 对审批行静默失效（两条待批只能靠等待时长排）——契约只在某些行成立，
        // 就不是契约，是巧合。
        priority: th.priority ?? undefined,
        stage: th.stage,
        lastActivity: th.lastActivity,
        actionLabel: '去处理',
        onAction: () => navigateForApproval(pseudo),
      });
    } else if (th.stage === 'person:review') {
      out.push({
        id: th.id,
        ref: th.ref,
        kind: 'review',
        title,
        meta: [owner, '已提交待验收'].filter(Boolean).join(' · '),
        detail: th.detail ?? undefined,
        priority: th.priority ?? undefined,
        stage: th.stage,
        lastActivity: th.lastActivity,
        actionLabel: '去验收',
        onAction: () => navBus.navigate(PAGE.WORK, { openTask: th.ref }),
      });
    } else if (th.stage === 'person:blocked') {
      out.push({
        id: th.id,
        ref: th.ref,
        kind: 'blocked',
        title,
        meta: owner ? `卡在 ${owner}` : '需要人工介入',
        detail: th.detail ?? undefined,
        priority: th.priority ?? undefined,
        stage: th.stage,
        lastActivity: th.lastActivity,
        actionLabel: '查看',
        onAction: () => navBus.navigate(PAGE.WORK, { openTask: th.ref }),
      });
    } else if (th.stage === 'person:answer') {
      out.push({
        id: th.id,
        ref: th.ref,
        kind: 'thread',
        title,
        meta: owner
          ? `${owner} ${STAGE_LABEL['person:answer']!.label}`
          : STAGE_LABEL['person:answer']!.label,
        detail: th.detail ?? undefined,
        priority: th.priority ?? undefined,
        stage: th.stage,
        lastActivity: th.lastActivity,
        actionLabel: '去看',
        onAction: () => navBus.navigate(PAGE.TEAM),
      });
    }
  }

  return out;
}
