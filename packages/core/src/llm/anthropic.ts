import { type LLMProviderConfig, type LLMRequest, type LLMResponse, type LLMStreamEvent, type LLMMessage, type LLMTool, type LLMContentPart, getTextContent } from '@markus/shared';
import type { LLMProviderInterface } from './provider.js';

interface AnthropicAPIMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'image' | 'compaction';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  source?: { type: 'base64'; media_type: string; data: string };
  summary?: string;
}

interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: string;
}

export class AnthropicProvider implements LLMProviderInterface {
  name = 'anthropic';
  model: string;
  private apiKey: string;
  private baseUrl: string;
  private maxTokens: number;

  constructor(config?: LLMProviderConfig) {
    this.model = config?.model ?? 'claude-sonnet-4-20250514';
    this.apiKey = config?.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
    this.baseUrl = config?.baseUrl ?? 'https://api.anthropic.com';
    this.maxTokens = config?.maxTokens ?? 4096;
  }

  configure(config: LLMProviderConfig): void {
    if (config.model) this.model = config.model;
    if (config.apiKey) this.apiKey = config.apiKey;
    if (config.baseUrl) this.baseUrl = config.baseUrl;
    if (config.maxTokens) this.maxTokens = config.maxTokens;
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const systemMsg = request.messages.find((m) => m.role === 'system');
    const messages = this.convertMessages(request.messages.filter((m) => m.role !== 'system'));
    const useCompaction = request.compaction && this.isCompactionSupported();

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxTokens ?? this.maxTokens,
      messages,
    };

