/**
 * 守卫：**brand 作背景时，前景色只有一个事实源**（`--color-on-brand`）。
 *
 * 起因（2026-11-05，Owner 报）：mono（黑白）主题下 brand 底按钮白底白字、看不见。
 * 根因不是「漏了某几个按钮」，而是「brand 底色上的前景色」这个事实写在两个地方：
 *   1) 每个组件自己猜一个 `text-white`（175 处）；
 *   2) index.css 里一条 `html.mono .btn-primary, .bg-brand-600, .bg-brand-500`
 *      的逐个选择器补丁 —— 结构上不可能覆盖 hover/active、带透明度的变体
 *      （`bg-brand-600/90`）和以后新增的组件。
 * mono 把 brand-500..700 全映射成白色，于是凡是补丁没点到的位置就是白底白字。
 *
 * 现在只留一个写者：`--color-on-brand`（每套主题各定义一次），brand 底一律
 * `text-on-brand`。本文件的四条断言分别钉住：
 *   ① 五套主题都定义了这个 token（少一套 = 该类名在那一套里静默失效）；
 *   ② 它在**每一套主题 × 每一种承载文字的 brand 底色**上都真的可读（算对比度，
 *      不是文本快照 —— mono 回退成白 on 白会算出 1.00，必然红）；
 *   ③ 源码里不再有人硬编码极性（solid brand 底 + `text-white`/`text-black`）；
 *   ④ 旧的逐个选择器补丁不许回流。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webUiRoot = join(here, '..');
const srcDir = join(webUiRoot, 'src');
const cssPath = join(srcDir, 'index.css');

/* ── 主题解析 ─────────────────────────────────────────────────────────── */

