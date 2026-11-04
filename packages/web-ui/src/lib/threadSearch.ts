/**
 * 全局流页的**检索**语义（B4）。
 *
 * 为什么把这段逻辑抽成纯函数：它决定了「这一页到底是什么」——
 * 输入是 ref（`tsk_…` / `tkt_…` / `agent:…` / `gh:o/r`）就**直接解析**成那条流，
 * 输入是关键词就在候选流里筛标题 / ref。这个判断如果写在 JSX 里，
 * 就只能靠「打开页面看一眼」验证，而语义退化（变回目录）不会被任何东西拦住。
 *
 * 判据（可测）：`looksLikeRef('登录超时') === false`，
 * `looksLikeRef('tsk_abc') === true`，`looksLikeRef('gh:acme/repo') === true`。
 */

/** 平台内置 id 前缀（`threadRefOf` 允许任何实体 id，这些是我们确定认识的）。 */
const PLATFORM_ID = /^(tsk|req|proj|tkt|apr|cs|a2a|thr|dlv|mbx|sub|agt|org|job|usr)_/i;

/**
 * 这段输入是不是一个「流标识」而不是搜索词。
 *
 * 两种合法形态：
 *   1. 平台内置 id：`tsk_…` / `tkt_…` / `agent:` 之外的 `agt_…` 等；
 *   2. 带命名空间前缀的外部资源键：`gh:acme/repo` / `xhs:brand_01` / `agent:agt_x`。
 * 判据是**结构**（前缀 + 冒号 + 非空局部名），不是白名单枚举 ——
 * 加一个来源不需要改这里（契约 H2：加实例 = 注册适配器，不改核心）。
 */
export function looksLikeRef(raw: string): boolean {
  const q = raw.trim();
  if (!q || /\s/.test(q)) return false;
  if (PLATFORM_ID.test(q)) return true;
  const i = q.indexOf(':');
  return i > 0 && i < q.length - 1;
}

/** 关键词是否命中一条流（标题 / ref / 详情，大小写不敏感）。 */
export function matchesThreadQuery(
  t: { ref?: string | null; title?: string | null; detail?: string | null },
  raw: string,
): boolean {
  const q = raw.trim().toLowerCase();
  if (!q) return false;
  return [t.ref, t.title, t.detail].some(v => typeof v === 'string' && v.toLowerCase().includes(q));
}
