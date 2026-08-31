/**
 * streamResilience — 前端流式/轮询连接兜底（SS-2，F 域）。
 *
 * 核心目标：*流式输出 / 状态轮询* 在断连、provider 异常、服务进程重启时
 * 不死循环、不永久卡在「思考中」，并能自动恢复连接。
 *
 * 两个纯函数（不依赖 DOM/React，可直接单测）：
 *  1. createStreamWatchdog —— SSE 读循环的「空转看门狗」。
 *     服务端对 agent 消息流每 15s 发一次 heartbeat（见 org-manager/sse-handler.ts：
 *     heartbeatInterval: 15000），因此「长时间完全没有任何数据」只可能发生在
 *     连接已死（半开 TCP / 服务进程退出 / 网络中断）时，而非合法长任务执行期。
 *     看门狗据此安全地把卡死的 read() 抢救出来，避免「永久思考中」。
 *  2. exponentialBackoffDelay —— 带抖动的指数退避，供 WS/轮询重连使用。
 *     避免断连时所有客户端同时紧密重连（雷群效应），且退避封顶、可设重试上限。
 */

export const STREAM_WATCHDOG_DEFAULT_MS = 60_000; // 服务端 heartbeat 15s 的 4 倍余量
export const BACKOFF_DEFAULT_BASE_MS = 1000;
export const BACKOFF_DEFAULT_MAX_MS = 30_000;
export const BACKOFF_DEFAULT_MAX_ATTEMPTS = 30;

export interface StreamWatchdogOptions {
  signal: AbortSignal;
  /** 完全无任何流数据超过该毫秒数即判定连接死亡。默认 60_000。 */
  timeoutMs?: number;
  /** 连接被判死时回调（只会触发一次）。 */
  onStall?: () => void;
}

export interface StreamWatchdog {
  /** 每次成功读到一块数据（含 heartbeat）时调用，重置计时。 */
  bump(): void;
  /** 流正常结束 / 出错 / 主动停止时调用，清除计时器。 */
  stop(): void;
}

/**
 * 创建一个「空转看门狗」。在 SSE 读循环中每次拿到 chunk 后调用 bump()，
 * 若 timeoutMs 内没有任何 chunk 到达则触发 onStall()（仅一次）。
 *
 * - 合法长任务（工具执行数分钟）不会误杀：服务端 heartbeat 会持续 bump。
 * - 仅在连接真正死亡（无任何字节到达）时触发，用于把卡死的「思考中」抢救出来。
 */
export function createStreamWatchdog(opts: StreamWatchdogOptions): StreamWatchdog {
  const timeoutMs = opts.timeoutMs ?? STREAM_WATCHDOG_DEFAULT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fired = false;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const arm = () => {
    if (fired || opts.signal.aborted) return;
    clear();
    timer = setTimeout(() => {
      timer = null;
      if (fired || opts.signal.aborted) return;
      fired = true;
      opts.onStall?.();
    }, timeoutMs);
  };

  const onAbort = () => clear();
  opts.signal.addEventListener('abort', onAbort, { once: true });
  arm();

  return {
    bump(): void {
      // 只有计时器还挂着时才重置——已触发 or 已停止则不再重复计时。
      if (timer !== null) arm();
    },
    stop(): void {
      clear();
      opts.signal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * 带全抖动（full jitter）的指数退避延迟：delay = random(0, base * 2^attempt)，
 * 封顶 maxMs，且超过 maxRetries 后不再增长。返回「任务希望等待」的毫秒数。
 *
 * 例：
 *  exponentialBackoffDelay(0)  → [0, base] 之间随机
 *  exponentialBackoffDelay(2)  → [0, base*4] 之间随机（封顶 maxMs）
 */
export function exponentialBackoffDelay(
  attempt: number,
  opts?: {
    baseMs?: number;
    maxMs?: number;
    maxAttempts?: number;
    /** 注入随机源以便测试（默认 Math.random）。 */
    random?: () => number;
  },
): number {
  const base = opts?.baseMs ?? BACKOFF_DEFAULT_BASE_MS;
  const max = opts?.maxMs ?? BACKOFF_DEFAULT_MAX_MS;
  const maxAttempts = opts?.maxAttempts ?? BACKOFF_DEFAULT_MAX_ATTEMPTS;
  const rnd = opts?.random ?? Math.random;

  const capped = Math.min(attempt, Math.max(0, maxAttempts - 1));
  const window = Math.min(base * Math.pow(2, capped), max);
  return Math.floor(rnd() * window);
}
