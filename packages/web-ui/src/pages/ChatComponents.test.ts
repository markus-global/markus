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