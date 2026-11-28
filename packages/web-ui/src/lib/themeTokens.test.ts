/**
 * Theme-token guard — a class name that no token backs is INVISIBLE, not a no-op.
 *
 * Found live 2026-11-28: the milestone progress bar carried `bg-state-success`, the computed
 * background was `rgba(0,0,0,0)`, and the theme only defines `--color-status-ok`. So a 100 %
 * milestone rendered as an empty track — every unit test green, the user sees nothing.
 *
 * The check is deliberately narrow (it scans the components this feature owns rather than the
 * whole tree) so it can only fail for a real defect, not for a style preference.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const themeCss = readFileSync(join(here, '..', 'index.css'), 'utf-8');

/** Every `--color-<name>` the theme actually defines (any scheme block). */
const definedTokens = new Set(
  [...themeCss.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map(m => m[1]!),
);

/** `text-left` / `text-xs` / `border-b` are not colours — skip the non-colour utility tails. */
const NON_COLOR_TAILS = new Set([
  'left', 'center', 'right', 'justify', 'start', 'end', 'wrap', 'nowrap', 'ellipsis', 'clip',
  'xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl',
  'b', 't', 'l', 'r', 'x', 'y', 's', 'e', 'collapse', 'separate',
]);

/** Color utilities used by a component file, as `<prefix>-<token>`. */
function colorTokensIn(file: string): string[] {
  const src = readFileSync(join(here, '..', file), 'utf-8');
  const found = new Set<string>();
  for (const m of src.matchAll(/\b(?:bg|text|border|ring|from|via|to)-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/g)) {
    const rest = m[1]!;
    // Only look at namespaces that are theme colors; spacing/typography utilities end up here too.
    if (/^(white|black|transparent|current|inherit|none|auto|full|0|\[)/.test(rest)) continue;
    if (/^\d/.test(rest)) continue;
    if (NON_COLOR_TAILS.has(rest)) continue;
    found.add(rest);
  }
  return [...found];
}

describe('milestone UI uses only theme color tokens that exist', () => {
  for (const file of ['components/MilestonePanel.tsx', 'lib/milestoneScope.ts']) {
    it(`${file}: every color utility resolves to a --color-* token`, () => {
      const missing = colorTokensIn(file).filter(t => !definedTokens.has(t));
      expect(missing, `no --color-* definition for: ${missing.join(', ')}`).toEqual([]);
    });
  }
});
