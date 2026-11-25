/**
 * 跨仓库 slug 契约向量表（markus 侧副本）。
 *
 * 同一条 slug 规则活在两个仓库，而它们无法共享代码：
 *   · markus-hub  负责**生成**：`sanitizeOrgSlug` / `orgSlugWithSuffix`
 *   · markus      负责**校验与本地占位**：`address.ts#checkOrgSlug`、
 *                 `storage#registryOrgSlug`
 * 跨仓唯一能共享的是**数据**。两个仓库各存一份本表，各自断言自己那一侧：
 *   · hub    断言 `sanitizeOrgSlug(input, 'org') === expected`
 *   · markus 断言 `checkOrgSlug(expected).ok === true`（本文件旁边那条测试）
 * 任一侧改了规则，它那一侧必红；要让另一侧也跟上，只能显式同步本表 ——
 * 而同步本表就是一次显式契约变更。
 *
 * 对应文件：markus-hub `src/server/helpers/org-slug-vectors.ts`
 * 同步义务：改这里必须同步改那边（反之亦然），否则两端会静默分叉。
 *
 * 期望值是人工判定的语义（合法、确定、结构保留），不是任何一侧实现的快照。
 */

export interface OrgSlugVector {
  input: string;
  expected: string;
  why: string;
}

export const ORG_SLUG_VECTORS: OrgSlugVector[] = [
  { input: 'Acme Corp', expected: 'acme-corp', why: '空格折叠成连字符（地址段唯一合法分隔符）' },
  { input: 'Acme', expected: 'acme', why: '大小写归一' },
  { input: 'acme', expected: 'acme', why: '已合法则原样返回（幂等）' },
  { input: 'ACME-Corp-2024', expected: 'acme-corp-2024', why: '保留数字与连字符结构' },
  { input: 'a---b', expected: 'a-b', why: '连续连字符折叠（禁止 doubled hyphen）' },
  { input: '  spaced  name  ', expected: 'spaced-name', why: '首尾与额外空白不进入 slug' },
  {
    input: 'org_default',
    expected: 'orgdefault',
    why: '下划线不是地址段合法字符（旧 slug 不可寻址的根因）；删除而非替换为连字符',
  },
  { input: 'Org_Default', expected: 'orgdefault', why: '同上（大小写不改变结论）' },
  {
    input: '中文公司',
    expected: 'org',
    why: '非拉丁名称无法转成合法段 → 回落调用方给的 fallback，绝不产出空串或非法段',
  },
  { input: '!!!', expected: 'org', why: '纯符号同样回落 fallback' },
  {
    input: '1password',
    expected: 'org',
    why: '地址段必须以字母开头；数字开头整体不合法 → 回落 fallback，而不是删掉首字符猜一个名字',
  },
  {
    input: 'a'.repeat(60),
    expected: 'a'.repeat(30),
    why: '截断到 MAX_ORG_SLUG_LENGTH=30（地址 org 段上限），截断后尾部连字符被去掉',
  },
];

export interface OrgSlugSuffixVector {
  base: string;
  n: number;
  expected: string;
  why: string;
}

/**
 * 冲突消解向量。存在的唯一理由：hub 侧曾用
 * `sanitizeOrgSlug(`${base}-${n}`)` 做重试，长 base 的后缀被截断掉 →
 * 候选恒等于 base → 唯一性循环死循环（请求挂死）。
 * 因此断言必须包含 29/30 字符的 base —— 短 base 修复前后都绿，咬不住缺陷。
 */
export const ORG_SLUG_SUFFIX_VECTORS: OrgSlugSuffixVector[] = [
  { base: 'acme', n: 1, expected: 'acme-1', why: '短 base 保留可读性' },
  { base: 'acme', n: 35, expected: 'acme-z', why: '后缀用 36 进制，序号增大时字符不失控（35 → z）' },
  {
    base: 'a'.repeat(29),
    n: 1,
    expected: `${'a'.repeat(28)}-1`,
    why: '29 字符 base：后缀必须挤进 30 字符预算（room=28），否则候选==base',
  },
  {
    base: 'a'.repeat(30),
    n: 1,
    expected: `${'a'.repeat(28)}-1`,
    why: '30 字符 base：同上，这是修复前必然挂死的那一档',
  },
];
