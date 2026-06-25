/**
 * MarkusProvider — standard LLM provider that routes requests through
 * the Cloudflare Worker proxy (token-billing gateway).
 *
 * Architecture:
 *   Desktop Agent  →  MarkusProvider  →  CF Worker Proxy  →  (upstream LLM)
 *                       (carries           (validates key,
 *                     subscription_key)     deducts quota)
 *
 * The provider is registered like any other provider (OpenAI, Anthropic, etc.),
 * making it a first-class citizen in the LLM Router.
 *
 * Key management (generate, revoke, rotate) is handled at the Hub/API layer;
 * this provider simply reads the configured subscription_key and sends it
 * as a Bearer token in the `Authorization` header.
 */

import { createLogger, type LLMProviderConfig, type LLMRequest, type LLMResponse, type LLMStreamEvent } from '@markus/shared';
import type { LLMProviderInterface } from './provider.js';

const log = createLogger('markus-provider');

// ---------------------------------------------------------------------------
// CU (Compute Unit) cache
// ---------------------------------------------------------------------------

interface CUEntry {
  inputCUs: number;
  outputCUs: number;
  timestamp: number;
}

/**
 * Lightweight in-memory CU usage cache.
 * Keeps track of CU consumption within the provider — no DB, no persistence.
 * Used for diagnostic / near-real-time feedback rather than billing.
 */
class CUCache {
  private entries: CUEntry[] = [];
  private readonly MAX_ENTRIES = 100;

  add(inputCUs: number, outputCUs: number): void {
    this.entries.push({ inputCUs, outputCUs, timestamp: Date.now() });
    if (this.entries.length > this.MAX_ENTRIES) {
      this.entries = this.entries.slice(-this.MAX_ENTRIES);
    }
  }

  /** Total CU consumed across all cached entries. */
  getTotal(): { inputCUs: number; outputCUs: number } {
    let inputCUs = 0;
    let outputCUs = 0;
    for (const e of this.entries) {
      inputCUs += e.inputCUs;
      outputCUs += e.outputCUs;
    }
    return { inputCUs, outputCUs };
  }

  clear(): void {
    this.entries = [];
  }
}

// ---------------------------------------------------------------------------
// MarkusProvider
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'http://localhost:8787';
const DEFAULT_MODEL = 'markus-default';
const DEFAULT_MAX_TOKENS = 4096;
const CHAT_TIMEOUT_MS = 90_000;
const STREAM_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;

export class MarkusProvider implements LLMProviderInterface {
  readonly name = 'markus';
  model: string;
  private apiKey: string;
  private baseUrl: string;
  private maxTokens: number;
  private chatTimeoutMs: number;
  private streamTimeoutMs: number;
  private cuCache = new CUCache();

