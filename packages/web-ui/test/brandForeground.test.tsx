/**
 * 守卫：**brand 作背景时，前景色只有一个事实源**（`--color-on-brand`）。
 *
 * 起因（2026-11-05，Owner 报）：mono（黑白）主题下 brand 底按钮白底白字、看不见。
 * 根因不是「漏了某几个按钮」，而是「brand 底色上的前景色」这个事实有两个写者：
 *   1) 组件里各自猜一个 `text-white`；
 *   2) index.css 里一条 `html.mono .btn-primary, .bg-brand-600, .bg-brand-500` 的
 *      逐个选择器补丁 —— 结构上不可能覆盖 hover/active、带透明度的变体
 *      （`bg-brand-600/90`）和以后新增的组件。
 * 现在只留一个写者：`--color-on-brand`；brand 底一律 `text-on-brand`。
 *
 * ── 第二轮评审打回后的修正（2026-11-05，Secretary）────────────────────────
 * 第一版守卫把「类名字符串」等同于「`className=` 属性里的字符串」——那是同一类错误
 * 的翻版：类名这个事实还活在**常量表、三元分支、默认参数值**里。于是守卫全绿，而
 * `ActionCenter.KIND_META.thread.btn`（常量）、`ConfirmModal.confirmBtnClass`（三元）、
 * `Avatar.bgClass` 默认值三处照样白底白字。
 * 修法是**换域**，不是加例外：扫描对象从「className 属性表达式」改为「源码里任意
 * 字符串字面量」（含模板字面量 `${…}` 内部的文本）。凡是**同一个字面量**里既有 solid
 * brand 底又有硬编码极性的，一律红。
 * 唯一静态不可判的形态是「底色由变量给、前景在另一个字面量里兜底」（Avatar）——对它
 * 用**行为测试**钉住真实渲染结果，而不是源码文本断言（重命名即失效的栅栏不算守卫）。
 *
 * 五条断言：
 *   ① 五套主题都定义了这个 token（少一套 = 该类名在那一套里静默失效）；
 *   ② 它在**每一套主题 × 每一种承载文字的 brand 底色**上都真的可读（算对比度，
 *      不是文本快照 —— mono 回退成白 on 白会算出 1.00，必然红）；
 *   ③ 任何字符串字面量里，solid brand 底不得再配 `text-white`/`text-black`；
 *   ④ 旧的逐个选择器补丁不许回流；
 *   ⑤ 变量/默认值形态（Avatar 的 bgClass）由真实渲染结果钉住。
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '@testing-library/react';

// 守卫要渲染真实组件，但不需要真实后端与 i18n：把这两个边界钉住，测试只驱动类名结果。
vi.mock('../src/api.ts', () => ({ api: {}, hubApi: { getUrl: () => null } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { Avatar } from '../src/components/Avatar.tsx';
import { ConfirmModal } from '../src/components/ConfirmModal.tsx';

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

/* ── 源码扫描：任意字符串字面量（不是 className 属性） ─────────────────── */

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(entry)) out.push(full);
  }
  return out;
}

interface Literal {
  /** 1-based line where the literal starts. */
  line: number;
  /** Literal body — for templates this includes the `${…}` expression source text. */
  text: string;
}

/**
 * 逐字符扫描，取出每一个 '…' / "…" / `…` 的内容（跳过注释）。
 *
 * 为什么要包含模板字面量里 `${…}` 的源码文本：`${cond ? '' : 'text-white'}` 里的
 * `text-white` 最终也会落到**同一个元素的类名**上，所以「同一字面量」这个域必须把
 * 插值内部算进来。反过来，`bgClass` 这种标识符不含字面量文本，所以它不会被误判 ——
 * 那一类由下面的行为测试覆盖。
 */
function stringLiterals(src: string): Literal[] {
  const out: Literal[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      const start = i;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
      out.push({
        line: src.slice(0, start).split('\n').length,
        text: src.slice(start + 1, i),
      });
      i++;
      continue;
    }
    if (c === '`') {
      const start = i;
      let depth = 0;
      i++;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === '$' && src[i + 1] === '{') {
          depth++;
          i += 2;
          continue;
        }
        if (ch === '}' && depth > 0) {
          depth--;
          i++;
          continue;
        }
        if (ch === '`' && depth === 0) break;
        i++;
      }
      out.push({
        line: src.slice(0, start).split('\n').length,
        text: src.slice(start + 1, i),
      });
      i++;
      continue;
    }
    i++;
  }
  return out;
}

