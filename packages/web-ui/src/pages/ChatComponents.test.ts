import { describe, expect, it, vi } from 'vitest';

// ChatComponents.tsx transitively imports api.ts which reads `window` at module
// load. jsdom is not installed in this repo, so provide a minimal window stub
// BEFORE the component module is imported. vi.hoisted runs before imports.
const _stub = vi.hoisted(() => {
  (globalThis as unknown as { window: unknown }).window = {
    __MARKUS_HUB_BASE_URL__: '',
    location: { origin: 'http://localhost' },
  } as unknown as Window & typeof globalThis;
  return true;
});

describe('segmentsToStreamEntries thinking merge', () => {
  it('merges repeated thinking segments into a single thinking row', async () => {
    const { segmentsToStreamEntries } = await import('./ChatComponents.tsx');
    const entries = segmentsToStreamEntries(
      [
        { type: 'text' as const, content: '', thinking: 'first reasoning', createdAt: '2026-08-02T07:04:00.000Z' },
        { type: 'text' as const, content: '', thinking: 'second reasoning', createdAt: '2026-08-02T07:04:01.000Z' },
        { type: 'text' as const, content: 'final answer', createdAt: '2026-08-02T07:04:02.000Z' },
      ],
      'agt_1',
      '2026-08-02T07:04:00.000Z',
    );

    const thinking = entries.filter(e => e.type === 'text' && e.metadata?.isThinking);
    expect(thinking).toHaveLength(1);
    expect(thinking[0]!.content).toBe('first reasoning\n\nsecond reasoning');
    const texts = entries.filter(e => e.type === 'text' && !e.metadata?.isThinking);
    expect(texts.some(e => e.content === 'final answer')).toBe(true);
  });

  it('does not duplicate thinking when body mentions "thinking" mid-sentence', async () => {
    const { segmentsToStreamEntries } = await import('./ChatComponents.tsx');
    const entries = segmentsToStreamEntries(
      [
        { type: 'text' as const, content: 'I was thinking about the response layout', createdAt: '2026-08-02T07:04:00.000Z' },
      ],
      'agt_1',
      '2026-08-02T07:04:00.000Z',
    );

    expect(entries.filter(e => e.type === 'text' && e.metadata?.isThinking)).toHaveLength(0);
    const texts = entries.filter(e => e.type === 'text' && !e.metadata?.isThinking);
    expect(texts.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Live bubble rendering ────────────────────────────────────────────────────
// Regression guard for "the bubble is empty while the answer streams": live
// `segments` (not just the completed turn) must drive the visible body text.

describe('AgentMessageBody live streaming bubble', () => {
  const render = async (msg: Record<string, unknown>, isStreaming: boolean) => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const React = await import('react');
    const { AgentMessageBody } = await import('./ChatComponents.tsx');
    return renderToStaticMarkup(
      React.createElement(AgentMessageBody, {
        msg: {
          id: 'm', sender: 'agent', time: '',
          rawCreatedAt: '2026-09-11T00:00:00.000Z',
          isStreaming,
          ...msg,
        },
        isStreaming,
        liveActivities: [],
      } as never),
    );
  };

  it('renders answer prose while the turn is still streaming (no tool rows yet)', async () => {
    const html = await render(
      { text: '正在流式输出的回答', segments: [{ type: 'text', content: '正在流式输出的回答' }] },
      true,
    );
    expect(html).toContain('正在流式输出的回答');
    expect(html).not.toContain('activity-text-shimmer');
  });

  it('shows the thinking indicator (not a blank bubble) when only reasoning arrived', async () => {
    const html = await render(
      { text: '', segments: [{ type: 'text', content: '', thinking: '内心独白内容' }] },
      true,
    );
    expect(html).toContain('activity-text-shimmer');
    // Reasoning is never rendered as the answer body while streaming.
    expect(html).not.toContain('内心独白内容');
  });

  it('reasoning + tools collapse into one process row; details are behind a click', async () => {
    const html = await render(
      {
        text: '答案',
        segments: [
          { type: 'text', content: '', thinking: '内心独白内容' },
          { type: 'tool', key: 't1', tool: 'shell_execute', status: 'running' },
          { type: 'text', content: '答案' },
        ],
      },
      true,
    );
    // 折叠行在，而且是个可展开的按钮（默认 aria-expanded=false）。
    // 这个夹具里工具还在跑（status: 'running'），所以收起行显示的是活标签
    // 「正在运行 shell_execute…」，不是「思考 · N 个工具调用」的计数摘要 ——
    // 跑着的工具必须显示成正在进行，哪怕它不在时间线的最后一块。
    expect(html).toContain('data-process-state="running"');
    expect(html).toContain('execution.processRun.runningTool');
    expect(html).toContain('aria-expanded="false"');
    // 默认收起：思考/工具明细不铺在气泡里，想看的人点开 —— 这正是「生成中与生成完
    // 气泡一样长」的前提。明细本身由 groupProcessRuns 的单测保证不丢。
    expect(html).not.toContain('内心独白内容');
    // 正文照常显示。
    expect(html).toContain('答案');
  });
});

// ─── ProcessRun 折叠行的状态图标 ─────────────────────────────────────────────
// 收起状态下，开头那个小图标是用户唯一的进度线索：还在跑？跑完了？还是跑挂了？
// 所以三个状态必须给三种**形状不同**的图标 —— 只换颜色在 11px 高的一行里等于没换，
// 对色觉障碍用户更是完全无感。

describe('ProcessRunIcon — 三态图标', () => {
  const render = async (state: 'running' | 'error' | 'done') => {
    const { ProcessRunIcon } = await import('./ChatComponents.tsx');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const React = await import('react');
    return renderToStaticMarkup(React.createElement(ProcessRunIcon, { state } as never));
  };

  it('三种状态两两不同（不是只换颜色的同一个图形）', async () => {
    const [running, done, error] = await Promise.all([
      render('running'), render('done'), render('error'),
    ]);
    expect(new Set([running, done, error]).size).toBe(3);
  });

  it('执行中 = 转圈的弧线，走 tick 驱动的 animate-spin（不额外产帧）', async () => {
    const running = await render('running');
    expect(running).toContain('animate-spin');
    expect(running).not.toContain('M20 6.5'); // 不是勾
  });

  it('已完成 = 对勾，且不转（静态图标，不花电）', async () => {
    const done = await render('done');
    expect(done).toContain('M20 6.5');
    expect(done).not.toContain('animate-spin');
  });

  it('有失败 = 三角形惊叹号，绝不显示成表示完成的勾', async () => {
    const error = await render('error');
    expect(error).toContain('10.29 3.86');
    expect(error).not.toContain('M20 6.5');
  });
});

describe('ProcessRun — 折叠行的状态判定', () => {
  const render = async (msg: Record<string, unknown>, isStreaming: boolean) => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const React = await import('react');
    const { AgentMessageBody } = await import('./ChatComponents.tsx');
    return renderToStaticMarkup(
      React.createElement(AgentMessageBody, {
        msg: {
          id: 'm', sender: 'agent', time: '',
          rawCreatedAt: '2026-09-11T00:00:00.000Z',
          isStreaming,
          ...msg,
        },
        isStreaming,
        liveActivities: [],
      } as never),
    );
  };

  const completedTurn = (toolStatus: 'done' | 'running' | 'error') => ({
    text: '答案',
    segments: [
      { type: 'text', content: '', thinking: '想了点什么' },
      { type: 'tool', key: 't1', tool: 'file_edit', status: toolStatus },
      { type: 'text', content: '答案' },
    ],
  });

  it('流式进行中 → running', async () => {
    const html = await render(completedTurn('running'), true);
    expect(html).toContain('data-process-state="running"');
    expect(html).toContain('execution.processRun.state.running');
  });

  it('这轮结束、工具成功 → done', async () => {
    const html = await render(completedTurn('done'), false);
    expect(html).toContain('data-process-state="done"');
    expect(html).toContain('execution.processRun.state.done');
    // 跑完了就没理由报警，收起行里不该出现任何红色。
    expect(html).not.toContain('text-red-500');
  });

  it('这轮结束、工具有失败 → error，并在收起行里直接报出失败次数', async () => {
    const html = await render(completedTurn('error'), false);
    expect(html).toContain('data-process-state="error"');
    expect(html).toContain('execution.processRun.state.error');
    // 失败次数写进标签：收起状态也必须看得见「这段里有东西挂了」。
    expect(html).toContain('execution.processRun.errors');
    // 红色出现两次 = 图标 + 失败次数文字，两处都得提示。
    expect((html.match(/text-red-500/g) ?? []).length).toBe(2);
  });

  it('还在跑的时候不报错 —— 工具失败后 agent 往往还会重试', async () => {
    const html = await render(
      {
        text: '',
        segments: [
          { type: 'tool', key: 't1', tool: 'file_edit', status: 'error' },
          { type: 'text', content: '', thinking: '换个写法再来' },
        ],
      },
      true,
    );
    expect(html).toContain('data-process-state="running"');
    expect(html).not.toContain('data-process-state="error"');
  });
});

describe('summarizeProcessRun — errorCount', () => {
  const load = async () => (await import('./ChatComponents.tsx')).summarizeProcessRun;
  const entry = (over: Record<string, unknown>) => ({
    id: 'e', sourceType: 'chat', sourceId: '', agentId: 'a', seq: 0,
    type: 'text', content: '', createdAt: '2026-09-19T00:00:00.000Z',
    ...over,
  }) as never;

  it('tool_end success:false 记一次失败', async () => {
    const summarize = await load();
    const s = summarize([entry({ type: 'tool_end', content: 'file_edit', metadata: { success: false } })]);
    expect(s.errorCount).toBe(1);
  });

  it('tool_end success:true 不算失败', async () => {
    const summarize = await load();
    const s = summarize([entry({ type: 'tool_end', content: 'file_edit', metadata: { success: true } })]);
    expect(s.errorCount).toBe(0);
  });

  it('error 行也计入失败次数', async () => {
    const summarize = await load();
    const s = summarize([entry({ type: 'error', content: '连不上模型' })]);
    expect(s.errorCount).toBe(1);
  });

  it('工具失败 + error 行 = 两次，且工具配对不影响 running 判定', async () => {
    const summarize = await load();
    const s = summarize([
      entry({ type: 'tool_start', content: 'shell_execute' }),
      entry({ type: 'tool_end', content: 'shell_execute', metadata: { success: false } }),
      entry({ type: 'error', content: '命令失败' }),
      entry({ type: 'text', content: '换个思路', metadata: { isThinking: true } }),
    ]);
    expect(s.errorCount).toBe(2);
    expect(s.toolCount).toBe(1);
    expect(s.running).toBe(false);
    expect(s.tailIsThinking).toBe(true);
  });
});