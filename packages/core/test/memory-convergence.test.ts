import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MEMORY_MD_CURATED_MAX_CHARS } from '@markus/shared';
import { MemoryStore } from '../src/memory/store.js';

/**
 * knowledge.md 的**注入段（curated）上限必须是不变式**（读进来的就一定是合规的）。
 *
 * 回归背景：上限原先只在**写入**路径检查，且越界时的处理是**拒绝写入** ——
 * 而拒绝写入无法让一个已经超标的文件变小，所以一旦超标就永久超标
 * （实测 23 323 字符 vs 15 000 上限）。同时「删除」这个最基本的遗忘操作缺失，
 * 旧结论只能被覆盖、不能被移除。
 *
 * 注：本文件只覆盖 **curated（注入）** 预算。观察缓冲 `## _observations` 是**另一个
 * 独立预算**（MEMORY_OBSERVATIONS_MAX_CHARS），在 memory-budget-invariants.test.ts 覆盖。
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

/** H24/H26 — 观察条目持久化为 observations.json（不再在 knowledge.md 里）。 */
function obsBodies(dir: string): Array<{ id?: string; content?: string }> {
  const p = path.join(dir, 'observations.json');
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Array<{ id?: string; content?: string }>;
}

describe('knowledge.md 注入段收敛（load 时不变式）', () => {
  let dir: string;

  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('超标的注入段只被**报告**，不被改写（H19：不再静默压缩 curated）', () => {
    const file = path.join(dir, 'knowledge.md');
    const original = bigKnowledge(6, 5_000);
    fs.writeFileSync(file, original, 'utf8');
    expect(original.length).toBeGreaterThan(MEMORY_MD_CURATED_MAX_CHARS);

    const store = new MemoryStore(dir); // 构造即 enforceMemoryBudgets
    expect(store).toBeTruthy();

    // 一个字节都不改：没有静默归档、没有指针存根，每个主题正文完整保留
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toBe(original);
    expect(text).not.toContain('_[archived');
    expect(text).toContain('## topic-0');
  });

  it('合规文件不被改写（幂等、无副作用）', () => {
    const file = path.join(dir, 'knowledge.md');
    const small = '# Knowledge\n\n## a\nsmall\n';
    fs.writeFileSync(file, small, 'utf8');
    const store = new MemoryStore(dir);
    const result = store.enforceMemoryBudgets();
    expect(result.curated.converged).toBe(false);
    // §24 — observations.converged 读作"在建议线以内"（空缓冲 ⇒ true；平台不再强制收敛）
    expect(result.observations.converged).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(small);
  });

  it('收敛注入段不动观察条目（H26：旧格式首载即迁入 observations.json）', () => {
    const file = path.join(dir, 'knowledge.md');
    const withObs = bigKnowledge(6, 5_000)
      + '\n## _observations\n<!-- buffer -->\n\n### obs_1\n<!-- type: note -->\nkeep me\n';
    fs.writeFileSync(file, withObs, 'utf8');
    new MemoryStore(dir);
    // 观察正文逐字节保留（换了容器，没换内容）；knowledge.md 只剩注入用的 curated 区。
    expect(obsBodies(dir).some(e => (e.content ?? '').includes('keep me'))).toBe(true);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain('## _observations');
    expect(text).toContain('## topic-0');
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
    // H24/H26 — 观察条目在 observations.json；删除 curated 段落不得动它
    expect(obsBodies(dir).some(e => (e.content ?? '').includes('observation body'))).toBe(true);
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
