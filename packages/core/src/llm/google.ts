import type { LLMProviderConfig, LLMRequest, LLMResponse, LLMStreamEvent, LLMMessage, LLMTool } from '@markus/shared';
import type { LLMProviderInterface } from './provider.js';

interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text: string } | { functionCall: { name: string; args: Record<string, unknown> } } | { functionResponse: { name: string; response: { result: string } } }>;
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface GeminiResponse {
  candidates: Array<{
    content: { parts: Array<{ text?: string; functionCall?: { name: string; args: Record<string, unknown> } }> };
    finishReason: string;
  }>;
  usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
}

/**
 * Google Gemini LLM provider using the REST API.
 * Supports chat, tool use, and streaming.
 */
export class GoogleProvider implements LLMProviderInterface {
  name = 'google';
  model: string;
  private apiKey: string;
  private baseUrl: string;
  private maxTokens: number;

  constructor(config?: LLMProviderConfig) {
    this.model = config?.model ?? 'gemini-2.0-flash';
    this.apiKey = config?.apiKey ?? process.env['GOOGLE_API_KEY'] ?? '';
    this.baseUrl = config?.baseUrl ?? 'https://generativelanguage.googleapis.com';
    this.maxTokens = config?.maxTokens ?? 4096;
  }

  configure(config: LLMProviderConfig): void {
    if (config.model) this.model = config.model;
    if (config.apiKey) this.apiKey = config.apiKey;
    if (config.baseUrl) this.baseUrl = config.baseUrl;
    if (config.maxTokens) this.maxTokens = config.maxTokens;
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const { contents, systemInstruction } = this.convertMessages(request.messages);

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? this.maxTokens,
        ...(request.temperature !== undefined && { temperature: request.temperature }),
        ...(request.stopSequences?.length && { stopSequences: request.stopSequences }),
      },
    };

    if (systemInstruction) {
      body['systemInstruction'] = { parts: [{ text: systemInstruction }] };
    }

    if (request.tools?.length) {
      body['tools'] = [{ functionDeclarations: this.convertTools(request.tools) }];
    }

    const endpoint = `${this.baseUrl}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini API error ${res.status}: ${errText}`);
      }

      const data = (await res.json()) as GeminiResponse;
      return this.convertResponse(data);
    } finally {
      clearTimeout(timeout);
    }
  }

  async chatStream(request: LLMRequest, onEvent: (event: LLMStreamEvent) => void, signal?: AbortSignal): Promise<LLMResponse> {
    const { contents, systemInstruction } = this.convertMessages(request.messages);

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? this.maxTokens,
        ...(request.temperature !== undefined && { temperature: request.temperature }),
      },
    };

    if (systemInstruction) {
      body['systemInstruction'] = { parts: [{ text: systemInstruction }] };
    }

    if (request.tools?.length) {
      body['tools'] = [{ functionDeclarations: this.convertTools(request.tools) }];
    }

    const endpoint = `${this.baseUrl}/v1beta/models/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
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
      throw new Error(`Gemini API error ${res.status}: ${errText}`);
    }

    let content = '';
    const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
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
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const chunk = JSON.parse(trimmed.slice(6)) as GeminiResponse;
          const candidate = chunk.candidates?.[0];

          if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
              if (part.text) {
                content += part.text;
                onEvent({ type: 'text_delta', text: part.text });
              }
              if (part.functionCall) {
                const id = `call_${Date.now()}_${toolCalls.length}`;
                toolCalls.push({ id, name: part.functionCall.name, arguments: part.functionCall.args });
                onEvent({ type: 'tool_call_start', toolCall: { id, name: part.functionCall.name } });
                onEvent({ type: 'tool_call_end', toolCall: { id, name: part.functionCall.name } });
              }
            }
          }

          if (candidate?.finishReason) {
            finishReason = this.mapFinishReason(candidate.finishReason);
          }

          if (chunk.usageMetadata) {
            promptTokens = chunk.usageMetadata.promptTokenCount ?? 0;
            completionTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
          }
        } catch { /* skip unparseable */ }
      }
    }

    clearTimeout(timeout);

    const usage = { inputTokens: promptTokens, outputTokens: completionTokens };
    onEvent({ type: 'message_end', usage, finishReason });

    return { content, toolCalls: toolCalls.length ? toolCalls : undefined, usage, finishReason };
  }

  private convertMessages(messages: LLMMessage[]): { contents: GeminiContent[]; systemInstruction?: string } {
    let systemInstruction: string | undefined;
    const contents: GeminiContent[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = (systemInstruction ? systemInstruction + '\n' : '') + msg.content;
        continue;
      }

      if (msg.role === 'tool') {
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: msg.toolCallId ?? 'unknown',
              response: { result: msg.content },
            },
          }],
        });
        continue;
      }

      if (msg.role === 'assistant') {
        const parts: GeminiContent['parts'] = [];
        if (msg.content) parts.push({ text: msg.content });
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
          }
        }
        if (parts.length > 0) contents.push({ role: 'model', parts });
        continue;
      }

      contents.push({ role: 'user', parts: [{ text: msg.content }] });
    }

    return { contents, systemInstruction };
  }

  private convertTools(tools: LLMTool[]): GeminiFunctionDeclaration[] {
    return tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));
  }

  private mapFinishReason(reason: string): LLMResponse['finishReason'] {
    const map: Record<string, LLMResponse['finishReason']> = {
      STOP: 'end_turn',
      MAX_TOKENS: 'max_tokens',
      SAFETY: 'end_turn',
    };
    return map[reason] ?? 'end_turn';
  }

  private convertResponse(data: GeminiResponse): LLMResponse {
    const candidate = data.candidates?.[0];
    if (!candidate) throw new Error('No response candidate from Gemini');

    let content = '';
    const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];

    for (const part of candidate.content.parts) {
      if (part.text) content += part.text;
      if (part.functionCall) {
        toolCalls.push({
          id: `call_${Date.now()}_${toolCalls.length}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args,
        });
      }
    }

    return {
      content,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
      finishReason: this.mapFinishReason(candidate.finishReason),
    };
  }
}
