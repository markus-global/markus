/**
 * Shared pure helpers for OpenAI-compatible LLM providers.
 *
 * Both `OpenAIProvider` (openai.ts) and `MarkusProvider` (markus-provider.ts)
 * talk to OpenAI-compatible `/chat/completions` endpoints (OpenRouter included).
 * This module holds the state-free building blocks they share:
 * message/tool conversion, reasoning extraction, endpoint construction,
 * non-streaming response parsing, and an SSE stream accumulator.
 *
 * No I/O, no provider state, no modules side effects — easy to unit test.
 */

import {
  getTextContent,
  sanitizeForLLM,
  sanitizeLLMMessages,
  type LLMContentPart,
  type LLMMessage,
  type LLMResponse,
  type LLMTool,
} from '@markus/shared';

// ---------------------------------------------------------------------------
// Wire types (OpenAI-compatible)
// ---------------------------------------------------------------------------

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface OpenAIToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Endpoint + finish-reason helpers
// ---------------------------------------------------------------------------

/** Build an OpenAI-compatible endpoint by appending `path` to `baseUrl`,
 *  adding `/v1` only when the base has no version segment. */
export function buildOpenAICompatEndpoint(baseUrl: string, path: string): string {
  const base = (baseUrl || '').replace(/\/+$/, '');
  return /\/v\d+$/.test(base) ? `${base}${path}` : `${base}/v1${path}`;
}

/** Map an upstream `finish_reason` string to the internal LLMResponse reason. */
export const FINISH_REASON_MAP: Record<string, LLMResponse['finishReason']> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
};

// ---------------------------------------------------------------------------
// Reasoning extraction (OpenRouter returns several shapes)
// ---------------------------------------------------------------------------

/**
 * OpenRouter returns reasoning in several shapes:
 * - `reasoning` / `reasoning_content` / `thinking` (string)
 * - `reasoning_details` (array of { type, text|summary|content, ... })
 */
export function extractReasoningText(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (!Array.isArray(value)) return '';
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item) {
      parts.push(item);
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.text === 'string' && obj.text) parts.push(obj.text);
    else if (typeof obj.summary === 'string' && obj.summary) parts.push(obj.summary);
    else if (typeof obj.content === 'string' && obj.content) parts.push(obj.content);
  }
  return parts.join('');
}

/** Extract reasoning from a streamed `delta`, preferring content over details. */
export function extractDeltaReasoning(delta: Record<string, unknown> | undefined): string {
  if (!delta) return '';
  return (
    extractReasoningText(delta.reasoning_content) ||
    extractReasoningText(delta.reasoning) ||
    extractReasoningText(delta.thinking) ||
    extractReasoningText(delta.reasoning_details)
  );
}

/**
 * Models that should request visible reasoning tokens via OpenRouter.
 * Name-based heuristic (no catalog access — providers may layer their own
 * catalog lookup on top).
 */
export function isOpenRouterReasoningModel(modelId: string | undefined | null): boolean {
  const id = (modelId ?? '').trim().toLowerCase();
  // DeepSeek V4 thinking is opt-in on OpenRouter; without `reasoning`, traces are omitted.
  return /deepseek-v4|deepseek-r1|(^|\/)(o1|o3|o4)([-/.]|$)|gpt-5|reasoner|thinking/.test(id);
}

// ---------------------------------------------------------------------------
// Text-emitted tool-call recovery (shared by MarkusProvider + OpenAIProvider)
// ---------------------------------------------------------------------------

/**
 * Some models (notably `deepseek-v4-flash` via OpenAI-compatible proxies) emit
 * tool calls as *plain text* using an Anthropic-style `<invoke name="...">`
 * markup instead of the structured `tool_calls` field. When that happens the
 * upstream returns no `tool_calls`, `finish_reason` is `stop`, and the raw
 * markup leaks into the visible reply (see the `DSML` token noise some
 * DeepSeek builds wrap the tags with).
 *
 * This recovers those text-emitted calls into structured tool calls and strips
 * the markup from the content, so the agent loop can execute them normally. The
 * tag matchers use `[^<>]*?` around the tag name so they tolerate arbitrary
 * token noise between `<`/`>` and `invoke`/`parameter` (e.g. `<DSML|invoke`,
 * MiniMax `<]minimax[>` fence noise).
 */
