import { type LLMProviderConfig, type LLMRequest, type LLMResponse, type LLMStreamEvent, type LLMMessage, type LLMTool, type LLMContentPart, getTextContent } from '@markus/shared';
import type { LLMProviderInterface } from './provider.js';

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | Array<{type: string; text?: string; image_url?: {url: string}}>;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface OpenAIResponse {
  choices: Array<{
    message: OpenAIMessage;
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number };
}

export type TokenResolver = () => Promise<string>;

export class OpenAIProvider implements LLMProviderInterface {
  name: string;
  model: string;
  private apiKey: string;
  private baseUrl: string;
  private maxTokens: number;
  private chatTimeoutMs: number;
  private streamTimeoutMs: number;
  private tokenResolver?: TokenResolver;

  constructor(config?: LLMProviderConfig, tokenResolver?: TokenResolver) {
    this.name = config?.provider ?? 'openai';
    this.model = config?.model ?? 'gpt-4o';
    this.apiKey = config?.apiKey ?? process.env['OPENAI_API_KEY'] ?? '';
    this.baseUrl = config?.baseUrl ?? 'https://api.openai.com';
    this.maxTokens = config?.maxTokens ?? 4096;
    this.chatTimeoutMs = config?.timeoutMs ?? 90_000;
    this.streamTimeoutMs = config?.timeoutMs ?? 120_000;
    this.tokenResolver = tokenResolver;
  }

  configure(config: LLMProviderConfig): void {
    if (config.model) this.model = config.model;
    if (config.apiKey) this.apiKey = config.apiKey;
    if (config.baseUrl) this.baseUrl = config.baseUrl;
    if (config.maxTokens) this.maxTokens = config.maxTokens;
    if (config.timeoutMs) {
      this.chatTimeoutMs = config.timeoutMs;
      this.streamTimeoutMs = config.timeoutMs;
    }
  }

  setTokenResolver(resolver: TokenResolver): void {
    this.tokenResolver = resolver;
  }

