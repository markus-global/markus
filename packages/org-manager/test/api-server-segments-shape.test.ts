/**
 * Non-streaming persisted-segment shape (shared constructor).
 *
 * The SSE path already stamps every segment it persists with `createdAt`; the
 * two non-streaming chat endpoints used to hand-roll the same array *without* it,
 * so the same DB column held two different row shapes depending on whether the
 * client asked for a stream. These tests pin the constructed shape to the
 * authoritative one (read off the live SQLite rows written by the streaming
 * path), field name by field name:
 *
 *   • thinking → { type:'text', content:'', thinking, createdAt }
 *   • tool     → { type:'tool', tool, status, arguments, result?, error?, durationMs, createdAt }
 *   • prose    → { type:'text', content, createdAt }
 *
 * Keys are asserted as a sorted set (not just presence) so an extra or missing
 * field — the exact class of bug this refactor removes — fails loudly.
 */
import { describe, it, expect } from 'vitest';
import {
  buildNonStreamingSegments,
  type NonStreamingToolEvent,
} from '../src/api-server.js';

/** Sorted key set of a plain object — the assertion currency for shape parity. */
const keysOf = (o: Record<string, unknown>): string[] => Object.keys(o).sort();

const THINKING_KEYS = ['content', 'createdAt', 'thinking', 'type'];
const TOOL_KEYS = ['arguments', 'createdAt', 'durationMs', 'result', 'status', 'tool', 'type'];
/** Same as TOOL_KEYS plus `error` — i.e. a failed tool that still carries its result. */
const TOOL_ERROR_KEYS = [...TOOL_KEYS, 'error'].sort();
const PROSE_KEYS = ['content', 'createdAt', 'type'];

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const expectIsoStamp = (value: unknown): void => {
  expect(typeof value).toBe('string');
  const s = value as string;
  // Format must be exactly what `new Date().toISOString()` produces …
  expect(s).toMatch(ISO_RE);
  // … and it must be a real, round-trippable instant (not e.g. a shifted clock).
  expect(new Date(s).toISOString()).toBe(s);
  expect(Number.isNaN(Date.parse(s))).toBe(false);
};

const evt = (over: Partial<NonStreamingToolEvent> = {}): NonStreamingToolEvent => ({
  tool: 'read_file',
  status: 'done',
  arguments: { path: '/tmp/a.ts' },
  result: 'file contents',
  durationMs: 42,
  ...over,
});