  constructor(config?: LLMProviderConfig) {
    this.model = config?.model ?? DEFAULT_MODEL;
    this.apiKey = config?.apiKey ?? process.env['MARKUS_SUBSCRIPTION_KEY'] ?? '';
    this.baseUrl = config?.baseUrl ?? process.env['MARKUS_PROXY_URL'] ?? DEFAULT_BASE_URL;
    this.maxTokens = config?.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.chatTimeoutMs = config?.timeoutMs ?? CHAT_TIMEOUT_MS;
    this.streamTimeoutMs = config?.timeoutMs ?? STREAM_TIMEOUT_MS;
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

  /** Return CU usage totals for diagnostic purposes. */
  getCUCacheTotals(): { inputCUs: number; outputCUs: number } {
    return this.cuCache.getTotal();
  }

  /** Clear CU cache. */
  clearCUCache(): void {
    this.cuCache.clear();
  }

  // -------------------------------------------------------------------------
  // Chat (non-streaming)
  // -------------------------------------------------------------------------

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const endpoint = this.buildEndpoint();
    const body = this.buildBody(request, false);
    const headers = await this.buildHeaders();

    const response = await this.fetchWithRetry(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.chatTimeoutMs),
    });

    const data = await response.json() as Record<string, unknown>;

    // Check for proxy-level error
    if (data.error) {
      const err = data.error as Record<string, unknown>;
      throw new Error(`Markus proxy error: ${String(err.message ?? err.code ?? 'unknown')}`);
    }

    const llmResponse = this.parseResponse(data);
    this.recordCU(llmResponse);

    return llmResponse;
  }

  // -------------------------------------------------------------------------
  // Chat (streaming)
  // -------------------------------------------------------------------------

  async chatStream(
    request: LLMRequest,
    onEvent: (event: LLMStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const endpoint = this.buildEndpoint();
    const body = this.buildBody(request, true);
    const headers = await this.buildHeaders();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.streamTimeoutMs);
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

    let res: Response;
    try {
      res = await this.fetchWithRetry(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      }, true); // skip retry for stream to avoid duplicating chunks
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
      throw new Error(`Markus proxy error ${res.status}: ${errText}`);
    }

    let content = '';
    let reasoningContent = '';
    let finishReason: LLMResponse['finishReason'] = 'end_turn';
    let promptTokens = 0;
    let completionTokens = 0;

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body reader');

    const decoder = new TextDecoder();
    let buffer = '';

    try {
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
            const chunk = JSON.parse(trimmed.slice(6)) as Record<string, unknown>;
            const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
            const delta = choice?.delta as Record<string, unknown> | undefined;

            if (delta?.reasoning_content) {
              reasoningContent += String(delta.reasoning_content);
              onEvent({ type: 'thinking_delta', thinking: String(delta.reasoning_content) });
            }

            if (delta?.content) {
              content += String(delta.content);
              onEvent({ type: 'text_delta', text: String(delta.content) });
            }

            if (choice?.finish_reason) {
              const finishMap: Record<string, LLMResponse['finishReason']> = {
                stop: 'end_turn',
                tool_calls: 'tool_use',
                length: 'max_tokens',
              };
              finishReason = finishMap[String(choice.finish_reason)] ?? 'end_turn';
            }

            if (chunk.usage) {
              const u = chunk.usage as Record<string, number>;
              promptTokens = u.prompt_tokens ?? 0;
              completionTokens = u.completion_tokens ?? 0;
            }
          } catch { /* skip unparseable lines */ }
        }
      }
    } finally {
      clearTimeout(timeout);
    }

    const usage = { inputTokens: promptTokens, outputTokens: completionTokens };
    onEvent({ type: 'message_end', usage, finishReason });

    const streamResult: LLMResponse = { content, usage, finishReason };
    if (reasoningContent) streamResult.reasoningContent = reasoningContent;

    this.cuCache.add(promptTokens, completionTokens);
    return streamResult;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private buildEndpoint(): string {
    const base = this.baseUrl.replace(/\/+$/, '');
    return `${base}/v1/chat/completions`;
  }

  private async buildHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private buildBody(request: LLMRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages,
      max_tokens: request.maxTokens ?? this.maxTokens,
      stream,
    };
    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.tools?.length) body['tools'] = request.tools;
    if (request.stopSequences?.length) body['stop'] = request.stopSequences;
    return body;
  }

  /**
   * Fetch with exponential backoff retry.
   * Does NOT retry on 4xx errors (client errors) — only on 5xx / network issues.
   * For streaming requests, skipRetry avoids duplicating chunks.
   */
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    skipRetry = false,
    retries = MAX_RETRIES,
  ): Promise<Response> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const res = await fetch(url, init);

        // Client errors (4xx) — don't retry
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          return res;
        }

        // Success
        if (res.ok) return res;

        // Rate limit (429) or server error (5xx) — retry
        if (res.status === 429) {
          log.warn(`Markus proxy rate-limited (attempt ${attempt + 1}/${retries})`);
        } else {
          const errText = await res.text();
          log.warn(`Markus proxy error ${res.status} (attempt ${attempt + 1}/${retries})`, { body: errText.slice(0, 200) });
          lastError = new Error(`Markus proxy error ${res.status}: ${errText}`);
        }

        if (skipRetry) return res; // stream: return to caller for handling
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        log.warn(`Markus proxy network error (attempt ${attempt + 1}/${retries})`, { error: lastError.message });
      }

      if (attempt < retries - 1) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    throw lastError ?? new Error('Markus proxy request failed after all retries');
  }

  /**
   * Parse non-streaming response from the proxy.
   * The proxy returns standard OpenAI-compatible JSON.
   */
  private parseResponse(data: Record<string, unknown>): LLMResponse {
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    if (!choices?.length) {
      throw new Error('No response choices from Markus proxy');
    }

    const choice = choices[0];
    const message = choice.message as Record<string, unknown> | undefined;
    const content = typeof message?.content === 'string' ? message.content : '';

    const toolCallsData = message?.tool_calls as Array<Record<string, unknown>> | undefined;
    const toolCalls = toolCallsData?.map((tc: Record<string, unknown>) => ({
      id: String(tc.id ?? ''),
      name: String((tc.function as Record<string, unknown>)?.name ?? ''),
      arguments: JSON.parse(String((tc.function as Record<string, unknown>)?.arguments ?? '{}')) as Record<string, unknown>,
    }));

    const usage = data.usage as Record<string, number> | undefined;
    const finishMap: Record<string, LLMResponse['finishReason']> = {
      stop: 'end_turn',
      tool_calls: 'tool_use',
      length: 'max_tokens',
    };

    return {
      content,
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
      },
      finishReason: finishMap[String(choice.finish_reason ?? 'stop')] ?? 'end_turn',
    };
  }

  /** Record CU usage for diagnostic tracking within the provider. */
  private recordCU(response: LLMResponse): void {
    this.cuCache.add(response.usage.inputTokens, response.usage.outputTokens);
  }
}
