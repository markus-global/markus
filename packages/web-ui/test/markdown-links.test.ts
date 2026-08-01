import { describe, it, expect } from 'vitest';
import {
  classifyMarkdownHref,
  dirnamePath,
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
});
