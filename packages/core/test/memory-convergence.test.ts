import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MEMORY_MD_TOTAL_MAX_CHARS } from '@markus/shared';
import { MemoryStore } from '../src/memory/store.js';

/**
 * knowledge.md 的**上限必须是不变式**（读进来的就一定是合规的）。
 *
 * 回归背景：上限原先只在**写入**路径检查，且越界时的处理是**拒绝写入** ——
 * 而拒绝写入无法让一个已经超标的文件变小，所以一旦超标就永久超标
 * （实测 23 323 字符 vs 15 000 上限）。同时「删除」这个最基本的遗忘操作缺失，
 * 旧结论只能被覆盖、不能被移除。
 */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-converge-'));
}

function bigKnowledge(sections: number, bodyChars: number): string {
  const parts = ['# Knowledge', ''];
  for (let i = 0; i < sections; i++) {
    parts.push(`## topic-${i}`, 'x'.repeat(bodyChars), '');
  }
  return parts.join('\n');
}

describe('knowledge.md 总量收敛（load 时不变式）', () => {
  let dir: string;

  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('超标的 knowledge.md 在加载时被收敛到上限内', () => {
    const file = path.join(dir, 'knowledge.md');
    fs.writeFileSync(file, bigKnowledge(6, 5_000), 'utf8');
    const before = fs.statSync(file).size;
    expect(before).toBeGreaterThan(MEMORY_MD_TOTAL_MAX_CHARS);

    const store = new MemoryStore(dir); // 构造即加载
    expect(store).toBeTruthy();

    const after = fs.statSync(file).size;
    expect(after).toBeLessThanOrEqual(MEMORY_MD_TOTAL_MAX_CHARS);
    // 标题必须保留：索引行与 memory_search 仍要能发现这些主题
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('## topic-0');
  });

  it('合规文件不被改写（幂等、无副作用）', () => {
    const file = path.join(dir, 'knowledge.md');
    const small = '# Knowledge\n\n## a\nsmall\n';
    fs.writeFileSync(file, small, 'utf8');
    const store = new MemoryStore(dir);
    const result = store.convergeLongTermToCap();
    expect(result.converged).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(small);
  });

  it('收敛不动 ## _observations 缓冲区', () => {
    const file = path.join(dir, 'knowledge.md');
    fs.writeFileSync(
      file,
      bigKnowledge(6, 5_000)
        + '\n## _observations\n<!-- buffer -->\n\n### obs_1\n<!-- type: note -->\nkeep me\n',
      'utf8',
    );
    new MemoryStore(dir);
    expect(fs.readFileSync(file, 'utf8')).toContain('keep me');
  });
});

describe('curated 段落删除（forget 原语）', () => {
  let dir: string;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('删除指定段落，保留其余段落与 observations', () => {
    const file = path.join(dir, 'knowledge.md');
    fs.writeFileSync(
      file,
      [
        '# Knowledge',
        '',
        '## keep-me',
        'durable',
        '',
        '## stale',
        'superseded conclusion',
        '',
        '## _observations',
        '<!-- buffer -->',
        '',
        '### obs_1',
        '<!-- type: note -->',
        'observation body',
        '',
      ].join('\n'),
      'utf8',
    );
    const store = new MemoryStore(dir);
    const result = store.removeLongTermSection('stale');

    expect(result.ok).toBe(true);
    expect(result.removedChars).toBeGreaterThan(0);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain('superseded conclusion');
    expect(text).toContain('## keep-me');
    expect(text).toContain('## _observations');
    expect(text).toContain('observation body');
  });

  it('未知段落返回可读错误，不改文件', () => {
    const file = path.join(dir, 'knowledge.md');
    fs.writeFileSync(file, '# Knowledge\n\n## a\nbody\n', 'utf8');
    const store = new MemoryStore(dir);
    const before = fs.readFileSync(file, 'utf8');
    const result = store.removeLongTermSection('nope');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not found');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('拒绝把 observations 缓冲区当段落删', () => {
    const dir2 = makeTempDir();
    try {
      const store = new MemoryStore(dir2);
      const result = store.removeLongTermSection('_observations');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('_observations');
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('容忍调用方带 ## 前缀', () => {
    const file = path.join(dir, 'knowledge.md');
    fs.writeFileSync(file, '# Knowledge\n\n## stale\nx\n', 'utf8');
    const store = new MemoryStore(dir);
    expect(store.removeLongTermSection('## stale').ok).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('## stale');
  });
});