/** 从 `selector` 的 `{` 起做花括号配平，返回块体（不含最外层花括号）。 */
function blockBody(css: string, selector: RegExp): string | null {
  const match = selector.exec(css);
  if (!match) return null;
  const open = css.indexOf('{', match.index + match[0].length - 1);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

/** 五套主题：默认（dark，@theme）、light、系统 light、cyberpunk、mono。 */
const THEMES: Array<{ name: string; selector: RegExp }> = [
  { name: 'default(dark) @theme', selector: /^@theme\s*\{/m },
  { name: 'html.light', selector: /^html\.light\s*\{/m },
  { name: 'system light (@media)', selector: /^@media \(prefers-color-scheme: light\)\s*\{/m },
  { name: 'html.cyberpunk', selector: /^html\.cyberpunk\s*\{/m },
  { name: 'html.mono', selector: /^html\.mono\s*\{/m },
];

function tokenValue(body: string, token: string): string | null {
  const m = new RegExp(`--color-${token}\\s*:\\s*([^;]+);`).exec(body);
  return m ? m[1]!.trim() : null;
}

/* ── oklch → 相对亮度 → WCAG 对比度 ────────────────────────────────────── */

function oklchLuminance(value: string): number {
  const m = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/.exec(value);
  if (!m) throw new Error(`unsupported colour (expected an oklch literal): ${value}`);
  const [L, C, h] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const rad = (h * Math.PI) / 180;
  const a = C * Math.cos(rad);
  const b = C * Math.sin(rad);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  const r = clamp(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s);
  const g = clamp(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s);
  const bl = clamp(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s);
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

function contrast(fg: string, bg: string): number {
  const a = oklchLuminance(fg);
  const b = oklchLuminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/* ── 源码扫描：className 表达式 ───────────────────────────────────────── */

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(entry)) out.push(full);
  }
  return out;
}

/** 与 codemod 同一套读取逻辑：className="…" / className={`…`} / className={cn(…)}。 */
function classNameValues(src: string): string[] {
  const out: string[] = [];
  const re = /\bclassName\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + 'className'.length;
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (src[i] === '=') {
      i++;
      while (i < src.length && /\s/.test(src[i]!)) i++;
    }
    if (src[i] === '"' || src[i] === "'") {
      const quote = src[i]!;
      const end = src.indexOf(quote, i + 1);
      if (end > 0) out.push(src.slice(i + 1, end));
      re.lastIndex = end > 0 ? end : i;
      continue;
    }
    if (src[i] === '{') {
      let depth = 0;
      const start = i + 1;
      let j = i;
      while (j < src.length) {
        const ch = src[j]!;
        if (ch === '"' || ch === "'" || ch === '`') {
          j++;
          while (j < src.length && src[j] !== ch) {
            if (src[j] === '\\') j++;
            j++;
          }
          j++;
          continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) break;
        }
        j++;
      }
      out.push(src.slice(start, j));
      re.lastIndex = j;
    }
  }
  return out;
}

const SOLID_BRAND = /(?<![\w-])bg-brand-(\d+)(?![\w/])/g;
const HAS_SOLID_BRAND = /(?<![\w-])bg-brand-\d+(?![\w/])/;
const HARDCODED_FG = /(?<![\w-])text-(white|black)(?![\w-])/;

/* ── 断言 ─────────────────────────────────────────────────────────────── */

describe('brand 前景色单一事实源（--color-on-brand）', () => {
  const css = readFileSync(cssPath, 'utf8');

  it('五套主题各自定义了一次 --color-on-brand（少一套 = 该类名在那套主题静默失效）', () => {
    const missing: string[] = [];
    for (const theme of THEMES) {
      const body = blockBody(css, theme.selector);
      expect(body, `主题块没找到：${theme.name}`).not.toBeNull();
      if (!tokenValue(body!, 'on-brand')) missing.push(theme.name);
    }
    expect(missing, `以下主题缺少 --color-on-brand：${missing.join(', ')}`).toEqual([]);
  });

  it('每一套主题 × 每一种承载文字的 brand 底色都真的可读（mono 回退成白 on 白 = 1.00，必红）', () => {
    // 底色档位从源码里现算：凡是「solid bg-brand-N 与 text-on-brand 同时出现」
    // 的档位都属于承载文字的表面。新增档位自动纳入，不需要人来补测试。
    const levels = new Set<number>();
    for (const file of walk(srcDir)) {
      for (const value of classNameValues(readFileSync(file, 'utf8'))) {
        if (!/text-on-brand/.test(value)) continue;
        for (const hit of value.matchAll(SOLID_BRAND)) levels.add(Number(hit[1]));
      }
    }
    expect(levels.size, '没扫到任何 brand 底色 —— 解析或源码结构变了，别静默通过').toBeGreaterThan(0);

    // 门槛按「这块底色承载什么」定：主/次按钮填充（500/600/700）按 AA 正文的 4.0
    // 兜底（dark 的 brand-500 = 4.27 是最紧的一处），400 只用于 hover/active
    // 强调填充（dark = 3.10、cyberpunk = 3.25），按 AA 大字号的 3.0。
    const floor = (level: number) => (level >= 500 ? 4.0 : 3.0);
    const failures: string[] = [];
    for (const theme of THEMES) {
      const body = blockBody(css, theme.selector)!;
      const onBrand = tokenValue(body, 'on-brand');
      if (!onBrand) continue; // 第一条用例已经在报这个
      for (const level of [...levels].sort((a, b) => a - b)) {
        const fill = tokenValue(body, `brand-${level}`);
        if (!fill) continue;
        const ratio = contrast(onBrand, fill);
        if (ratio < floor(level)) {
          failures.push(
            `${theme.name}: text-on-brand(${onBrand}) on bg-brand-${level}(${fill}) = ${ratio.toFixed(2)} < ${floor(level)}`,
          );
        }
      }
    }
    expect(failures, `brand 底上的前景色不可读：\n  ${failures.join('\n  ')}`).toEqual([]);
  });

  it('源码里没人再硬编码极性：solid brand 底上不出现 text-white / text-black', () => {
    const offenders: string[] = [];
    for (const file of walk(srcDir)) {
      for (const value of classNameValues(readFileSync(file, 'utf8'))) {
        if (!HAS_SOLID_BRAND.test(value)) continue;
        if (!HARDCODED_FG.test(value)) continue;
        offenders.push(`${relative(webUiRoot, file)} → ${value.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
    expect(
      offenders,
      `这些地方把「brand 底上的前景色」又写死了一次（mono 下会白底白字）——改成 text-on-brand：\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('旧的逐个选择器补丁不许回流（.btn-primary / .bg-brand-* 只由 token 决定）', () => {
    const mono = blockBody(css, /^html\.mono\s*\{/m);
    expect(mono, 'html.mono 块没找到').not.toBeNull();
    // 整份 CSS 里不得再有「html.mono 下点 .btn-primary / .bg-brand-*」的规则。
    const patchRules = [...css.matchAll(/html\.mono[^{]*\{[^}]*color\s*:[^}]*\}/g)].map((m) => m[0]);
    expect(patchRules, `html.mono 下仍有颜色补丁：\n${patchRules.join('\n')}`).toEqual([]);
    // .btn-primary 必须引用 token（它是唯一不经过 className 扫描的 brand 按钮）。
    const primary = /\.btn-primary\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(primary).toContain('text-on-brand');
    expect(primary).not.toMatch(/text-white|text-black/);
  });
});
