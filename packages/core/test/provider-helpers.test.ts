import { describe, it, expect } from 'vitest';
import type { LLMMessage } from '@markus/shared';
import {
  buildOpenAICompatEndpoint,
  FINISH_REASON_MAP,
  extractReasoningText,
  extractDeltaReasoning,
  convertMessagesOpenAI,
  convertToolsOpenAI,
  parseOpenAICompatResponse,
  normalizeOpenAIUsage,
  createSSEAccumulator,
} from '../src/llm/provider-helpers.js';

describe('buildOpenAICompatEndpoint', () => {
  it('appends /v1 when base has no version segment', () => {
    expect(buildOpenAICompatEndpoint('https://api.openai.com', '/chat/completions')).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
  });

  it('does not duplicate /v1 when base already ends with it', () => {
    expect(buildOpenAICompatEndpoint('https://api.openai.com/v1', '/chat/completions')).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
  });

  it('does not add /v1 when base ends with another version segment (/v2)', () => {
    expect(buildOpenAICompatEndpoint('https://custom.example/v2', '/chat/completions')).toBe(
      'https://custom.example/v2/chat/completions',
    );
  });

  it('strips trailing slashes from base', () => {
    expect(buildOpenAICompatEndpoint('https://openrouter.ai/api/v1/', '/chat/completions')).toBe(
      'https://openrouter.ai/api/v1/chat/completions',
    );
  });
});

describe('FINISH_REASON_MAP', () => {
  it('maps OpenAI finish reasons to LLMResponse reasons', () => {
    expect(FINISH_REASON_MAP['stop']).toBe('end_turn');
    expect(FINISH_REASON_MAP['tool_calls']).toBe('tool_use');
    expect(FINISH_REASON_MAP['length']).toBe('max_tokens');
  });

  it('does not contain unknown keys (callers fall back to end_turn)', () => {
    expect(FINISH_REASON_MAP['something_else']).toBeUndefined();
  });
});

describe('extractReasoningText', () => {
  it('extracts plain string reasoning', () => {
    expect(extractReasoningText('thinking hard')).toBe('thinking hard');
  });

  it('extracts from array of strings', () => {
    expect(extractReasoningText(['a', 'b'])).toBe('ab');
  });

  it('extracts from array of objects (text/summary/content)', () => {
    expect(extractReasoningText([{ type: 'text', text: 'aa' }, { summary: 'bb' }, { content: 'cc' }])).toBe('aabbcc');
  });

  it('handles mixed arrays and ignores empties', () => {
    expect(extractReasoningText(['x', { text: 'y' }, '', null])).toBe('xy');
  });

  it('returns empty string for falsy / unsupported values', () => {
    expect(extractReasoningText(undefined)).toBe('');
    expect(extractReasoningText('')).toBe('');
    expect(extractReasoningText(123)).toBe('');
    expect(extractReasoningText({ text: '' })).toBe('');
  });
});

describe('extractDeltaReasoning', () => {
  it('prefers reasoning_content over other shapes', () => {
    expect(extractDeltaReasoning({ reasoning_content: 'a', thinking: 'b' })).toBe('a');
  });

  it('falls back to reasoning / thinking / reasoning_details', () => {
    expect(extractDeltaReasoning({ reasoning: 'r' })).toBe('r');
    expect(extractDeltaReasoning({ thinking: 't' })).toBe('t');
    expect(extractDeltaReasoning({ reasoning_details: [{ text: 'd' }] })).toBe('d');
  });

  it('returns empty for undefined delta', () => {
    expect(extractDeltaReasoning(undefined)).toBe('');
    expect(extractDeltaReasoning({})).toBe('');
  });
});

