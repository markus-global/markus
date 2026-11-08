/**
 * 守卫：右栏本地文件自动刷新的三条纪律。
 *
 * 这三条都是「做错了不会让别的测试变红」的形态，所以单独钉住：
 *  ① 用户正在编辑 → 绝不探测（探测到变化就会重读，把他刚打的字冲掉）；
 *  ② 面板不可见 → 不探测（后台不该持续读盘）；
 *  ③ URL / 非文件类载荷 → 不探测（没有 mtime 这回事）。
 *
 * 负向对照：把 `shouldProbeFileRefresh` 改成恒返回 true，① 与 ② 立刻红。
 */
import { describe, it, expect } from 'vitest';
import { shouldProbeFileRefresh, hasFileChanged, FILE_AUTO_REFRESH_MS } from './fileAutoRefresh.ts';

const base = {
  kind: 'file',
  hasPath: true,
  isUrlReference: false,
  editorDirty: false,
  visibility: 'visible' as const,
};

describe('shouldProbeFileRefresh — 什么时候允许去 stat', () => {
  it('本地文件 + 可见 + 没在编辑 → 探测', () => {
    expect(shouldProbeFileRefresh(base)).toBe(true);
  });

  it('① 编辑中绝不探测（否则重读会覆盖用户输入）', () => {
    expect(shouldProbeFileRefresh({ ...base, editorDirty: true })).toBe(false);
  });

  it('② 面板不可见不探测', () => {
    expect(shouldProbeFileRefresh({ ...base, visibility: 'hidden' })).toBe(false);
    expect(shouldProbeFileRefresh({ ...base, visibility: 'prerender' })).toBe(false);
  });

  it('③ URL 与无路径载荷不探测', () => {
    expect(shouldProbeFileRefresh({ ...base, isUrlReference: true })).toBe(false);
    expect(shouldProbeFileRefresh({ ...base, hasPath: false })).toBe(false);
  });

  it('终端 / 浏览器标签页不是本地文件，不探测', () => {
    expect(shouldProbeFileRefresh({ ...base, kind: 'terminal' })).toBe(false);
    expect(shouldProbeFileRefresh({ ...base, kind: 'url' })).toBe(false);
    expect(shouldProbeFileRefresh({ ...base, kind: 'deliverable' })).toBe(true);
  });
});

describe('hasFileChanged — 只有真的变了才重读', () => {
  it('首轮没有基线 → 不重读（只建基线）', () => {
    expect(hasFileChanged(null, { mtimeMs: 100, size: 10 })).toBe(false);
  });

  it('mtime 变了 → 重读', () => {
    expect(hasFileChanged({ mtimeMs: 100, size: 10 }, { mtimeMs: 101, size: 10 })).toBe(true);
  });

  it('大小变了 → 重读（某些写入方式不更新 mtime 精度）', () => {
    expect(hasFileChanged({ mtimeMs: 100, size: 10 }, { mtimeMs: 100, size: 11 })).toBe(true);
  });

  it('完全没变 → 不重读（避免无谓重渲染整份 Markdown）', () => {
    expect(hasFileChanged({ mtimeMs: 100, size: 10 }, { mtimeMs: 100, size: 10 })).toBe(false);
  });

  it('拿不到 mtime 时退回比大小；两者都拿不到则不重读', () => {
    expect(hasFileChanged({ mtimeMs: undefined, size: 10 }, { mtimeMs: undefined, size: 11 })).toBe(true);
    expect(hasFileChanged({ mtimeMs: undefined, size: undefined }, { mtimeMs: 1, size: 2 })).toBe(false);
  });
});

describe('节流间隔', () => {
  it('探测间隔是秒级而不是零 —— 不允许退化成忙轮询', () => {
    expect(FILE_AUTO_REFRESH_MS).toBeGreaterThanOrEqual(1_000);
    expect(FILE_AUTO_REFRESH_MS).toBeLessThanOrEqual(30_000);
  });
});
