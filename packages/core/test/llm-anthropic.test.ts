import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicProvider } from '../src/llm/anthropic.js';

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    provider = new AnthropicProvider({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'ant-key',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('constructs with defaults', () => {
    expect(provider.name).toBe('anthropic');
    expect(provider.model).toBe('claude-sonnet-4-20250514');
  });

  it('configure updates model and apiKey', () => {
    provider.configure({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      apiKey: 'new-key',
    });
    expect(provider.model).toBe('claude-opus-4-6');
  });

  it('chat returns success response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ type: 'text', text: 'Hello from Claude' }],
        usage: { input_tokens: 12, output_tokens: 8 },
        stop_reason: 'end_turn',
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(response.content).toBe('Hello from Claude');
    expect(response.usage.inputTokens).toBe(12);
    expect(response.finishReason).toBe('end_turn');
  });

  it('throws on API error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('invalid api key'),
    }));

    await expect(provider.chat({
      messages: [{ role: 'user', content: 'Hi' }],
    })).rejects.toThrow('Anthropic API error 401');
  });

  it('handles tool use in response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [
          { type: 'text', text: 'Let me search' },
          { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { query: 'weather' } },
        ],
        usage: { input_tokens: 20, output_tokens: 15 },
        stop_reason: 'tool_use',
      }),
    }));

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [{ name: 'web_search', description: 'Search', inputSchema: { type: 'object', properties: {} } }],
    });

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls![0].name).toBe('web_search');
    expect(response.toolCalls![0].arguments).toEqual({ query: 'weather' });
    expect(response.finishReason).toBe('tool_use');
  });

  it('adds prompt caching headers on cache breakpoint messages', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 5, output_tokens: 2 },
          stop_reason: 'end_turn',
        }),
      });
    }));

    await provider.chat({
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Remember this', cacheBreakpoint: true },
      ],
    });

    const messages = capturedBody?.messages as Array<{ content: Array<{ cache_control?: { type: string } }> }>;
    expect(messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('builds structured system cache segments', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 5, output_tokens: 2 },
          stop_reason: 'end_turn',
        }),
      });
    }));

    await provider.chat({
      messages: [{ role: 'system', content: 'ignored' }, { role: 'user', content: 'Hi' }],
      systemCacheSegments: [
        { content: 'Stable prefix', cacheBreakpoint: true },
        { content: 'Dynamic suffix' },
      ],
    });

    const system = capturedBody?.system as Array<{ text: string; cache_control?: { type: string } }>;
    expect(Array.isArray(system)).toBe(true);
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(system[1].cache_control).toBeUndefined();
  });

  it('converts base64 image messages', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          content: [{ type: 'text', text: 'I see an image' }],
          usage: { input_tokens: 100, output_tokens: 10 },
          stop_reason: 'end_turn',
        }),
      });
    }));

    await provider.chat({
      messages: [{
        role: 'user',
        content: [{
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,abc123' },
        }, {
          type: 'text',
          text: 'What is this?',
        }],
      }],
    });

    const messages = capturedBody?.messages as Array<{ content: Array<{ type: string; source?: { type: string; data: string } }> }>;
    const imageBlock = messages[0].content.find(b => b.type === 'image');
    expect(imageBlock?.source).toEqual({ type: 'base64', media_type: 'image/png', data: 'abc123' });
  });

  it('chat fails fast with a timeout error when the provider hangs (never resolves)', async () => {
    // Simulate a hung provider: the fetch promise never settles on its own, and
    // like real fetch it rejects with AbortError once our signal aborts. The
    // per-call hard timeout must reject with a descriptive error, not hang.
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'));
        });
      });
    }));

    provider.configure({ provider: 'anthropic', model: 'x', apiKey: 'k', timeoutMs: 50 });

    await expect(provider.chat({ messages: [{ role: 'user', content: 'Hi' }] }))
      .rejects.toThrow(/Anthropic chat timeout after 50ms/);
  });

  it('gracefully terminates a stream that stalls mid-response (idle timeout) by finalizing partial output as max_tokens', async () => {
    // Stream emits one text chunk then never produces another byte -> the idle
    // (per-chunk) timeout must abort, and with partial content the provider
    // finalizes as max_tokens instead of throwing / hanging forever.
    const encoder = new TextEncoder();
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;
      (init.signal as AbortSignal).addEventListener('abort', () => {
        // Real fetch cancels the body stream on abort -> erroring the controller
        // makes the pending reader.read() reject so the provider's catch runs.
        try { ctrl?.error(new DOMException('Stream aborted', 'AbortError')); } catch { /* noop */ }
      });
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          ctrl = c;
          c.enqueue(encoder.encode('data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n'));
          c.enqueue(encoder.encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}\n\n'));
        },
        pull() {
          // stall: never enqueue more, never close -> reader.read() stays pending
          // until the idle timeout abort errors the controller.
        },
        cancel() { /* noop */ },
      });
      return Promise.resolve({ ok: true, body: stream });
    }));

    provider.configure({ provider: 'anthropic', model: 'x', apiKey: 'k', streamTimeoutMs: 40 });

    const onEvent = vi.fn();
    const response = await provider.chatStream(
      { messages: [{ role: 'user', content: 'Hi' }] },
      onEvent,
    );

    // Partial output preserved, gracefully finalized instead of hanging/throw.
    expect(response.content).toContain('Hello');
    expect(response.finishReason).toBe('max_tokens');
  });

  it('converts tool result messages to user role with tool_result blocks', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 5, output_tokens: 2 },
          stop_reason: 'end_turn',
        }),
      });
    }));

    await provider.chat({
      messages: [{
        role: 'tool',
        content: 'search results here',
        toolCallId: 'toolu_abc',
      }],
    });

    const messages = capturedBody?.messages as Array<{ role: string; content: Array<{ type: string; tool_use_id?: string }> }>;
    expect(messages[0].role).toBe('user');
    expect(messages[0].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_abc' });
  });

  it('merges parallel tool results into ONE user message (Anthropic requirement)', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 5, output_tokens: 2 },
          stop_reason: 'end_turn',
        }),
      });
    }));

    await provider.chat({
      messages: [
        { role: 'user', content: 'do two things' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'toolu_1', name: 'search', arguments: { q: 'a' } },
            { id: 'toolu_2', name: 'search', arguments: { q: 'b' } },
          ],
        },
        { role: 'tool', content: 'result A', toolCallId: 'toolu_1' },
        { role: 'tool', content: 'result B', toolCallId: 'toolu_2' },
      ],
    });

    const messages = capturedBody?.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    // user(text) → assistant(tool_use ×2) → user(tool_result ×2)
    expect(messages).toHaveLength(3);
    expect(messages[2]!.role).toBe('user');
    expect(messages[2]!.content).toHaveLength(2);
    expect(messages[2]!.content.map(b => b['tool_use_id'])).toEqual(['toolu_1', 'toolu_2']);
  });
});

