import { describe, expect, it, vi } from 'vitest';

// ChatComponents.tsx transitively imports api.ts which reads `window` at module
// load. Provide the properties it needs BEFORE the component module is imported.
// vi.hoisted runs before imports.
//
// 注意：这段桩是**就地补属性**，不是把 window 整个换掉 —— 早期这里是
// `window = { … }` 直接覆盖，服务端渲染（不跑 effect）看不出问题，一旦用
// RTL 做客户端渲染就会炸在 `window.matchMedia is not a function`
// （MarkdownMessage 的窄屏监听要用它）。补全比覆盖更安全。
const _stub = vi.hoisted(() => {
  const win = ((globalThis as unknown as { window?: Record<string, unknown> }).window
    ?? {}) as Record<string, unknown>;
  win['__MARKUS_HUB_BASE_URL__'] = '';
  win['location'] = { origin: 'http://localhost' };
  if (typeof win['innerWidth'] !== 'number') win['innerWidth'] = 1024;
  if (typeof win['matchMedia'] !== 'function') {
    win['matchMedia'] = (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  }
  (globalThis as unknown as { window: unknown }).window = win;
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
// 收起状态下，开头那个小图标是用户唯一的进度线索：还在跑？还是跑完了？
// 两种形态必须**形状不同** —— 只换颜色在 11px 高的一行里等于没换，对色觉障碍
// 用户更是完全无感。

describe('ProcessRunIcon — 两态图标', () => {
  const render = async (state: string) => {
    const { ProcessRunIcon } = await import('./ChatComponents.tsx');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const React = await import('react');
    return renderToStaticMarkup(React.createElement(ProcessRunIcon, { state } as never));
  };

  it('两种状态形状不同（不是只换颜色的同一个图形）', async () => {
    const [running, done] = await Promise.all([render('running'), render('done')]);
    expect(new Set([running, done]).size).toBe(2);
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

  it('工具失败不再有专属的警告图标（老板 2026-09-23 明确要求）', async () => {
    // 状态类型里已经删掉 'error' 了。这里故意硬塞一个进去，钉死「就算有人把它
    // 加回来，也只画勾、绝不画三角」——失败信息改由文字（N 个失败）承载。
    const forced = await render('error');
    const done = await render('done');
    expect(forced).toBe(done);
    // 三角形惊叹号的路径必须彻底消失。
    expect(forced).not.toContain('10.29 3.86');
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

  it('这轮结束后整条时间线折进顶部一行，气泡里不再有过程行', async () => {
    const html = await render(completedTurn('done'), false);
    // 顶部一行在（可点开），过程行已被折走 —— 这正是「降低气泡高度」。
    expect(html).toContain('data-worked-summary="true"');
    expect(html).not.toContain('data-process-state');
    // 最终结论照常显示。
    expect(html).toContain('答案');
    // 跑完了就没理由报警，收起状态里不该出现任何红色。
    expect(html).not.toContain('text-red-');
  });

  it('这轮结束时同样不因为工具有失败而报警 —— 顶部一行照旧是对勾', async () => {
    const html = await render(completedTurn('error'), false);
    expect(html).toContain('data-worked-summary="true"');
    // 失败不再产生警告图标/红色；次数改由文字承载（展开后才看得到）。
    expect(html).not.toContain('10.29 3.86');
    expect(html).not.toContain('text-red-');
  });

  it('「执行中」是这一行唯一的颜色（品牌色）', async () => {
    const runningHtml = await render(completedTurn('running'), true);
    expect(runningHtml).toContain('text-brand-400');
    expect(runningHtml).not.toContain('text-red-');
    const doneHtml = await render(completedTurn('done'), false);
    expect(doneHtml).not.toContain('text-brand-400');
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

// ─── 完成后整体折叠成一行 ─────────────────────────────────────────────────────
// 老板 2026-09-23：「流式输出完成后，非最终结果的正文和思考及工具调用行，整体
// 折叠成一行……顶部有一行，显示已工作 xx 秒，点击可以展开……这样是为了减少气泡
// 的高度。」下面是这条要求的护栏。

describe('lastTextBlockIndex / collapsibleBlockCount — 折叠边界', () => {
  const block = (kind: 'text' | 'process', key: string) => kind === 'text'
    ? { kind, key, entry: { content: 'x' } }
    : { kind, key, entries: [], summary: {} };

  it('「最终结果」= 最后一个正文块，不是第一个', async () => {
    const { lastTextBlockIndex } = await import('./ChatComponents.tsx');
    expect(lastTextBlockIndex([
      block('text', 'a'), block('process', 'p'), block('text', 'b'),
    ] as never)).toBe(2);
  });

  it('没有正文块 → -1（无处可折，也不该硬折成空气泡）', async () => {
    const { lastTextBlockIndex } = await import('./ChatComponents.tsx');
    expect(lastTextBlockIndex([block('process', 'p')] as never)).toBe(-1);
  });

  it('流式期间绝不折叠 —— 正在产出的内容不能被收走', async () => {
    const { collapsibleBlockCount } = await import('./ChatComponents.tsx');
    expect(collapsibleBlockCount([
      block('process', 'p'), block('text', 'a'),
    ] as never, true)).toBe(0);
  });

  it('只有一条正文的简单回复不折叠（不给它平白加一行）', async () => {
    const { collapsibleBlockCount } = await import('./ChatComponents.tsx');
    expect(collapsibleBlockCount([block('text', 'a')] as never, false)).toBe(0);
  });

  it('思考/工具 + 最终结论 → 折 1 块，气泡只剩结论', async () => {
    const { collapsibleBlockCount } = await import('./ChatComponents.tsx');
    expect(collapsibleBlockCount([
      block('process', 'p'), block('text', 'a'),
    ] as never, false)).toBe(1);
  });
});

describe('formatWorkedFor — 「已工作」文案', () => {
  // 回显 key + 参数的假 t：只用来断言「选了哪个分支 / 传了哪些参数」。
  // 真正的「能不能翻译出来」由 test/workedLabelI18n.test.ts 用真实语言包验证 ——
  // 这里若也用假 t 去断言 key，就永远发现不了 key 渲染不出来。
  const t = ((key: string, opts?: Record<string, unknown>) => `${key}|${JSON.stringify(opts ?? {})}`) as never;

  it('不足 1 分钟 → 只写秒，不出现「0 分」', async () => {
    const { formatWorkedFor } = await import('./ChatComponents.tsx');
    const out = formatWorkedFor(45_400, t);
    expect(out).toContain('common:execution.workedForSeconds');
    expect(out).not.toContain('workedForMinutes');
    expect(out).toContain('45');
  });

  it('超过 1 分钟 → 分 + 余秒（「2 分 13 秒」比「2 分钟」说明力强得多）', async () => {
    const { formatWorkedFor } = await import('./ChatComponents.tsx');
    const out = formatWorkedFor(133_000, t);
    expect(out).toContain('common:execution.workedForMinutes');
    expect(out).toContain('"minutes":2');
    expect(out).toContain('"seconds":13');
  });
});

describe('AgentMessageBody — 顶部一行的展开 / 收起', () => {
  const finishedTurn = {
    text: '最终结论',
    segments: [
      // 中间正文必须是**完整句子**（以句号收尾）：否则会被 healSentenceSplits
      // 判定成「被工具行从中间切开的一句话」而拼进最终结论，夹具就失真了
      // —— 那样「最终结果」会落在 index 0，压根没有可折叠的内容。
      { type: 'text', content: '先说说思路。', createdAt: '2026-09-11T00:00:00.000Z' },
      { type: 'text', content: '', thinking: '内心独白', createdAt: '2026-09-11T00:00:05.000Z' },
      { type: 'tool', key: 't1', tool: 'file_edit', status: 'error', createdAt: '2026-09-11T00:00:10.000Z' },
      { type: 'text', content: '最终结论', createdAt: '2026-09-11T00:00:20.000Z' },
    ],
  };

  const renderBody = async (msg: Record<string, unknown>, isStreaming = false) => {
    const React = await import('react');
    const { render } = await import('@testing-library/react');
    const { AgentMessageBody } = await import('./ChatComponents.tsx');
    return render(
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

  it('默认收起：只剩顶部一行 + 最终结论，中间正文/思考/工具全部不见', async () => {
    const { container } = await renderBody(finishedTurn);
    expect(container.querySelector('[data-worked-summary]')).toBeTruthy();
    expect(container.textContent).toContain('最终结论');
    expect(container.textContent).not.toContain('先说说思路');
    expect(container.textContent).not.toContain('内心独白');
  });

  it('点开 → 完整时间线回来（含失败计数），再点 → 收起', async () => {
    const { container } = await renderBody(finishedTurn);
    const { fireEvent } = await import('@testing-library/react');
    const btn = () => container.querySelector('[data-worked-summary]')!;

    expect(btn().getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(btn());
    expect(container.textContent).toContain('先说说思路');
    expect(btn().getAttribute('aria-expanded')).toBe('true');
    // 展开后过程行回来，失败次数写在文字里；但**绝不出现警告三角**。
    expect(container.textContent).toContain('execution.processRun.errors');
    expect(container.innerHTML).not.toContain('10.29 3.86');
    // 两级展开：展开顶部行返回的是过程行的**收起态**，思考正文要再点一次过程行
    // 才出来。这里钉死「展开顶部行不等于把所有明细一次性铺满」。
    expect(container.textContent).not.toContain('内心独白');

    fireEvent.click(btn());
    expect(container.textContent).not.toContain('先说说思路');
  });

  it('流式进行中不折叠 —— 不把用户正盯着的内容收走', async () => {
    const { container } = await renderBody(finishedTurn, true);
    expect(container.querySelector('[data-worked-summary]')).toBeNull();
    expect(container.textContent).toContain('先说说思路');
  });
});