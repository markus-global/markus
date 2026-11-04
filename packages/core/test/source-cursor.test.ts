/**
 * 拉取侧位点：**只有全部消费成功才推进**。
 *
 * 这个文件的每一条断言都对应一种「静默丢事件」的形状：
 *  - 失败也推进 → 上游认为你收过了，你却没收（永久丢）；
 *  - 空批次不推进 → 同一页被永远重拉（位点不生效）；
 *  - 乱序/并发推进 → 慢的覆盖快的（位点后退）。
 */
import { describe, expect, it } from 'vitest';
import { consumeBatch, mintCursorAdvance } from '../src/source-cursor.js';
import type { PullSource } from '../src/source-cursor.js';
import type { IngressResult } from '../src/event-ingress.js';
import type { RawEvent } from '../src/event-source.js';

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const raw = (prefix = 'rss'): RawEvent => ({
  prefix,
  headers: {},
  rawBody: Buffer.from('{}'),
  secret: 's',
});

/** 真仓储的行为等价物：CAS 推进 + 位点持久化。 */
class FakeSources {
  row: PullSource = { id: 'src_1', prefix: 'rss', cursor: null, config: {} };
  writes: Array<{ expectedCursor: string | null; cursor: string | null }> = [];
  /** 模拟「读到之后、写之前，另一个拉取者先提交了」 */
  onBeforeWrite?: (s: FakeSources) => void;
  getById(id: string) {
    // 返回**快照**：调用方拿到的是「读取那一刻」的位点（真仓储也一样）
    return id === this.row.id ? { ...this.row } : null;
  }
  advanceCursor(a: { sourceId: string; expectedCursor: string | null; cursor: string | null; polledAt: number }) {
    this.onBeforeWrite?.(this);
    this.writes.push({ expectedCursor: a.expectedCursor, cursor: a.cursor });
    if (this.row.cursor !== a.expectedCursor) return false; // CAS
    this.row.cursor = a.cursor;
    return true;
  }
}

/** 可编排的入口：只回放预置结果（真 EventIngress 的结构子集）。 */
function fakeIngress(script: IngressResult[]) {
  let i = 0;
  return {
    calls: 0,
    ingest() {
      this.calls++;
      return script[Math.min(i++, script.length - 1)]!;
    },
  };
}

const ok = (events: number): IngressResult => ({ status: 'ignored', reason: '留痕', events });

describe('mintCursorAdvance — 失败拿不到凭证（不变量在类型 + 运行时两层）', () => {
  it('failed > 0 直接抛错，且错误里给出可行动提示', () => {
    expect(() =>
      mintCursorAdvance({ sourceId: 'src_1', expectedCursor: null, cursor: 'p2', polledAt: NOW, consumed: 1, failed: 1 }),
    ).toThrow(/CURSOR_ADVANCE_AFTER_FAILURE/);
    expect(() =>
      mintCursorAdvance({ sourceId: 'src_1', expectedCursor: null, cursor: 'p2', polledAt: NOW, consumed: 1, failed: 1 }),
    ).toThrow(/重试同一位置/);
  });

  it('全部成功时才铸得出凭证', () => {
    const a = mintCursorAdvance({ sourceId: 'src_1', expectedCursor: null, cursor: 'p2', polledAt: NOW, consumed: 2, failed: 0 });
    expect(a.cursor).toBe('p2');
    expect(a.expectedCursor).toBeNull();
  });
});