const SOLID_BRAND = /(?<![\w-])bg-brand-(\d+)(?![\w/])/g;
const HAS_SOLID_BRAND = /(?<![\w-])bg-brand-\d+(?![\w/])/;
const HARDCODED_FG = /(?<![\w-])text-(white|black)(?![\w-])/;
const ON_BRAND = /(?<![\w-])text-on-brand(?![\w-])/;

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
    // 底色档位从源码现算：凡是「solid bg-brand-N 与 text-on-brand 同时出现」的档位
    // 都属于承载文字的表面。新增档位自动纳入，不需要人来补测试。
    const levels = new Set<number>();
    for (const file of walk(srcDir)) {
      if (/\.test\.(tsx?|jsx?)$/.test(file)) continue;
      for (const lit of stringLiterals(readFileSync(file, 'utf8'))) {
        if (!ON_BRAND.test(lit.text)) continue;
        for (const hit of lit.text.matchAll(SOLID_BRAND)) levels.add(Number(hit[1]));
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

  it('任何字符串字面量里，solid brand 底都不配硬编码极性（常量/三元/默认值/插值都算）', () => {
    const offenders: string[] = [];
    for (const file of walk(srcDir)) {
      if (/\.test\.(tsx?|jsx?)$/.test(file)) continue;
      for (const lit of stringLiterals(readFileSync(file, 'utf8'))) {
        if (!HAS_SOLID_BRAND.test(lit.text)) continue;
        if (!HARDCODED_FG.test(lit.text)) continue;
        offenders.push(
          `${relative(webUiRoot, file)}:${lit.line} → ${lit.text.replace(/\s+/g, ' ').trim().slice(0, 100)}`,
        );
      }
    }
    expect(
      offenders,
      `这些字面量把「brand 底上的前景色」又写死了一次（mono 下会白底白字）——改成 text-on-brand：\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('旧的逐个选择器补丁不许回流（.btn-primary / .bg-brand-* 只由 token 决定）', () => {
    // 整份 CSS 里不得再有「html.mono 下点 .btn-primary / .bg-brand-*」的颜色规则。
    const patchRules = [...css.matchAll(/html\.mono[^{]*\{[^}]*color\s*:[^}]*\}/g)].map((m) => m[0]);
    expect(patchRules, `html.mono 下仍有颜色补丁：\n${patchRules.join('\n')}`).toEqual([]);
    // .btn-primary 必须引用 token（它是唯一不经过 className 扫描的 brand 按钮）。
    const primary = /\.btn-primary\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(primary).toContain('text-on-brand');
    expect(primary).not.toMatch(/text-white|text-black/);
  });

  /**
   * 变量/默认值形态：底色由变量给、前景在另一个字面量里兜底 —— 上面那条字面量扫描
   * 在结构上无法发现（`${bgClass}` 不含字面量文本）。所以这里渲染**真实组件**，
   * 断言最终 DOM 类名，而不是读源码字符串。
   */
  describe('变量/默认值形态', () => {
    it('Avatar 默认底色是 brand → 前景来自 token，且不再追加 text-white', () => {
      const { container } = render(<Avatar name="Ada" />);
      const el = container.firstElementChild as HTMLElement;
      expect(el.className, '默认底色 bg-brand-600 必须带 text-on-brand').toContain('text-on-brand');
      expect(el.className, 'mono 下 text-white 会变成白底白字').not.toContain('text-white');
    });

    it('Avatar 显式传非重映射底色时仍走 text-white 兜底（不误伤）', () => {
      const { container } = render(<Avatar name="Ada" bgClass="bg-surface-overlay" />);
      const el = container.firstElementChild as HTMLElement;
      expect(el.className).toContain('text-white');
      expect(el.className).not.toContain('text-on-brand');
    });

    it('ConfirmModal 的 primary 确认按钮问 token；danger 保持白字', () => {
      const { unmount } = render(
        <ConfirmModal variant="primary" title="t" message="m" onConfirm={() => {}} onCancel={() => {}} />,
      );
      const primary = [...document.body.querySelectorAll('button')].find((b) =>
        b.className.includes('bg-brand-600'),
      );
      expect(primary, 'primary 确认按钮没找到').toBeTruthy();
      expect(primary!.className).toContain('text-on-brand');
      expect(primary!.className).not.toContain('text-white');
      unmount();

      render(<ConfirmModal title="t" message="m" onConfirm={() => {}} onCancel={() => {}} />);
      const danger = [...document.body.querySelectorAll('button')].find((b) =>
        b.className.includes('bg-red-600'),
      );
      expect(danger, 'danger 确认按钮没找到').toBeTruthy();
      expect(danger!.className, 'red 不在 mono 的重映射范围内，白字正确').toContain('text-white');
    });
  });
});

