/**
 * §24 —— 第一性原理不变式（这些用例的作用是让根因 R1–R4 **在结构上无法再表达**）。
 *
 * 背景：本轮 16 次事故按症状看是"按下葫芦浮起瓢"，按根因归只有四类：
 *   R1 一个事实多个写者 · R2 一个不变量多个（有条件的）执行点
 *   R3 结构从载荷推断（带内容器） · R4 平台替 Agent 决定内容
 *
 * 这里钉的是 R2 + R4：**平台永不自动搬运/改写 Agent 的观察内容**。
 *   • 越界 → 拒绝写入（Agent 自己决定如何整理），**不**静默驱逐、**不**归档；
 *   • 装载路径不再对内容做启发式修复/自愈 → 合规文件必须逐字节不变。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MEMORY_OBSERVATIONS_MAX_CHARS, MEMORY_OBSERVATIONS_HARD_MAX_CHARS } from '@markus/shared';
import { MemoryStore, sanitizeSectionBody } from '../src/memory/store.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-inv-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const kFile = () => path.join(dir, 'knowledge.md');
const obsFile = () => path.join(dir, 'observations.json');
const obsArchive = () => path.join(dir, 'observations-archive.json');
const read = (p: string) => fs.readFileSync(p, 'utf8');
const bodies = () => (fs.existsSync(obsFile()) ? JSON.parse(read(obsFile())) as Array<{ id: string; content?: string }> : []);
const payload = () => bodies().reduce((s, e) => s + (e.content ?? '').length, 0);

const entry = (i: number, chars: number) => ({
  id: `obs_${i}`, timestamp: '2026-10-04T00:00:00.000Z', type: 'note' as const,
  content: `body-${i} ` + 'z'.repeat(chars), metadata: {},
});

describe('§24 · R4 — 平台不再替 Agent 搬运或改写内容', () => {
  it('越过软线不驱逐、不归档：条目一条不少（只报告）', () => {
    const store = new MemoryStore(dir);
    for (let i = 0; i < 20; i++) store.addEntry(entry(i, MEMORY_OBSERVATIONS_MAX_CHARS / 10));
    const before = bodies().length;
    expect(payload()).toBeGreaterThan(MEMORY_OBSERVATIONS_MAX_CHARS); // 前提：确实越过软线
    expect(before).toBe(20);
    // 平台不得自行搬运（旧行为：把最旧的搬进 observations-archive.json）
    expect(fs.existsSync(obsArchive())).toBe(false);
    expect(bodies().length).toBe(20);
  });

  it('越过硬线**拒绝**新写入，且既有条目纹丝不动（Agent 自己决定怎么整理）', () => {
    const store = new MemoryStore(dir);
    // 单条有上限（MEMORY_ENTRY_MAX_CHARS=4000），所以用「多条填满」而不是「一条巨鲸」。
    let refused: { ok: boolean; reason?: string } | undefined;
    for (let i = 0; i < 60 && !refused; i++) {
      const r = store.addEntry(entry(i, 3_900));
      if (!r.ok) refused = r;
    }
    expect(refused, '必须撞上硬线并被拒绝').toBeTruthy();
    expect(payload()).toBeGreaterThan(MEMORY_OBSERVATIONS_HARD_MAX_CHARS - 4_000);

    const snapshot = JSON.stringify(bodies());
    const again = store.addEntry(entry(999, 3_900));
    expect(again.ok).toBe(false);
    expect(again.reason ?? '').toMatch(/ceiling|full|budget|consolidat|memory_organize/i);
    // 拒绝 ≠ 搬运：既有内容逐字节不动
    expect(JSON.stringify(bodies())).toBe(snapshot);
    expect(fs.existsSync(obsArchive())).toBe(false);
  });

  it('装载路径不对内容做启发式修复/自愈：合规的 curated 文件逐字节不变', () => {
    // 含 `## ` 标题、代码围栏、$& 等"看着像结构"的正文 —— 旧实现会在装载时重写它们。
    const body = ['## 现象', '```js', "x = s.replace(/a/, '$&')", '```', '## 根因', 'text'].join('\n');
    const original = `# Knowledge\n\n## design-notes\n${body}\n`;
    fs.writeFileSync(kFile(), original, 'utf8');
    // eslint-disable-next-line no-new
    new MemoryStore(dir);
    expect(read(kFile())).toBe(original);
  });
});

describe('§24 · I3 — 清洗只在写入口发生（单点、确定性），装载时不改写', () => {
  it('`<think>` 泄漏在写入口被剔除；`## ` 在正文里降级为 `### `（否则会切段）', () => {
    const out = sanitizeSectionBody(['ok', '<think>', 'secret reasoning', '</think>', '## 子标题', 'tail'].join('\n'));
    expect(out).not.toContain('<think>');
    expect(out).not.toContain('secret reasoning');
    expect(out).toContain('### 子标题');
    // 未闭合的 `<think>` 同样不能把推理泄进注入区
    expect(sanitizeSectionBody('a\n<think>\nleaked')).not.toContain('leaked');
  });
});

describe('§24 · I2 — 一个预算一种度量（与容器无关）', () => {
  it('上报口径 = payload，且既不依赖容器语法、也不因容器变更而触发驱逐', () => {
    const store = new MemoryStore(dir);
    for (let i = 0; i < 5; i++) store.addEntry(entry(i, 1_000));
    const h = store.getMemoryHealth();
    expect(h.observationChars).toBe(payload());
    // payload 量的是内容；容器（JSON 语法）比它大 —— 口径绝不等于“文件多大”
    expect(fs.readFileSync(obsFile(), 'utf8').length).toBeGreaterThan(h.observationChars);
    expect(h.observationPercent).toBe(Math.round((payload() / MEMORY_OBSERVATIONS_MAX_CHARS) * 100));
  });
});