describe('consumeBatch — 两轮消费只拿新增（位点生效）', () => {
  it('第一轮提交 p2，第二轮从 p2 读、只提交 p3', () => {
    const sources = new FakeSources();
    const ingress = fakeIngress([ok(2), ok(1)]);

    const r1 = consumeBatch({ sources, ingress, now: () => NOW }, { sourceId: 'src_1', raw: raw(), nextCursor: 'p2' });
    expect(r1.status).toBe('committed');
    expect(r1.cursor).toBe('p2');
    expect(sources.row.cursor).toBe('p2');

    const r2 = consumeBatch({ sources, ingress, now: () => NOW }, { sourceId: 'src_1', raw: raw(), nextCursor: 'p3' });
    expect(r2.status).toBe('committed');
    // CAS 期望值必须是上一轮提交的位点 —— 这就是「第二轮从 p2 读」的可判定证据
    expect(sources.writes[1]!.expectedCursor).toBe('p2');
    expect(sources.row.cursor).toBe('p3');
  });

  it('空批次也推进：拉取成功但这一页没有新事件同样是「读过了」', () => {
    const sources = new FakeSources();
    const ingress = fakeIngress([{ status: 'ignored', reason: '该载荷不包含需要处理的事件', events: 0 }]);
    const r = consumeBatch({ sources, ingress, now: () => NOW }, { sourceId: 'src_1', raw: raw(), nextCursor: 'p1' });
    expect(r.status).toBe('committed');
    expect(r.consumed).toBe(0);
    expect(sources.row.cursor).toBe('p1');
  });
});

describe('consumeBatch — 消费失败，位点一动不动', () => {
  it('有 failed 事件时提交被拒绝，cursor 保持原值', () => {
    const sources = new FakeSources();
    sources.row.cursor = 'p1';
    const ingress = fakeIngress([
      { status: 'ignored', failed: true, reason: '归一化失败：bad payload', events: 2, results: [
        { status: 'ignored', failed: true, reason: '归一化失败：bad payload', events: 1 },
        { status: 'ignored', reason: '留痕', events: 1 },
      ] },
    ]);
    const r = consumeBatch({ sources, ingress, now: () => NOW }, { sourceId: 'src_1', raw: raw(), nextCursor: 'p9' });
    expect(r.status).toBe('not-committed');
    expect(r.failed).toBe(1);
    expect(r.cursor).toBe('p1');
    expect(sources.row.cursor).toBe('p1');
    // 关键：**没有发生任何写入**（不是「写了旧值」，是根本没写）
    expect(sources.writes).toHaveLength(0);
  });

  it('入口整体抛异常也按失败处理，不推进', () => {
    const sources = new FakeSources();
    sources.row.cursor = 'p1';
    const r = consumeBatch(
      { sources, ingress: { ingest() { throw new Error('db gone'); } }, now: () => NOW },
      { sourceId: 'src_1', raw: raw(), nextCursor: 'p9' },
    );
    expect(r.status).toBe('not-committed');
    expect(r.reason).toContain('db gone');
    expect(sources.row.cursor).toBe('p1');
  });

  it('来源不存在 → missing-source，不写入', () => {
    const sources = new FakeSources();
    const r = consumeBatch({ sources, ingress: fakeIngress([ok(1)]), now: () => NOW }, { sourceId: 'src_nope', raw: raw(), nextCursor: 'p1' });
    expect(r.status).toBe('missing-source');
    expect(sources.writes).toHaveLength(0);
  });
});

describe('consumeBatch — CAS 挡住乱序推进（慢的不会覆盖快的）', () => {
  it('读到之后被别人推进 → stale，位点不被覆盖（慢的不覆盖快的）', () => {
    const sources = new FakeSources();
    sources.row.cursor = 'p1';
    // 竞态：本拉取者读到 p1，正要把 p2 写回去时，另一个拉取者已经推到 p5
    sources.onBeforeWrite = s => {
      s.row.cursor = 'p5';
      s.onBeforeWrite = undefined;
    };
    const r = consumeBatch({ sources, ingress: fakeIngress([ok(1)]), now: () => NOW }, { sourceId: 'src_1', raw: raw(), nextCursor: 'p2' });
    expect(r.status).toBe('stale');
    expect(sources.row.cursor).toBe('p5');
    expect(r.cursor).toBe('p1'); // 本次读到的位置，未提交
  });
});
