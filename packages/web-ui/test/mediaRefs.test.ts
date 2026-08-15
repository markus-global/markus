import { describe, it, expect } from 'vitest';
import {
  parseLocalMediaRefs,
  replaceMediaRefs,
  normalizeReferencePath,
  kindForFilename,
  rewriteFragment,
  toAbsoluteHubUrl,
  buildReplacementsFromUploads,
} from '../src/lib/mediaRefs.ts';

describe('mediaRefs (web-ui mirror)', () => {
  it('parses markdown image refs (absolute + local API form)', () => {
    const encoded = encodeURIComponent('/Users/liuqian/.markus/generated/img-1.png');
    const { refs } = parseLocalMediaRefs(
      '# T\n\n![alt](/Users/a/img.png)\n\n![gen](/api/files/image?path=' + encoded + ')\n\n![web](https://x.com/a.png)',
    );
    expect(refs).toHaveLength(2);
    expect(refs[0]!.localPath).toBe('/Users/a/img.png');
    expect(refs[1]!.localPath).toBe('/Users/liuqian/.markus/generated/img-1.png');
  });

  it('parses HTML img/video/source refs', () => {
    const { refs } = parseLocalMediaRefs(
      '<img src="/Users/a/img.png"><video src="/Users/a/v.mp4"></video><source src="/Users/a/x.webm">',
    );
    expect(refs.map(r => r.kind)).toEqual(['image', 'media', 'media']);
  });

  it('resolves relative refs using baseDir', () => {
    const { refs } = parseLocalMediaRefs('![img](./img.png)', '/Users/a/doc');
    expect(refs[0]!.localPath).toBe('/Users/a/doc/img.png');
  });

  it('replaces fragments with new URLs', () => {
    const out = replaceMediaRefs(
      '![a](/x/1.png) then ![a](/x/1.png)',
      new Map([['![a](/x/1.png)', '![a](https://hub.example/u/1.png)']]),
    );
    expect(out).toBe('![a](https://hub.example/u/1.png) then ![a](https://hub.example/u/1.png)');
  });

  it('rewrites markdown and html fragments', () => {
    expect(rewriteFragment('![alt](/a/b.png "t")', 'https://hub/u.png')).toBe('![alt](https://hub/u.png)');
    expect(rewriteFragment('src="/a/b.png"', 'https://hub/u.png')).toBe('src="https://hub/u.png"');
  });

  it('normalizeReferencePath handles file:// and windows paths', () => {
    expect(normalizeReferencePath('file:///Users/a/img.png')).toBe('/Users/a/img.png');
    expect(normalizeReferencePath('C:\\Users\\a\\img.png')).toBe('C:/Users/a/img.png');
  });

  it('kindForFilename classifies extensions', () => {
    expect(kindForFilename('/a/b.png')).toBe('image');
    expect(kindForFilename('/a/b.mp4')).toBe('media');
    expect(kindForFilename('/a/b.pdf')).toBe('other');
  });

  it('toAbsoluteHubUrl keeps absolute URLs and prefixes relative ones', () => {
    expect(toAbsoluteHubUrl('https://cdn.example/u.png', 'https://hub.example')).toBe('https://cdn.example/u.png');
    expect(toAbsoluteHubUrl('/uploads/img_abc.png', 'https://hub.example')).toBe('https://hub.example/uploads/img_abc.png');
    expect(toAbsoluteHubUrl('uploads/img_abc.png', 'https://hub.example/')).toBe('https://hub.example/uploads/img_abc.png');
  });

  it('buildReplacementsFromUploads maps by key=localPath and skips missing', () => {
    const refs = parseLocalMediaRefs('![a](/a/img.png) ![b](/b/same.png)', '/base').refs;
    const map = buildReplacementsFromUploads(
      refs,
      [
        { key: '/a/img.png', url: '/uploads/img_1.png' },
        { key: '/b/same.png', url: 'https://cdn.example/abs.png' },
        { key: '/missing.png', url: '/uploads/x.png' },
      ],
      'https://hub.example',
    );
    expect(map.size).toBe(2);
    // 同名文件（same.png）用 key 区分不串图
    const rawA = refs.find(r => r.localPath === '/a/img.png')!.raw;
    const rawB = refs.find(r => r.localPath === '/b/same.png')!.raw;
    expect(map.get(rawA)).toBe('https://hub.example/uploads/img_1.png');
    expect(map.get(rawB)).toBe('https://cdn.example/abs.png');
  });
});