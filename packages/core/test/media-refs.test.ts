import { describe, it, expect } from 'vitest';
import {
  parseLocalMediaRefs,
  replaceMediaRefs,
  normalizeReferencePath,
  stripFileProtocol,
  kindForFilename,
  rewriteFragment,
} from '../src/media-refs.js';

describe('stripFileProtocol', () => {
  it('strips file:// prefix', () => {
    expect(stripFileProtocol('file:///Users/a/img.png')).toBe('/Users/a/img.png');
    expect(stripFileProtocol('file:/Users/a/img.png')).toBe('/Users/a/img.png');
    expect(stripFileProtocol('/Users/a/img.png')).toBe('/Users/a/img.png');
  });
});

describe('kindForFilename', () => {
  it('classifies image extensions', () => {
    expect(kindForFilename('/a/b.png')).toBe('image');
    expect(kindForFilename('/a/b.jpeg')).toBe('image');
    expect(kindForFilename('/a/b.svg')).toBe('image');
    expect(kindForFilename('/a/b.webp')).toBe('image');
  });
  it('classifies media extensions', () => {
    expect(kindForFilename('/a/b.mp4')).toBe('media');
    expect(kindForFilename('/a/b.mp3')).toBe('media');
    expect(kindForFilename('/a/b.wav')).toBe('media');
  });
  it('defaults to other', () => {
    expect(kindForFilename('/a/b.pdf')).toBe('other');
    expect(kindForFilename('/a/b')).toBe('other');
  });
});

describe('normalizeReferencePath', () => {
  it('passes absolute POSIX paths through', () => {
    expect(normalizeReferencePath('/Users/liuqian/img.png')).toBe('/Users/liuqian/img.png');
  });
  it('strips file:// protocol', () => {
    expect(normalizeReferencePath('file:///Users/liuqian/img.png')).toBe('/Users/liuqian/img.png');
    expect(normalizeReferencePath('file:///C:/Users/a/img.png')).toBe('/C:/Users/a/img.png');
  });
  it('keeps Windows drive paths and normalizes backslashes', () => {
    expect(normalizeReferencePath('C:\\Users\\a\\img.png')).toBe('C:/Users/a/img.png');
    expect(normalizeReferencePath('C:/Users/a/img.png')).toBe('C:/Users/a/img.png');
  });
  it('decodes local API form (path query)', () => {
    const encoded = encodeURIComponent('/Users/liuqian/img.png');
    expect(normalizeReferencePath(`/api/files/image?path=${encoded}`)).toBe('/Users/liuqian/img.png');
    expect(normalizeReferencePath(`/api/files/stream?path=${encoded}`)).toBe('/Users/liuqian/img.png');
    expect(normalizeReferencePath(`/api/files/preview?path=${encoded}`)).toBe('/Users/liuqian/img.png');
  });
  it('resolves relative paths against baseDir', () => {
    expect(normalizeReferencePath('img.png', '/Users/a/doc')).toBe('/Users/a/doc/img.png');
    expect(normalizeReferencePath('./img.png', '/Users/a/doc')).toBe('/Users/a/doc/img.png');
    expect(normalizeReferencePath('../img.png', '/Users/a/doc')).toBe('/Users/a/doc/../img.png');
  });
  it('returns null for http/data refs', () => {
    expect(normalizeReferencePath('https://example.com/a.png')).toBeNull();
    expect(normalizeReferencePath('data:image/png;base64,xxx')).toBeNull();
  });
});

describe('parseLocalMediaRefs', () => {
  it('parses markdown image refs', () => {
    const { refs } = parseLocalMediaRefs(
      '# T\n\n![alt](/Users/a/img.png)\n\n[link](/Users/a/other.png)\n\n![ok](https://x.com/a.png)',
    );
    const images = refs.filter(r => r.kind === 'image');
    expect(images).toHaveLength(2);
    expect(images[0]!.raw).toBe('![alt](/Users/a/img.png)');
    expect(images[0]!.localPath).toBe('/Users/a/img.png');
  });

  it('parses markdown image with title', () => {
    const { refs } = parseLocalMediaRefs('![alt](/Users/a/img.png "title")');
    expect(refs).toHaveLength(1);
    expect(refs[0]!.localPath).toBe('/Users/a/img.png');
  });

  it('parses HTML img src', () => {
    const { refs } = parseLocalMediaRefs('<div><img src="/Users/a/img.png" alt="x"></div>');
    expect(refs).toHaveLength(1);
    expect(refs[0]!.kind).toBe('image');
    expect(refs[0]!.localPath).toBe('/Users/a/img.png');
  });

  it('parses HTML source/video/audio refs', () => {
    const { refs } = parseLocalMediaRefs(
      '<video src="/Users/a/v.mp4"></video><audio src="/Users/a/s.mp3"></audio><source src="/Users/a/x.webm">',
    );
    expect(refs.map(r => r.kind)).toEqual(['media', 'media', 'media']);
    expect(refs.map(r => r.localPath)).toEqual(['/Users/a/v.mp4', '/Users/a/s.mp3', '/Users/a/x.webm']);
  });

  it('parses local API form url', () => {
    const encoded = encodeURIComponent('/Users/liuqian/.markus/generated/images/img-1.png');
    const { refs } = parseLocalMediaRefs(`![gen](/api/files/image?path=${encoded})`);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.localPath).toBe('/Users/liuqian/.markus/generated/images/img-1.png');
  });

  it('resolves relative refs using baseDir', () => {
    const { refs } = parseLocalMediaRefs('![img](./img.png)', '/Users/a/doc');
    expect(refs[0]!.localPath).toBe('/Users/a/doc/img.png');
  });

  it('skips http/data refs and anchors', () => {
    const result = parseLocalMediaRefs(
      '![web](https://x.com/a.png)\n![d](data:image/png;base64,xxx)\n[#](#anchor)',
    );
    expect(result.refs).toHaveLength(0);
  });

  it('does not duplicate identical raw fragments', () => {
    const { refs } = parseLocalMediaRefs('![a](/x/1.png) then ![a](/x/1.png) again');
    expect(refs).toHaveLength(1);
  });
});

describe('replaceMediaRefs', () => {
  it('replaces all occurrences of a fragment keeping markdown syntax', () => {
    const out = replaceMediaRefs(
      '![a](/x/1.png) and ![a](/x/1.png) again',
      new Map([['![a](/x/1.png)', 'https://hub.example/u/1.png']]),
    );
    expect(out).toBe('![a](https://hub.example/u/1.png) and ![a](https://hub.example/u/1.png) again');
  });

  it('replaces html attribute fragment keeping tag structure', () => {
    const out = replaceMediaRefs(
      '<img src="/x/1.png" alt="x">',
      new Map([['<img src="/x/1.png" alt="x">', 'https://hub.example/u/1.png']]),
    );
    expect(out).toBe('<img src="https://hub.example/u/1.png" alt="x">');
  });
});

describe('rewriteFragment', () => {
  it('rewrites markdown fragment keeping alt text', () => {
    expect(rewriteFragment('![alt](/a/b.png)', 'https://hub/u.png')).toBe('![alt](https://hub/u.png)');
  });
  it('rewrites markdown with title keeping alt', () => {
    expect(rewriteFragment('![alt](/a/b.png "t")', 'https://hub/u.png')).toBe('![alt](https://hub/u.png)');
  });
  it('rewrites html attribute', () => {
    expect(rewriteFragment('src="/a/b.png"', 'https://hub/u.png')).toBe('src="https://hub/u.png"');
    expect(rewriteFragment("src='/a/b.png'", 'https://hub/u.png')).toBe("src='https://hub/u.png'");
  });
});