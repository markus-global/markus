/**
 * H25 —— 观察缓冲的预算口径必须**与表示形式无关**（representation-invariant）。
 *
 * 回归背景（见 docs/records/PLATFORM-HARDENING-2026-10.md §21）：
 *
 * H24 把观察从带内 markdown（`## _observations` 里的 `### id` 块）搬到了
 * `observations.json`。结构因此变得不可伪造（题设正确），**但度量单位被顺手换掉了**：
 * 上限常量 `MEMORY_OBSERVATIONS_MAX_CHARS = 30000` 是**按 markdown 序列化标定的**，
 * 而新口径量的是 `JSON.stringify(entries, null, 2)` —— 缩进 + 重复键 + 引号。
 *
 * 实测（本机真实数据，34 条）：
 *   内容本体 23899 · 旧 markdown 计量 25716（86%，健康）· JSON pretty 计量 35182（117%）
 *   ⇒ 32% 的预算被 JSON 语法本身吃掉，同一批知识**只因换了容器**就超限。
 *
 * 后果不是"数字变难看"，而是**迁移时静默驱逐**：启动日志里 10 个 Agent 各被
 * 归档 1~6 条（`trimmed losslessly {charsBefore:35183, charsAfter:29425, archived:6}`），
 * 而它们在 markdown 口径下本来是健康的。无损（归档可检索）不等于无害 ——
 * 一次表示变更不该改变"哪些知识是活的"。
 *
 * 判据：**预算量的是 Agent 自己写的字节（payload），不是容器的序列化开销。**
 * 这样换任何容器（markdown / JSON / 未来的二进制）都不会再触发驱逐。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MEMORY_OBSERVATIONS_MAX_CHARS } from '@markus/shared';
import { MemoryStore } from '../src/memory/store.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-measure-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const file = () => path.join(dir, 'knowledge.md');
const obsFile = () => path.join(dir, 'observations.json');
const obsArchive = () => path.join(dir, 'observations-archive.json');

/** 旧形态 knowledge.md：curated 段 + 带内 `## _observations`。 */
function legacyKnowledge(n: number, contentChars: number): { text: string; payload: number } {
  const lines = ['# Knowledge', '', '## Notes', 'durable curated note', '', '## _observations', '<!-- buffer -->', ''];
  let payload = 0;
  for (let i = 0; i < n; i++) {
    const body = `observation-${i} ` + 'z'.repeat(contentChars);
    payload += body.length;
    lines.push(`### obs_${1000 + i}`, '<!-- type: note -->', body, '');
  }
  return { text: lines.join('\n'), payload };
}

function readObs(): Array<{ id: string; content?: string }> {
  if (!fs.existsSync(obsFile())) return [];
  return JSON.parse(fs.readFileSync(obsFile(), 'utf8')) as Array<{ id: string; content?: string }>;
}

describe('H25 — 观察预算口径与表示形式无关', () => {
  it('health.observationChars 量的是 Agent 自撰字节（payload），不是容器序列化长度', () => {
    const N = 30, PER = 950;
    const { text, payload } = legacyKnowledge(N, PER);
    fs.writeFileSync(file(), text, 'utf8');

    const store = new MemoryStore(dir);
    const health = store.getMemoryHealth();
    const live = readObs();
    const livePayload = live.reduce((s, e) => s + (e.content ?? '').length, 0);

    // 单一口径：横幅/触发器/裁剪器说的是同一个量 = payload。
    expect(health.observationChars).toBe(livePayload);
    // 并且它不是 JSON 容器长度 —— 若有人改回 `serializeRecords().length` 则此断言会红。
    const container = fs.existsSync(obsFile()) ? fs.readFileSync(obsFile(), 'utf8').length : 0;
    expect(container).toBeGreaterThan(0);
    expect(health.observationChars).toBeLessThan(container);
    // 健全性：夹具的 payload 确实低于上限（否则本用例什么都没证明）。
    expect(payload).toBeLessThan(MEMORY_OBSERVATIONS_MAX_CHARS);
  });

  it('payload 未超上限的旧数据，迁移后**不得**被驱逐到归档（表示变更不该改变谁还活着）', () => {
    const N = 30, PER = 950;
    const { text, payload } = legacyKnowledge(N, PER);
    expect(payload).toBeLessThan(MEMORY_OBSERVATIONS_MAX_CHARS);
    fs.writeFileSync(file(), text, 'utf8');

    // 迁移前：容器（JSON pretty）会因语法开销超过上限 —— 旧实现据此驱逐。
    const asJSON = JSON.stringify(
      Array.from({ length: N }, (_, i) => ({
        id: `obs_${1000 + i}`, timestamp: '2026-10-04T00:00:00.000Z', type: 'note',
        content: `observation-${i} ` + 'z'.repeat(PER), metadata: {},
      })), null, 2,
    ).length;
    expect(asJSON).toBeGreaterThan(MEMORY_OBSERVATIONS_MAX_CHARS); // 前提：确实会误判

    // eslint-disable-next-line no-new
    new MemoryStore(dir);

    const live = readObs();
    const livePayload = live.reduce((s, e) => s + (e.content ?? '').length, 0);
    const archived = fs.existsSync(obsArchive())
      ? (JSON.parse(fs.readFileSync(obsArchive(), 'utf8')) as unknown[]).length : 0;

    expect(archived).toBe(0);              // 修复前：archived = 6（静默驱逐）
    expect(live.length).toBe(N);           // 修复前：只剩 24 条
    expect(livePayload).toBe(payload);     // 一条不多、一条不少
  });
});
