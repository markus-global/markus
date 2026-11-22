import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TFunction } from 'i18next';
import { categorizeTools } from '../src/lib/toolCategories.ts';
import type { AgentToolInfo } from '../src/api.ts';

/**
 * Minimal translator stub: returns the category id (last segment of the i18n
 * key) so assertions can compare against stable group ids instead of the
 * localized label.
 */
const t = ((key: string, opts?: Record<string, unknown>) => {
  const m = /toolCategories\.([\w-]+)/.exec(key);
  if (m) return m[1] === 'mcp' ? `mcp:${String(opts?.['server'] ?? '')}` : m[1];
  return key;
}) as unknown as TFunction;

const tool = (name: string): AgentToolInfo => ({ name, description: '' });
const groupOf = (groups: ReturnType<typeof categorizeTools>, name: string) =>
  groups.find(g => g.tools.some(x => x.name === name))?.category;

describe('categorizeTools — known tool placement', () => {
  it('places memory / office / knowledge / decide / runtime tools in semantic groups, never in 其他', () => {
    const groups = categorizeTools(
      [
        tool('memory_stats'),
        tool('memory_organize'),
        tool('memory_save'),
        tool('office_generate'),
        tool('kb_search'),
        tool('decide'),
        tool('background_wait'),
      ],
      t,
    );
    expect(groupOf(groups, 'memory_stats')).toBe('memory');
    expect(groupOf(groups, 'memory_organize')).toBe('memory');
    expect(groupOf(groups, 'memory_save')).toBe('memory');
    expect(groupOf(groups, 'office_generate')).toBe('deliverables');
    expect(groupOf(groups, 'kb_search')).toBe('knowledge');
    expect(groupOf(groups, 'decide')).toBe('reasoning');
    expect(groupOf(groups, 'background_wait')).toBe('runtime');
    // The catch-all must stay empty — an uncategorized tool is a grouping bug.
    expect(groups.find(g => g.category === 'other')).toBeUndefined();
  });
});

/**
 * Drift guard.
 *
 * `TOOL_CATEGORY_DEF` is a hand-maintained prefix list that duplicates the
 * authoritative tool registry in `packages/core/src/tools`. Historically a NEW
 * core tool silently fell into "其他" because nobody added its prefix (e.g.
 * memory_stats / memory_organize / office_generate / decide). This test turns
 * the "MUST get a prefix here" comment into an enforced invariant: every tool
 * name literal in the core tool sources must land in a real category.
 */
// vitest runs from the repo root (see root scripts), so cwd is stable here.
const TOOLS_DIR = join(process.cwd(), 'packages', 'core', 'src', 'tools');

/** `name: '…'` literals in core tool sources that are NOT registered tools. */
const NON_TOOL_NAME_LITERALS = new Set([
  // web-search provider labels
  'Tavily', 'Serper', 'SerpAPI', 'Bing', 'Bocha', 'Brave', 'Exa', 'Google',
  // MCP clientInfo names
  'markus', 'Markus', 'markus-test',
  // GUI layout constants
  'LAYOUT_WIDE',
]);

function registeredToolNameLiterals(): string[] {
  const files = readdirSync(TOOLS_DIR).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  const names = new Set<string>();
  for (const f of files) {
    const src = readFileSync(join(TOOLS_DIR, f), 'utf8');
    for (const m of src.matchAll(/\bname:\s*'([a-zA-Z0-9_.-]+)'/g)) {
      const n = m[1];
      if (!NON_TOOL_NAME_LITERALS.has(n)) names.add(n);
    }
  }
  return [...names];
}

describe('categorizeTools — coverage guard (drift protection)', () => {
  it('every registered core tool name is placed in a category, none in 其他', () => {
    const tools = registeredToolNameLiterals().map(tool);
    expect(tools.length).toBeGreaterThan(80); // sanity: the scan actually found tools
    const groups = categorizeTools(tools, t);
    const uncategorized = groups.find(g => g.category === 'other')?.tools.map(x => x.name) ?? [];
    expect(uncategorized).toEqual([]);
  });
});