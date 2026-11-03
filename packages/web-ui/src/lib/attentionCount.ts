/**
 * 「概览待办数」的唯一发布/订阅通道。
 *
 * 背景（Owner 2026-11-02 发现）：同一件事曾有三个口径 ——
 *   · 桌面侧栏「概览」徽标：未读通知 + 待批审批
 *   · 概览行动台：待批审批 + 阻塞异常 + 等你回话
 *   · 移动端底栏「概览」徽标：**只算未读通知**
 * 结果是移动端永远不显示数字（用户通知全读完了，待批在审批表里，不在通知里）。
 *
 * 现在只有一个计算点：概览页的 actionItems.length。它算完就发布，
 * 侧栏与底栏只订阅、不自己算 —— 想加一类待办，只需要改概览那一处。
 *
 * 为什么用 localStorage 存一份：应用可以直接深链到 Team/Work 页，
 * 那时概览还没挂载，徽标至少要显示上一次已知的数字，而不是闪成 0。
 */

const STORAGE_KEY = 'markus_attention_count';
const EVENT = 'markus:attention-count';

export function publishAttentionCount(count: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(count));
  } catch {
    /* 隐私模式下 localStorage 可能不可用 —— 事件仍然有效 */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { count } }));
}

export function readAttentionCount(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const n = raw === null ? 0 : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function subscribeAttentionCount(cb: (count: number) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ count?: number }>).detail;
    cb(typeof detail?.count === 'number' ? detail.count : readAttentionCount());
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
