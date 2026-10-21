/**
 * 流事件批量落盘回归（M3）。
 *
 * 背景：`execution_stream_logs` 每个流事件写一行（tool_start / tool_end / status /
 * 正文 flush），node:sqlite 下每次 `run()` 是独立隐式事务 = 每个事件一次 WAL 提交
 * （fsync）。实测 427 万行 / 5.9 GB，是全系统写入频率最高的表。
 *
 * 本文件锁四件事（对应 stream-write-batcher.ts 的四条不变量）：
 *   I1 读取绝不漏掉缓冲区里的行 —— 任何读路径先 flush
 *   I2 顺序保持 —— 批量写入后 seq 顺序与 push 顺序一致
 *   I3/I4 批量生效且不重复 —— 100 条只产生 1 次写入批次
 *   I5 删除前先 flush —— 否则"删掉的来源"会被缓冲区复活
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openSqlite, closeSqlite, SqliteExecutionStreamRepo } from '../src/sqlite-storage.js';
import { StreamWriteBatcher } from '../src/stream-write-batcher.js';

function evt(sourceId: string, seq: number, type = 'tool_start') {
  return {
    sourceType: 'task',
    sourceId,
    agentId: 'agt_test',
    seq,
    type,
    content: `c${seq}`,
    metadata: { seq },
  };
}

describe('StreamWriteBatcher（纯缓冲逻辑）', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('未 flush 前不写；flush 后一次性写出全部（I1/I3）', () => {
    const writes: unknown[][] = [];
    const b = new StreamWriteBatcher<{ n: number }>({ writer: rows => writes.push(rows), maxRows: 100 });
    b.push({ n: 1 });
    b.push({ n: 2 });
    expect(writes).toHaveLength(0);
    expect(b.pendingCount()).toBe(2);
    b.flush();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toHaveLength(2);
    expect(b.pendingCount()).toBe(0);
  });

  it('达到 maxRows 立即自动 flush', () => {
    const writes: unknown[][] = [];
    const b = new StreamWriteBatcher<number>({ writer: rows => writes.push(rows), maxRows: 3 });
    b.push(1); b.push(2);
    expect(writes).toHaveLength(0);
    b.push(3); // 触发
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual([1, 2, 3]);
  });

  it('定时器到期自动 flush', () => {
    vi.useFakeTimers();
    const writes: unknown[][] = [];
    const b = new StreamWriteBatcher<number>({ writer: rows => writes.push(rows), flushIntervalMs: 250 });
    b.push(1);
    expect(writes).toHaveLength(0);
    vi.advanceTimersByTime(249);
    expect(writes).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(writes).toHaveLength(1);
  });

  it('dispose 会 flush 且之后 push 报错', () => {
    const writes: unknown[][] = [];
    const b = new StreamWriteBatcher<number>({ writer: rows => writes.push(rows) });
    b.push(1);
    b.dispose();
    expect(writes).toHaveLength(1);
    expect(() => b.push(2)).toThrow(/dispose/);
  });

  it('writer 抛错不会重复写（I4：先排空再写）', () => {
    let calls = 0;
    const b = new StreamWriteBatcher<number>({
      writer: () => { calls += 1; throw new Error('boom'); },
    });
    b.push(1);
    expect(() => b.flush()).toThrow('boom');
    expect(calls).toBe(1);
    expect(b.pendingCount()).toBe(0); // 已排空，不会二次写
    b.flush(); // 空缓冲 = no-op，不再抛
    expect(calls).toBe(1);
  });
});

describe('SqliteExecutionStreamRepo 批量落盘（真库）', () => {
  let tempDir: string;
  let dbPath: string;
  let repo: SqliteExecutionStreamRepo;

  beforeEach(() => {
    closeSqlite();
    tempDir = mkdtempSync(join(tmpdir(), 'markus-stream-batch-'));
    dbPath = join(tempDir, 'data.db');
    repo = new SqliteExecutionStreamRepo(openSqlite(dbPath));
  });

  afterEach(() => {
    repo.dispose();
    closeSqlite();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('append 先入缓冲，读取时自动 flush 且顺序不变（I1/I2）', () => {
    repo.append(evt('t1', 0));
    repo.append(evt('t1', 1));
    repo.append(evt('t1', 2));
    expect(repo.stats().pending).toBe(3);

    const rows = repo.getBySource('task', 't1');
    expect(rows.map(r => r.seq)).toEqual([0, 1, 2]);
    expect(repo.stats().pending).toBe(0);
    expect(repo.stats().written).toBe(3);
  });

  it('100 条事件只产生 1 个写入批次（I3）', () => {
    for (let i = 0; i < 100; i += 1) repo.append(evt('t100', i));
    const s = repo.stats();
    expect(s.written).toBe(100);
    expect(s.batches).toBe(1);
    expect(s.pending).toBe(0);
    expect(repo.getBySource('task', 't100')).toHaveLength(100);
  });

  it('getMaxSeq 前先 flush，不会读到过期序号（I1）', () => {
    repo.append(evt('t2', 0));
    repo.append(evt('t2', 7));
    expect(repo.getMaxSeq('task', 't2')).toBe(7);
  });

  it('deleteBySource 前先 flush —— 删掉的来源不会被缓冲区复活（I1）', () => {
    repo.append(evt('t3', 0));
    repo.append(evt('t3', 1));
    repo.deleteBySource('task', 't3');
    expect(repo.getBySource('task', 't3')).toHaveLength(0);
    expect(repo.stats().pending).toBe(0);
  });

  it('append 同步返回可用行（id / created_at 立刻可读）', () => {
    const row = repo.append(evt('t4', 0));
    expect(row.id).toMatch(/^esl_/);
    expect(row.createdAt).toBeTruthy();
    expect(row.metadata).toEqual({ seq: 0 });
  });
});
