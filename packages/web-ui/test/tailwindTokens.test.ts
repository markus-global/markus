/**
 * 守卫：源码里用到的语义色 token **必须都在主题里定义过**。
 *
 * 起因（2026-10-28，Owner 报）：任务"取消（含依赖任务）"的弹窗背景透明。
 * 根因不是 z-index、也不是遮罩，而是卡片用了 `bg-surface-default` —— 这个 token
 * 主题里从来没定义过。类名解析不出来 → 卡片没有背景 → 看到的是底下的页面。
 *
 * 同一批隐患共 9 个 token / 70 处（surface-base、surface-2/3/inset/tertiary、
 * border-hover、content-primary/secondary/tertiary），已在主题里补成 var() 别名，
 * 让它们有唯一取值来源。这条守卫保证**不会再出现新的未定义 token**。
 *
 * 为什么值得单独一条测试：这类缺陷不报错、不红类型、不红构建，只有人眼能发现。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webUiRoot = join(here, '..');
const srcDir = join(webUiRoot, 'src');

/** 主题里定义过的语义色 token（--color-*）。 */
function definedTokens(): Set<string> {
  const css = readFileSync(join(srcDir, 'index.css'), 'utf8');
  return new Set([...css.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * 只扫"语义色家族"（surface/fg/border/content/brand/selected/switch），
 * 不扫 Tailwind 自带调色板（gray/red/blue…），那些是内置的、无需主题定义。
 */
const SEMANTIC =
  /(?:bg|text|border|divide|ring|from|to|via|fill|stroke|outline|decoration|shadow|placeholder|accent|caret)-(surface|fg|border|content|selected|switch)-([a-z0-9-]+)/g;

describe('Tailwind 语义色 token', () => {
  it('源码用到的 token 全部在主题里定义过（未定义类名会静默失效）', () => {
    const defined = definedTokens();
    expect(defined.size).toBeGreaterThan(10); // 主题解析失败时不要静默通过

    const offenders = new Map<string, string[]>();
    for (const file of walk(srcDir)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(SEMANTIC)) {
        const token = `${match[1]}-${match[2]}`;
        if (defined.has(token)) continue;
        const list = offenders.get(token) ?? [];
        list.push(relative(webUiRoot, file));
        offenders.set(token, list);
      }
    }

    const report = [...offenders.entries()]
      .sort()
      .map(([token, files]) => `  ${token} ×${files.length} ← ${[...new Set(files)].slice(0, 3).join(', ')}`);

    expect(
      report,
      `以下类名在主题里没有对应 token，会静默渲染成"没有背景/颜色/边框"：\n${report.join('\n')}\n` +
        `修法二选一：改用规范 token，或在 index.css 里补一条 var() 别名。`,
    ).toEqual([]);
  });
});
