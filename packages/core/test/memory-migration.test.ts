/**
 * Migration-read layer（审计 P-08）：**读旧、只写新**。
 *
 * 锁定两件事：
 *   1) knowledge.md 内的旧 `, tags:` 观察行在加载后被收敛为单 `data-meta` JSON 行
 *      （读取端容忍旧格式，写入端只发规范格式）；
 *   2) 已退场的 `state.md` 被读入为一条观察，源文件改名为 `.migrated`（消费而非销毁）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryStore } from '../src/memory/store.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-mig-'));
}

describe('MemoryStore — migration-read layer (P-08)', () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTempDir(); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('收敛旧 `, tags:` 观察行 → 单 `data-meta`（仅写新格式）', () => {
    const legacy = [
      '# Knowledge',
      '',
      '## _observations',
      '### obs_1700000000000',
      '<!-- type: insight, tags: alpha, beta -->',
      'legacy observation body',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmp, 'knowledge.md'), legacy, 'utf8');

    // 构造即触发迁移读取层 → 规范重写。
    const store = new MemoryStore(tmp);
    const after = fs.readFileSync(path.join(tmp, 'knowledge.md'), 'utf8');

    // 落盘后只保留规范格式，不再有裸 `, tags:` 行。
    expect(after).toMatch(/<!-- type: insight, data-meta: \{/);
    expect(after).not.toMatch(/<!-- type: \w+, tags: /);
    // 标签无损跨格式保留（读旧 → 写新）。
    expect(after).toContain('alpha');
    // 观察内容仍可读取。
    expect(store.getObservations().map(e => e.content)).toContain('legacy observation body');
  });

  it('读入已退场的 state.md 为观察，源文件改名 .migrated（不销毁）', () => {
    fs.writeFileSync(path.join(tmp, 'knowledge.md'), '# Knowledge\n\n## _observations\n', 'utf8');
    fs.writeFileSync(path.join(tmp, 'state.md'), 'situational state that must not be lost', 'utf8');

    const store = new MemoryStore(tmp);

    // 内容被保留为一条观察…
    expect(store.getObservations().some(e => e.content.includes('situational state that must not be lost'))).toBe(true);
    // …来源被消费（改名而非删除）。
    expect(fs.existsSync(path.join(tmp, 'state.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'state.md.migrated'))).toBe(true);
  });
});
