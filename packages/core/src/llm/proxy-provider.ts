/**
 * ProxyProvider — LLM provider wrapper that routes requests through
 * the CF Worker proxy (platform-credit mode) instead of calling
 * LLM providers directly.
 *
 * Architecture
 * ────────────
 *   LLMRouter.chat() ─→ ProxyProvider ─→ CF Worker Proxy ─→ Upstream LLM
 *                                              │
 *                                              └── Returns LLM response + CU headers
 *
 * The proxy speaks the OpenAI Chat Completions wire format on both
 * sides, so this class uses the same body serialisation and response
 * parsing as OpenAIProvider but changes the endpoint URL to the proxy.
 */

import { createLogger } from '@markus/shared';
import type { LLMProviderConfig, LLMRequest, LLMResponse, LLMStreamEvent } from '@markus/shared';
import type { LLMProviderInterface } from './provider.js';
import type { CUCache } from './cu-cache.js';

const log = createLogger('proxy-provider');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProxyProviderConfig {
  /** CF Worker proxy URL (e.g. "http://localhost:8787" or deployed URL) */
  proxyUrl: string;
  /** Optional JWT / subscription key for proxy auth */
  apiKey?: string;
  /** Default model ID to use */
  defaultModel?: string;
  /** Request timeout in ms */
  timeoutMs?: number;
  /** CU cache instance to record usage (optional — can be set later) */
  cuCache?: CUCache;
}

// ---------------------------------------------------------------------------
// ProxyProvider
// ---------------------------------------------------------------------------

export class ProxyProvider implements LLMProviderInterface {
  readonly name: string;
  model: string;
  private proxyUrl: string;
  private apiKey: string;
  private chatTimeoutMs: number;
  private streamTimeoutMs: number;
  /** Max retry attempts for transient network failures (timeout, DNS, TCP reset) */
  private maxRetries = 1;
  private cuCache?: CUCache;

  constructor(config: ProxyProviderConfig) {
    this.name = 'proxy';
    this.model = config.defaultModel ?? 'claude-sonnet-4-20250514';
    this.proxyUrl = config.proxyUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey ?? '';
    this.chatTimeoutMs = config.timeoutMs ?? 90_000;
    this.streamTimeoutMs = config.timeoutMs ?? 120_000;
    this.cuCache = config.cuCache;
  }

  /** Allow late-binding of the CU cache (e.g. after Router init). */
  setCUCache(cache: CUCache): void {
    this.cuCache = cache;
  }

  /** Return the proxy URL for diagnostic purposes. */
  getProxyUrl(): string {
    return this.proxyUrl;
  }

  configure(config: LLMProviderConfig): void {
    if (config.model) this.model = config.model;
    if (config.apiKey) this.apiKey = config.apiKey;
    if (config.timeoutMs) {
      this.chatTimeoutMs = config.timeoutMs;
      this.streamTimeoutMs = config.timeoutMs;
    }
  }

