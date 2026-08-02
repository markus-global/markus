import { describe, it, expect } from 'vitest';
import {
  classifyMarkdownHref,
  dirnamePath,
  isLocalFilesystemPath,
  normalizeLocalFilesystemPath,
  normalizeWindowsPathsInMarkdown,
  resolvePathAgainstBase,
  slugifyHeading,
} from '../src/components/markdown-links.ts';

describe('slugifyHeading', () => {
  it('slugs english headings like GitHub', () => {
    expect(slugifyHeading('Hello World')).toBe('hello-world');
    expect(slugifyHeading('1. Overview')).toBe('1-overview');
  });

  it('keeps CJK characters', () => {
    expect(slugifyHeading('债务人信息')).toBe('债务人信息');
  });
});

describe('resolvePathAgainstBase', () => {
  it('resolves relative paths', () => {
    expect(resolvePathAgainstBase('./notes.md', '/Users/me/docs')).toBe('/Users/me/docs/notes.md');
    expect(resolvePathAgainstBase('../x.md', '/Users/me/docs/a')).toBe('/Users/me/docs/x.md');
  });

  it('dirnamePath strips filename', () => {
    expect(dirnamePath('/a/b/c.md')).toBe('/a/b');
  });
});

describe('classifyMarkdownHref', () => {
  it('treats #heading as in-document fragment', () => {
    expect(classifyMarkdownHref('#overview')).toEqual({ kind: 'fragment', id: 'overview' });
    expect(classifyMarkdownHref('#债务人信息')).toEqual({ kind: 'fragment', id: '债务人信息' });
  });

  it('does not treat #mention / #entity as fragments', () => {
    // These are handled earlier in MarkdownMessage; classifier should not steal them
    // if somehow reached — they start with #mention: / #entity:
    expect(classifyMarkdownHref('#mention:Alice').kind).not.toBe('fragment');
    expect(classifyMarkdownHref('#entity:proj_abc').kind).not.toBe('fragment');
  });

  it('classifies relative and absolute files', () => {
    expect(classifyMarkdownHref('./sib.md', '/Users/me/docs')).toEqual({
      kind: 'file',
      path: '/Users/me/docs/sib.md',
      fragment: undefined,
    });
    expect(classifyMarkdownHref('/tmp/a.md#sec')).toEqual({
      kind: 'file',
      path: '/tmp/a.md',
      fragment: 'sec',
    });
  });

  it('classifies http(s) as external', () => {
    expect(classifyMarkdownHref('https://example.com/a')).toEqual({
      kind: 'external',
      url: 'https://example.com/a',
    });
  });

  it('classifies Windows drive paths as files (not URI schemes)', () => {
    expect(classifyMarkdownHref('C:\\Users\\19684\\.markus\\generated\\images\\a.jpg')).toEqual({
      kind: 'file',
      path: 'C:/Users/19684/.markus/generated/images/a.jpg',
      fragment: undefined,
    });
    expect(classifyMarkdownHref('C:/Users/19684/.markus/generated/images/a.jpg')).toEqual({
      kind: 'file',
      path: 'C:/Users/19684/.markus/generated/images/a.jpg',
      fragment: undefined,
    });
  });
});

describe('Windows local image path helpers', () => {
  it('detects Windows / file:// / POSIX local paths', () => {
    expect(isLocalFilesystemPath('C:\\Users\\a\\b.jpg')).toBe(true);
    expect(isLocalFilesystemPath('C:/Users/a/b.jpg')).toBe(true);
    expect(isLocalFilesystemPath('file:///C:/Users/a/b.jpg')).toBe(true);
    expect(isLocalFilesystemPath('/tmp/a.jpg')).toBe(true);
    expect(isLocalFilesystemPath('https://example.com/a.jpg')).toBe(false);
  });

  it('normalizes Windows and file:// paths for the image API', () => {
    expect(normalizeLocalFilesystemPath('C:\\Users\\19684\\.markus\\generated\\images\\img.jpg'))
      .toBe('C:/Users/19684/.markus/generated/images/img.jpg');
    expect(normalizeLocalFilesystemPath('C:\\\\Users\\\\19684\\\\.markus\\\\img.jpg'))
      .toBe('C:/Users/19684/.markus/img.jpg');
    expect(normalizeLocalFilesystemPath('file:///C:/Users/19684/.markus/img.jpg'))
      .toBe('C:/Users/19684/.markus/img.jpg');
  });

  it('rewrites Windows backslash destinations inside markdown', () => {
    const src = '![Markus 展示海报](C:\\\\Users\\\\19684\\\\.markus\\\\generated\\\\images\\\\img-1.jpg)';
    expect(normalizeWindowsPathsInMarkdown(src)).toBe(
      '![Markus 展示海报](C:/Users/19684/.markus/generated/images/img-1.jpg)',
    );
  });
});