describe('convertMessagesOpenAI', () => {
  it('passes through plain messages', () => {
    const out = convertMessagesOpenAI([{ role: 'user', content: 'hi' }]);
    expect(out).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('converts tool messages with tool_call_id', () => {
    const out = convertMessagesOpenAI([
      { role: 'tool', content: 'result', toolCallId: 'tc_1' },
    ]);
    expect(out).toEqual([
      { role: 'tool', content: 'result', tool_call_id: 'tc_1' },
    ]);
  });

  it('serializes assistant tool_calls with stringified arguments', () => {
    const out = convertMessagesOpenAI([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc_2', name: 'get_weather', arguments: { city: 'SF' } }],
      },
    ]);
    expect(out[0]).toMatchObject({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'tc_2',
          type: 'function',
          function: { name: 'get_weather', arguments: JSON.stringify({ city: 'SF' }) },
        },
      ],
    });
  });

  it('backfills reasoning_content on assistant messages when backfillReasoning is set', () => {
    const out = convertMessagesOpenAI(
      [{ role: 'assistant', content: 'ok' }],
      { backfillReasoning: true },
    );
    expect(out[0]).toMatchObject({ role: 'assistant', content: 'ok', reasoning_content: '' });
  });

  it('keeps existing reasoningContent on assistant messages', () => {
    const out = convertMessagesOpenAI([
      { role: 'assistant', content: 'ok', reasoningContent: 'trace' },
    ]);
    expect(out[0]).toMatchObject({ reasoning_content: 'trace' });
  });

  it('maps multimodal content arrays to image_url/text parts', () => {
    const out = convertMessagesOpenAI([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          { type: 'text', text: 'describe' },
        ],
      } as unknown as LLMMessage,
    ]);
    expect(out[0]).toEqual({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
        { type: 'text', text: 'describe' },
      ],
    });
  });

  it('splits system messages by cache segments when provided', () => {
    const out = convertMessagesOpenAI(
      [{ role: 'system', content: 'T1' }, { role: 'user', content: 'hi' }],
      {
        systemCacheSegments: [
          { content: 'seg1', cacheBreakpoint: true },
          { content: 'seg2' },
        ],
      },
    );
    expect(out[0]).toEqual({ role: 'system', content: 'seg1' });
    expect(out[1]).toEqual({ role: 'system', content: 'seg2' });
  });
});

describe('convertToolsOpenAI', () => {
  it('deduplicates by name and builds function defs', () => {
    const out = convertToolsOpenAI([
      { name: 'a', description: 'A', inputSchema: { type: 'object' } },
      { name: 'b', description: 'B', inputSchema: { type: 'object' } },
      { name: 'a', description: 'A dup', inputSchema: { type: 'object' } },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].function.name).toBe('a');
    expect(out[0].function.parameters).toEqual({ type: 'object' });
  });

  it('returns empty for empty input', () => {
    expect(convertToolsOpenAI([])).toEqual([]);
  });
});

