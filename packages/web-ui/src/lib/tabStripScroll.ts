/**
 * 标签条「把活跃标签滚进真正可见的区间」的偏移量计算。
 *
 * 单独成纯函数的原因：右侧栏的新建按钮是 `sticky right-0` 的**覆盖层**。
 * 浏览器并不知道滚动视口右缘被一块不透明的按钮盖住了，`scrollIntoView({
 * inline: 'nearest' })` 会心安理得地把标签停在那块按钮底下 —— 用户点了新建 / 切换
 * 标签，结果看不见它。所以可见右界要手动扣掉按钮宽度，再用纯几何算偏移量。
 *
 * 返回值为 `scrollBy({ left })` 的入参（正数向右滚、负数向左滚，0 表示不用动）。
 */
export interface TabStripGeometry {
  /** 滚动视口（`[role=tablist]`）左右边界，来自 getBoundingClientRect。 */
  stripLeft: number;
  stripRight: number;
  /** 活跃标签左右边界。 */
  tabLeft: number;
  tabRight: number;
  /** 贴边按钮占掉的宽度（sticky 覆盖层），0 表示没有贴边按钮。 */
  reserved: number;
  /** 标签与视口边缘之间至少留出的空隙，默认 4px。 */
  edge?: number;
}

export function activeTabScrollDelta(g: TabStripGeometry): number {
  const edge = g.edge ?? 4;
  // 真正能看见的右界 = 视口右缘 - 覆盖层宽度。
  const visibleRight = g.stripRight - g.reserved;
  // 左缘优先：标签比可见区间还宽时，对齐左侧至少能看见标题开头。
  if (g.tabLeft < g.stripLeft + edge) return g.tabLeft - g.stripLeft - edge;
  if (g.tabRight > visibleRight - edge) return g.tabRight - visibleRight + edge;
  return 0;
}
