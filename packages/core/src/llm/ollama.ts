import { type LLMProviderConfig, type LLMRequest, type LLMResponse, type LLMStreamEvent, type LLMMessage, type LLMTool, getTextContent } from '@markus/shared';
import type { LLMProviderInterface } from './provider.js';

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}

interface OllamaTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface OllamaChatResponse {
  message: OllamaMessage;
  done: boolean;
  total_duration?: number;
  eval_count?: number;
  prompt_eval_count?: number;
}

/**
 * Ollama LLM provider for local model inference.
 * Connects to a running Ollama server via its REST API.
 */
export class OllamaProvider implements LLMProviderInterface {
  name = 'ollama';
  model: string;
  private baseUrl: string;
  private maxTokens: number;

  constructor(config?: LLMProviderConfig) {
    this.model = config?.model ?? 'llama3.1';
    this.baseUrl = config?.baseUrl ?? 'http://localhost:11434';
    this.maxTokens = config?.maxTokens ?? 4096;
  }

  configure(config: LLMProviderConfig): void {
    if (config.model) this.model = config.model;
    if (config.baseUrl) this.baseUrl = config.baseUrl;
    if (config.maxTokens) this.maxTokens = config.maxTokens;
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const messages = this.convertMessages(request.messages);

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
      options: {
        num_predict: request.maxTokens ?? this.maxTokens,
        ...(request.temperature !== undefined && { temperature: request.temperature }),
        ...(request.stopSequences?.length && { stop: request.stopSequences }),
      },
    };

    if (request.tools?.length) {
      body['tools'] = this.convertTools(request.tools);
    }

    const endpoint = `${this.baseUrl.replace(/\/+$/, '')}/api/chat`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Ollama API error ${res.status}: ${errText}`);
      }

      const data = (await res.json()) as OllamaChatResponse;
      return this.convertResponse(data);
    } finally {
      clearTimeout(timeout);
    }
  }

  async chatStream(request: LLMRequest, onEvent: (event: LLMStreamEvent) => void, signal?: AbortSignal): Promise<LLMResponse> {
    const messages = this.convertMessages(request.messages);

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
      options: {
        num_predict: request.maxTokens ?? this.maxTokens,
        ...(request.temperature !== undefined && { temperature: request.temperature }),
      },
    };

    if (request.tools?.length) {
      body['tools'] = this.convertTools(request.tools);
    }

    const endpoint = `${this.baseUrl.replace(/\/+$/, '')}/api/chat`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }

    if (!res.ok) {
      clearTimeout(timeout);
      const errText = await res.text();
      throw new Error(`Ollama API error ${res.status}: ${errText}`);
    }

    let content = '';
    const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
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
        if (!trimmed) continue;

        try {
          const chunk = JSON.parse(trimmed) as OllamaChatResponse;

          if (chunk.message?.content) {
            content += chunk.message.content;
            onEvent({ type: 'text_delta', text: chunk.message.content });
          }

          if (chunk.message?.tool_calls) {
            for (const tc of chunk.message.tool_calls) {
              const id = `call_${Date.now()}_${toolCalls.length}`;
              toolCalls.push({ id, name: tc.function.name, arguments: tc.function.arguments });
              onEvent({ type: 'tool_call_start', toolCall: { id, name: tc.function.name } });
              onEvent({ type: 'tool_call_end', toolCall: { id, name: tc.function.name } });
            }
          }

          if (chunk.done) {
            promptTokens = chunk.prompt_eval_count ?? 0;
            completionTokens = chunk.eval_count ?? 0;
          }
        } catch { /* skip */ }
      }
    }

    clearTimeout(timeout);

    const finishReason: LLMResponse['finishReason'] = toolCalls.length > 0 ? 'tool_use' : 'end_turn';
    const usage = { inputTokens: promptTokens, outputTokens: completionTokens };
    onEvent({ type: 'message_end', usage, finishReason });

    return { content, toolCalls: toolCalls.length ? toolCalls : undefined, usage, finishReason };
  }

  private convertMessages(messages: LLMMessage[]): OllamaMessage[] {
    return messages.map(m => {
      if (m.role === 'tool') {
        return { role: 'tool' as const, content: getTextContent(m.content) };
      }
      if (m.toolCalls?.length) {
        return {
          role: 'assistant' as const,
          content: getTextContent(m.content) || '',
          tool_calls: m.toolCalls.map(tc => ({
            function: { name: tc.name, arguments: tc.arguments },
          })),
        };
      }
      if (Array.isArray(m.content)) {
        const text = m.content.filter(p => p.type === 'text').map(p => (p as {type:'text';text:string}).text).join('');
        const images = m.content
          .filter(p => p.type === 'image_url')
          .map(p => {
            const url = (p as {type:'image_url';image_url:{url:string}}).image_url.url;
            const match = url.match(/^data:image\/[^;]+;base64,(.+)$/);
            return match ? match[1]! : '';
          })
          .filter(Boolean);
        const msg: OllamaMessage = { role: m.role as OllamaMessage['role'], content: text };
        if (images.length > 0) msg.images = images;
        return msg;
      }
      return { role: m.role as OllamaMessage['role'], content: m.content };
    });
  }

  private convertTools(tools: LLMTool[]): OllamaTool[] {
    return tools.map(t => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }

  private convertResponse(data: OllamaChatResponse): LLMResponse {
    const toolCalls = data.message.tool_calls?.map((tc, i) => ({
      id: `call_${Date.now()}_${i}`,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));

    return {
      content: data.message.content ?? '',
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
      },
      finishReason: toolCalls?.length ? 'tool_use' : 'end_turn',
    };
  }
}
