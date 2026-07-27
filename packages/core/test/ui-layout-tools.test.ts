import { describe, it, expect } from 'vitest';
import { parseOpenRightPanelArgs } from '../src/tools/ui-layout.js';

describe('parseOpenRightPanelArgs', () => {
  it('parses url and normalizes https', () => {
    const r = parseOpenRightPanelArgs({ url: 'example.com', title: 'Ex' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.panel).toEqual({ kind: 'url', url: 'https://example.com', title: 'Ex' });
    }
  });

  it('parses file path', () => {
    const r = parseOpenRightPanelArgs({ path: '/tmp/a.md' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.panel).toEqual({ kind: 'file', path: '/tmp/a.md', title: undefined });
  });

  it('treats absolute path in url as file://', () => {
    const r = parseOpenRightPanelArgs({ url: '/Users/me/logo.png' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.panel).toEqual({
        kind: 'url',
        url: 'file:///Users/me/logo.png',
        title: undefined,
      });
    }
  });

  it('parses deliverable_id', () => {
    const r = parseOpenRightPanelArgs({ deliverable_id: 'del_1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.panel).toEqual({ kind: 'deliverable', deliverableId: 'del_1' });
  });

  it('rejects missing and mixed kinds', () => {
    expect(parseOpenRightPanelArgs({}).ok).toBe(false);
    expect(parseOpenRightPanelArgs({ url: 'https://a.com', path: '/x' }).ok).toBe(false);
  });
});