function coerceToolParam(raw: string, nonString: boolean): unknown {
  if (!nonString) return raw;
  try { return JSON.parse(raw) as unknown; } catch { return raw; }
}

export interface RecoveredToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export function recoverTextToolCalls(content: string): {
  toolCalls: RecoveredToolCall[];
  cleanedContent: string;
} {
  if (!content || !/invoke\s+name=/i.test(content)) {
    return { toolCalls: [], cleanedContent: content };
  }
  const invokeRe = /<[^<>]*?invoke\s+name="([^"]+)"[^<>]*>([\s\S]*?)<\/[^<>]*?invoke>/gi;
  const paramRe = /<[^<>]*?parameter\s+name="([^"]+)"([^<>]*)>([\s\S]*?)<\/[^<>]*?parameter>/gi;
  const toolCalls: RecoveredToolCall[] = [];
  let m: RegExpExecArray | null;
  while ((m = invokeRe.exec(content)) !== null) {
    const name = m[1];
    const inner = m[2] ?? '';
    const args: Record<string, unknown> = {};
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(inner)) !== null) {
      const pName = pm[1];
      const attrs = pm[2] ?? '';
      const raw = (pm[3] ?? '').trim();
      args[pName] = coerceToolParam(raw, /string="false"/i.test(attrs));
    }
    toolCalls.push({ id: `text_tc_${toolCalls.length}_${Date.now().toString(36)}`, name, arguments: args });
  }
  if (!toolCalls.length) return { toolCalls: [], cleanedContent: content };
  const cleanedContent = content
    .replace(/<[^<>]*?tool_calls>[\s\S]*?<\/[^<>]*?tool_calls>/gi, '')
    .replace(invokeRe, '')
    .replace(/[｜|]{1,2}\s*DSML\s*[｜|]{0,2}/gi, '')
    .replace(/<\]minimax\[>/gi, '')
    .trim();
  return { toolCalls, cleanedContent };
}

/**
 * Strip leaked text-emitted tool markup from a message body (no call recovery).
 * Used to clean *history* before it is sent back to the model, so previously
 * leaked `<invoke>` plaintext stops re-infecting the loop.
 */
export function stripTextToolMarkup(content: string | null | undefined): string {
  if (!content || !/invoke\s+name=/i.test(content)) return content ?? '';
  return recoverTextToolCalls(content).cleanedContent;
}

// ---------------------------------------------------------------------------
// Message / tool conversion
// ---------------------------------------------------------------------------

export interface ConvertMessagesOptions {
  /** Backfill `reasoning_content: ''` on assistant turns (DeepSeek thinking). */
  backfillReasoning?: boolean;
  systemCacheSegments?: Array<{ content: string; cacheBreakpoint?: boolean }>;
}

