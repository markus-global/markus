import { describe, expect, it, vi } from 'vitest';

// api.ts reads `window` at module load (Hub base URL); jsdom is not installed in
// this repo, so stub the minimum surface BEFORE importing it.
vi.hoisted(() => {
  (globalThis as unknown as { window: unknown }).window = {
    __MARKUS_HUB_BASE_URL__: '',
    location: { origin: 'http://localhost' },
  } as unknown as Window & typeof globalThis;
  return true;
});

/**
 * Transport contract for reasoning deltas.
 *
 * The server emits `thinking_delta` with RAW reasoning text. `dispatchThinkingDelta`
 * is the single routing point shared by `agents.messageStream` and
 * `sessions.reattachStream`, so these tests lock down the rule that reasoning
 * must never travel to consumers as inline prose on `onChunk` — that round-trip
 * (encode marker → parse marker) is what silently dropped live thinking before.
 */
describe('dispatchThinkingDelta', () => {
  it('routes raw reasoning to onThinking and leaves onChunk untouched', async () => {
    const { dispatchThinkingDelta } = await import('./api.ts');
    const chunks: string[] = [];
    const thoughts: string[] = [];

    dispatchThinkingDelta(
      { onChunk: c => chunks.push(c), onThinking: t => thoughts.push(t) },
      '推理 A',
    );

    expect(thoughts).toEqual(['推理 A']);
    expect(chunks).toEqual([]);
  });

  it('never lets reasoning reach the answer channel even mid-word', async () => {
    const { dispatchThinkingDelta } = await import('./api.ts');
    const chunks: string[] = [];
    dispatchThinkingDelta({ onChunk: c => chunks.push(c), onThinking: () => {} }, 'think');
    expect(chunks.join('')).not.toContain('think');
  });

  it('falls back to the legacy <think> protocol only when onThinking is absent', async () => {
    const { dispatchThinkingDelta } = await import('./api.ts');
    const chunks: string[] = [];
    dispatchThinkingDelta({ onChunk: c => chunks.push(c) }, '推理 B');
    // Locks the legacy transport spelling — if this changes, the inline parsers
    // kept for un-wired legacy implementations must change with it.
    expect(chunks).toEqual(['<think>推理 B</think>']);
  });

  it('is a no-op-safe when a consumer provides neither handler', async () => {
    const { dispatchThinkingDelta } = await import('./api.ts');
    expect(() => dispatchThinkingDelta({}, '推理 C')).not.toThrow();
  });
});
