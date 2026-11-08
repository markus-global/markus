/**
 * 「打开历史弹窗」的唯一请求通道（概览页消费）。
 *
 * 为什么需要它：桌端系统通知被点击时，主进程只知道「要打开通知相关界面」，
 * 而历史弹窗的开关状态住在概览页（Home）。点击常常伴随一次导航，请求到达时
 * 概览可能还没挂载 —— 直接 dispatch 一个 window 事件会丢在半空（删除铃铛后
 * 的 `markus:open-notifications` 就是这样：有人发、没人听）。
 *
 * 因此请求先落成一个 pending 标记：概览已挂载就立刻收到；未挂载则在它订阅
 * 的那一刻被消费。一个事实（用户要看历史）、一个执行点。
 */

type Listener = () => void;

const listeners = new Set<Listener>();
let pending = false;

/** Ask for the history modal to open (screen may not be mounted yet). */
export function requestHistoryModal(): void {
  pending = true;
  if (listeners.size === 0) return; // 概览未挂载：留着，等它订阅时消费
  pending = false;
  listeners.forEach((l) => l());
}

/** Subscribe a consumer (the Overview page). Honours a request that arrived early. */
export function subscribeHistoryModal(cb: Listener): () => void {
  listeners.add(cb);
  if (pending) {
    pending = false;
    cb();
  }
  return () => {
    listeners.delete(cb);
  };
}

/** Test-only: reset module state between cases (module state is process-wide). */
export function __resetHistoryModalForTest(): void {
  listeners.clear();
  pending = false;
}
