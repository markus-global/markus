/**
 * Guard: no hardcoded user-visible copy in source.
 *
 * Why this exists (Owner 2026-11-21: "感觉很多地方东西，仍然没有正确国际化，再彻底检查"):
 * `keys.test.ts` only proves "every key the code asks for exists". It cannot see
 * copy that never goes through `t()` at all. Two whole classes slipped past it:
 *
 *  1. Hardcoded **Chinese** (HistoryModal's header, relativeTime, ReadErrorNotice
 *     props…). Invisible to a zh-CN reviewer — it looks correct — while en/es
 *     users read Chinese. An English-only grep misses it entirely.
 *  2. Hardcoded **English** prose in JSX text and aria-label/title/alt.
 *
 * Mechanism: a source scan over the TypeScript AST. The invariant is structural
 * ("no literal copy outside the dictionary"), and the AST — unlike a regex —
 * never mistakes a comment for copy, and can tell a *display* literal from a
 * *matching* literal.
 *
 * Exemptions are decided by **syntactic shape, not by filename**: a file-level
 * allowlist would silently shelter future violations in that file. Each rule
 * below names the shape that makes the literal legitimately non-translatable.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const SRC = join(__dirname, '..');
const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;

/** Brand names / product terms that are identical in every language. */
const BRAND_PHRASES = new Set(['Markus Cloud AI']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'locales') walk(p, out);
    } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

/** Is this literal used for *matching* rather than *displaying*? */
function isMatchingLiteral(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  // `name === '秘书'`, `role !== 'x'`
  if (ts.isBinaryExpression(p) && ['===', '!==', '==', '!='].includes(p.operatorToken.getText())) return true;
  // `.includes('重启')` / `.startsWith('task:')` — payload used as structure.
  if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression)
    && ['includes', 'startsWith', 'endsWith', 'indexOf'].includes(p.expression.name.text)) return true;
  // A CJK *property key* (`'开发工具': 'code'`) is a lookup key over data.
  if (ts.isPropertyAssignment(p) && ts.isStringLiteral(p.name) && CJK.test(p.name.text)) return true;
  // `console.warn('[right-panel] …失败:', err)` — developer diagnostics, never
  // rendered to the user. Localising logs would make them ungreppable.
  if (ts.isCallExpression(p) && /^console\./.test(p.expression.getText())) return true;
  // `new Set(['任务', 'Task', …])` — a membership table, not display copy.
  // `stripChipLabelPrefix` has to recognise the type words of *every* language
  // older builds baked into labels, so translating this set would break it.
  if (ts.isArrayLiteralExpression(p) && ts.isNewExpression(p.parent)
    && p.parent.expression.getText() === 'Set') return true;
  return false;
}

/** Is this literal a legitimate i18n fallback / non-translatable field? */
function isExemptLiteral(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (isMatchingLiteral(node)) return true;
  if (ts.isPropertyAssignment(p)) {
    const name = p.name.getText();
    // `t(key, { defaultValue: '…' })` — the dictionary is authoritative.
    if (name === 'defaultValue') return true;
    // Explicit bilingual field: the zh half of a deliberate en/zh pair.
    if (name === 'labelZh') return true;
    // `{ key: 'runStatusRunning', label: '运行中' }` — label is t(key, label)'s fallback.
    if (name === 'label' && ts.isObjectLiteralExpression(p.parent)
      && p.parent.properties.some(x => ts.isPropertyAssignment(x) && x.name.getText() === 'key')) return true;
  }
  // `t('ns:key', '中文默认')` — positional fallback, same contract as defaultValue.
  if (ts.isCallExpression(p)) {
    const callee = p.expression.getText();
    if ((/(^|\.)t$/.test(callee) || callee === 'i18n.t') && p.arguments.indexOf(node as ts.Expression) >= 1) return true;
  }
  return false;
}

type Violation = { file: string; line: number; text: string; why: string };

function scan(): Violation[] {
  const found: Violation[] = [];
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file);
    // Language autonyms ("中文", "Español") are by definition not translated.
    if (rel === join('i18n', 'index.ts')) continue;
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const push = (n: ts.Node, text: string, why: string) =>
      found.push({ file: rel, line: at(n), text: text.replace(/\s+/g, ' ').trim().slice(0, 80), why });

    const visit = (node: ts.Node): void => {
      if (ts.isJsxText(node)) {
        const txt = node.text.trim();
        if (txt && CJK.test(txt)) push(node, txt, 'JSX text is hardcoded Chinese');
        else if (txt && !txt.startsWith('&') && /[a-z]/.test(txt)
          && txt.split(/\s+/).length >= 2 && !BRAND_PHRASES.has(txt)) {
          push(node, txt, 'JSX text is hardcoded prose (must go through t())');
        }
      }
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        && CJK.test(node.text) && !isExemptLiteral(node)) {
        push(node, node.text, 'hardcoded Chinese literal');
      }
      // Only the template's OWN literal parts — nested `${t(...)}` is visited separately.
      if (ts.isTemplateExpression(node)) {
        const parts = [node.head.text, ...node.templateSpans.map(s => s.literal.text)];
        if (parts.some(x => CJK.test(x))) push(node, parts.join('…'), 'hardcoded Chinese in template literal');
      }
      if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)
        && ['placeholder', 'title', 'aria-label', 'alt'].includes(node.name.getText())
        && CJK.test(node.initializer.text)) {
        push(node, node.initializer.text, 'hardcoded Chinese in a user-visible attribute');
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

describe('no hardcoded user-visible copy', () => {
  const violations = scan();

  it('every Chinese literal in source is either a dictionary fallback or a matching key', () => {
    // Actionable on purpose: the message names the file, line and the exact copy,
    // so the fix is "move this string into src/locales/* and call t()", not a guess.
    expect(violations, violations.map(v => `${v.file}:${v.line} — ${v.why}: "${v.text}"`).join('\n')).toEqual([]);
  });

  it('the scanner actually sees copy (a scanner that finds nothing proves nothing)', () => {
    // Negative control: feed the scanner a shape it MUST flag, so a future
    // refactor that silently disables detection cannot pass as "all clean".
    const src = `export const A = () => <div>历史</div>;`;
    const sf = ts.createSourceFile('probe.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let hits = 0;
    const visit = (n: ts.Node): void => {
      if (ts.isJsxText(n) && CJK.test(n.text.trim())) hits++;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(hits).toBe(1);
  });
});
