import type { LLMProviderConfig, LLMRequest, LLMResponse, LLMMessage, LLMTool } from '@markus/shared';
import type { LLMProviderInterface } from './provider.js';

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
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

export class OpenAIProvider implements LLMProviderInterface {
  name = 'openai';
  model: string;
  private apiKey: string;
  private baseUrl: string;
  private maxTokens: number;

  constructor(config?: LLMProviderConfig) {
    this.model = config?.model ?? 'gpt-4o';
    this.apiKey = config?.apiKey ?? process.env['OPENAI_API_KEY'] ?? '';
    this.baseUrl = config?.baseUrl ?? 'https://api.openai.com';
    this.maxTokens = config?.maxTokens ?? 4096;
  }

  configure(config: LLMProviderConfig): void {
    if (config.model) this.model = config.model;
    if (config.apiKey) this.apiKey = config.apiKey;
    if (config.baseUrl) this.baseUrl = config.baseUrl;
    if (config.maxTokens) this.maxTokens = config.maxTokens;
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
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as OpenAIResponse;
    return this.convertResponse(data);
  }

  private convertMessages(messages: LLMMessage[]): OpenAIMessage[] {
    return messages.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool' as const,
          content: m.content,
          tool_call_id: m.toolCallId ?? '',
        };
      }

      if (m.toolCalls?.length) {
        return {
          role: 'assistant' as const,
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
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
      content: msg.content ?? '',
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      usage: {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
      },
      finishReason: finishMap[choice.finish_reason] ?? 'end_turn',
    };
  }
}
