import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIProvider } from '../src/llm/openai.js';

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

describe('OpenAIProvider', () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    provider = new OpenAIProvider({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('constructs with defaults', () => {
    expect(provider.name).toBe('openai');
    expect(provider.model).toBe('gpt-4o');
  });

  it('configure updates settings', () => {
    provider.configure({
      provider: 'openai',
      model: 'gpt-5.4',
      apiKey: 'sk-new',
      baseUrl: 'https://custom.example/v1',
      maxTokens: 8192,
      timeoutMs: 30_000,
    });
    expect(provider.model).toBe('gpt-5.4');
  });

  it('chat returns success response', async () => {
    let capturedUrl = '';
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          choices: [{
            message: { role: 'assistant', content: 'Hello!' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0.7,
    });

    expect(capturedUrl).toBe('https://api.openai.com/v1/chat/completions');
    expect(response.content).toBe('Hello!');
    expect(response.usage.inputTokens).toBe(10);
    expect(response.finishReason).toBe('end_turn');
  });

  it('throws on API error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('rate limit exceeded'),
    }));

    await expect(provider.chat({
      messages: [{ role: 'user', content: 'Hi' }],
    })).rejects.toThrow('OpenAI API error 429');
  });

  it('handles tool calls in chat response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 15, completion_tokens: 10 },
      }),
    }));

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'weather in Paris' }],
      tools: [{ name: 'get_weather', description: 'Get weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } }],
    });

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls![0].name).toBe('get_weather');
    expect(response.toolCalls![0].arguments).toEqual({ city: 'Paris' });
    expect(response.finishReason).toBe('tool_use');
  });

  it('chatStream emits text deltas and message_end', async () => {
    const events: Array<{ type: string; text?: string }> = [];
    const sseBody = createSSEStream([
      'data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":2}}\n',
      'data: [DONE]\n',
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
    expect(events.filter(e => e.type === 'text_delta')).toHaveLength(2);
    expect(events.some(e => e.type === 'message_end')).toBe(true);
  });

  it('chatStream handles streaming tool calls', async () => {
    const events: string[] = [];
    const sseBody = createSSEStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search","arguments":""}}]},"finish_reason":null}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":\\"test\\"}"}}]},"finish_reason":"tool_calls"}]}\n',
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: sseBody }));

    const response = await provider.chatStream(
      { messages: [{ role: 'user', content: 'search' }] },
      (event) => { if (event.type.startsWith('tool_call')) events.push(event.type); },
    );

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls![0].arguments).toEqual({ q: 'test' });
    expect(events).toContain('tool_call_start');
    expect(events).toContain('tool_call_end');
  });

  it('generateImage parses data array format', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: [{ url: 'https://cdn.example/img.png', b64_json: 'abc', revised_prompt: 'revised' }],
      }),
    }));

    const results = await provider.generateImage('a cat');
    expect(results[0].url).toBe('https://cdn.example/img.png');
    expect(results[0].base64).toBe('abc');
    expect(results[0].revisedPrompt).toBe('revised');
  });

  it('generateImage parses images array format', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        images: [{ url: 'https://cdn.example/alt.png' }],
      }),
    }));

    const results = await provider.generateImage('a dog');
    expect(results[0].url).toBe('https://cdn.example/alt.png');
  });

  it('generateSpeech returns audio buffer', async () => {
    const audioData = Buffer.from('mp3-bytes');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new Uint8Array(audioData).buffer),
    }));

    const result = await provider.generateSpeech('Hello world', { voice: 'alloy', responseFormat: 'mp3' });
    expect(Buffer.from(result.audio)).toEqual(audioData);
    expect(result.format).toBe('mp3');
  });

  it('getCapabilities for native OpenAI vs non-OpenAI', () => {
    const native = new OpenAIProvider({
      provider: 'openai', model: 'gpt-4o', apiKey: 'k', baseUrl: 'https://api.openai.com',
    });
    expect(native.getCapabilities().imageGeneration).toBe(true);
    expect(native.getCapabilities().tts).toBe(true);

    const proxy = new OpenAIProvider({
      provider: 'deepseek' as any, model: 'deepseek-v4', apiKey: 'k', baseUrl: 'https://api.deepseek.com',
    });
    expect(proxy.getCapabilities().imageGeneration).toBe(false);
    expect(proxy.getCapabilities().tts).toBe(false);
  });

  it('uses tokenResolver for auth header', async () => {
    provider.setTokenResolver(async () => 'oauth-token-xyz');
    let authHeader = '';
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      authHeader = (init.headers as Record<string, string>).Authorization;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      });
    }));

    await provider.chat({ messages: [{ role: 'user', content: 'Hi' }] });
    expect(authHeader).toBe('Bearer oauth-token-xyz');
  });
});
