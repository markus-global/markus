import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import type ReactMarkdown from 'react-markdown';

// MarkdownComponents.tsx transitively imports api.ts which reads `window` at
// module load. Provide a minimal window stub BEFORE importing (vi.hoisted).
const _stub = vi.hoisted(() => {
  const stub = {
    __MARKUS_HUB_BASE_URL__: '',
    __MARKUS_PREVIEW__: false,
    location: { origin: 'http://localhost', href: 'http://localhost/' },
    matchMedia: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: undefined,
  };
  (globalThis as unknown as { window: unknown }).window = stub;
  return true;
});

vi.mock('../src/components/MermaidBlock.tsx', () => ({
  MermaidBlock: ({ code }: { code: string }) => h('div', { 'data-testid': 'mermaid-mock' }, code),
}));
vi.mock('../src/components/PlantUMLBlock.tsx', () => ({
  PlantUMLBlock: ({ code }: { code: string }) => h('div', { 'data-testid': 'plantuml-mock' }, code),
}));

let _mdComponents: typeof import('../src/components/MarkdownComponents.tsx').mdComponents;
let _ReactMarkdown: typeof ReactMarkdown;

async function renderMd(md: string): Promise<string> {
  if (!_mdComponents || !_ReactMarkdown) {
    const [mod, rm] = await Promise.all([
      import('../src/components/MarkdownComponents.tsx'),
      import('react-markdown'),
    ]);
    _mdComponents = mod.mdComponents;
    _ReactMarkdown = rm.default;
  }
  return renderToStaticMarkup(
    // @ts-expect-error valid react-markdown components map
    _ReactMarkdown({ components: _mdComponents, children: md }),
  );
}

/**
 * Regression: a real, existing file whose path contains Chinese characters
 * rendered as a dead `<code>` span in chat — not clickable, no preview, no
 * reveal. The gate is `looksLikeFilePath` (see markdown-links.ts): its ASCII-only
 * character class rejected any non-ASCII segment.
 *
 * The component tag `data-file-path-link` is emitted by FilePathLink in every
 * state (loading / missing / ready), so we can tell "routed to the file chip"
 * apart from the plain-code fallback before the async existence check resolves.
 */
describe('inline-code file path chips', () => {
  const CJK_PATH = '/Users/liuqian/mycode/vision_explosion/prompts/xhs-ootd-一周5天通勤穿搭/方案与提示词_v3.md';

  it('routes a path containing Chinese characters to the file chip', async () => {
    const html = await renderMd('方案在这里：`' + CJK_PATH + '`');
    expect(html).toContain('data-file-path-link');
    expect(html).toContain('方案与提示词_v3.md');
  });

  it('still routes ASCII absolute paths to the file chip', async () => {
    const html = await renderMd('see `/Users/me/proj/packages/web-ui/src/components/FilePathLink.tsx`');
    expect(html).toContain('data-file-path-link');
  });

  it('leaves bare repo-relative paths as plain code (unchanged: they cannot be resolved)', async () => {
    const html = await renderMd('see `packages/web-ui/src/components/FilePathLink.tsx`');
    expect(html).not.toContain('data-file-path-link');
  });

  it('does not turn ordinary Chinese prose into a path chip', async () => {
    const html = await renderMd('这是`一周5天通勤穿搭`的主题，另外`每周更新两次`。');
    expect(html).not.toContain('data-file-path-link');
  });

  it('does not turn a URL into a path chip', async () => {
    const html = await renderMd('docs: `https://example.com/指南/入门`');
    expect(html).not.toContain('data-file-path-link');
  });
});
