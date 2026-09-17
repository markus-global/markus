import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import type ReactMarkdown from 'react-markdown';
import type { Options as ReactMarkdownOptions } from 'react-markdown';

// MarkdownComponents.tsx transitively imports api.ts which reads `window` at
// module load — provide a minimal stub before importing (vi.hoisted).
vi.hoisted(() => {
  (globalThis as unknown as { window: unknown }).window = {
    __MARKUS_HUB_BASE_URL__: '',
    __MARKUS_PREVIEW__: false,
    location: { origin: 'http://localhost', href: 'http://localhost/' },
    matchMedia: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: undefined,
  };
  return true;
});

vi.mock('../src/components/MermaidBlock.tsx', () => ({
  MermaidBlock: ({ code }: { code: string }) => h('div', { 'data-testid': 'mermaid-mock' }, code),
}));
vi.mock('../src/components/PlantUMLBlock.tsx', () => ({
  PlantUMLBlock: ({ code }: { code: string }) => h('div', { 'data-testid': 'plantuml-mock' }, code),
}));

/** A 1×1 PNG — enough for `isLocalImagePath` + fs assertions. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8ACAAwAAQAB7nr9AAAAAElFTkSuQmCC',
  'base64',
);

const DIR_NAME = 'xhs-ootd-一周通勤穿搭';
const FILE_NAME = '01-封面图-v1.png';
const SPACED_NAME = '方案 图 v1.png';

let imagePath = '';
let spacedPath = '';

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'markus-cjk-img-'));
  const dir = join(root, DIR_NAME);
  mkdirSync(dir, { recursive: true });
  imagePath = join(dir, FILE_NAME);
  spacedPath = join(dir, SPACED_NAME);
  writeFileSync(imagePath, PNG);
  writeFileSync(spacedPath, PNG);
});

let _ReactMarkdown: typeof ReactMarkdown | null = null;

/** Render `md` and return the value react-markdown handed to `components.img`. */
async function imgSrcHandedToComponents(md: string, urlTransform?: ReactMarkdownOptions['urlTransform']) {
  if (!_ReactMarkdown) _ReactMarkdown = (await import('react-markdown')).default;
  const captured: string[] = [];
  renderToStaticMarkup(
    h(_ReactMarkdown as never, {
      // transform ignores `node`; cast keeps the test free of react-markdown internals
      urlTransform: urlTransform as never,
      components: {
        img: ({ src }: { src?: string }) => {
          captured.push(String(src));
          return null;
        },
      } as never,
      children: md,
    }),
  );
  return captured[0] ?? '';
}

describe('local chat images with non-ASCII paths', () => {
  it('react-markdown percent-encodes the destination before our components see it', async () => {
    // Pins the upstream behaviour the fix has to cope with (`normalizeUri` in mdast-util-to-hast).
    const handed = await imgSrcHandedToComponents(`![封面图](${imagePath})`);
    expect(handed).not.toBe(imagePath);
    expect(handed).toContain(encodeURI(DIR_NAME));
  });

  it('chatUrlTransform decodes local paths back to the real path', async () => {
    const { chatUrlTransform } = await import('../src/components/MarkdownMessage.tsx');
    const handed = await imgSrcHandedToComponents(`![封面图](${imagePath})`, chatUrlTransform);
    expect(handed).toBe(imagePath);
  });

  it('chatUrlTransform keeps the encoded form for remote URLs', async () => {
    const { chatUrlTransform } = await import('../src/components/MarkdownMessage.tsx');
    const handed = await imgSrcHandedToComponents(
      '![x](https://example.com/%E4%B8%AD.png)',
      chatUrlTransform,
    );
    expect(handed).toBe('https://example.com/%E4%B8%AD.png');
  });

  it('builds a single-encoded image API URL that resolves to the file on disk', async () => {
    const { localImageApiUrl } = await import('../src/components/MarkdownComponents.tsx');

    // Both the raw path and the mdast-encoded form must produce the same URL.
    for (const src of [imagePath, await imgSrcHandedToComponents(`![封面图](${imagePath})`)]) {
      const url = localImageApiUrl(src);
      expect(url).toBeTruthy();
      expect(url).not.toContain('%25'); // no double encoding

      const param = new URL(url!, 'http://localhost').searchParams.get('path')!;
      expect(param).toBe(imagePath);
      expect(existsSync(param)).toBe(true);
    }
  });

  it('survives a path that contains both CJK characters and a space', async () => {
    const { localImageApiUrl } = await import('../src/components/MarkdownComponents.tsx');

    // CommonMark forbids a bare space in a link destination, so a path with spaces
    // reaches us as either the pointy-bracket form or pre-escaped (`%20`).
    const variants = [
      spacedPath,                                              // raw path, as an agent would write it
      encodeURI(spacedPath),                                    // %20 + %E6%96%B9… pre-escaped
      await imgSrcHandedToComponents(`![图](<${spacedPath}>)`), // what react-markdown hands over
    ];

    for (const src of variants) {
      const url = localImageApiUrl(src);
      expect(url, `variants must be treated as a local image: ${src}`).toBeTruthy();
      expect(url).not.toContain('%25');
      const param = new URL(url!, 'http://localhost').searchParams.get('path')!;
      expect(param).toBe(spacedPath);
      expect(existsSync(param)).toBe(true);
    }
  });

  it('leaves remote images alone', async () => {
    const { localImageApiUrl } = await import('../src/components/MarkdownComponents.tsx');
    expect(localImageApiUrl('https://example.com/a.png')).toBeNull();
  });
});
