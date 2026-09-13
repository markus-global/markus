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

  it('surfaces reasoning as a thinking row once a tool row exists', async () => {
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
    // The timeline renders a (collapsed) thinking row labelled execution.thinking.
    expect(html).toContain('execution.thinking');
    expect(html).toContain('答案');
  });
});