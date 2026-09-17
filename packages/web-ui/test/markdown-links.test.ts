import { describe, it, expect } from 'vitest';
import {
  classifyMarkdownHref,
  decodePercentEscapesToUnicode,
  dirnamePath,
  isLocalFilesystemPath,
  looksLikeFilePath,
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

describe('looksLikeFilePath', () => {
  it('accepts ASCII paths (unchanged behaviour)', () => {
    expect(looksLikeFilePath('/tmp/a.md')).toBe(true);
    expect(looksLikeFilePath('/usr/local/bin')).toBe(true);
    expect(looksLikeFilePath('~/notes/todo.md')).toBe(true);
    expect(looksLikeFilePath('./sib.md')).toBe(true);
    expect(looksLikeFilePath('../up/x.md')).toBe(true);
    expect(looksLikeFilePath('C:/Users/me/doc.md')).toBe(true);
  });

  it('accepts CJK / non-ASCII file and directory names', () => {
    // The reported regression: a real file that rendered as dead <code> text.
    expect(looksLikeFilePath(
      '/Users/liuqian/mycode/vision_explosion/prompts/xhs-ootd-一周5天通勤穿搭/方案与提示词_v3.md',
    )).toBe(true);
    expect(looksLikeFilePath('~/文档/周报/2026年09月.md')).toBe(true);
    expect(looksLikeFilePath('./子目录/文件.txt')).toBe(true);
    expect(looksLikeFilePath('/tmp/方案（终版）.md')).toBe(true);
    expect(looksLikeFilePath('/tmp/report_сводка.md')).toBe(true);
  });

  it('accepts CJK names in Windows-style paths', () => {
    expect(looksLikeFilePath('C:\\Users\\19684\\.markus\\生成\\图.jpg')).toBe(true);
    expect(looksLikeFilePath('C:/Users/19684/.markus/生成/图.jpg')).toBe(true);
  });

  it('rejects things that are not bare filesystem paths', () => {
    expect(looksLikeFilePath('')).toBe(false);
    expect(looksLikeFilePath('a')).toBe(false);
    expect(looksLikeFilePath('hello world')).toBe(false);
    expect(looksLikeFilePath('https://example.com/中文')).toBe(false);
    expect(looksLikeFilePath('npm install')).toBe(false);
    expect(looksLikeFilePath('一周5天通勤穿搭')).toBe(false);
    expect(looksLikeFilePath('/' + 'x'.repeat(600))).toBe(false);
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

/**
 * Regression: markdown destinations with non-ASCII names arrive from
 * `mdast-util-to-hast` (which runs `normalizeUri` on every image/link URL) already
 * percent-encoded. Re-encoding that for `/api/files/image` produced a
 * double-escaped path, so an existing file reported "Image not found".
 */
describe('decodePercentEscapesToUnicode', () => {
  const CJK_DIR = '/Users/liuqian/mycode/vision_explosion/output/xhs-ootd-一周通勤穿搭';

  it('round-trips a percent-encoded CJK path (encodeURI form)', () => {
    const encoded = encodeURI(`${CJK_DIR}/01-封面图-v1.png`);
    expect(encoded).toContain('%E4%B8%80%E5%91%A8');
    expect(decodePercentEscapesToUnicode(encoded)).toBe(`${CJK_DIR}/01-封面图-v1.png`);
  });

  it('decodes mixed runs that contain ASCII escapes (e.g. %20 for a space)', () => {
    const p = '/Users/me/一周 穿搭/图 1.png';
    expect(decodePercentEscapesToUnicode(encodeURI(p))).toBe(p);
  });

  it('handles accented / Cyrillic / emoji file names', () => {
    for (const p of ['/Users/me/Réunion/café.png', '/Users/me/отчёт/схема.png', '/Users/me/📁-x/图.png']) {
      expect(decodePercentEscapesToUnicode(encodeURI(p))).toBe(p);
    }
  });

  it('never mangles a literal percent sign', () => {
    expect(decodePercentEscapesToUnicode('/Users/me/100%-done.png')).toBe('/Users/me/100%-done.png');
    expect(decodePercentEscapesToUnicode('/Users/me/%41.png')).toBe('/Users/me/%41.png');
    expect(decodePercentEscapesToUnicode('/Users/me/%E4.png')).toBe('/Users/me/%E4.png'); // incomplete UTF-8
  });

  it('is a no-op for plain ASCII (and cheap when there is no %)', () => {
    expect(decodePercentEscapesToUnicode('/tmp/a.png')).toBe('/tmp/a.png');
    expect(decodePercentEscapesToUnicode('https://example.com/%E4%B8%AD.png')).toBe('https://example.com/中.png');
  });

  it('normalizeLocalFilesystemPath decodes CJK and still normalizes Windows paths', () => {
    expect(normalizeLocalFilesystemPath(encodeURI(`${CJK_DIR}/01-封面图-v1.png`)))
      .toBe(`${CJK_DIR}/01-封面图-v1.png`);
    expect(normalizeLocalFilesystemPath('file:///C:/Users/19684/.markus/img.jpg'))
      .toBe('C:/Users/19684/.markus/img.jpg');
  });
});

describe('classifyMarkdownHref with non-ASCII file names', () => {
  it('decodes an encoded local markdown link back to the real path', () => {
    const real = '/Users/liuqian/mycode/vision_explosion/prompts/xhs-ootd-一周5天通勤穿搭/方案与提示词_v3.md';
    expect(classifyMarkdownHref(encodeURI(real))).toEqual({ kind: 'file', path: real, fragment: undefined });
  });

  it('keeps remote URLs untouched', () => {
    expect(classifyMarkdownHref('https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87'))
      .toEqual({ kind: 'external', url: 'https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87' });
  });
});
