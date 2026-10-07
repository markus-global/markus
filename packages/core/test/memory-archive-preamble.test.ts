/**
 * §27 — 三处自身体验发现：
 *   1. 策展归档是最后一个 in-band markdown 容器 → 载荷里的 `## ` 被当成"段落"（`memory_search`
 *      把我的 prompt 脚手架当已归档知识返回）。改 JSON 记录 + 把脚手架分出。
 *   2. `knowledge.md` 前言区（第一个 `## ` 之前）无删除路径 → 给执行点。
 *   3. conversation_fragment 载荷无上界（实测曾达 1.1M 字符）→ 设上界。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/memory/store.js';

function mk(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-arch-'));
}

describe('§27 归档改 JSON 记录 + 脚手架分出', () => {
  let dir: string;
  beforeEach(() => { dir = mk(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('legacy knowledge-archive.md → JSON；真知识留在 json，prompt 脚手架移入 scaffolding 侧文件并删除 md', () => {
    const legacy = [
      '## 我的老段落', 'REALBODYTOKEN 这是一段真知识。', '',
      '## Relevant Memories', '- SCAFFOLDTOKEN 这是被 dump 进来的 prompt 脚手架。', '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'knowledge-archive.md'), legacy, 'utf8');

    // 构造即触发一次性迁移
    new MemoryStore(dir);

    expect(fs.existsSync(path.join(dir, 'knowledge-archive.md'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'knowledge-archive.json'))).toBe(true);

    const keep = fs.readFileSync(path.join(dir, 'knowledge-archive.json'), 'utf8');
    expect(keep).toContain('REALBODYTOKEN');
    expect(keep).not.toContain('SCAFFOLDTOKEN');

    expect(fs.existsSync(path.join(dir, 'knowledge-archive-scaffolding.json'))).toBe(true);
    const moved = fs.readFileSync(path.join(dir, 'knowledge-archive-scaffolding.json'), 'utf8');
    expect(moved).toContain('SCAFFOLDTOKEN');
  });

  it('search 返回归档真知识，但不返回被分出的 prompt 脚手架', () => {
    fs.writeFileSync(path.join(dir, 'knowledge-archive.md'), [
      '## 我的老段落', 'REALBODYTOKEN 这是一段真知识。', '',
      '## Relevant Memories', '- SCAFFOLDTOKEN 这是被 dump 进来的 prompt 脚手架。', '',
    ].join('\n'), 'utf8');

    const store = new MemoryStore(dir);

    const real = store.search('REALBODYTOKEN');
    expect(real.some(e => (e.content ?? '').includes('REALBODYTOKEN'))).toBe(true);
    expect(real.some(e => e.metadata?.source === 'archive')).toBe(true);

    const scaffold = store.search('SCAFFOLDTOKEN');
    expect(scaffold.some(e => (e.content ?? '').includes('SCAFFOLDTOKEN'))).toBe(false);
  });

  it('迁移幂等：再构造一次不改动已迁移结果', () => {
    fs.writeFileSync(path.join(dir, 'knowledge-archive.md'), '## A\nBODY_A\n', 'utf8');
    new MemoryStore(dir);
    const after1 = fs.readFileSync(path.join(dir, 'knowledge-archive.json'), 'utf8');
    new MemoryStore(dir);
    expect(fs.readFileSync(path.join(dir, 'knowledge-archive.json'), 'utf8')).toBe(after1);
  });
});

describe('§27 knowledge.md 前言执行点', () => {
  let dir: string;
  beforeEach(() => { dir = mk(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('getLongTermPreamble 读得到、removeLongTermPreamble 清得掉，且段落不受影响', () => {
    fs.writeFileSync(path.join(dir, 'knowledge.md'),
      '# Knowledge\n遗留前言行 PREAMBLE_TOKEN\n\n## 段落A\nbodyA\n', 'utf8');
    const store = new MemoryStore(dir);

    expect(store.getLongTermPreamble()).toContain('PREAMBLE_TOKEN');

    const res = store.removeLongTermPreamble();
    expect(res.removedChars).toBeGreaterThan(0);

    const after = fs.readFileSync(path.join(dir, 'knowledge.md'), 'utf8');
    expect(after).not.toContain('PREAMBLE_TOKEN');
    expect(after).toContain('## 段落A');
    expect(after).toContain('bodyA');
    expect(store.getLongTermPreamble().trim()).toBe('');
  });

  it('setLongTermPreamble 可写回（写者/删除者对称）', () => {
    fs.writeFileSync(path.join(dir, 'knowledge.md'), '# Knowledge\n\n## 段落A\nbodyA\n', 'utf8');
    const store = new MemoryStore(dir);
    const w = store.setLongTermPreamble('新前言 PREAMBLE_TOKEN');
    expect(w.ok).toBe(true);
    const after = fs.readFileSync(path.join(dir, 'knowledge.md'), 'utf8');
    expect(after).toContain('PREAMBLE_TOKEN');
    expect(after).toContain('## 段落A');
  });
});

// §27 修正：fragment 载荷**本来就有上界** —— `sanitizeEntry` 把每条记录硬截到
// `MEMORY_ENTRY_MAX_CHARS`(4000)。实测 600k 载荷落盘后为 4034 字符。那 1.1M 字符的
// fragment 是**旧 guard 时代的遗留物**，不是当前写入路径的行为。故本项无需修改。
