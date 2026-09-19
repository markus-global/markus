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

// ---------------------------------------------------------------------------
// 本轮适配器修复的回归护栏。
//
// 每个用例都盯着一个真实缺陷的**根因**，因此都能在修复前的旧实现上失败；
// 断言里刻意避开「新旧实现都会通过」的表面检查（例如只断言“有响应”）。
// ---------------------------------------------------------------------------
describe('GoogleProvider 回归护栏（functionResponse.name / 安全拦截 / 思维链 / 用量）', () => {
  let provider: GoogleProvider;

  beforeEach(() => {
    provider = new GoogleProvider({
      provider: 'google',
      model: 'gemini-2.5-flash',
      apiKey: 'google-key',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 捕获 chat() 实际发出去的请求体。 */
  function captureChatBody(captured: { body?: Record<string, unknown> }) {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      captured.body = JSON.parse(init.body as string) as Record<string, unknown>;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
      });
    }));
  }

  it('工具结果回传时 functionResponse.name 必须是函数名，而不是 toolCallId', async () => {
    // 守住的 bug：functionResponse.name 曾被填成 toolCallId（call_abc123）。
    // Gemini 要求这个字段是**函数名**，填 id 会让携带工具结果的后续轮次
    // 被上游直接拒绝 —— 工具调用链在第二次调用时就断掉。
    const captured: { body?: Record<string, unknown> } = {};
    captureChatBody(captured);

    await provider.chat({
      messages: [
        { role: 'user', content: '北京现在多少度？' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_abc123', name: 'get_weather', arguments: { city: '北京' } }],
        },
        { role: 'tool', content: '{"temp":20}', toolCallId: 'call_abc123' },
      ],
    });

    const contents = captured.body?.['contents'] as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    const fnPart = contents
      .flatMap(c => c.parts)
      .find(p => p['functionResponse'] !== undefined) as
        | { functionResponse: { name: string; response: { result: string } } }
        | undefined;

    expect(fnPart).toBeDefined();
    // 根因断言：这里必须是函数名，而不是 call_abc123。
    expect(fnPart!.functionResponse.name).toBe('get_weather');
    expect(fnPart!.functionResponse.response.result).toContain('20');
  });

  // Gemini 所有「拒绝回答」的 finishReason。旧实现里 SAFETY 被显式映射成 end_turn，
  // 其余几个落到默认分支同样变成 end_turn —— 被拦截的一轮看起来像正常答完。
  it.each(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION'])(
    '非流式：finishReason=%s 映射为 content_filter，而不是静默的 end_turn',
    async (reason) => {
      // 守住的 bug：安全/合规拦截被当成正常结束，agent 会把空回答或半截回答
      // 当作最终答案继续往下走，没有任何地方能感知到「这一轮其实被拒了」。
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          // 刻意保留一个（空）parts 数组：本用例只针对 finishReason 的映射，
          // 「content 缺失」那条路径由下一个用例单独守住。
          candidates: [{ content: { parts: [{ text: '' }] }, finishReason: reason }],
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 0 },
        }),
      }));

      const response = await provider.chat({ messages: [{ role: 'user', content: 'Hi' }] });
      expect(response.finishReason).toBe('content_filter');
    },
  );

  it('非流式：被安全拦截（candidate 没有 content）时抛出带 blockReason 的错误，而不是 TypeError', async () => {
    // 守住的 bug：拦截响应里 candidates[0].content 整个缺失，旧实现直接取
    // `.parts` → TypeError，把真实原因（promptFeedback.blockReason）完全吃掉，
    // 上层只能看到一个毫无信息量的运行时错误，无法区分「拦截」和「崩溃」。
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ finishReason: 'SAFETY' }],
        promptFeedback: { blockReason: 'SAFETY' },
      }),
    }));

    await expect(provider.chat({ messages: [{ role: 'user', content: 'bad' }] }))
      .rejects.toThrow(/blockReason=SAFETY/);
  });

  it('流式：thought:true 的思维链进入 reasoningContent，不再混进正文', async () => {
    // 守住的 bug：2.5 thinking 模型把思维链当普通 text part 流式返回
    // （part.thought=true），旧实现把它累加进 content 并发出 text_delta，
    // 用户看到的回答里混进原始思维链。
    const events: Array<{ type: string; text?: string; thinking?: string }> = [];
    const sseBody = createSSEStream([
      'data: {"candidates":[{"content":{"parts":[{"text":"先分析一下题意…","thought":true}]}}]}\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"答案是 42"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":3}}\n',
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: sseBody }));

    const response = await provider.chatStream(
      { messages: [{ role: 'user', content: '6*7 等于多少？' }] },
      (event) => { events.push(event); },
    );

    expect(response.content).toBe('答案是 42');
    expect(response.reasoningContent).toBe('先分析一下题意…');
    expect(events.some(e => e.type === 'thinking_delta' && e.thinking === '先分析一下题意…')).toBe(true);
    // 思维链绝不能以 text_delta 的形式泄漏给用户。
    expect(events.filter(e => e.type === 'text_delta').map(e => e.text)).toEqual(['答案是 42']);
  });

  it('非流式：thought part 不再混进正文，且 outputTokens 计入 thoughtsTokenCount', async () => {
    // 守住的 bug（两条，同属 convertResponse）：
    //   1. thought part 被当正文拼进 content —— 用户回答里混进原始思维链；
    //   2. usageMetadata.thoughtsTokenCount 未计入 outputTokens，
    //      推理轮用量被严重低估（预算是按输出计费的）。
    //
    //   3. convertResponse 里算出了 reasoningContent 却没写进 return —— 非流式
    //      推理内容静默丢失（流式路径则正确带上了）。已一并修复，故此处断言该字段。
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{
          content: { parts: [{ text: '内心独白', thought: true }, { text: '正式回答' }] },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6, thoughtsTokenCount: 40 },
      }),
    }));

    const response = await provider.chat({ messages: [{ role: 'user', content: 'Hi' }] });

    expect(response.content).toBe('正式回答');
    expect(response.usage.outputTokens).toBe(46);
    // 修复后：思维链必须出现在 reasoningContent 里（既不混进正文，也不被丢掉）。
    expect(response.reasoningContent).toBe('内心独白');
  });

  it('流式：usage.outputTokens 计入 thoughtsTokenCount，并随 message_end 事件上报', async () => {
    // 守住的 bug：流式路径只取 candidatesTokenCount，thoughtsTokenCount 被丢弃，
    // 于是推理轮的用量上报（含 message_end 事件里的 usage）远低于真实计费值。
    const events: Array<{ type: string; usage?: { inputTokens: number; outputTokens: number } }> = [];
    const sseBody = createSSEStream([
      'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"thoughtsTokenCount":100}}\n',
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: sseBody }));

    const response = await provider.chatStream(
      { messages: [{ role: 'user', content: 'Hi' }] },
      (event) => { events.push(event); },
    );

    expect(response.usage.outputTokens).toBe(105);
    const endEvent = events.find(e => e.type === 'message_end');
    expect(endEvent?.usage?.outputTokens).toBe(105);
  });

  it('流式：finishReason=SAFETY 也映射为 content_filter 并随 message_end 上报', async () => {
    // 守住的 bug：流式路径同样把安全拦截映射成 end_turn，
    // 调用方从 message_end 事件里读到的是「正常结束」。
    const events: Array<{ type: string; finishReason?: string }> = [];
    const sseBody = createSSEStream([
      'data: {"candidates":[{"finishReason":"SAFETY"}]}\n',
      'data: {"candidates":[{"content":{"parts":[{"text":""}]},"finishReason":"SAFETY"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":0}}\n',
    ]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: sseBody }));

    const response = await provider.chatStream(
      { messages: [{ role: 'user', content: 'bad' }] },
      (event) => { events.push(event); },
    );

    expect(response.finishReason).toBe('content_filter');
    expect(events.find(e => e.type === 'message_end')?.finishReason).toBe('content_filter');
  });
});