  // ---- Chat (non-streaming) -----------------------------------------------

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const body = this.buildRequestBody(request);
    const endpoint = `${this.proxyUrl}/v1/chat/completions`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.chatTimeoutMs);

    try {
      const { res } = await this.fetchWithRetry(endpoint, body, controller, false);

      if (!res.ok) {
        const errText = await res.text();
        // CU exhausted (402 Payment Required) — return friendly error, do NOT degrade
        if (res.status === 402 || /cu.*(exhausted|limit|insufficient)/i.test(errText)) {
          throw new Error(`CU_EXCEEDED: ${errText}`);
        }
        throw new Error(`Proxy API error ${res.status}: ${errText}`);
      }

      const response = this.parseChatResponse(await res.json() as Record<string, unknown>);

      // Record CU usage from proxy response headers
      this.recordCU(res, response);

      return response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if ((err as Error).name === 'AbortError') {
        throw new Error(`Proxy request timed out after ${this.chatTimeoutMs}ms`);
      }
      // Wrap with PROXY_UNAVAILABLE prefix so the router can degrade to direct mode
      if (this.isProxyUnavailableError(err)) {
        throw new Error(`PROXY_UNAVAILABLE: ${msg}`);
      }
      throw new Error(`Proxy chat failed: ${msg}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  // ---- Streaming ----------------------------------------------------------

  async chatStream(
    request: LLMRequest,
    onEvent: (event: LLMStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const body = this.buildRequestBody(request, true);
    const endpoint = `${this.proxyUrl}/v1/chat/completions`;
    const controller = new AbortController();

    // Combine external signal with timeout
    const handleAbort = () => controller.abort();
    signal?.addEventListener('abort', handleAbort);
    const timeout = setTimeout(() => controller.abort(), this.streamTimeoutMs);

    try {
      const { res } = await this.fetchWithRetry(endpoint, body, controller, true);

      if (!res.ok) {
        const errText = await res.text();
        // CU exhausted (402 Payment Required) — return friendly error, do NOT degrade
        if (res.status === 402 || /cu.*(exhausted|limit|insufficient)/i.test(errText)) {
          throw new Error(`CU_EXCEEDED: ${errText}`);
        }
        throw new Error(`Proxy stream error ${res.status}: ${errText}`);
      }

      const response = await this.processStream(res, onEvent, signal);

      // Record CU usage from proxy response headers
      this.recordCU(res, response);

      return response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if ((err as Error).name === 'AbortError') {
        throw new Error(`Proxy stream timed out after ${this.streamTimeoutMs}ms`);
      }
      // Wrap with PROXY_UNAVAILABLE prefix so the router can degrade to direct mode
      if (this.isProxyUnavailableError(err)) {
        throw new Error(`PROXY_UNAVAILABLE: ${msg}`);
      }
      throw new Error(`Proxy stream failed: ${msg}`);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', handleAbort);
    }
  }

  // ---- Private helpers ----------------------------------------------------

  /**
   * Fetch from the proxy endpoint with automatic retry on transient failures.
   * Retries once on network-level errors (timeout, DNS, TCP reset).
   * Does NOT retry on HTTP error responses (4xx/5xx) — those are valid responses.
   */
  private async fetchWithRetry(
    endpoint: string,
    body: Record<string, unknown>,
    controller: AbortController,
    stream: boolean,
  ): Promise<{ res: Response; retried: boolean }> {
    const headers = stream
      ? { ...this.buildHeaders(), Accept: 'text/event-stream' }
      : this.buildHeaders();

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        return { res, retried: attempt > 0 };
      } catch (err) {
        const isLastAttempt = attempt >= this.maxRetries;
        // Only retry on transient network failures (TypeError: fetch failed)
        if (!(err instanceof TypeError) || isLastAttempt) {
          throw err;
        }
        // Don't retry if the controller was aborted (timeout or external signal)
        if (controller.signal.aborted) {
          throw err;
        }
        log.warn(`Proxy fetch attempt ${attempt + 1} failed, retrying...`, { error: String(err) });
        // Brief backoff before retry
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    // Should never reach here
    throw new Error('Proxy fetch failed after all retries');
  }

  /**
   * Detect whether an error indicates the proxy is unreachable.
   * These errors should trigger the router to fall back to direct mode.
   */
  private isProxyUnavailableError(err: unknown): boolean {
    if (err instanceof TypeError) {
      // fetch() throws TypeError on network failures
      return true;
    }
    const msg = err instanceof Error ? err.message : String(err);
    return /ECONNREFUSED|ENOTFOUND|fetch failed|network.*error|connect.*refused/i.test(msg);
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['X-Subscription-Key'] = this.apiKey;
    }
    return headers;
  }

  /** Convert internal LLMRequest to OpenAI-compatible JSON body. */
  private buildRequestBody(request: LLMRequest, stream = false): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : m.content,
      })),
      max_tokens: request.maxTokens ?? 4096,
      stream,
    };

    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.stopSequences?.length) body['stop'] = request.stopSequences;
    if (request.tools?.length) {
      body['tools'] = request.tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }

    return body;
  }

  /** Parse an OpenAI-compatible non-streaming response into our internal format. */
  private parseChatResponse(data: Record<string, unknown>): LLMResponse {
    const choices = data['choices'] as Array<Record<string, unknown>> | undefined;
    const usage = data['usage'] as Record<string, unknown> | undefined;

    if (!choices || choices.length === 0) {
      return {
        content: '',
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: 'end_turn',
      };
    }

    const choice = choices[0]!;
    const message = choice['message'] as Record<string, unknown> | undefined;

    // Extract content
    let content = '';
    let toolCalls: LLMResponse['toolCalls'];
    const reasoningContent = message?.['reasoning_content'] as string | undefined;

    if (message?.['content']) {
      content = String(message['content']);
    }

    // Extract tool calls
    const rawToolCalls = message?.['tool_calls'] as Array<Record<string, unknown>> | undefined;
    if (rawToolCalls?.length) {
      toolCalls = rawToolCalls.map(tc => ({
        id: String(tc['id'] ?? ''),
        name: String((tc['function'] as Record<string, unknown>)?.['name'] ?? ''),
        arguments: JSON.parse(String((tc['function'] as Record<string, unknown>)?.['arguments'] ?? '{}')),
      }));
    }

    const rawFinish = String(choice['finish_reason'] ?? '');
    const mappedFinish: LLMResponse['finishReason'] =
      rawFinish === 'stop' ? 'end_turn' :
      rawFinish === 'tool_calls' ? 'tool_use' :
      rawFinish === 'length' ? 'max_tokens' : 'end_turn';

    return {
      content,
      toolCalls,
      usage: {
        inputTokens: (usage?.['prompt_tokens'] as number) ?? 0,
        outputTokens: (usage?.['completion_tokens'] as number) ?? 0,
      },
      finishReason: mappedFinish,
      reasoningContent,
    };
  }

  /** Process SSE stream from proxy. */
  private async processStream(
    res: Response,
    onEvent: (event: LLMStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body for stream');

    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: LLMResponse['finishReason'] = 'end_turn';

    try {
      while (true) {
        if (signal?.aborted) break;

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE lines
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') break;

          try {
            const chunk = JSON.parse(payload) as Record<string, unknown>;
            this.processStreamChunk(chunk, onEvent, (t, o, c, f) => {
              if (t !== undefined) inputTokens = t;
              if (o !== undefined) outputTokens = o;
              if (c !== undefined) fullContent += c;
              if (f !== undefined) finishReason = f;
            });
          } catch {
            // Skip malformed chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      content: fullContent,
      usage: { inputTokens, outputTokens },
      finishReason,
    };
  }

  /** Process a single SSE data chunk from an OpenAI-compatible stream. */
  private processStreamChunk(
    chunk: Record<string, unknown>,
    onEvent: (event: LLMStreamEvent) => void,
    collect: (inputTokens: number, outputTokens: number, contentDelta: string, finishReason?: LLMResponse['finishReason']) => void,
  ): void {
    const choices = chunk['choices'] as Array<Record<string, unknown>> | undefined;
    if (!choices?.length) {
      // Usage-only chunk at end of stream
      const usage = chunk['usage'] as Record<string, unknown> | undefined;
      if (usage) {
        collect(
          (usage['prompt_tokens'] as number) ?? 0,
          (usage['completion_tokens'] as number) ?? 0,
          '',
        );
        onEvent({
          type: 'message_end',
          usage: {
            inputTokens: (usage['prompt_tokens'] as number) ?? 0,
            outputTokens: (usage['completion_tokens'] as number) ?? 0,
          },
          finishReason: 'end_turn',
        });
      }
      return;
    }

    const delta = choices[0]!;
    const finish = delta['finish_reason'] as string | null;
    const d = delta['delta'] as Record<string, unknown> | undefined;

    // Content delta
    if (d?.['content']) {
      const text = String(d['content']);
      collect(0, 0, text);
      onEvent({ type: 'text_delta', text });
    }

    // Tool call delta
    if (d?.['tool_calls']) {
      const tcs = d['tool_calls'] as Array<Record<string, unknown>>;
      for (const tc of tcs) {
        const func = tc['function'] as Record<string, unknown> | undefined;
        onEvent({
          type: 'tool_call_start',
          toolCall: {
            id: String(tc['id'] ?? ''),
            name: String(func?.['name'] ?? ''),
            arguments: func?.['arguments'] ? JSON.parse(String(func['arguments'])) : {},
          },
        });
      }
    }

    // Finish reason
    if (finish) {
      const mappedFinish: LLMResponse['finishReason'] =
        finish === 'stop' ? 'end_turn' :
        finish === 'tool_calls' ? 'tool_use' :
        finish === 'length' ? 'max_tokens' : 'end_turn';

      collect(0, 0, '', mappedFinish);
      onEvent({ type: 'message_end', finishReason: mappedFinish });
    }
  }

  /** Extract CU usage from proxy response headers and record in cache. */
  private recordCU(response: Response, llmResponse: LLMResponse): void {
    if (!this.cuCache) return;

    const cuUsedStr = response.headers.get('X-CU-Used');
    const cuBalanceStr = response.headers.get('X-CU-Balance');

    const inputTokens = llmResponse.usage.inputTokens;
    const outputTokens = llmResponse.usage.outputTokens;

    // Record token usage (provider name will be replaced with real upstream
    // name when the proxy returns it in a header; for now use "proxy" as the
    // upstream reporting name).
    const upstreamProvider = response.headers.get('X-Upstream-Provider') ?? 'proxy';
    this.cuCache.recordUsage(upstreamProvider, this.model, inputTokens, outputTokens);

    // Track CU balance if reported
    if (cuBalanceStr !== null) {
      const balance = Number(cuBalanceStr);
      if (!Number.isNaN(balance)) {
        this.cuCache.setBalance(balance);
      }
    }

    if (cuUsedStr !== null || cuBalanceStr !== null) {
      log.debug('Proxy CU data', { cuUsed: cuUsedStr, cuBalance: cuBalanceStr, inputTokens, outputTokens });
    }
  }
}
