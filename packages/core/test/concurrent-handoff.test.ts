import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ConcurrentHandoffLog,
  HANDOFF_COMPACT_THRESHOLD,
} from '../src/concurrent-handoff.js';

// ── 并发交接日志（ConcurrentHandoffLog）审计回归 ─────────────────────────────
// 覆盖审计发现的缺陷：
//  1. clear() 用 appendFileSync(path,'') 只写 0 字节，**不截断文件** → 重启后记录回归
//  2. 纯 append、从不轮转 → 文件无界增长
//  3. 模块级 seq 跨实例共享 → 多实例 id 不保证唯一
//
// 注：旧实现的 `inFlight()` 已删除 —— 它试图从**历史**反推「现在谁在干活」，那在结构上
// 就是错的（永远无法确定一条没有 `done` 的 `declared` 是因为还在跑，还是因为进程被
// 杀了）。权威在途信号只有 `AttentionController.getActiveClaims()`（实时状态），
// 回归覆盖見 context-concurrency-notebook.test.ts。

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'markus-handoff-'));
  file = join(dir, 'concurrent-handoffs.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ConcurrentHandoffLog', () => {
  it('clear() 必须真正截断磁盘文件（重启后不得复活旧记录）', () => {
    const log = new ConcurrentHandoffLog(file);
    log.append('declared', 1, 'task:t1', '开始处理 t1');
    log.append('done', 1, 'task:t1', '处理完成');
    expect(readFileSync(file, 'utf-8').length).toBeGreaterThan(0);

    log.clear();
    expect(log.size).toBe(0);
    // 关键：磁盘清零，否则 load() 会把「已清空」的记录读回来
    expect(readFileSync(file, 'utf-8')).toBe('');

    const reloaded = new ConcurrentHandoffLog(file);
    reloaded.load();
    expect(reloaded.size).toBe(0);
  });

  it('磁盘文件有界：超过压实阈值后行数收敛，且与内存视图一致', () => {
    const log = new ConcurrentHandoffLog(file, 16);
    const total = HANDOFF_COMPACT_THRESHOLD * 3;
    for (let i = 0; i < total; i++) {
      log.append('done', (i % 3) + 1, `task:t${i}`, `事件 ${i}`);
    }
    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    // 旧实现纯 append、从不轮转 → lines === total（1536）。压实后上界为
    // 「最近一次压实写入的 maxKeep 行 + 其后尚未压实的追加行（< 阈值）」。
    expect(lines.length).toBeLessThanOrEqual(16 + HANDOFF_COMPACT_THRESHOLD);
    expect(lines.length).toBeLessThan(total);
    // 内存视图仍是 maxKeep 上界；文件内容包含内存视图的最后一条（时间序一致）
    expect(log.size).toBeLessThanOrEqual(16);
    const last = JSON.parse(lines[lines.length - 1]!) as { summary: string };
    expect(last.summary).toBe(`事件 ${total - 1}`);
  });

  it('id 在跨实例间唯一（旧实现用模块级 seq，多实例会撞号）', () => {
    const a = new ConcurrentHandoffLog();
    const b = new ConcurrentHandoffLog();
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      ids.add(a.append('done', 1, undefined, `a${i}`).id);
      ids.add(b.append('done', 1, undefined, `b${i}`).id);
    }
    expect(ids.size).toBe(10);
  });

  it('load() 跳过损坏行且容忍缺失文件', () => {
    writeFileSync(file, '{"id":"1","workerId":1,"kind":"declared","summary":"ok"}\nNOT JSON\n\n', 'utf-8');
    const log = new ConcurrentHandoffLog(file);
    log.load();
    expect(log.size).toBe(1);

    const missing = new ConcurrentHandoffLog(join(dir, 'nope.jsonl'));
    expect(() => missing.load()).not.toThrow();
    expect(missing.size).toBe(0);
  });

  it('load() 后已存在记录不会在压实前被再次重复写入', () => {
    const first = new ConcurrentHandoffLog(file, 16);
    for (let i = 0; i < 5; i++) first.append('done', 1, `task:t${i}`, `e${i}`);

    const second = new ConcurrentHandoffLog(file, 16);
    second.load();
    expect(second.size).toBe(5);
    expect(existsSync(file)).toBe(true);
    // 追加一条后磁盘行数 = 6（不是 5+1 两次计数）
    second.append('done', 2, 'task:new', 'new');
    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    expect(lines.length).toBe(6);
  });
});
