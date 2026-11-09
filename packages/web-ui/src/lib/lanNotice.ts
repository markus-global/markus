/**
 * 「已对局域网开放」顶部提示的已读状态。
 *
 * 语义：用户手动点过「关闭」即视为已知情，同一暴露状态下不再提示；
 * 但这不是「永久静音」——提醒的唯一目的是让人知道自己被暴露出去了，
 * 所以已读状态绑定在**被知情的那个 bindHost** 上：
 *   - 仍是 0.0.0.0    → 不再提示（用户已经知道）
 *   - 换成别的暴露地址 → 重新提示一次（暴露面变了，是新的知情事实）
 *
 * 这个文件是这条状态的**唯一写者**，App.tsx 不直接碰 localStorage key。
 */

const ACK_KEY = 'markus_lan_notice_acked';

interface KVStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * 取一个**确实可用**的键值存储。
 *
 * 不能直接信 `globalThis.localStorage`：它可能是一个形状不对的桩（Node 25 在
 * 未配置 `--localstorage-file` 时会装一个 setItem 不是函数的 experimental 全局，
 * 见本仓 vitest 的 web-ui 环境）。形状不对就退化到进程内存——那只影响跨重启，
 * 不影响当次会话内的行为，也绝不因为「存不下」而把提示永远藏起来。
 */
let memoryFallback: Map<string, string> | null = null;

function kv(): KVStore {
  try {
    const candidate = (globalThis as { localStorage?: Partial<KVStore> }).localStorage;
    if (
      candidate &&
      typeof candidate.getItem === 'function' &&
      typeof candidate.setItem === 'function' &&
      typeof candidate.removeItem === 'function'
    ) {
      return candidate as KVStore;
    }
  } catch {
    // 访问 localStorage 本身可能抛（隐私模式 / 沙箱 iframe）
  }
  memoryFallback ??= new Map<string, string>();
  const mem = memoryFallback;
  return {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => { mem.set(k, v); },
    removeItem: (k) => { mem.delete(k); },
  };
}

/** 当前暴露地址是否已被用户确认过（即不需要再提示）。 */
export function isLanNoticeAcknowledged(host: string): boolean {
  return kv().getItem(ACK_KEY) === host;
}

/** 记录用户已确认当前暴露地址。 */
export function acknowledgeLanNotice(host: string): void {
  kv().setItem(ACK_KEY, host);
}

/**
 * 是否需要展示该提示：正常代码路径只有「是新事实」才展示。
 * 单独导出便于行为测试直接断言判定，而不是去渲染整个 App。
 */
export function shouldShowLanNotice(exposed: boolean, host: string): boolean {
  return exposed && !isLanNoticeAcknowledged(host);
}

/** 测试专用：清掉已读状态（与 llmSettingsCache 的 __reset 同一约定）。 */
export function __resetLanNoticeForTests(): void {
  kv().removeItem(ACK_KEY);
}
