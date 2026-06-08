import { type LLMProviderConfig, type LLMRequest, type LLMResponse, type LLMStreamEvent, type LLMMessage, type LLMTool, type LLMContentPart, getTextContent, sanitizeLLMMessages } from '@markus/shared';
import type { LLMProviderInterface } from './provider.js';
import type { TokenResolver } from './openai.js';
import { proxyFetch } from './proxy-fetch.js';

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

interface CodexInputItem {
  type: 'message';
  role: 'user' | 'assistant' | 'developer';
  content: Array<{ type: 'input_text'; text: string } | { type: 'output_text'; text: string } | { type: 'input_image'; image_url: string }>;
}

interface CodexToolDef {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export class CodexResponsesProvider implements LLMProviderInterface {
  name: string;
  model: string;
  private baseUrl: string;
  private timeoutMs: number;
  private tokenResolver: TokenResolver;
  private accountId?: string;

  constructor(config: LLMProviderConfig, tokenResolver: TokenResolver, accountId?: string) {
    this.name = config.provider ?? 'openai-codex';
    this.model = config.model ?? 'gpt-5.5';
    this.baseUrl = config.baseUrl ?? CODEX_BASE_URL;
    this.timeoutMs = config.timeoutMs ?? 180_000;
    this.tokenResolver = tokenResolver;
    this.accountId = accountId;
  }

  configure(config: LLMProviderConfig): void {
    if (config.model) this.model = config.model;
    if (config.baseUrl) this.baseUrl = config.baseUrl;
    if (config.timeoutMs) this.timeoutMs = config.timeoutMs;
  }

  setAccountId(accountId: string): void {
    this.accountId = accountId;
  }

  /**
   * Codex backend is stream-only. Non-streaming chat collects the full SSE stream.
   */
  async chat(request: LLMRequest): Promise<LLMResponse> {
    let content = '';
    let reasoningContent = '';
    const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
    let usage = { inputTokens: 0, outputTokens: 0 };
    let finishReason: LLMResponse['finishReason'] = 'end_turn';

    await this.chatStream(request, (event) => {
      if (event.type === 'text_delta' && event.text) content += event.text;
      if (event.type === 'thinking_delta' && event.thinking) reasoningContent += event.thinking;
      if (event.type === 'message_end') {
        if (event.usage) usage = event.usage;
        if (event.finishReason) finishReason = event.finishReason;
      }
    });

    // Collect tool calls from the accumulated state in chatStream
    const result: LLMResponse = { content, toolCalls: toolCalls.length ? toolCalls : undefined, usage, finishReason };
    if (reasoningContent) result.reasoningContent = reasoningContent;
    return result;
  }

