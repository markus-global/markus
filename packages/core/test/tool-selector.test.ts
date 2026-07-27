import { describe, it, expect } from 'vitest';
import { ToolSelector } from '../src/tool-selector.js';

/**
 * Tests for discover_tools description slim-down
 * — skills listed by name only, inactive tools listed by name only
 */
describe('ToolSelector — discover_tools slim description', () => {
  function makeToolMap(names: string[]): Map<string, { name: string; description: string; inputSchema: Record<string, unknown> }> {
    return new Map(names.map((name) => [
      name,
      { name, description: `Tool ${name} — long description that wastes tokens`, inputSchema: {} },
    ]));
  }

  function makeSlimCatalog(names: string[]): Array<{ name: string }> {
    return names.map(name => ({ name }));
  }

  function getDiscoverToolDescription(tools: ReturnType<typeof makeToolMap>, catalog?: ReturnType<typeof makeSlimCatalog>): string {
    const selector = new ToolSelector();
    const result = selector.selectTools({
      allTools: tools,
      userMessage: 'hello',
      skillCatalog: catalog,
    });
    const discover = result.find(t => t.name === 'discover_tools');
    return discover?.description ?? '';
  }

  describe('skill catalog in discover_tools', () => {
    it('lists skills by name only, comma-separated, without descriptions', () => {
      const tools = makeToolMap(['shell_execute', 'file_read', 'grep_search']);
      const catalog = makeSlimCatalog(['chrome-devtools', 'agent-building', 'markitdown']);

      const desc = getDiscoverToolDescription(tools, catalog);

      expect(desc).toContain('Skills available');
      expect(desc).toContain('chrome-devtools, agent-building, markitdown');
      // Should NOT contain the old-style (has instructions) tags
      expect(desc).not.toContain('has instructions');
      expect(desc).not.toContain('no instructions');
    });

    it('shows skill count in header', () => {
      const tools = makeToolMap(['shell_execute']);
      const catalog = makeSlimCatalog(['a', 'b', 'c']);

      const desc = getDiscoverToolDescription(tools, catalog);

      expect(desc).toContain('(3 total');
    });

    it('truncates to max 30 skills', () => {
      const tools = makeToolMap(['shell_execute']);
      const catalog = makeSlimCatalog(Array.from({ length: 35 }, (_, i) => `skill-${i}`));

      const desc = getDiscoverToolDescription(tools, catalog);

      expect(desc).toContain('... and 5 more');
      expect(desc).not.toContain('skill-30');
    });

    it('handles empty skill catalog gracefully', () => {
      const tools = makeToolMap(['shell_execute', 'file_read']);
      const catalog: Array<{ name: string }> = [];

      const desc = getDiscoverToolDescription(tools, catalog);

      expect(desc).not.toContain('Skills available');
    });

    it('handles undefined skill catalog', () => {
      const tools = makeToolMap(['shell_execute', 'file_read']);

      const desc = getDiscoverToolDescription(tools);

      expect(desc).not.toContain('Skills available');
    });
  });

  describe('inactive tools in discover_tools', () => {
    it('lists inactive tools by name only, comma-separated, without descriptions', () => {
      const tools = makeToolMap(['tool_a', 'tool_b', 'tool_c']);

      const desc = getDiscoverToolDescription(tools);

      expect(desc).toContain('Inactive tools');
      expect(desc).toContain('tool_a, tool_b, tool_c');
      // Should NOT contain the long description text
      expect(desc).not.toContain('long description that wastes tokens');
    });

    it('correctly shows inactive count header', () => {
      const tools = makeToolMap(['tool_a', 'tool_b']);

      const desc = getDiscoverToolDescription(tools);

      expect(desc).toContain('Inactive tools (2)');
    });
  });

  describe('combined slim output', () => {
    it('produces much smaller description than before', () => {
      const tools = makeToolMap(Array.from({ length: 20 }, (_, i) => `tool_${i}`));
      const catalog = makeSlimCatalog(Array.from({ length: 10 }, (_, i) => `skill-${i}`));

      const desc = getDiscoverToolDescription(tools, catalog);

      // The combined description should be well under 3000 chars
      expect(desc.length).toBeLessThan(3000);
      // Must contain the key headers
      expect(desc).toContain('tools active');
      expect(desc).toContain('Skills available');
      expect(desc).toContain('Inactive tools');
    });

    it('includes usage instructions with list_skills, search_registry, install hints', () => {
      const tools = makeToolMap(['shell_execute']);
      const catalog = makeSlimCatalog(['skill-1']);

      const desc = getDiscoverToolDescription(tools, catalog);

      expect(desc).toContain('list_skills');
      expect(desc).toContain('search_registry');
      expect(desc).toContain('install');
      expect(desc).toContain('activate');
    });
  });
});
