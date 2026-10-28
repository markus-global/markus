#!/usr/bin/env node
/**
 * 一次性 codemod：把遗留语义色 token 改成规范名（2026-10-28）。
 *
 * 背景：9 个 token 在源码里用了 70 处，但主题从未定义它们（`surface-default`
 * 那次的透明弹窗就是同一类病）。先在 `index.css` 里补了 `var()` 别名让视觉正确，
 * 现在把调用点改成规范名、删掉别名，让一个概念只剩一个名字。
 *
 * 为什么用脚本而不是逐处手改：多数调用点位于**同一个文件里重复出现的长 className
 * 字符串**（例如 `'bg-surface-inset text-content-tertiary'` 在 RemoteAccessSection
 * 出现两次），按唯一锚点编辑无法安全命中第二处。
 *
 * 为什么安全：每个映射都与当前别名**取值完全等价**（`bg-surface-2` 就是
 * `var(--color-surface-elevated)`），所以渲染结果不会变；脚本只做字符串替换。
 *
 * 用法：
 *   node scripts/codemod-legacy-tokens.mjs            # dry-run：源码替换统计
 *   node scripts/codemod-legacy-tokens.mjs --apply    # 写入源码
 *   node scripts/codemod-legacy-tokens.mjs --css      # 删掉 index.css 里的别名块
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const APPLY = process.argv.includes('--apply');
const CSS_MODE = process.argv.includes('--css');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'packages', 'web-ui', 'src');

/** 遗留名 → 规范名（与 index.css 里曾有的 var() 别名一一对应，取值等价）。 */
const MAP = {
  'surface-base': 'surface-primary',
  'surface-2': 'surface-elevated',
  'surface-3': 'surface-overlay',
  'surface-inset': 'surface-secondary',
  'surface-tertiary': 'surface-elevated',
  'border-hover': 'border-default',
  'content-primary': 'fg-primary',
  'content-secondary': 'fg-secondary',
  'content-tertiary': 'fg-tertiary',
};

const PREFIXES = ['bg', 'text', 'border', 'divide', 'ring', 'fill', 'stroke', 'outline', 'shadow', 'placeholder', 'from', 'to', 'via', 'accent', 'caret', 'decoration'];

// ── CSS 模式：删掉别名定义 + 换掉那段说明 ────────────────────────────────────
if (CSS_MODE) {
  const cssPath = join(SRC, 'index.css');
  const before = readFileSync(cssPath, 'utf8');
  const lines = before.split('\n');
  const aliasNames = Object.keys(MAP);
  const isAliasLine = (line) =>
    aliasNames.some((name) => new RegExp(`^\\s*--color-${name}\\s*:`).test(line));

  const kept = [];
  let removed = 0;
  let inLegacyComment = false;
  for (const line of lines) {
    if (/\/\*\s*──\s*遗留 token 别名/.test(line)) { inLegacyComment = true; continue; }
    if (inLegacyComment) {
      if (line.includes('*/')) inLegacyComment = false;
      continue;
    }
    if (isAliasLine(line)) { removed += 1; continue; }
    kept.push(line);
  }

  const note = [
    '  /* 遗留 token 已全部改名（2026-10-28）：`surface-base/2/3/inset/tertiary`、',
    '     `border-hover`、`content-*` 的 70 处调用点由 scripts/codemod-legacy-tokens.mjs',
    '     改成规范名，别名定义随之删除——一个概念只留一个名字。',
    '     新增语义色请先在这里定义 token 再用类名（tailwindTokens.test 会卡住未定义 token）。 */',
    '',
  ];
  // 插在 `--color-fg-quaternary` 那一行之后，保持 token 区连续
  const insertAt = kept.findIndex((line) => /^\s*--color-fg-quaternary\s*:/.test(line));
  kept.splice(insertAt + 1, 0, ...note);

  const after = kept.join('\n');
  if (APPLY) writeFileSync(cssPath, after, 'utf8');
  console.log(`[codemod:css] ${APPLY ? 'APPLY' : 'DRY-RUN'} 删除别名行 ${removed} 条，重写说明段`);
  process.exit(0);
}

// ── 源码模式：替换调用点 ────────────────────────────────────────────────────
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(tsx?|jsx?)$/.test(entry) && !/\.test\./.test(entry)) files.push(full);
  }
})(SRC);

let total = 0;
const perFile = [];

for (const file of files) {
  const before = readFileSync(file, 'utf8');
  let text = before;
  let hits = 0;

  for (const [legacy, canonical] of Object.entries(MAP)) {
    const pattern = new RegExp(`(${PREFIXES.join('|')})-${legacy}(?![a-z0-9-])`, 'g');
    text = text.replace(pattern, (_m, prefix) => {
      hits += 1;
      return `${prefix}-${canonical}`;
    });
  }

  if (hits > 0) {
    total += hits;
    perFile.push(`${relative(SRC, file)}: ${hits}`);
    if (APPLY) writeFileSync(file, text, 'utf8');
  }
}

console.log(`[codemod] ${APPLY ? 'APPLY' : 'DRY-RUN'} 替换 ${total} 处，涉及 ${perFile.length} 个文件`);
for (const line of perFile) console.log('  - ' + line);
if (!APPLY) console.log('[codemod] 这是 dry-run；确认无误后加 --apply。');