  async chatStream(request: LLMRequest, onEvent: (event: LLMStreamEvent) => void, signal?: AbortSignal): Promise<LLMResponse> {
    const { instructions, input } = this.convertMessages(request.messages);
    const body: Record<string, unknown> = {
      model: this.model,
      instructions: instructions || '',
      input,
      stream: true,
      store: false,
    };

    if (request.tools?.length) {
      body['tools'] = this.convertTools(request.tools);
      body['tool_choice'] = 'auto';
      body['parallel_tool_calls'] = false;
    }

    body['reasoning'] = { effort: 'medium', summary: 'auto' };

    const endpoint = `${this.baseUrl.replace(/\/+$/, '')}/responses`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

    let res: Response;
    try {
      const token = await this.tokenResolver();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      };
      if (this.accountId) {
        headers['ChatGPT-Account-Id'] = this.accountId;
      }

      res = await proxyFetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Codex API request failed: ${msg}`);
    }

    if (!res.ok) {
      clearTimeout(timeout);
      const errText = await res.text();
      throw new Error(`Codex API error ${res.status}: ${errText}`);
    }

    let content = '';
    let reasoningContent = '';
    const toolCallsMap = new Map<string, { id: string; name: string; args: string; callId: string }>();
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
        if (!trimmed || trimmed.startsWith(':')) continue;

        if (trimmed.startsWith('event: ')) continue;

        if (!trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') continue;

        try {
          const event = JSON.parse(dataStr);
          this.handleSSEEvent(event, onEvent, {
            content: () => content,
            setContent: (v: string) => { content = v; },
            appendContent: (v: string) => { content += v; },
            reasoningContent: () => reasoningContent,
            appendReasoning: (v: string) => { reasoningContent += v; },
            toolCallsMap,
            setFinishReason: (v: LLMResponse['finishReason']) => { finishReason = v; },
            setTokens: (input: number, output: number) => { promptTokens = input; completionTokens = output; },
          });
        } catch { /* skip unparseable lines */ }
      }
    }

    clearTimeout(timeout);

    const resultToolCalls = [...toolCallsMap.values()]
      .filter(tc => tc.name)
      .map(tc => {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.args) as Record<string, unknown>; } catch { /* empty */ }
        onEvent({ type: 'tool_call_end', toolCall: { id: tc.callId, name: tc.name } });
        return { id: tc.callId, name: tc.name, arguments: args };
      });

    if (resultToolCalls.length) finishReason = 'tool_use';

    const usage = { inputTokens: promptTokens, outputTokens: completionTokens };
    onEvent({ type: 'message_end', usage, finishReason });

    const result: LLMResponse = {
      content,
      toolCalls: resultToolCalls.length ? resultToolCalls : undefined,
      usage,
      finishReason,
    };
    if (reasoningContent) result.reasoningContent = reasoningContent;
    return result;
  }

  private handleSSEEvent(
    event: any,
    onEvent: (event: LLMStreamEvent) => void,
    state: {
      content: () => string;
      setContent: (v: string) => void;
      appendContent: (v: string) => void;
      reasoningContent: () => string;
      appendReasoning: (v: string) => void;
      toolCallsMap: Map<string, { id: string; name: string; args: string; callId: string }>;
      setFinishReason: (v: LLMResponse['finishReason']) => void;
      setTokens: (input: number, output: number) => void;
    },
  ): void {
    const type = event.type as string;

    switch (type) {
      case 'response.output_text.delta': {
        const delta = event.delta as string;
        if (delta) {
          state.appendContent(delta);
          onEvent({ type: 'text_delta', text: delta });
        }
        break;
      }

      case 'response.reasoning_summary_text.delta': {
        const delta = event.delta as string;
        if (delta) {
          state.appendReasoning(delta);
          onEvent({ type: 'thinking_delta', thinking: delta });
        }
        break;
      }

      case 'response.function_call_arguments.delta': {
        const itemId = event.item_id as string;
        const delta = event.delta as string;
        if (itemId && delta) {
          const tc = state.toolCallsMap.get(itemId);
          if (tc) {
            tc.args += delta;
            onEvent({ type: 'tool_call_delta', toolCall: { id: tc.callId }, text: delta });
          }
        }
        break;
      }

      case 'response.output_item.added': {
        const item = event.item;
        if (item?.type === 'function_call') {
          const callId = item.call_id ?? item.id ?? '';
          state.toolCallsMap.set(item.id, { id: item.id, name: item.name ?? '', args: '', callId });
          if (item.name) {
            onEvent({ type: 'tool_call_start', toolCall: { id: callId, name: item.name } });
          }
        }
        break;
      }

      case 'response.function_call_arguments.done': {
        const itemId = event.item_id as string;
        if (itemId) {
          const tc = state.toolCallsMap.get(itemId);
          if (tc && !tc.name && event.name) tc.name = event.name;
        }
        break;
      }

      case 'response.completed': {
        const response = event.response;
        if (response?.usage) {
          state.setTokens(
            response.usage.input_tokens ?? response.usage.prompt_tokens ?? 0,
            response.usage.output_tokens ?? response.usage.completion_tokens ?? 0,
          );
        }
        if (response?.status === 'completed') {
          state.setFinishReason(state.toolCallsMap.size > 0 ? 'tool_use' : 'end_turn');
        }
        break;
      }

      case 'response.output_item.done': {
        const item = event.item;
        if (item?.type === 'function_call') {
          const tc = state.toolCallsMap.get(item.id);
          if (tc) {
            if (item.name && !tc.name) tc.name = item.name;
            if (item.arguments && !tc.args) tc.args = item.arguments;
            if (item.call_id && !tc.callId) tc.callId = item.call_id;
          }
        }
        break;
      }

      default:
        break;
    }
  }

  private convertMessages(messages: LLMMessage[]): { instructions: string; input: CodexInputItem[] } {
    const cleaned = sanitizeLLMMessages(messages);
    let instructions = '';
    const input: CodexInputItem[] = [];

    for (const msg of cleaned) {
      if (msg.role === 'system') {
        const text = getTextContent(msg.content);
        instructions += (instructions ? '\n\n' : '') + text;
        continue;
      }

      if (msg.role === 'tool') {
        input.push({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `[Tool Result (${msg.toolCallId})]: ${getTextContent(msg.content)}` }],
        });
        continue;
      }

      if (msg.role === 'assistant') {
        const parts: CodexInputItem['content'] = [];
        const text = getTextContent(msg.content);
        if (text) parts.push({ type: 'output_text', text });
        if (msg.toolCalls?.length) {
          const tcText = msg.toolCalls.map(tc => `[Tool Call: ${tc.name}(${JSON.stringify(tc.arguments)})]`).join('\n');
          parts.push({ type: 'output_text', text: tcText });
        }
        if (parts.length) {
          input.push({ type: 'message', role: 'assistant', content: parts });
        }
        continue;
      }

      // user message
      const contentParts = this.convertContentParts(msg.content);
      if (contentParts.length) {
        input.push({ type: 'message', role: 'user', content: contentParts });
      }
    }

    return { instructions, input };
  }

  private convertContentParts(content: string | LLMContentPart[]): CodexInputItem['content'] {
    if (typeof content === 'string') {
      return content ? [{ type: 'input_text', text: content }] : [];
    }
    return content.map(part => {
      if (part.type === 'image_url') {
        return { type: 'input_image' as const, image_url: part.image_url.url };
      }
      return { type: 'input_text' as const, text: part.text };
    });
  }

  private convertTools(tools: LLMTool[]): CodexToolDef[] {
    const seen = new Set<string>();
    const unique: CodexToolDef[] = [];
    for (const t of tools) {
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      unique.push({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      });
    }
    return unique;
  }
}
