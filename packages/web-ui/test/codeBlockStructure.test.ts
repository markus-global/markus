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

// Lazy import so the window stub above runs first.
// Mock the diagram renderers: they use useSyncExternalStore (theme subscription)
// which throws in SSR (no server snapshot). We only need to assert the wrapper
// structure, so render them as inert placeholders.
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
 * Structural regression tests for diagram auto-detection.
 *
 * Context: the old heuristic auto-treated ANY unlabeled code starting with
 * mermaid keywords (`pie|journey|timeline|gantt|mindmap|flowchart|graph...`)
 * as a diagram and tried to render it, producing spurious
 * "Mermaid render error" on ordinary prose/code blocks.
 *
 * New contract:
 *   - explicit ```mermaid / ```plantuml fences  -> diagram renderer
 *   - everything else                           -> plain code block, never mermaid
 */
describe('markdown code-block diagram detection', () => {
  it('renders explicit ```mermaid fence as a diagram block with language label', async () => {
    const html = await renderMd('```mermaid\ngraph TD\n  A-->B\n```');
    // DiagramToggleBlock shell (not-prose) with the "mermaid" label
    expect(html).toContain('not-prose');
    expect(html).toContain('>mermaid<');
    // must NOT be wrapped in the plain CodeBlock shell (group/code) — double shell
    expect(html).not.toContain('group/code');
  });

  it('renders explicit ```plantuml fence as a diagram block', async () => {
    const html = await renderMd('```plantuml\n@startuml\nAlice -> Bob\n@enduml\n```');
    expect(html).toContain('not-prose');
    expect(html).toContain('>plantuml<');
    expect(html).not.toContain('group/code');
  });

  it('does NOT auto-detect unlabeled code starting with "pie" as mermaid', async () => {
    const html = await renderMd('```\npie chart of sales\nx = 1\n```');
    // plain code block shell present (group/code = CodeBlock, not diagram)
    expect(html).toContain('group/code');
    // no mermaid language label / diagram marker
    expect(html).not.toContain('>mermaid<');
    expect(html).not.toContain('language-mermaid');
  });

  it('does NOT auto-detect unlabeled code starting with "timeline"/"journey"', async () => {
    const html = await renderMd('```\ntimeline of events\njourney begins now\n```');
    expect(html).toContain('group/code');
    expect(html).not.toContain('>mermaid<');
    expect(html).not.toContain('language-mermaid');
  });

  it('does NOT auto-detect inline code containing "pie" as mermaid', async () => {
    const html = await renderMd('text with `pie` and `timeline` inline');
    expect(html).not.toContain('not-prose');
    expect(html).not.toContain('>mermaid<');
    expect(html).not.toContain('language-mermaid');
  });

  it('still renders normal language-tagged code as a plain code block', async () => {
    const html = await renderMd('```js\nconst pie = 3.14;\n```');
    expect(html).toContain('group/code');
    expect(html).toContain('>JavaScript<');
    expect(html).not.toContain('>mermaid<');
    expect(html).not.toContain('language-mermaid');
  });
});