export function convertMessagesOpenAI(
  messages: LLMMessage[],
  opts?: ConvertMessagesOptions,
): OpenAIMessage[] {
  const clean = sanitizeLLMMessages(messages);
  // DeepSeek thinking models expect reasoning_content on assistant turns (incl. tool calls).
  const backfillReasoning = !!opts?.backfillReasoning || clean.some((m) => !!m.reasoningContent);
  const splitSystemIntoSegments = !!opts?.systemCacheSegments && opts.systemCacheSegments.length >= 1;

  // De-infect history: strip leaked `<invoke>` plaintext from previous turns so
  // it never reaches the model again (fixes the permanent re-feed loop).
  for (const m of clean) {
    if (m.role === 'system') continue;
    if (typeof m.content === 'string') {
      const cleaned = stripTextToolMarkup(m.content);
      if (cleaned !== m.content) m.content = cleaned;
    }
  }

  return clean.flatMap((m): OpenAIMessage | OpenAIMessage[] => {
    if (splitSystemIntoSegments && m.role === 'system') {
      return (opts!.systemCacheSegments!)
        .filter((seg) => seg.content.length > 0)
        .map((seg) => ({ role: 'system' as const, content: seg.content }));
    }

    if (m.role === 'tool') {
      return {
        role: 'tool' as const,
        content: sanitizeForLLM(stripTextToolMarkup(getTextContent(m.content))),
        tool_call_id: m.toolCallId ?? '',
      };
    }

    if (m.toolCalls?.length) {
      const msg: OpenAIMessage = {
        role: 'assistant' as const,
        content: getTextContent(m.content) || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
      if (m.reasoningContent || backfillReasoning) msg.reasoning_content = m.reasoningContent ?? '';
      return msg;
    }

    if (m.role === 'assistant' && (m.reasoningContent || backfillReasoning)) {
      return {
        role: 'assistant' as const,
        content: typeof m.content === 'string' ? m.content : getTextContent(m.content),
        reasoning_content: m.reasoningContent ?? '',
      };
    }

    if (Array.isArray(m.content)) {
      return {
        role: m.role,
        content: m.content.map((p: LLMContentPart) =>
          p.type === 'image_url'
            ? { type: 'image_url' as const, image_url: { url: p.image_url.url } }
            : { type: 'text' as const, text: p.text },
        ),
      };
    }

    return { role: m.role, content: m.content };
  });
}

export function convertToolsOpenAI(tools: LLMTool[]): OpenAIToolDef[] {
  const seen = new Set<string>();
  const out: OpenAIToolDef[] = [];
  for (const t of tools) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    out.push({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Usage normalization
// ---------------------------------------------------------------------------

/**
 * Extract cache-read token count from an OpenAI-compatible usage payload.
 * Supports the two common upstream shapes:
 *  - OpenAI / OpenRouter: `usage.prompt_tokens_details.cached_tokens`
 *  - DeepSeek:            `usage.prompt_cache_hit_tokens` (top-level sibling)
 * Returns 0 when neither is present.
 */
export function extractCacheReadTokens(raw: Record<string, unknown> | undefined): number {
  if (!raw) return 0;
  const details = raw.prompt_tokens_details as Record<string, unknown> | undefined;
  const openaiCached = typeof details?.cached_tokens === 'number' ? details.cached_tokens : 0;
  const deepseekHit = typeof raw.prompt_cache_hit_tokens === 'number' ? raw.prompt_cache_hit_tokens : 0;
  return Math.max(openaiCached, deepseekHit);
}

export function normalizeOpenAIUsage(raw: Record<string, number> | undefined): LLMResponse['usage'] {
  const usage: LLMResponse['usage'] = {
    inputTokens: raw?.prompt_tokens ?? 0,
    outputTokens: raw?.completion_tokens ?? 0,
  };
  // raw is typed `number`-valued but may carry nested objects / sibling cache fields.
  const cached = extractCacheReadTokens(raw as unknown as Record<string, unknown>);
  if (cached > 0) usage.cacheReadTokens = cached;
  return usage;
}

// ---------------------------------------------------------------------------
// Non-streaming response parsing
// ---------------------------------------------------------------------------

export interface ParseOpenAICompatResponseOptions {
  /** Optional hook for providers that recover tool calls emitted as plain text
   *  (e.g. DeepSeek) instead of the structured `tool_calls` field. */
  recoverTextToolCalls?: (content: string) => {
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    cleanedContent: string;
  };
}

export function parseOpenAICompatResponse(
  data: Record<string, unknown>,
  opts?: ParseOpenAICompatResponseOptions,
): LLMResponse {
  const choices = data.choices as Array<Record<string, unknown>> | undefined;
  if (!choices?.length) {
    throw new Error('No response choices from OpenAI-compatible provider');
  }

  const choice = choices[0];
  const message = choice.message as Record<string, unknown> | undefined;
  let content = typeof message?.content === 'string' ? message.content : '';

  const toolCallsData = message?.tool_calls as Array<Record<string, unknown>> | undefined;
  let toolCalls = toolCallsData?.map((tc: Record<string, unknown>) => ({
    id: String(tc.id ?? ''),
    name: String((tc.function as Record<string, unknown>)?.name ?? ''),
    arguments: JSON.parse(
      String((tc.function as Record<string, unknown>)?.arguments ?? '{}'),
    ) as Record<string, unknown>,
  }));

  const usage = normalizeOpenAIUsage(data.usage as Record<string, number> | undefined);
  let finishReason = FINISH_REASON_MAP[String(choice.finish_reason ?? 'stop')] ?? 'end_turn';

  if (!toolCalls?.length && opts?.recoverTextToolCalls) {
    const recovered = opts.recoverTextToolCalls(content);
    if (recovered.toolCalls.length) {
      toolCalls = recovered.toolCalls;
      content = recovered.cleanedContent;
      finishReason = 'tool_use';
    }
  }

  const reasoningContent =
    extractReasoningText(message?.reasoning_content) ||
    extractReasoningText(message?.reasoning) ||
    extractReasoningText(message?.thinking) ||
    extractReasoningText(message?.reasoning_details);

  const result: LLMResponse = {
    content,
    toolCalls: toolCalls?.length ? toolCalls : undefined,
    usage,
    finishReason,
  };
  if (reasoningContent) result.reasoningContent = reasoningContent;
  return result;
}

// ---------------------------------------------------------------------------
// SSE streaming accumulator (no I/O)
// ---------------------------------------------------------------------------

export interface SSEAccumulatorState {
  content: string;
  reasoningContent: string;
  toolCalls: Map<number, { id: string; name: string; args: string }>;
  finishReason: LLMResponse['finishReason'];
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** Raw last usage chunk (may carry provider extras such as `cost`). */
  lastRawUsage?: Record<string, unknown>;
}

export interface SSEHandlers {
  onThinking?(text: string): void;
  onText?(text: string): void;
  onToolStart?(call: { id: string; name: string }): void;
  onToolDelta?(call: { id: string }, text: string): void;
  onFinish?(reason: LLMResponse['finishReason']): void;
  onUsage?(usage: LLMResponse['usage'], raw: Record<string, unknown>): void;
}

/**
 * State machine for a streaming OpenAI-compatible `data:` chunk.
 *
 * Feed already-JSON-parsed chunks via `feed()`; the accumulator updates its
 * state and fires the given callbacks. It performs no I/O and owns no
 * timeouts — providers keep their own read loop / timeout semantics and call
 * back here per chunk.
 */
export function createSSEAccumulator() {
  const state: SSEAccumulatorState = {
    content: '',
    reasoningContent: '',
    toolCalls: new Map(),
    finishReason: 'end_turn',
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
  };

  return {
    state,

    feed(chunk: Record<string, unknown>, handlers: Partial<SSEHandlers> = {}): void {
      const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
      const choice = choices?.[0];
      const delta = choice?.delta as Record<string, unknown> | undefined;

      const deltaReasoning = extractDeltaReasoning(delta);
      if (deltaReasoning) {
        state.reasoningContent += deltaReasoning;
        handlers.onThinking?.(deltaReasoning);
      }

      if (delta?.content) {
        const text = String(delta.content);
        state.content += text;
        handlers.onText?.(text);
      }

      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
          const idx = typeof tc.index === 'number' ? tc.index : 0;
          if (!state.toolCalls.has(idx)) {
            state.toolCalls.set(idx, { id: '', name: '', args: '' });
          }
          const existing = state.toolCalls.get(idx)!;
          if (tc.id) existing.id = String(tc.id);
          const fn = tc.function as Record<string, unknown> | undefined;
          if (fn?.name) {
            existing.name = String(fn.name);
            handlers.onToolStart?.({ id: existing.id, name: existing.name });
          }
          if (fn?.arguments) {
            existing.args += String(fn.arguments);
            handlers.onToolDelta?.({ id: existing.id }, String(fn.arguments));
          }
        }
      }

      const finishRaw =
        choice?.finish_reason !== undefined && choice?.finish_reason !== null
          ? String(choice.finish_reason)
          : '';
      if (finishRaw) {
        state.finishReason = FINISH_REASON_MAP[finishRaw] ?? 'end_turn';
        handlers.onFinish?.(state.finishReason);
      }

      if (chunk.usage && typeof chunk.usage === 'object') {
        const u = chunk.usage as Record<string, unknown>;
        state.promptTokens = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0;
        state.completionTokens = typeof u.completion_tokens === 'number' ? u.completion_tokens : 0;
        const cached = extractCacheReadTokens(u);
        if (cached > 0) state.cachedTokens = cached;
        state.lastRawUsage = chunk.usage as Record<string, unknown>;
        handlers.onUsage?.(normalizeOpenAIUsage(u as Record<string, number>), chunk.usage as Record<string, unknown>);
      }
    },

    /** Finalize streamed tool calls: parse arguments JSON and drop nameless calls. */
    finalizeToolCalls(): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
      return [...state.toolCalls.values()]
        .filter((tc) => tc.name)
        .map((tc) => ({
          id: tc.id,
          name: tc.name,
          // Malformed partial JSON (stream cut mid-argument) must not throw.
          arguments: tc.args ? safeParseJson(tc.args) : {},
        }));
    },
  };
}

export function safeParseJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}