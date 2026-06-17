import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleProvider } from '../src/llm/google.js';

function createSSEStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < lines.length) {
        controller.enqueue(encoder.encode(lines[i++]));
      } else {
        controller.close();
      }
    },
  });
}

describe('GoogleProvider extended', () => {
  let provider: GoogleProvider;

  beforeEach(() => {
    provider = new GoogleProvider({
      provider: 'google',
      model: 'gemini-2.0-flash',
      apiKey: 'google-key',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports imageGeneration capability', () => {
    expect(provider.getCapabilities().imageGeneration).toBe(true);
  });

  it('generates image from inlineData response', async () => {
    let capturedUrl = '';
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          candidates: [{
            content: {
              parts: [{ inlineData: { mimeType: 'image/png', data: 'base64imagedata' } }],
            },
          }],
        }),
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    const results = await provider.generateImage('a blue sky');
    expect(capturedUrl).toContain('gemini-2.0-flash-preview-image-generation');
    expect(results).toHaveLength(1);
    expect(results[0].base64).toBe('base64imagedata');
  });

  it('throws on image generation API error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve('forbidden'),
    }));

    await expect(provider.generateImage('test')).rejects.toThrow('Gemini image generation error 403');
  });

  it('streams chat responses via SSE', async () => {
    const events: Array<{ type: string; text?: string }> = [];
    const sseBody = createSSEStream([
      'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]},"finishReason":"STOP"}]}\n',
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody,
    }));

    const response = await provider.chatStream(
      { messages: [{ role: 'user', content: 'Hi' }] },
      (event) => { events.push(event); },
    );

    expect(response.content).toBe('Hello');
    expect(events.some(e => e.type === 'text_delta')).toBe(true);
    expect(events.some(e => e.type === 'message_end')).toBe(true);
  });

  it('streams tool calls in SSE response', async () => {
    const sseBody = createSSEStream([
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"lookup","args":{"q":"test"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5}}\n',
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody,
    }));

    const response = await provider.chatStream(
      { messages: [{ role: 'user', content: 'lookup test' }] },
      () => {},
    );

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls![0].name).toBe('lookup');
    expect(response.toolCalls![0].arguments).toEqual({ q: 'test' });
  });
});