// ---------------------------------------------------------------------------
// 本轮适配器修复的回归护栏：SSE 流内 `error` 事件 + `refusal` 停止原因。
// 每个用例都能在修复前的旧实现上失败（断言盯着根因，不是“有响应就算过”）。
// ---------------------------------------------------------------------------
describe('AnthropicProvider 回归护栏（流内 error 事件 / refusal）', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    provider = new AnthropicProvider({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'ant-key',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * 与文件内已有流式用例同一套 mock 手法：TextEncoder + ReadableStream.start
   * 预先把 SSE 帧写进流，然后关闭。
   */
  function sseResponse(lines: string[]): { ok: true; body: ReadableStream<Uint8Array> } {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const line of lines) c.enqueue(encoder.encode(line));
        c.close();
      },
    });
    return { ok: true, body };
  }

  it('流内 error 事件（overloaded_error）必须抛错，而不是把截断的半截回答当成功', async () => {
    // 守住的 bug：SSE 里的 {"type":"error"} 事件曾被 switch 静默忽略。
    // overloaded_error 造成的流中断因此被当成正常结束：调用方拿到一小段
    // 看似成功的回答，既不知道被截断，也没有机会重试。
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":0}}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"我先查一下"}}\n\n',
      'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    ])));

    const onEvent = vi.fn();
    await expect(provider.chatStream(
      { messages: [{ role: 'user', content: 'Hi' }] },
      onEvent,
    )).rejects.toThrow(/overloaded_error/);

    // 半截回答绝不能被当成一次正常收尾：message_end 不应发出。
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'message_end' }));
  });

  it('流内 error 事件缺少 type/message 时也要抛错（回退分支不能静默）', async () => {
    // 守住的 bug：与上一个用例同根因，额外守住错误信息的回退分支 ——
    // 即使上游只发了一个没有 error 体的 error 事件，也只能抛错，不能吞掉。
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":0}}}\n\n',
      'data: {"type":"error"}\n\n',
    ])));

    await expect(provider.chatStream(
      { messages: [{ role: 'user', content: 'Hi' }] },
      () => {},
    )).rejects.toThrow(/Anthropic stream error \(unknown\)/);
  });

  it('流式：stop_reason=refusal 映射为 content_filter', async () => {
    // 守住的 bug：refusal（Claude 因安全/策略拒答）原本不在流式 finishMap 里，
    // 落到 ?? 'end_turn' 默认分支 —— 拒答被上报为正常结束。
    const events = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":8,"output_tokens":0}}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":1}}\n\n',
    ])));

    const response = await provider.chatStream(
      { messages: [{ role: 'user', content: 'Hi' }] },
      events,
    );

    expect(response.finishReason).toBe('content_filter');
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: 'message_end', finishReason: 'content_filter' }));
  });

  it('非流式：stop_reason=refusal 映射为 content_filter', async () => {
    // 守住的 bug：同上的非流式路径（convertResponse 的 finishMap 里也缺 refusal）。
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ type: 'text', text: 'I refuse to answer that.' }],
        usage: { input_tokens: 9, output_tokens: 4 },
        stop_reason: 'refusal',
      }),
    }));

    const response = await provider.chat({ messages: [{ role: 'user', content: 'Hi' }] });
    expect(response.finishReason).toBe('content_filter');
  });
});