    if (systemMsg) body['system'] = getTextContent(systemMsg.content);
    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.stopSequences?.length) body['stop_sequences'] = request.stopSequences;
    if (request.tools?.length) body['tools'] = this.convertTools(request.tools);
    if (useCompaction) {
      body['context_management'] = { edits: [{ type: 'compact_20260112' }] };
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    };
    if (useCompaction) {
      headers['anthropic-beta'] = 'compact-2026-01-12';
    }

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as AnthropicResponse;
    return this.convertResponse(data);
  }

  async chatStream(request: LLMRequest, onEvent: (event: LLMStreamEvent) => void, signal?: AbortSignal): Promise<LLMResponse> {
    const systemMsg = request.messages.find((m) => m.role === 'system');
    const messages = this.convertMessages(request.messages.filter((m) => m.role !== 'system'));
    const useCompaction = request.compaction && this.isCompactionSupported();

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxTokens ?? this.maxTokens,
      messages,
      stream: true,
    };
    if (systemMsg) body['system'] = getTextContent(systemMsg.content);
    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.stopSequences?.length) body['stop_sequences'] = request.stopSequences;
    if (request.tools?.length) body['tools'] = this.convertTools(request.tools);
    if (useCompaction) {
      body['context_management'] = { edits: [{ type: 'compact_20260112' }] };
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    };
    if (useCompaction) {
      headers['anthropic-beta'] = 'compact-2026-01-12';
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${errText}`);
    }

    let content = '';
    const toolCalls: Array<{ id: string; name: string; args: string }> = [];
    let currentToolIdx = -1;
    let finishReason: LLMResponse['finishReason'] = 'end_turn';
    let inputTokens = 0;
    let outputTokens = 0;

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
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const event = JSON.parse(trimmed.slice(6)) as {
            type: string;
            delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
            content_block?: { type?: string; id?: string; name?: string };
            index?: number;
            usage?: { input_tokens?: number; output_tokens?: number };
            message?: { usage?: { input_tokens?: number; output_tokens?: number } };
          };

          switch (event.type) {
            case 'message_start':
              inputTokens = event.message?.usage?.input_tokens ?? 0;
              break;
            case 'content_block_start':
              if (event.content_block?.type === 'tool_use') {
                currentToolIdx = toolCalls.length;
                toolCalls.push({ id: event.content_block.id ?? '', name: event.content_block.name ?? '', args: '' });
                onEvent({ type: 'tool_call_start', toolCall: { id: event.content_block.id, name: event.content_block.name } });
              }
              break;
            case 'content_block_delta':
              if (event.delta?.type === 'text_delta' && event.delta.text) {
                content += event.delta.text;
                onEvent({ type: 'text_delta', text: event.delta.text });
              } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json && currentToolIdx >= 0) {
                toolCalls[currentToolIdx].args += event.delta.partial_json;
                onEvent({ type: 'tool_call_delta', text: event.delta.partial_json });
              }
              break;
            case 'content_block_stop':
              if (currentToolIdx >= 0) {
                const tc = toolCalls[currentToolIdx];
                onEvent({ type: 'tool_call_end', toolCall: { id: tc.id, name: tc.name } });
                currentToolIdx = -1;
              }
              break;
            case 'message_delta':
              if (event.delta?.stop_reason) {
                const finishMap: Record<string, LLMResponse['finishReason']> = {
                  end_turn: 'end_turn', tool_use: 'tool_use', max_tokens: 'max_tokens', stop_sequence: 'stop_sequence',
                };
                finishReason = finishMap[event.delta.stop_reason] ?? 'end_turn';
              }
              if (event.usage?.output_tokens) outputTokens = event.usage.output_tokens;
              break;
          }
        } catch { /* skip unparseable */ }
      }
    }

    clearTimeout(timeout);

    const usage = { inputTokens, outputTokens };
    onEvent({ type: 'message_end', usage, finishReason });

    const parsedToolCalls = toolCalls
      .filter((tc) => tc.name)
      .map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.args ? (JSON.parse(tc.args) as Record<string, unknown>) : {},
      }));

    return {
      content,
      toolCalls: parsedToolCalls.length ? parsedToolCalls : undefined,
      usage,
      finishReason,
    };
  }

  private convertContentParts(parts: LLMContentPart[]): AnthropicContentBlock[] {
    const blocks: AnthropicContentBlock[] = [];
    for (const p of parts) {
      if (p.type === 'text') {
        blocks.push({ type: 'text', text: p.text });
      } else if (p.type === 'image_url') {
        const url = p.image_url.url;
        const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (match) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: match[1]!, data: match[2]! },
          });
        }
      }
    }
    return blocks;
  }

  private convertMessages(messages: LLMMessage[]): AnthropicAPIMessage[] {
    return messages.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'user' as const,
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: m.toolCallId ?? '',
              content: getTextContent(m.content),
            },
          ],
        };
      }

      if (m.toolCalls?.length) {
        const blocks: AnthropicContentBlock[] = [];
        const text = getTextContent(m.content);
        if (text) blocks.push({ type: 'text', text });
        for (const tc of m.toolCalls) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
        return { role: 'assistant' as const, content: blocks };
      }

      if (Array.isArray(m.content)) {
        return {
          role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
          content: this.convertContentParts(m.content),
        };
      }

      return {
        role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
        content: m.content,
      };
    });
  }

  private convertTools(tools: LLMTool[]): AnthropicToolDef[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  private isCompactionSupported(): boolean {
    return this.model.startsWith('claude-opus-4') || this.model.startsWith('claude-sonnet-4');
  }

  private convertResponse(data: AnthropicResponse): LLMResponse {
    let content = '';
    let compactionContent: string | undefined;
    const toolCalls: LLMResponse['toolCalls'] = [];

    for (const block of data.content) {
      if (block.type === 'text' && block.text) {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id!,
          name: block.name!,
          arguments: (block.input as Record<string, unknown>) ?? {},
        });
      } else if (block.type === 'compaction' && block.summary) {
        compactionContent = block.summary;
      }
    }

    const finishMap: Record<string, LLMResponse['finishReason']> = {
      end_turn: 'end_turn',
      tool_use: 'tool_use',
      max_tokens: 'max_tokens',
      stop_sequence: 'stop_sequence',
    };

    return {
      content,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
      },
      finishReason: finishMap[data.stop_reason] ?? 'end_turn',
      compactionContent,
    };
  }
}