describe('normalizeOpenAIUsage', () => {
  it('maps prompt/completion tokens and cached tokens', () => {
    expect(normalizeOpenAIUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 30 },
    })).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 30 });
  });

  it('omits cacheReadTokens when zero/absent', () => {
    expect(normalizeOpenAIUsage({ prompt_tokens: 1, completion_tokens: 1 }))
      .toEqual({ inputTokens: 1, outputTokens: 1 });
  });

  it('reads DeepSeek top-level prompt_cache_hit_tokens', () => {
    // DeepSeek reports cache hits as a top-level sibling (not prompt_tokens_details).
    expect(normalizeOpenAIUsage({
      prompt_tokens: 500,
      completion_tokens: 60,
      prompt_cache_hit_tokens: 300,
    })).toEqual({ inputTokens: 500, outputTokens: 60, cacheReadTokens: 300 });
  });

  it('prefers the larger cache figure when both DeepSeek + OpenAI shapes present', () => {
    expect(normalizeOpenAIUsage({
      prompt_tokens: 500,
      completion_tokens: 60,
      prompt_cache_hit_tokens: 300,
      prompt_tokens_details: { cached_tokens: 120 },
    })).toEqual({ inputTokens: 500, outputTokens: 60, cacheReadTokens: 300 });
  });

  it('returns zero usage for undefined input', () => {
    expect(normalizeOpenAIUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('parseOpenAICompatResponse', () => {
  it('parses basic response with content and usage', () => {
    const res = parseOpenAICompatResponse({
      choices: [{ message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(res.content).toBe('Hello!');
    expect(res.finishReason).toBe('end_turn');
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('parses tool_calls from message', () => {
    const res = parseOpenAICompatResponse({
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'f', arguments: '{"x":1}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    expect(res.finishReason).toBe('tool_use');
    expect(res.toolCalls).toEqual([{ id: 'tc_1', name: 'f', arguments: { x: 1 } }]);
  });

  it('extracts reasoning from any shape', () => {
    for (const [field, value] of [
      ['reasoning_content', 'r1'],
      ['reasoning', 'r2'],
      ['thinking', 'r3'],
    ] as const) {
      const res = parseOpenAICompatResponse({
        choices: [{ message: { role: 'assistant', content: 'x', [field]: value }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
      expect(res.reasoningContent).toBe(value);
    }
    const details = parseOpenAICompatResponse({
      choices: [{ message: { role: 'assistant', content: 'x', reasoning_details: [{ text: 'rd' }] }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    expect(details.reasoningContent).toBe('rd');
  });

  it('throws when no choices are present', () => {
    expect(() => parseOpenAICompatResponse({ choices: [] })).toThrow(/choices/i);
  });

  it('invokes recoverTextToolCalls hook when no structured tool calls', () => {
    const res = parseOpenAICompatResponse(
      {
        choices: [{ message: { role: 'assistant', content: '<invoke name="f"></invoke>' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
      {
        recoverTextToolCalls: (content) => ({
          toolCalls: [{ id: 'tc_text', name: 'f', arguments: {} }],
          cleanedContent: content.replace(/<[^>]*>/g, ''),
        }),
      },
    );
    expect(res.toolCalls).toEqual([{ id: 'tc_text', name: 'f', arguments: {} }]);
    expect(res.finishReason).toBe('tool_use');
  });
});

describe('createSSEAccumulator', () => {
  const noop = () => {};

  it('accumulates text deltas and emits text_delta events', () => {
    const acc = createSSEAccumulator();
    const events: Array<{ type: string; text?: string }> = [];
    acc.feed({ choices: [{ delta: { content: 'hel' } }] }, {
      onText: (t) => events.push({ type: 'text_delta', text: t }),
    });
    acc.feed({ choices: [{ delta: { content: 'lo' } }] }, {
      onText: (t) => events.push({ type: 'text_delta', text: t }),
    });
    expect(acc.state.content).toBe('hello');
    expect(events.map(e => e.text)).toEqual(['hel', 'lo']);
  });

  it('accumulates reasoning deltas via extractDeltaReasoning shapes', () => {
    const acc = createSSEAccumulator();
    const thoughts: string[] = [];
    acc.feed({ choices: [{ delta: { reasoning_content: 'think1' } }] }, {
      onThinking: (t) => thoughts.push(t),
    });
    acc.feed({ choices: [{ delta: { reasoning_details: [{ text: 'think2' }] } }] }, {
      onThinking: (t) => thoughts.push(t),
    });
    expect(acc.state.reasoningContent).toBe('think1think2');
    expect(thoughts).toEqual(['think1', 'think2']);
  });

  it('accumulates tool_calls by index across chunks', () => {
    const acc = createSSEAccumulator();
    const starts: Array<{ id: string; name: string }> = [];
    const deltas: string[] = [];
    acc.feed({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc_1', function: { name: 'get_weather' } }] } }] }, {
      onToolStart: (t) => starts.push(t),
      onToolDelta: (t, text) => deltas.push(text),
    });
    acc.feed({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] } }] }, {
      onToolStart: noop,
      onToolDelta: (t, text) => deltas.push(text),
    });
    acc.feed({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ': "SF"}' } }] } }] }, {
      onToolStart: noop,
      onToolDelta: (t, text) => deltas.push(text),
    });
    expect(starts).toEqual([{ id: 'tc_1', name: 'get_weather' }]);
    expect(deltas).toEqual(['{"city"', ': "SF"}']);
    const calls = acc.finalizeToolCalls();
    expect(calls).toEqual([{ id: 'tc_1', name: 'get_weather', arguments: { city: 'SF' } }]);
  });

  it('tracks finish_reason via FINISH_REASON_MAP', () => {
    const acc = createSSEAccumulator();
    acc.feed({ choices: [{ delta: { content: 'x' }, finish_reason: 'tool_calls' }] }, {});
    expect(acc.state.finishReason).toBe('tool_use');
    acc.feed({ choices: [{ delta: { content: 'y' }, finish_reason: 'stop' }] }, {});
    expect(acc.state.finishReason).toBe('end_turn');
  });

  it('tracks usage chunks and keeps last raw usage', () => {
    const acc = createSSEAccumulator();
    acc.feed({ usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 40 }, cost: 0.001 } }, {});
    expect(acc.state.promptTokens).toBe(100);
    expect(acc.state.completionTokens).toBe(7);
    expect(acc.state.cachedTokens).toBe(40);
    expect(acc.state.lastRawUsage).toMatchObject({ cost: 0.001 });
  });

  it('ignores empty / non-choice chunks without crashing', () => {
    const acc = createSSEAccumulator();
    acc.feed({}, {});
    acc.feed({ choices: [] }, {});
    acc.feed({ choices: [{ delta: {} }] }, {});
    expect(acc.state.content).toBe('');
  });

  it('finalizeToolCalls filters calls without a name', () => {
    const acc = createSSEAccumulator();
    acc.feed({
      choices: [{ delta: { tool_calls: [
        { index: 0, id: 'a', function: { name: 'real', arguments: '{}' } },
        { index: 1, id: 'b', function: { arguments: '{}' } },
      ] } }],
    }, {});
    const calls = acc.finalizeToolCalls();
    expect(calls).toEqual([{ id: 'a', name: 'real', arguments: {} }]);
  });
});