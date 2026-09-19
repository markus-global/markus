// ChatComponents.tsx 会经 api.ts 读 window；沿用同一套显式桩。
vi.hoisted(() => {
  (globalThis as unknown as { window: unknown }).window = {
    __MARKUS_HUB_BASE_URL__: '',
    location: { origin: 'http://localhost' },
  } as unknown as Window & typeof globalThis;
  return true;
});

/**
 * 过程成组 —— 「思考 + 工具默认折成一行」的渲染骨架护栏。
 *
 * Owner 的要求：无论生成中还是生成完，气泡长得差不多；而**顺序不能动**
 * （思考 → 正文 → 执行 → 思考 要看得见）。所以这里锁两件事：
 *   ① 只分组、不搬运：正文块/过程块按原时间顺序出现，正文一句都不丢；
 *   ② 折叠行的摘要数字要对（思考几条、工具几个、还在不在跑、耗时）。
 */
import { describe, it, expect } from 'vitest';
import { groupProcessRuns, summarizeProcessRun, isProcessEntry } from '../src/pages/ChatComponents.tsx';

const T0 = '2026-09-19T15:00:00.000Z';
const at = (sec: number) => new Date(Date.parse(T0) + sec * 1000).toISOString();

type Entry = Parameters<typeof groupProcessRuns>[0][number];
let seq = 0;
const base = (type: Entry['type'], content: string, createdAt: string, metadata?: Record<string, unknown>): Entry => ({
  id: `e${seq++}`,
  sourceType: 'chat',
  sourceId: '',
  agentId: 'agt_1',
  seq: seq,
  type,
  content,
  ...(metadata ? { metadata } : {}),
  createdAt,
});

const think = (c: string, sec: number) => base('text', c, at(sec), { isThinking: true });
const prose = (c: string, sec: number) => base('text', c, at(sec));
const tStart = (name: string, sec: number) => base('tool_start', name, at(sec));
const tEnd = (name: string, sec: number) => base('tool_end', name, at(sec));

describe('过程成组：只分组、不搬运', () => {
  it('空输入 → 空块', () => {
    expect(groupProcessRuns([])).toEqual([]);
  });

  it('思考 / 工具属于过程，正文不属于', () => {
    expect(isProcessEntry(think('r', 0))).toBe(true);
    expect(isProcessEntry(tStart('file_read', 0))).toBe(true);
    expect(isProcessEntry(prose('正文', 0))).toBe(false);
  });

  it('真实形状：思考+工具 → 正文 → 思考+工具(收尾) 生成三块，顺序原样', () => {
    const blocks = groupProcessRuns([
      think('先看一下文件', 0),
      tStart('file_read', 1),
      tEnd('file_read', 2),
      prose('看完了，问题在这里。', 3),
      think('接着改', 4),
      tStart('file_edit', 5),
      tEnd('file_edit', 6),
    ]);

    expect(blocks.map(b => b.kind)).toEqual(['process', 'text', 'process']);
    expect(blocks[1]).toMatchObject({ kind: 'text', entry: { content: '看完了，问题在这里。' } });
  });

  it('摘要：思考条数、工具个数、耗时（只认真实时间戳）', () => {
    const blocks = groupProcessRuns([
      think('r1', 0),
      think('r2', 1),
      tStart('shell_execute', 2),
      tEnd('shell_execute', 4),
      tStart('grep_search', 5),
      tEnd('grep_search', 7),
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe('process');
    const s = (blocks[0] as Extract<typeof blocks[number], { kind: 'process' }>).summary;
    expect(s.thinkingCount).toBe(2);
    expect(s.toolCount).toBe(2);
    expect(s.running).toBe(false);
    expect(s.elapsedMs).toBe(7000);
    expect(s.tailIsThinking).toBe(false);
  });

  it('最后一个工具还没结束 → running + runningTool（折叠行显示「正在运行 X」）', () => {
    const blocks = groupProcessRuns([think('开始', 0), tStart('shell_execute', 1)]);
    const s = (blocks[0] as Extract<typeof blocks[number], { kind: 'process' }>).summary;
    expect(s.running).toBe(true);
    expect(s.runningTool).toBe('shell_execute');
    expect(s.toolCount).toBe(1);
  });

  it('纯思考收尾 → tailIsThinking（折叠行显示「思考中…」）', () => {
    const s = summarizeProcessRun([tStart('file_read', 0), tEnd('file_read', 1), think('再想想', 2)]);
    expect(s.running).toBe(false);
    expect(s.tailIsThinking).toBe(true);
  });

  it('过程行被正文隔开就分成两块（不会跨正文合并）', () => {
    const blocks = groupProcessRuns([
      think('a', 0),
      prose('第一段', 1),
      tStart('file_read', 2),
      prose('第二段', 3),
    ]);
    expect(blocks.map(b => b.kind)).toEqual(['process', 'text', 'process', 'text']);
    expect(blocks.filter(b => b.kind === 'text').map(b => (b as { entry: { content: string } }).entry.content))
      .toEqual(['第一段', '第二段']);
  });

  it('没有真实时间戳（非流式老数据）→ 耗时为 0，不编造数字', () => {
    const same = [
      base('tool_start', 'file_read', 'Sun, 01 Jan 2023 00:00:00 GMT'),
      base('tool_end', 'file_read', 'Sun, 01 Jan 2023 00:00:00 GMT'),
    ];
    expect(summarizeProcessRun(same).elapsedMs).toBe(0);
  });

  it('正文本身一条都不会丢（分组是纯函数，不增删内容）', () => {
    const entries = [prose('一', 0), think('r', 1), tStart('x', 2), tEnd('x', 3), prose('二', 4)];
    const blocks = groupProcessRuns(entries);
    const texts = blocks.filter(b => b.kind === 'text').map(b => (b as { entry: { content: string } }).entry.content);
    const procCount = blocks.filter(b => b.kind === 'process')
      .reduce((n, b) => n + (b as { entries: unknown[] }).entries.length, 0);
    expect(texts).toEqual(['一', '二']);
    expect(procCount).toBe(3); // 思考 + start + end 一条不少
  });
});
