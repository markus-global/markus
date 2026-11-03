/**
 * 邮箱历史 → 按 thread（那件事）归并。
 *
 * ── 为什么必须做这一步（2026-11-03，Owner 指出）───────────────────────────
 * 「邮箱历史现在的呈现方式，有了 thread 之后，就不合理了。」
 *
 * 数据实测（生产库）：
 *   heartbeat            169134 行，带 taskId 的 0 行
 *   memory_consolidation   3028 行，带 taskId 的 0 行
 *   callback_result        5606 行，带 taskId 的 0 行
 *   task_comment           1729 行，带 taskId 的 1729 行（100%）
 *   mention                5549 行，带 taskId 的 4995 行
 *
 * 原来它是一张**投递流水**：把内部机械（心跳、记忆整理、回调）和真正的工作
 * （任务评论、@提及、评审请求）按时间平铺在一起。读者要在 17 万条噪声里
 * 找"这活干到哪了"。
 *
 * thread 的定义是「**一个实体上的连续性**」。所以正确的单位不是"一条投递"，
 * 而是"哪件事、它上面有多少动静、最近一次是什么"。
 *
 * ── 两条规则 ──────────────────────────────────────────────────────────────
 * 1. **内部机械不进历史**：心跳 / 记忆整理 / 回调结果 / 系统事件 不是「关于某件事
 *    发生过什么」，是 agent 自己的运转。它们属于诊断，不属于历史。
 * 2. **能落到实体的，按实体归并**：taskId → `tsk_*`；sessionId → `cs_*`。
 *    落不到实体的（如跨 agent 消息）不硬编，单列一组并如实标注。
 */

/** agent 自身运转产生的条目 —— 不是「某件事发生了什么」。 */
const MACHINERY_TYPES: ReadonlySet<string> = new Set([
  'heartbeat',
  'memory_consolidation',
  'callback_result',
  'system_event',
  'daily_report',
  'workflow_update',
]);

export interface MailboxLike {
  id: string;
  sourceType: string;
  status: string;
  queuedAt: string;
  payload?: { summary?: string; content?: string; taskId?: string; sessionId?: string; [k: string]: unknown } | null;
  metadata?: Record<string, unknown> | null;
}

export interface ThreadGroup {
  /** 归并键：`tsk_…` / `cs_…` / `a2a:…` / null（落不到实体） */
  ref: string | null;
  /** 这个键的展示名（由调用方用 threads 表补齐标题，缺则回退） */
  label: string;
  count: number;
  latestAt: string;
  latestSummary: string;
  /** 最近一次的状态（processing / done / dropped …） */
  latestStatus: string;
  /** 该组出现过的条目类型（去重，最多 3 个，供一眼判断性质） */
  kinds: string[];
}

/**
 * 一条 mailbox 条目归属哪条流（null = 落不到实体）。导出供调用方按 ref 过滤 ——
 * 「这件事收到过哪些投递」和「这些投递属于哪件事」必须是同一套解析，不能各写一份。
 */
export function refOf(item: MailboxLike): string | null {
  const p = item.payload ?? {};
  const raw = typeof p.taskId === 'string' ? p.taskId.trim() : '';
  if (raw) return raw.startsWith('tsk_') ? raw : `tsk_${raw}`;

  const sid = (typeof p.sessionId === 'string' ? p.sessionId : '') ||
    (typeof item.metadata?.['sessionId'] === 'string' ? String(item.metadata['sessionId']) : '');
  if (sid) return sid.startsWith('cs_') ? sid : `cs_${sid}`;

  const rid = typeof p.requirementId === 'string' ? p.requirementId.trim() : '';
  if (rid) return rid.startsWith('req_') ? rid : `req_${rid}`;

  return null;
}

/** 是否属于「内部机械」—— 不进历史。 */
export function isMachinery(item: MailboxLike): boolean {
  return MACHINERY_TYPES.has(item.sourceType);
}

/**
 * 归并。返回按「最近活动」倒序的组。
 *
 * @param history 邮箱历史（可能只是一页；调用方需如实说明「本页内」）
 * @param titleOf 可选：ref → 人类可读标题（来自 threads 表）
 * @param limit  最多返回多少组
 */
export function groupMailboxByThread(
  history: readonly MailboxLike[] | null | undefined,
  titleOf?: (ref: string) => string | undefined,
  limit = 12,
): ThreadGroup[] {
  const groups = new Map<string, ThreadGroup>();
  const orphans: ThreadGroup = {
    ref: null, label: '未关联到某件事', count: 0,
    latestAt: '', latestSummary: '', latestStatus: '', kinds: [],
  };

  for (const item of history ?? []) {
    if (isMachinery(item)) continue; // 规则 1

    const ref = refOf(item);
    const at = item.queuedAt;
    const summary = String(item.payload?.summary ?? item.payload?.content ?? '').slice(0, 200);

    let g = ref ? groups.get(ref) : orphans;
    if (ref && !g) {
      g = {
        ref,
        label: titleOf?.(ref) ?? ref,
        count: 0,
        latestAt: at,
        latestSummary: summary,
        latestStatus: item.status,
        kinds: [],
      };
      groups.set(ref, g);
    }
    if (!g) continue;

    g.count += 1;
    if (!g.kinds.includes(item.sourceType) && g.kinds.length < 3) g.kinds.push(item.sourceType);
    // 历史通常已按时间倒序；仍显式比较一次，避免依赖调用方顺序
    if (!g.latestAt || new Date(at).getTime() > new Date(g.latestAt).getTime()) {
      g.latestAt = at;
      g.latestSummary = summary;
      g.latestStatus = item.status;
    }
  }

  const out = [...groups.values()];
  if (orphans.count > 0) out.push(orphans);
  return out
    .sort((a, b) => new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime())
    .slice(0, limit);
}
