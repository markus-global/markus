/**
 * 右栏「本地文件自动刷新」的两条判据 —— 纯函数，可被单测直接问。
 *
 * 为什么抽出来：刷新逻辑写在组件 effect 里时，最容易出错的两种失败方式都**不会让
 * 既有测试变红**——
 *   ① 用户正在编辑时重读，把他刚打的字冲掉（最坏：可见的数据丢失）；
 *   ② 面板在后台还持续读盘（每次几十字节，但一直是「应用在偷偷干活」）。
 * 所以把「该不该探测」「内容是否真的变了」做成可断言的判据，而不是 effect 里的 if。
 */

/** 探测节流：stat 很便宜，5 秒一次足够让「agent 改完文件」几乎立刻可见。 */
export const FILE_AUTO_REFRESH_MS = 5_000;

export interface ProbeInput {
  /** 面板载荷的种类（file / deliverable / url / terminal …）。 */
  kind: string;
  /** 是否有一个真实可 stat 的本地路径。 */
  hasPath: boolean;
  /** 该载荷的引用是不是 URL（URL 不是本地文件，没有 mtime）。 */
  isUrlReference: boolean;
  /** 用户此刻是否正在编辑（有未保存改动）。 */
  editorDirty: boolean;
  /** 文档可见性。 */
  visibility: 'visible' | 'hidden' | 'prerender' | string;
}

/**
 * 这一轮该不该去 stat？
 *
 * 三条纪律按顺序：编辑中不碰 → 不可见不探测 → 只对本地文件类载荷探测。
 */
export function shouldProbeFileRefresh(input: ProbeInput): boolean {
  if (input.editorDirty) return false;                       // ① 绝不覆盖用户输入
  if (input.visibility !== 'visible') return false;          // ② 后台不读盘
  if (input.isUrlReference) return false;                    // ③ URL 没有 mtime，走自己的刷新
  if (!input.hasPath) return false;
  return input.kind === 'file' || input.kind === 'deliverable';
}

export interface FileStamp {
  mtimeMs?: number;
  size?: number;
}

/**
 * 内容是否真的变了。
 *
 * 只比 mtime + size：不读内容（重读很贵），也不猜。缺字段时按「无法判断」处理 ——
 * 返回 false，宁可不刷新，也不要把用户正在看的东西无故重渲染一遍。
 */
export function hasFileChanged(prev: FileStamp | null, next: FileStamp): boolean {
  if (!prev) return false;
  if (prev.mtimeMs === undefined || next.mtimeMs === undefined) {
    if (prev.size === undefined || next.size === undefined) return false;
    return prev.size !== next.size;
  }
  return prev.mtimeMs !== next.mtimeMs || prev.size !== next.size;
}