  private async resolveAuthHeader(): Promise<string> {
    if (this.tokenResolver) {
      const token = await this.tokenResolver();
      return `Bearer ${token}`;
    }
    return `Bearer ${this.apiKey}`;
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const messages = this.convertMessages(request.messages);

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxTokens ?? this.maxTokens,
      messages,
    };

    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.stopSequences?.length) body['stop'] = request.stopSequences;
    if (request.tools?.length) body['tools'] = this.convertTools(request.tools);

    const base = this.baseUrl.replace(/\/+$/, '');
    const endpoint = base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.chatTimeoutMs);
    try {
      const authorization = await this.resolveAuthHeader();
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authorization,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OpenAI API error ${res.status}: ${errText}`);
      }

      const data = (await res.json()) as OpenAIResponse;
      return this.convertResponse(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const cause = (err as NodeJS.ErrnoException).cause;
      const detail = cause instanceof Error ? ` (${cause.message})` : '';
      throw new Error(`${msg}${detail}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private convertMessages(messages: LLMMessage[]): OpenAIMessage[] {
    return messages.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool' as const,
          content: getTextContent(m.content),
          tool_call_id: m.toolCallId ?? '',
        };
      }

      if (m.toolCalls?.length) {
        return {
          role: 'assistant' as const,
          content: getTextContent(m.content) || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        };
      }

      if (Array.isArray(m.content)) {
        return {
          role: m.role,
          content: m.content.map((p: LLMContentPart) =>
            p.type === 'image_url'
              ? { type: 'image_url' as const, image_url: { url: p.image_url.url } }
              : { type: 'text' as const, text: p.text }
          ),
        };
      }

      return { role: m.role, content: m.content };
    });
  }

  private convertTools(tools: LLMTool[]): OpenAIToolDef[] {
    return tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  async chatStream(request: LLMRequest, onEvent: (event: LLMStreamEvent) => void, signal?: AbortSignal): Promise<LLMResponse> {
    const messages = this.convertMessages(request.messages);
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxTokens ?? this.maxTokens,
      messages,
      stream: true,
    };
    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.stopSequences?.length) body['stop'] = request.stopSequences;
    if (request.tools?.length) body['tools'] = this.convertTools(request.tools);

    const base = this.baseUrl.replace(/\/+$/, '');
    const endpoint = base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.streamTimeoutMs);
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
    let res: Response;
    try {
      const authorization = await this.resolveAuthHeader();
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authorization,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      const msg = err instanceof Error ? err.message : String(err);
      const cause = (err as NodeJS.ErrnoException).cause;
      const detail = cause instanceof Error ? ` (${cause.message})` : '';
      throw new Error(`${msg}${detail}`);
    }

    if (!res.ok) {
      clearTimeout(timeout);
      const errText = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${errText}`);
    }

    let content = '';
    const toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();
    let finishReason: LLMResponse['finishReason'] = 'end_turn';
    let promptTokens = 0;
    let completionTokens = 0;

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body reader');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const chunk = JSON.parse(trimmed.slice(6)) as {
            choices?: Array<{
              delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>; reasoning_details?: string; thinking?: string };
              finish_reason?: string;
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };

          const choice = chunk.choices?.[0];

          // Handle reasoning/thinking content from various providers
          // MiniMax may return: reasoning_details, thinking, or content with 【【】 tags
          const reasoningContent = choice?.delta?.reasoning_details ?? choice?.delta?.thinking;
          if (reasoningContent) {
            onEvent({ type: 'thinking_delta', thinking: reasoningContent });
          }

          if (choice?.delta?.content) {
            content += choice.delta.content;
            onEvent({ type: 'text_delta', text: choice.delta.content });
          }

          if (choice?.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              if (!toolCalls.has(tc.index)) {
                toolCalls.set(tc.index, { id: tc.id ?? '', name: '', args: '' });
              }
              const existing = toolCalls.get(tc.index)!;
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) {
                existing.name = tc.function.name;
                onEvent({ type: 'tool_call_start', toolCall: { id: existing.id, name: existing.name } });
              }
              if (tc.function?.arguments) {
                existing.args += tc.function.arguments;
                onEvent({ type: 'tool_call_delta', toolCall: { id: existing.id }, text: tc.function.arguments });
              }
            }
          }

          if (choice?.finish_reason) {
            const finishMap: Record<string, LLMResponse['finishReason']> = {
              stop: 'end_turn', tool_calls: 'tool_use', length: 'max_tokens',
            };
            finishReason = finishMap[choice.finish_reason] ?? 'end_turn';
          }

          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens ?? 0;
            completionTokens = chunk.usage.completion_tokens ?? 0;
          }
        } catch { /* skip unparseable lines */ }
      }
    }

    clearTimeout(timeout);

    const resultToolCalls = [...toolCalls.values()]
      .filter((tc) => tc.name)
      .map((tc) => {
        onEvent({ type: 'tool_call_end', toolCall: { id: tc.id, name: tc.name } });
        return {
          id: tc.id,
          name: tc.name,
          arguments: tc.args ? (JSON.parse(tc.args) as Record<string, unknown>) : {},
        };
      });

    const usage = { inputTokens: promptTokens, outputTokens: completionTokens };
    onEvent({ type: 'message_end', usage, finishReason });

    return {
      content,
      toolCalls: resultToolCalls.length ? resultToolCalls : undefined,
      usage,
      finishReason,
    };
  }

  private convertResponse(data: OpenAIResponse): LLMResponse {
    const choice = data.choices[0];
    if (!choice) throw new Error('No response choice from OpenAI');

    const msg = choice.message;
    const toolCalls = msg.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }));

    const finishMap: Record<string, LLMResponse['finishReason']> = {
      stop: 'end_turn',
      tool_calls: 'tool_use',
      length: 'max_tokens',
    };

    return {
      content: typeof msg.content === 'string' ? msg.content : '',
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      usage: {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
      },
      finishReason: finishMap[choice.finish_reason] ?? 'end_turn',
    };
  }
}