describe('buildNonStreamingSegments — 段形状与流式路径对齐', () => {
  it('三个段的 key 集合与权威形状逐字段一致（含 createdAt）', () => {
    const segments = buildNonStreamingSegments({
      thinking: ['让我先看看文件', '再看调用点'],
      toolEvents: [evt()],
      cleanReply: '这是正文回答。',
    });

    expect(segments).toBeDefined();
    expect(segments).toHaveLength(3);

    const [think, tool, prose] = segments!;
    expect(keysOf(think!)).toEqual(THINKING_KEYS);
    expect(keysOf(tool!)).toEqual(TOOL_KEYS);
    expect(keysOf(prose!)).toEqual(PROSE_KEYS);
  });

  it('每个段都带合法的 ISO createdAt，且格式与 new Date().toISOString() 完全一致', () => {
    const segments = buildNonStreamingSegments({
      thinking: ['思考'],
      toolEvents: [evt(), evt({ tool: 'grep', durationMs: 7 })],
      cleanReply: '正文',
    })!;

    expect(segments).toHaveLength(4);
    for (const seg of segments) expectIsoStamp(seg['createdAt']);
  });

  it('同一轮内 createdAt 严格递增 → 时间线可按 createdAt 排序而不打乱顺序', () => {
    const segments = buildNonStreamingSegments({
      thinking: ['思考'],
      toolEvents: [evt(), evt({ tool: 'b' }), evt({ tool: 'c' })],
      cleanReply: '正文',
    })!;

    const stamps = segments.map(s => Date.parse(s['createdAt'] as string));
    expect(stamps).toHaveLength(5);
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i]!).toBeGreaterThan(stamps[i - 1]!);
    }
  });

  it('顺序为 思考 → 工具… → 正文，且字段内容按语义填充', () => {
    const segments = buildNonStreamingSegments({
      thinking: ['第一段思考', '第二段思考'],
      toolEvents: [evt({ tool: 'grep_search' }), evt({ tool: 'read_file' })],
      cleanReply: '最终回答',
    })!;

    expect(segments.map(s => s['type'])).toEqual(['text', 'tool', 'tool', 'text']);

    // 思考段：content 为空串，thinking 为 blocks 以空行拼接
    expect(segments[0]).toMatchObject({
      type: 'text',
      content: '',
      thinking: '第一段思考\n\n第二段思考',
    });

    // 工具段：按执行顺序保留 tool / status / arguments / result / durationMs
    expect(segments[1]).toMatchObject({
      type: 'tool',
      tool: 'grep_search',
      status: 'done',
      arguments: { path: '/tmp/a.ts' },
      result: 'file contents',
      durationMs: 42,
    });
    expect(segments[2]).toMatchObject({ type: 'tool', tool: 'read_file' });

    // 正文段：content 为剥离思考后的正文
    expect(segments[3]).toMatchObject({ type: 'text', content: '最终回答' });
    expect(segments[3]).not.toHaveProperty('thinking');
  });

  it('工具段带 error 时形状正确（失败工具）', () => {
    // Mirrors what the streaming path persists for a failed tool: the error text
    // also lands in `result`, and `error` carries the message.
    const segments = buildNonStreamingSegments({
      thinking: [],
      toolEvents: [
        evt({ tool: 'run_script', status: 'error', result: 'Error: ETIMEDOUT', error: 'ETIMEDOUT', durationMs: 30_000 }),
      ],
      cleanReply: '失败了',
    })!;

    const tool = segments[0]!;
    expect(keysOf(tool)).toEqual(TOOL_ERROR_KEYS);
    expect(tool).toMatchObject({
      type: 'tool',
      tool: 'run_script',
      status: 'error',
      error: 'ETIMEDOUT',
      result: 'Error: ETIMEDOUT',
      durationMs: 30_000,
    });
    expect(Object.values(tool)).not.toContain('undefined');
    expectIsoStamp(tool['createdAt']);
  });

  it('失败工具未提供 result 时，result 键不出现（但不是字符串 "undefined"）', () => {
    const segments = buildNonStreamingSegments({
      thinking: [],
      toolEvents: [evt({ tool: 'run_script', status: 'error', result: undefined, error: 'ETIMEDOUT' })],
      cleanReply: '失败了',
    })!;

    const tool = segments[0]!;
    expect(keysOf(tool)).toEqual(['arguments', 'createdAt', 'durationMs', 'error', 'status', 'tool', 'type']);
    expect(tool).not.toHaveProperty('result');
    expect(Object.values(tool)).not.toContain('undefined');
  });

  it('没有 thinking → 不含思考段', () => {
    const segments = buildNonStreamingSegments({
      thinking: [],
      toolEvents: [evt()],
      cleanReply: '只有正文和工具',
    })!;

    expect(segments).toHaveLength(2);
    expect(segments.map(s => s['type'])).toEqual(['tool', 'text']);
    expect(keysOf(segments[0]!)).toEqual(TOOL_KEYS);
    expect(keysOf(segments[1]!)).toEqual(PROSE_KEYS);
  });

  it('没有工具 → 不含工具段', () => {
    const segments = buildNonStreamingSegments({
      thinking: ['思考'],
      toolEvents: [],
      cleanReply: '只有思考和正文',
    })!;

    expect(segments).toHaveLength(2);
    expect(segments.map(s => s['type'])).toEqual(['text', 'text']);
    expect(keysOf(segments[0]!)).toEqual(THINKING_KEYS);
    expect(keysOf(segments[1]!)).toEqual(PROSE_KEYS);
  });

  it('全空 → 返回 undefined（而不是空数组）', () => {
    const segments = buildNonStreamingSegments({ thinking: [], toolEvents: [], cleanReply: '' });
    expect(segments).toBeUndefined();
  });

  it('只有正文（无 thinking / 无工具）→ 仍返回 undefined —— 保留原有守卫，不改变行为', () => {
    // ⚠️ 这是**刻意保留**的既有语义：原非流式代码里的正文 push 由
    // `if (segments.length > 0)` 守卫，因此纯文本回答本来就不产生任何 segment
    // （前端走纯文本渲染回退）。本次「统一构造」不得顺带改掉它。
    const segments = buildNonStreamingSegments({
      thinking: [],
      toolEvents: [],
      cleanReply: '直接回答',
    });
    expect(segments).toBeUndefined();
  });

  it('正文段永远排在最后（无工具时 思考 → 正文）', () => {
    const segments = buildNonStreamingSegments({
      thinking: ['占位思考'],
      toolEvents: [],
      cleanReply: '直接回答',
    })!;

    expect(segments).toHaveLength(2);
    expect(segments.map(s => s['type'])).toEqual(['text', 'text']);
    expect(keysOf(segments[1]!)).toEqual(PROSE_KEYS);
    expect(segments[1]).toMatchObject({ type: 'text', content: '直接回答' });
  });

  it('省略的可选字段不落成键（undefined 不泄漏）', () => {
    const segments = buildNonStreamingSegments({
      thinking: [],
      toolEvents: [{ tool: 'noop', status: 'running' }],
      cleanReply: 'x',
    })!;

    const tool = segments[0]!;
    // 只保留必填三字段 + createdAt，其余一律不出现
    expect(keysOf(tool)).toEqual(['createdAt', 'status', 'tool', 'type']);
    expect(Object.values(tool)).not.toContain(undefined);
  });

  it('JSON 往返后形状不变（持久化到 SQLite 的那一步）', () => {
    const segments = buildNonStreamingSegments({
      thinking: ['t'],
      toolEvents: [evt(), evt({ tool: 'b', status: 'error', error: 'boom' })],
      cleanReply: 'r',
    })!;

    const roundTripped = JSON.parse(JSON.stringify(segments));
    expect(roundTripped).toEqual(segments);
    expect(keysOf(roundTripped[1])).toEqual(TOOL_KEYS);
    expect(keysOf(roundTripped[2])).toEqual(TOOL_ERROR_KEYS);
  });
});
