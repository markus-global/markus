/**
 * MarkusProvider — OpenRouter-only LLM provider.
 *
 * Chat / multimodal use the Hub-issued member key (`sk-or-…`) against OpenRouter.
 * Hosted search also uses that member key (see web-search.ts).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import {
  createLogger,
  getTextContent,
  type LLMMessage,
  type LLMProviderConfig,
  type LLMRequest,
  type LLMResponse,
  type LLMStreamEvent,
  type LLMTool,
  type ProviderCapabilities,
} from '@markus/shared';
import {
  CREDIT_EXCEEDED_MSG,
  UPSTREAM_BILLING_MISMATCH_MSG,
  defaultVoiceForModel,
  formatUpstreamMediaError,
  isCreditExhaustedHttp,
  parseOpenRouterAffordableTokens,
  parseOpenRouterPromptAffordableTokens,
  clampReservationMaxTokens,
  clampMaxTokensToRemainingAfford,
  type MultiModalProviderInterface,
  type MultiModalToolSchemas,
  type ImageGenOptions,
  type ImageResult,
  type TTSOptions,
  type AudioResult,
  type STTOptions,
  type VideoGenOptions,
  type VideoResult,
} from './provider.js';

/** Re-export for callers/tests that import helpers from this module. */
export {
  CREDIT_EXCEEDED_MSG,
  UPSTREAM_BILLING_MISMATCH_MSG,
  formatUpstreamMediaError,
  isCreditExhaustedHttp,
  parseOpenRouterAffordableTokens,
  parseOpenRouterPromptAffordableTokens,
  clampReservationMaxTokens,
  clampMaxTokensToRemainingAfford,
} from './provider.js';
// normalizeMarkusHubOrigin exported above with resolveMarkusRoute

const log = createLogger('markus-provider');

// ---------------------------------------------------------------------------
// Text-emitted tool-call recovery
// ---------------------------------------------------------------------------

/**
 * Some models (notably `deepseek-v4-flash` via OpenAI-compatible proxies) emit
 * tool calls as *plain text* using an Anthropic-style `<invoke name="...">`
 * markup instead of the structured `tool_calls` field. When that happens the
 * upstream returns no `tool_calls`, `finish_reason` is `stop`, and the raw
 * markup leaks into the visible reply (see the `｜DSML｜` token noise some
 * DeepSeek builds wrap the tags with).
 *
 * This recovers those text-emitted calls into structured tool calls and strips
 * the markup from the content, so the agent loop can execute them normally. The
 * tag matchers use `[^<>]*?` around the tag name so they tolerate arbitrary
 * token noise between `<`/`>` and `invoke`/`parameter` (e.g. `<｜DSML｜｜invoke`).
 */
function coerceToolParam(raw: string, nonString: boolean): unknown {
  if (!nonString) return raw;
  try { return JSON.parse(raw) as unknown; } catch { return raw; }
}

function recoverTextToolCalls(content: string): {
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  cleanedContent: string;
} {
  if (!content || !/invoke\s+name=/i.test(content)) {
    return { toolCalls: [], cleanedContent: content };
  }
  const invokeRe = /<[^<>]*?invoke\s+name="([^"]+)"[^<>]*>([\s\S]*?)<\/[^<>]*?invoke>/gi;
  const paramRe = /<[^<>]*?parameter\s+name="([^"]+)"([^<>]*)>([\s\S]*?)<\/[^<>]*?parameter>/gi;
  const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
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
    .trim();
  return { toolCalls, cleanedContent };
}

/**
 * OpenRouter returns reasoning in several shapes:
 * - `reasoning` / `reasoning_content` / `thinking` (string)
 * - `reasoning_details` (array of { type, text|summary, ... })
 */
function extractReasoningText(value: unknown): string {
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

function extractDeltaReasoning(delta: Record<string, unknown> | undefined): string {
  if (!delta) return '';
  return (
    extractReasoningText(delta.reasoning_content) ||
    extractReasoningText(delta.reasoning) ||
    extractReasoningText(delta.thinking) ||
    extractReasoningText(delta.reasoning_details)
  );
}

/** Models that should request visible reasoning tokens via OpenRouter. */
function shouldEnableOpenRouterReasoning(modelId: string): boolean {
  const id = stripMarkusNamespace(modelId).toLowerCase();
  // DeepSeek V4 thinking is opt-in on OpenRouter; without `reasoning`, traces are omitted.
  if (/deepseek-v4|deepseek-r1|(^|\/)(o1|o3|o4)([-/.]|$)|gpt-5|reasoner|thinking/.test(id)) {
    return true;
  }
  const cached = cachedModelList?.find(
    (m) => stripMarkusNamespace(m.id).toLowerCase() === id,
  );
  return !!cached?.supports_reasoning;
}

function convertMessagesForOpenRouter(
  messages: LLMMessage[],
  opts?: { backfillReasoning?: boolean },
): Array<Record<string, unknown>> {
  // DeepSeek thinking models expect reasoning_content on assistant turns (incl. tool calls).
  const backfillReasoning = !!opts?.backfillReasoning || messages.some((m) => !!m.reasoningContent);
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: getTextContent(m.content),
        tool_call_id: m.toolCallId ?? '',
      };
    }
    if (m.toolCalls?.length) {
      const msg: Record<string, unknown> = {
        role: 'assistant',
        content: getTextContent(m.content) || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
      if (m.reasoningContent || backfillReasoning) {
        msg.reasoning_content = m.reasoningContent ?? '';
      }
      return msg;
    }
    if (m.role === 'assistant' && (m.reasoningContent || backfillReasoning)) {
      return {
        role: 'assistant',
        content: getTextContent(m.content),
        reasoning_content: m.reasoningContent ?? '',
      };
    }
    return {
      role: m.role,
      content: m.content,
    };
  });
}

function convertToolsForOpenRouter(tools: LLMTool[]): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const t of tools) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    out.push({
      type: 'function',
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
// CU (Compute Unit) cache
// ---------------------------------------------------------------------------

interface CUEntry {
  inputTokens: number;
  outputTokens: number;
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

  add(inputTokens: number, outputTokens: number): void {
    this.entries.push({ inputTokens, outputTokens, timestamp: Date.now() });
    if (this.entries.length > this.MAX_ENTRIES) {
      this.entries = this.entries.slice(-this.MAX_ENTRIES);
    }
  }

  /** Total tokens consumed across all cached entries (diagnostic, not billing). */
  getTotal(): { inputTokens: number; outputTokens: number } {
    let inputTokens = 0;
    let outputTokens = 0;
    for (const e of this.entries) {
      inputTokens += e.inputTokens;
      outputTokens += e.outputTokens;
    }
    return { inputTokens, outputTokens };
  }

  clear(): void {
    this.entries = [];
  }
}

// ---------------------------------------------------------------------------
// Route resolution (exported for tests)
// ---------------------------------------------------------------------------

/** @deprecated Always openrouter — kept for tests / call-site compatibility. */
export type MarkusRoute = 'openrouter';

export interface MarkusRouteCatalogEntry {
  id: string;
  route?: string | null;
  /** @deprecated Unused — catalog ids are OR slugs; kept for call-site compat. */
  upstream_model?: string | null;
}

/** Always OpenRouter (Markus Provider uses Hub-issued OR member key). */
export function resolveMarkusRoute(
  _modelId?: string | null,
  _catalog?: MarkusRouteCatalogEntry[] | null,
): MarkusRoute {
  return 'openrouter';
}

/**
 * Apex `markus.global` 307s to `www.markus.global`. Node/fetch strips
 * `Authorization` on that cross-origin redirect → cu/sync 401 forever.
 * Always prefer the www origin for Hub API calls.
 */
export function normalizeMarkusHubOrigin(originOrUrl: string): string {
  const raw = (originOrUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (u.hostname === 'markus.global') {
      u.hostname = 'www.markus.global';
    }
    return u.origin;
  } catch {
    return raw;
  }
}

/**
 * Normalize an outgoing model id before sending it to OpenRouter.
 *
 * Catalog / routing ids are OpenRouter slugs (e.g. `deepseek/deepseek-v4-flash`).
 * A legacy `markus/` prefix (e.g. `markus/openai/gpt-image-1`) is stripped so
 * OpenRouter receives the bare vendor slug. Un-prefixed slugs pass through.
 */
export function stripMarkusNamespace(modelId: string | undefined | null): string {
  const id = (modelId ?? '').trim();
  return id.replace(/^markus\//i, '');
}

// ---------------------------------------------------------------------------
// MarkusProvider
// ---------------------------------------------------------------------------

const DEFAULT_OR_BASE_URL = 'https://openrouter.ai/api/v1';
/** Placeholder until Hub catalog is fetched; never a real OpenRouter id. */
const DEFAULT_MODEL = '';
const CLIENT_ID = 'markus-desktop/1.0';
const CHAT_TIMEOUT_MS = 90_000;
/** Max idle gap between stream chunks (also covers TTFT). Reset on every chunk. */
const STREAM_TIMEOUT_MS = 180_000;
/** Absolute wall-clock cap for one stream request (prevents runaway hangs). */
const STREAM_HARD_TIMEOUT_MS = 15 * 60_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
/** Cap Retry-After waits so a single turn cannot sleep for minutes. */
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Parse OpenRouter / RFC7231 `Retry-After` (seconds or HTTP-date) to ms.
 * @see https://openrouter.ai/docs/api_reference/limits
 */
export function parseRetryAfterMs(res: Response): number | null {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const asSec = Number(raw);
  if (Number.isFinite(asSec) && asSec >= 0) {
    return Math.min(asSec * 1000, MAX_RETRY_AFTER_MS);
  }
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) {
    return Math.min(Math.max(0, asDate - Date.now()), MAX_RETRY_AFTER_MS);
  }
  return null;
}

function retryDelayMs(res: Response | undefined, attempt: number): number {
  const fromHeader = res ? parseRetryAfterMs(res) : null;
  if (fromHeader !== null) return fromHeader;
  return RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
}

const CREDIT_MUTE_KEY = 'markus:credit-notif-muted';
let _lastCreditNotifTs = 0;

function fireCreditExhaustedEvent(): void {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.dispatchEvent !== 'function') return;
  try {
    const ls = g.localStorage as { getItem(k: string): string | null } | undefined;
    if (ls?.getItem(CREDIT_MUTE_KEY)) return;
  } catch { /* */ }
  const now = Date.now();
  if (now - _lastCreditNotifTs < 5 * 60_000) return;
  _lastCreditNotifTs = now;
  (g.dispatchEvent as (e: unknown) => void)(new (g.CustomEvent as typeof CustomEvent)('markus:credit-exhausted'));
}

export interface MarkusModelInfo {
  id: string;
  display_name: string;
  capability: string;
  tier: string;
  context_window: number;
  max_output_tokens: number;
  supports_vision: boolean;
  supports_reasoning: boolean;
  is_default?: boolean;
  input_modalities?: string[];
  output_modalities?: string[];
  /** Hub-derived tags: vision | imageGeneration | tts | audioOutput | stt | audioInput | videoGeneration */
  capabilities?: string[];
  /** Always openrouter when present; Hub no longer emits worker routes. */
  route?: string;
}

let cachedModelList: MarkusModelInfo[] | null = null;
let modelListExpiry = 0;
const MODEL_LIST_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Drop the in-memory Hub catalog cache (e.g. after reconnect). */
export function clearMarkusModelListCache(): void {
  cachedModelList = null;
  modelListExpiry = 0;
}

function looksLikeWorkerBase(url: string): boolean {
  return /localhost:8787|127\.0\.0\.1:8787|workers\.dev|markus-proxy/i.test(url);
}

export class MarkusProvider implements MultiModalProviderInterface {
  readonly name = 'markus';
  model: string;
  /** OpenRouter member key (`sk-or-…`). */
  private apiKey: string;
  /** OpenRouter OpenAI-compatible base (…/api/v1). */
  private baseUrl: string;
  /** Optional per-provider output cap. When unset, max_tokens is omitted so
   *  the upstream applies the model's own limit — no hardcoded default. */
  private maxTokens?: number;
  private chatTimeoutMs: number;
  private streamTimeoutMs: number;
  private cuCache = new CUCache();
  /** Hub-served geo-aware model catalog URL. */
  private modelsUrl = '';
  /** Optional Hub base for POST /api/user/cu/sync recovery. */
  private hubUrl = '';
  private hubToken = '';
  private lastCuSyncAt = 0;

  constructor(config?: LLMProviderConfig) {
    this.model = config?.model ?? DEFAULT_MODEL;
    this.apiKey = config?.apiKey ?? '';
    this.baseUrl = config?.baseUrl ?? DEFAULT_OR_BASE_URL;
    this.maxTokens = config?.maxTokens;
    this.chatTimeoutMs = config?.timeoutMs ?? CHAT_TIMEOUT_MS;
    // Stream idle is independent of chat timeoutMs — never inherit a lower chat
    // timeout (e.g. 90s) or long reasoning / sparse SSE gaps abort mid-reply.
    this.streamTimeoutMs = config?.streamTimeoutMs ?? STREAM_TIMEOUT_MS;
    this.modelsUrl = config?.modelsUrl ?? process.env['MARKUS_MODELS_URL'] ?? '';
    this.hubUrl = config?.hubUrl ?? process.env['MARKUS_HUB_URL'] ?? '';
    this.hubToken = config?.hubToken ?? process.env['MARKUS_HUB_TOKEN'] ?? '';
    if (this.baseUrl && looksLikeWorkerBase(this.baseUrl)) {
      this.baseUrl = DEFAULT_OR_BASE_URL;
    }
  }

  configure(config: LLMProviderConfig): void {
    if (config.model) this.model = config.model;
    if (config.apiKey) this.apiKey = config.apiKey;
    if (config.baseUrl) {
      this.baseUrl = looksLikeWorkerBase(config.baseUrl) ? DEFAULT_OR_BASE_URL : config.baseUrl;
    }
    if (config.maxTokens) this.maxTokens = config.maxTokens;
    if (config.modelsUrl !== undefined) this.modelsUrl = config.modelsUrl;
    if (config.hubUrl !== undefined) this.hubUrl = config.hubUrl;
    if (config.hubToken !== undefined) this.hubToken = config.hubToken;
    if (config.timeoutMs) this.chatTimeoutMs = config.timeoutMs;
    if (config.streamTimeoutMs) this.streamTimeoutMs = config.streamTimeoutMs;
  }

  /** Whether OpenRouter credentials are available. */
  private hasOpenRouterCreds(): boolean {
    return !!this.effectiveOpenRouterKey();
  }

  private effectiveOpenRouterKey(): string {
    if (this.apiKey && this.apiKey.startsWith('sk-or-')) return this.apiKey;
    if (this.apiKey && !/^markus[_-]/i.test(this.apiKey)) return this.apiKey;
    const env = process.env['MARKUS_OPENROUTER_KEY'] || process.env['OPENROUTER_API_KEY'] || '';
    return env;
  }

  private effectiveOpenRouterBase(): string {
    const base = this.baseUrl?.replace(/\/+$/, '') || '';
    if (base && !looksLikeWorkerBase(base)) return base;
    return DEFAULT_OR_BASE_URL;
  }

  private resolveRequestTarget(_modelId: string): {
    route: MarkusRoute;
    url: string;
    authKey: string;
  } {
    const key = this.effectiveOpenRouterKey();
    if (!key) {
      throw new Error('Markus OpenRouter apiKey not configured — reconnect to Hub');
    }
    return {
      route: 'openrouter',
      url: `${this.effectiveOpenRouterBase()}/chat/completions`,
      authKey: key,
    };
  }

  /** Latest CU quota info from the proxy response headers. */
  private lastQuotaInfo: { cuCost: number; cuRemaining: number; cuLimit: number } | null = null;
  /**
   * Soft-stop hint from plan remaining credits.
   * null = unknown (do not soft-block); 0 = refuse new requests locally.
   * Upstream 402 remains the network-level stop.
   */
  private hubRemainingHint: number | null = null;
  private totalCuUsed = 0;
  private cuUsedToday = 0;
  private todayCutoffDate = new Date().toISOString().slice(0, 10);
  /** Direct path: last/aggregate usage cost for local UX only (not ledgered by this client). */
  private lastCostUsd = 0;
  private totalCostUsd = 0;
  /** Last OpenRouter prompt-token afford ceiling (from 402 "Prompt tokens limit exceeded"). */
  private lastPromptAffordTokens: number | null = null;
  /** When lastPromptAffordTokens was recorded (stale afford must not permanently block). */
  private lastPromptAffordAt = 0;
  /** Last observed prompt token count (from usage) for proactive max_tokens clamp. */
  private lastPromptTokensEstimate: number | null = null;

  /** Ignore cached OR prompt-afford after this (key top-ups / pack shrinks invalidate it). */
  private static readonly PROMPT_AFFORD_TTL_MS = 90_000;

  /** Prompt-token budget hint for context packing (null if unknown / expired). */
  getLastPromptAffordTokens(): number | null {
    if (this.lastPromptAffordTokens === null) return null;
    if (Date.now() - this.lastPromptAffordAt > MarkusProvider.PROMPT_AFFORD_TTL_MS) {
      log.info('Clearing stale OpenRouter prompt afford', {
        promptAffordTokens: this.lastPromptAffordTokens,
        ageMs: Date.now() - this.lastPromptAffordAt,
      });
      this.lastPromptAffordTokens = null;
      this.lastPromptAffordAt = 0;
      return null;
    }
    return this.lastPromptAffordTokens;
  }

  /** Drop cached afford after a successful turn or when Hub shows healthy OR USD. */
  clearPromptAffordHint(reason?: string): void {
    if (this.lastPromptAffordTokens === null) return;
    log.info('Clearing OpenRouter prompt afford hint', {
      promptAffordTokens: this.lastPromptAffordTokens,
      reason: reason ?? 'manual',
    });
    this.lastPromptAffordTokens = null;
    this.lastPromptAffordAt = 0;
  }

  /** Fetch available models from the Hub live catalog. Cached 10 minutes. */
  async fetchModels(): Promise<MarkusModelInfo[]> {
    if (cachedModelList && Date.now() < modelListExpiry) {
      return cachedModelList;
    }

    if (!this.modelsUrl) {
      log.warn('No modelsUrl — cannot fetch Markus models (reconnect to Hub)');
      return cachedModelList ?? FALLBACK_MODELS;
    }

    try {
      const res = await fetch(this.modelsUrl, {
        headers: { 'X-Markus-Client': CLIENT_ID },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const data = (await res.json()) as { data: MarkusModelInfo[] };
        cachedModelList = data.data ?? [];
        modelListExpiry = Date.now() + MODEL_LIST_TTL_MS;
        return cachedModelList;
      }
      log.warn(`Failed to fetch models: ${res.status}`);
    } catch (err) {
      log.warn('Failed to fetch models', { error: err instanceof Error ? err.message : String(err) });
    }

    return cachedModelList ?? FALLBACK_MODELS;
  }

  /** Return token usage totals for diagnostic purposes. */
  getCUCacheTotals(): { inputTokens: number; outputTokens: number } {
    return this.cuCache.getTotal();
  }

  /** Return the latest quota info from the proxy. */
  getQuotaInfo(): { cuCost: number; cuRemaining: number; cuLimit: number } | null {
    return this.lastQuotaInfo;
  }

  /** Cumulative CU usage tracked from proxy response headers. */
  getCuUsageStats(): {
    totalCuUsed: number;
    cuUsedToday: number;
    cuRemaining: number;
    cuLimit: number;
    lastCuCost: number;
  } {
    const quota = this.lastQuotaInfo;
    return {
      totalCuUsed: this.totalCuUsed,
      cuUsedToday: this.cuUsedToday,
      cuRemaining: quota?.cuRemaining ?? -1,
      cuLimit: quota?.cuLimit ?? 0,
      lastCuCost: quota?.cuCost ?? 0,
    };
  }

  /** Clear CU cache. */
  clearCUCache(): void {
    this.cuCache.clear();
  }

  /** OpenRouter-path actual spend (USD) captured from usage.cost. */
  getCostUsdStats(): { lastCostUsd: number; totalCostUsd: number } {
    return { lastCostUsd: this.lastCostUsd, totalCostUsd: this.totalCostUsd };
  }

  /** Record a usage.cost (USD) sample from an OpenRouter response. */
  private recordCostUsd(usage: Record<string, unknown> | undefined): void {
    const cost = typeof usage?.cost === 'number' ? usage.cost : 0;
    if (cost > 0) {
      this.lastCostUsd = cost;
      this.totalCostUsd += cost;
      log.debug('OpenRouter usage.cost', { cost });
    }
  }

  private lowCreditWarned = false;

  /** Extract CU quota headers from a Worker response. */
  private extractQuotaHeaders(response: Response): number {
    const cuCost = parseInt(response.headers.get('x-cu-cost') ?? '0', 10);
    const cuRemaining = parseInt(response.headers.get('x-cu-remaining') ?? '-1', 10);
    const cuLimit = parseInt(response.headers.get('x-cu-limit') ?? '0', 10);
    if (cuRemaining >= 0) {
      this.lastQuotaInfo = { cuCost, cuRemaining, cuLimit };
      log.debug('CU quota', { cuCost, cuRemaining, cuLimit });
    }
    if (cuCost > 0) {
      const today = new Date().toISOString().slice(0, 10);
      if (today !== this.todayCutoffDate) {
        this.cuUsedToday = 0;
        this.todayCutoffDate = today;
      }
      this.totalCuUsed += cuCost;
      this.cuUsedToday += cuCost;
    }
    return cuCost;
  }

  /** Build a credit warning string if remaining credits are low; undefined otherwise. Fires once per session. */
  private checkLowCredit(): string | undefined {
    const q = this.lastQuotaInfo;
    if (!q || q.cuRemaining < 0 || q.cuLimit <= 0) return undefined;
    const pct = q.cuRemaining / q.cuLimit;
    if (pct > 0.1 || this.lowCreditWarned) return undefined;
    this.lowCreditWarned = true;
    return `Credits running low (${q.cuRemaining}/${q.cuLimit} remaining). Visit https://markus.global/settings?tab=billing to purchase more or upgrade your plan. | 积分即将用完（剩余 ${q.cuRemaining}/${q.cuLimit}），请访问 https://markus.global/settings?tab=billing 购买积分或升级计划。`;
  }

  /**
   * Soft-stop hint from plan remaining credits. Pass null to clear.
   * Does not replace upstream 402 hard stops.
   */
  setHubRemainingHint(remaining: number | null): void {
    if (remaining === null || remaining === undefined) {
      this.hubRemainingHint = null;
      return;
    }
    this.hubRemainingHint = Math.max(0, Math.floor(remaining));
  }

  private resolveHubBase(): string {
    const explicit = (this.hubUrl || process.env['MARKUS_HUB_URL'] || '').replace(/\/+$/, '');
    const raw = explicit || (() => {
      if (!this.modelsUrl) return '';
      try {
        return new URL(this.modelsUrl).origin;
      } catch {
        return '';
      }
    })();
    return normalizeMarkusHubOrigin(raw);
  }

  private resolveHubToken(): string {
    if (this.hubToken) return this.hubToken;
    const env = process.env['MARKUS_HUB_TOKEN'] || '';
    if (env) return env;
    try {
      const tokenPath = join(homedir(), '.markus', 'hub-token');
      if (existsSync(tokenPath)) return readFileSync(tokenPath, 'utf-8').trim();
    } catch { /* ignore */ }
    return '';
  }

  /**
   * Event-driven Hub sync: renew period if due, reconcile + align OpenRouter keys.
   * Used before soft-stop and once after upstream credit-exhausted responses.
   */
  async syncHubCredits(opts?: {
    force?: boolean;
    minIntervalMs?: number;
    /** Default true. Set false when handling a 402 so the just-recorded afford packing hint survives. */
    clearStaleAfford?: boolean;
  }): Promise<{
    remainingCu: number;
    remainingUsd: number;
  } | null> {
    const base = this.resolveHubBase();
    const token = this.resolveHubToken();
    if (!base || !token) return null;

    const minInterval = opts?.minIntervalMs ?? 30_000;
    const now = Date.now();
    if (!opts?.force && now - this.lastCuSyncAt < minInterval) return null;
    this.lastCuSyncAt = now;

    try {
      const res = await fetch(`${base}/api/user/cu/sync`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Markus-Client': CLIENT_ID,
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        log.warn('cu/sync failed', { status: res.status });
        return null;
      }
      const data = await res.json() as {
        remainingCu?: number;
        openrouter?: { remainingUsd?: number };
      };
      const remainingCu = Math.max(0, Number(data.remainingCu ?? 0));
      const remainingUsd = Math.max(0, Number(data.openrouter?.remainingUsd ?? 0));
      if (remainingCu > 0 || remainingUsd > 0) {
        this.hubRemainingHint = remainingCu > 0 ? remainingCu : null;
        if (this.lastQuotaInfo) {
          this.lastQuotaInfo = { ...this.lastQuotaInfo, cuRemaining: Math.max(remainingCu, 1) };
        }
        // Preflight sync with healthy OR USD → drop stale fail-closed ceiling.
        // Skip when clearStaleAfford=false (inside 402 handler — keep packing hint).
        if (opts?.clearStaleAfford !== false && remainingUsd >= 0.05) {
          this.clearPromptAffordHint('hub_sync_or_usd');
        }
      } else {
        this.hubRemainingHint = 0;
      }
      return { remainingCu, remainingUsd };
    } catch (err) {
      log.warn('cu/sync error', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /** After 402/key-limit: sync once; true if Hub reports remaining budget. */
  private async tryRecoverCredits(): Promise<boolean> {
    const synced = await this.syncHubCredits({ force: true });
    if (!synced) return false;
    return synced.remainingCu > 0 || synced.remainingUsd > 0;
  }

  /**
   * Resolve an upstream payment/credit HTTP status against Hub books.
   * Only emit CU_EXCEEDED (+ credit modal) when Hub confirms remaining is zero.
   *
   * OpenRouter often 402s because omitted `max_tokens` defaults to a high
   * reservation (e.g. 65536) while the key can only afford N. That clamp retry
   * must NOT depend on Hub cu/sync succeeding — sync can 401 while the OR key
   * is merely over-reserved (tonight's logs: cu/sync 401 → skipped clamp →
   * misleading "Hub still shows remaining credits").
   */
  private async resolveCreditHttpError(
    status: number,
    errText: string,
    alreadyRetried: boolean,
  ): Promise<{ retry: true; maxTokens?: number }> {
    const promptAfford = parseOpenRouterPromptAffordableTokens(errText);
    if (promptAfford !== null) {
      this.lastPromptAffordTokens = promptAfford;
      this.lastPromptAffordAt = Date.now();
      log.warn('OpenRouter prompt afford recorded for context packing', {
        promptAffordTokens: promptAfford,
        ttlMs: MarkusProvider.PROMPT_AFFORD_TTL_MS,
      });
    }

    const affordable = parseOpenRouterAffordableTokens(errText);
    // Keep the afford hint we just recorded for packing; do not clear on this sync.
    const synced = await this.syncHubCredits({ force: true, clearStaleAfford: false });
    const hubHasBudget = !!synced && (synced.remainingCu > 0 || synced.remainingUsd > 0);
    const hubEmpty = !!synced && synced.remainingCu <= 0 && synced.remainingUsd <= 0;

    // Prompt-limit 402s are not fixed by lowering max_tokens — packing must shrink next turn.
    // Still allow a max_tokens clamp retry when OR only reports reservation afford.
    if (!alreadyRetried && affordable !== null && promptAfford === null && !hubEmpty) {
      const maxTokens = clampReservationMaxTokens(affordable);
      log.info('Retrying with OpenRouter-affordable max_tokens', {
        maxTokens,
        affordable,
        hubSynced: !!synced,
        hubHasBudget,
      });
      return { retry: true, maxTokens };
    }

    if (!alreadyRetried && hubHasBudget) {
      return { retry: true };
    }

    if (hubEmpty) {
      fireCreditExhaustedEvent();
      throw new Error(CREDIT_EXCEEDED_MSG);
    }

    const detail = (errText || '')
      .replace(/https?:\/\/[^\s]*openrouter\.ai[^\s]*/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);

    // Sync failed — do not claim Hub still has credits.
    if (!synced) {
      throw new Error(
        `MARKUS_UPSTREAM_ERROR: Upstream returned a payment/credit error, and Hub credit sync failed. Please reconnect Hub or retry. (HTTP ${status}${detail ? `: ${detail}` : ''})`,
      );
    }

    throw new Error(
      `${UPSTREAM_BILLING_MISMATCH_MSG} (HTTP ${status}${detail ? `: ${detail}` : ''})`,
    );
  }

  /** Soft-stop before network I/O when remaining credits are already known to be zero. */
  private async assertCreditsAvailable(): Promise<void> {
    const softZero =
      this.hubRemainingHint === 0
      || this.lastQuotaInfo?.cuRemaining === 0;
    if (!softZero) return;

    const synced = await this.syncHubCredits({ force: true });
    if (synced && (synced.remainingCu > 0 || synced.remainingUsd > 0)) return;

    if (synced && synced.remainingCu <= 0 && synced.remainingUsd <= 0) {
      fireCreditExhaustedEvent();
      if (this.hubRemainingHint === 0) {
        throw new Error('CU_EXCEEDED: Organization credits exhausted');
      }
      throw new Error('CU_EXCEEDED: Credits exhausted');
    }

    // Sync unavailable — clear stale local zeros so we don't false-block.
    this.hubRemainingHint = null;
    if (this.lastQuotaInfo) {
      this.lastQuotaInfo = { ...this.lastQuotaInfo, cuRemaining: -1 };
    }
  }

  // -------------------------------------------------------------------------
  // Chat (non-streaming)
  // -------------------------------------------------------------------------

  async chat(request: LLMRequest, _retried = false): Promise<LLMResponse> {
    await this.assertCreditsAvailable();
    const modelId = request.model ?? this.model;
    const target = this.resolveRequestTarget(modelId);
    const body = this.buildBody(request, false, target.route);
    const headers = this.buildHeaders(target);

    const response = await this.fetchWithRetry(target.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.chatTimeoutMs),
    });

    if (response.status === 429) {
      const errBody = await response.json().catch(() => ({})) as Record<string, unknown>;
      const errCode = (errBody.error as Record<string, unknown>)?.code as string ?? '';
      const errMsg = ((errBody.error as Record<string, unknown>)?.message as string) ?? 'Rate limit exceeded';
      const prefix = errCode === 'CU_WINDOW_EXCEEDED' ? 'CU_WINDOW_EXCEEDED' : 'MARKUS_RATE_LIMITED';
      throw new Error(`${prefix}: ${errMsg}`);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      if (isCreditExhaustedHttp(response.status, errText)) {
        const outcome = await this.resolveCreditHttpError(response.status, errText, _retried);
        if (outcome.retry) {
          const next = outcome.maxTokens
            ? { ...request, maxTokens: outcome.maxTokens }
            : request;
          return this.chat(next, true);
        }
      }
      throw new Error(`Markus proxy error ${response.status}: ${errText}`);
    }

    const cuCost = 0;
    const data = await response.json() as Record<string, unknown>;

    if (data.error) {
      const err = data.error as Record<string, unknown>;
      throw new Error(`Markus proxy error: ${String(err.message ?? err.code ?? 'unknown')}`);
    }

    const llmResponse = this.parseResponse(data);
    if (cuCost > 0) llmResponse.cuCost = cuCost;
    if (target.route === 'openrouter') {
      this.recordCostUsd(data.usage as Record<string, unknown> | undefined);
    }
    llmResponse.creditWarning = this.checkLowCredit();
    this.recordCU(llmResponse);
    // Successful completion ⇒ key accepted this pack; drop stale afford ceiling.
    this.clearPromptAffordHint('chat_success');

    return llmResponse;
  }

  // -------------------------------------------------------------------------
  // Chat (streaming)
  // -------------------------------------------------------------------------

  async chatStream(
    request: LLMRequest,
    onEvent: (event: LLMStreamEvent) => void,
    signal?: AbortSignal,
    _retried = false,
  ): Promise<LLMResponse> {
    await this.assertCreditsAvailable();
    const modelId = request.model ?? this.model;
    const target = this.resolveRequestTarget(modelId);
    const body = this.buildBody(request, true, target.route);
    const headers = this.buildHeaders(target);
    const controller = new AbortController();
    // Idle timeout (reset on each chunk) + hard wall-clock cap. A single
    // wall-clock 120s abort was killing long multimodal tool loops with large
    // context even while the model was still streaming.
    let idleTimedOut = false;
    let hardTimedOut = false;
    let idleTimeout = setTimeout(() => {
      idleTimedOut = true;
      controller.abort();
    }, this.streamTimeoutMs);
    const hardTimeout = setTimeout(() => {
      hardTimedOut = true;
      controller.abort();
    }, STREAM_HARD_TIMEOUT_MS);
    const bumpIdleTimeout = () => {
      clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => {
        idleTimedOut = true;
        controller.abort();
      }, this.streamTimeoutMs);
    };
    const clearStreamTimeouts = () => {
      clearTimeout(idleTimeout);
      clearTimeout(hardTimeout);
    };
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

    let res: Response;
    try {
      res = await this.fetchWithRetry(target.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      }, true); // skip retry for stream to avoid duplicating chunks
    } catch (err) {
      clearStreamTimeouts();
      const msg = err instanceof Error ? err.message : String(err);
      const cause = (err as NodeJS.ErrnoException).cause;
      const detail = cause instanceof Error ? ` (${cause.message})` : '';
      if (idleTimedOut || hardTimedOut || /aborted/i.test(msg)) {
        const kind = hardTimedOut ? 'hard' : 'idle';
        throw new Error(
          `Markus stream ${kind} timeout after ${hardTimedOut ? STREAM_HARD_TIMEOUT_MS : this.streamTimeoutMs}ms${detail}`,
        );
      }
      throw new Error(`${msg}${detail}`);
    }

    if (!res.ok) {
      clearStreamTimeouts();
      const errText = await res.text();
      if (res.status === 429) {
        const prefix = errText.includes('CU_WINDOW_EXCEEDED') ? 'CU_WINDOW_EXCEEDED' : 'MARKUS_RATE_LIMITED';
        throw new Error(`${prefix}: ${errText}`);
      }
      if (isCreditExhaustedHttp(res.status, errText)) {
        const outcome = await this.resolveCreditHttpError(res.status, errText, _retried);
        if (outcome.retry) {
          const next = outcome.maxTokens
            ? { ...request, maxTokens: outcome.maxTokens }
            : request;
          return this.chatStream(next, onEvent, signal, true);
        }
      }
      throw new Error(`Markus proxy error ${res.status}: ${errText}`);
    }

    bumpIdleTimeout();
    const streamCuCost = 0;

    let content = '';
    let reasoningContent = '';
    let finishReason: LLMResponse['finishReason'] = 'end_turn';
    let promptTokens = 0;
    let completionTokens = 0;
    // Accumulate streamed tool calls by index. Without this, a streamed
    // tool_use turn arrives with finish_reason=tool_calls but zero parsed
    // calls — the agent then can't act and just stops after its text.
    const toolCallsAcc = new Map<number, { id: string; name: string; args: string }>();

    const reader = res.body?.getReader();
    if (!reader) {
      clearStreamTimeouts();
      throw new Error('No response body reader');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    /** Mid-stream OR rate limit (HTTP 200 + finish_reason=error / chunk.error). */
    let midStreamRateLimited = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bumpIdleTimeout();
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        let stopStream = false;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;

          try {
            const chunk = JSON.parse(trimmed.slice(6)) as Record<string, unknown>;
            const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
            const delta = choice?.delta as Record<string, unknown> | undefined;
            const streamErr = (chunk.error ?? null) as Record<string, unknown> | null;
            const finishRaw = choice?.finish_reason !== null ? String(choice?.finish_reason ?? '') : '';

            // OpenRouter: rate limit after stream starts arrives as SSE with
            // finish_reason "error" (status already 200), not HTTP 429.
            // https://openrouter.ai/docs/api_reference/limits#mid-stream-rate-limits
            if (streamErr || finishRaw === 'error') {
              const code = Number(streamErr?.code ?? 0);
              const errMsg = String(streamErr?.message ?? 'Rate limit exceeded');
              const isRateLimit = code === 429 || /rate.?limit/i.test(errMsg);
              if (isRateLimit) {
                midStreamRateLimited = true;
                stopStream = true;
                break;
              }
              throw new Error(`Markus stream error ${code || 'unknown'}: ${errMsg}`);
            }

            const deltaReasoning = extractDeltaReasoning(delta);
            if (deltaReasoning) {
              reasoningContent += deltaReasoning;
              onEvent({ type: 'thinking_delta', thinking: deltaReasoning });
            }

            if (delta?.content) {
              content += String(delta.content);
              onEvent({ type: 'text_delta', text: String(delta.content) });
            }

            if (Array.isArray(delta?.tool_calls)) {
              for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
                const idx = typeof tc.index === 'number' ? tc.index : 0;
                if (!toolCallsAcc.has(idx)) toolCallsAcc.set(idx, { id: '', name: '', args: '' });
                const existing = toolCallsAcc.get(idx)!;
                if (tc.id) existing.id = String(tc.id);
                const fn = tc.function as Record<string, unknown> | undefined;
                if (fn?.name) {
                  existing.name = String(fn.name);
                  onEvent({ type: 'tool_call_start', toolCall: { id: existing.id, name: existing.name } });
                }
                if (fn?.arguments) {
                  existing.args += String(fn.arguments);
                  onEvent({ type: 'tool_call_delta', toolCall: { id: existing.id }, text: String(fn.arguments) });
                }
              }
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
              if (promptTokens > 0) this.lastPromptTokensEstimate = promptTokens;
              if (target.route === 'openrouter') {
                this.recordCostUsd(chunk.usage as Record<string, unknown>);
              }
            }
          } catch (parseOrStreamErr) {
            // Re-throw hard stream errors; ignore JSON parse noise.
            if (parseOrStreamErr instanceof Error && parseOrStreamErr.message.startsWith('Markus stream error')) {
              throw parseOrStreamErr;
            }
          }
        }
        if (stopStream) break;
      }

      if (midStreamRateLimited) {
        const hasPartial = content.length > 0 || reasoningContent.length > 0 || toolCallsAcc.size > 0;
        if (hasPartial) {
          log.warn('OpenRouter mid-stream rate limit — returning partial for auto-continuation', {
            contentChars: content.length,
          });
          toolCallsAcc.clear();
          finishReason = 'max_tokens';
        } else {
          throw new Error('MARKUS_RATE_LIMITED: Rate limit exceeded (mid-stream)');
        }
      }
    } catch (err) {
      clearStreamTimeouts();
      const msg = err instanceof Error ? err.message : String(err);
      const hasPartial =
        content.length > 0
        || reasoningContent.length > 0
        || toolCallsAcc.size > 0;
      // Idle gap with partial output → treat like max_tokens so the agent loop
      // auto-continues instead of ending the turn and forcing UI「继续」.
      // Drop mid-flight tool_call JSON — executing a truncated call is unsafe.
      if (idleTimedOut && hasPartial) {
        log.warn('Markus stream idle timeout with partial content — returning for auto-continuation', {
          idleMs: this.streamTimeoutMs,
          contentChars: content.length,
          droppedToolCalls: toolCallsAcc.size,
        });
        toolCallsAcc.clear();
        finishReason = 'max_tokens';
      } else if (idleTimedOut || hardTimedOut) {
        const kind = hardTimedOut ? 'hard' : 'idle';
        throw new Error(
          `Markus stream ${kind} timeout after ${hardTimedOut ? STREAM_HARD_TIMEOUT_MS : this.streamTimeoutMs}ms`,
        );
      } else if (signal?.aborted || /aborted/i.test(msg)) {
        throw err instanceof Error ? err : new Error(msg);
      } else {
        throw err;
      }
    } finally {
      clearStreamTimeouts();
    }

    const resultToolCalls = [...toolCallsAcc.values()]
      .filter(tc => tc.name)
      .map(tc => {
        onEvent({ type: 'tool_call_end', toolCall: { id: tc.id, name: tc.name } });
        let args: Record<string, unknown> = {};
        try { args = tc.args ? JSON.parse(tc.args) as Record<string, unknown> : {}; } catch { /* malformed partial JSON — pass empty args */ }
        return { id: tc.id, name: tc.name, arguments: args };
      });

    // Recover tool calls the model streamed as plain text instead of via the
    // structured tool_calls field (see recoverTextToolCalls).
    let recoveredToolCalls = resultToolCalls;
    if (!recoveredToolCalls.length) {
      const recovered = recoverTextToolCalls(content);
      if (recovered.toolCalls.length) {
        log.warn('Recovered text-emitted tool calls from streamed content', {
          count: recovered.toolCalls.length,
          names: recovered.toolCalls.map(t => t.name),
        });
        recoveredToolCalls = recovered.toolCalls;
        content = recovered.cleanedContent;
      }
    }

    // Upstream sometimes reports finish_reason=stop even when it emitted tool
    // calls; normalize so the agent treats it as a tool turn.
    if (recoveredToolCalls.length && finishReason !== 'tool_use') finishReason = 'tool_use';

    const usage = { inputTokens: promptTokens, outputTokens: completionTokens };
    onEvent({ type: 'message_end', usage, finishReason });

    const streamResult: LLMResponse = { content, usage, finishReason };
    if (recoveredToolCalls.length) streamResult.toolCalls = recoveredToolCalls;
    if (reasoningContent) streamResult.reasoningContent = reasoningContent;
    if (streamCuCost > 0) streamResult.cuCost = streamCuCost;
    streamResult.creditWarning = this.checkLowCredit();

    this.cuCache.add(promptTokens, completionTokens);
    this.clearPromptAffordHint('stream_success');
    return streamResult;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private buildHeaders(target: { route: MarkusRoute; authKey: string }): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Markus-Client': CLIENT_ID,
      Authorization: `Bearer ${target.authKey}`,
    };
    if (target.route === 'openrouter') {
      headers['HTTP-Referer'] = 'https://markus.global';
      headers['X-Title'] = 'Markus';
    }
    return headers;
  }

  private resolveOutgoingModel(modelId: string | undefined): string {
    return stripMarkusNamespace((modelId ?? this.model ?? '').trim());
  }

  /** Rough prompt-token estimate for proactive max_tokens clamp (chars/4). */
  private estimateRequestPromptTokens(request: LLMRequest): number {
    try {
      const payload = JSON.stringify({
        messages: request.messages,
        tools: request.tools,
      });
      return Math.max(1, Math.ceil(payload.length / 4));
    } catch {
      return this.lastPromptTokensEstimate ?? 4_000;
    }
  }

  private buildBody(request: LLMRequest, stream: boolean, route: MarkusRoute): Record<string, unknown> {
    // Catalog ids are OR slugs; strip optional legacy `markus/` gateway prefix.
    const outgoingModel = this.resolveOutgoingModel(request.model);
    const enableReasoning = route === 'openrouter' && shouldEnableOpenRouterReasoning(outgoingModel);
    const body: Record<string, unknown> = {
      model: outgoingModel,
      messages: convertMessagesForOpenRouter(request.messages, {
        // When thinking is on, DeepSeek requires reasoning_content on every assistant turn.
        backfillReasoning: enableReasoning && /deepseek/i.test(outgoingModel),
      }),
      stream,
    };
    // Only cap output when a real value is known (from the request or config).
    // Otherwise omit it so the upstream uses the model's own maximum.
    // Afford.S4: when prompt afford is known, proactively clamp so we never
    // send a doomed high reservation (e.g. 13156) before the first 402.
    let maxTokens = request.maxTokens ?? this.maxTokens;
    if (this.lastPromptAffordTokens !== null && this.lastPromptAffordTokens > 0) {
      const estimatedPrompt =
        this.lastPromptTokensEstimate
        ?? this.estimateRequestPromptTokens(request);
      maxTokens = clampMaxTokensToRemainingAfford({
        requested: maxTokens && maxTokens > 0 ? maxTokens : undefined,
        promptAfford: this.lastPromptAffordTokens,
        estimatedPrompt,
      });
    }
    if (maxTokens && maxTokens > 0) body['max_tokens'] = maxTokens;
    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.tools?.length) body['tools'] = convertToolsForOpenRouter(request.tools);
    if (request.stopSequences?.length) body['stop'] = request.stopSequences;
    // OpenRouter: ask for usage.cost for near-real-time spend display.
    if (route === 'openrouter') {
      body['usage'] = { include: true };
      if (stream) body['stream_options'] = { include_usage: true };
      // DeepSeek V4 / other reasoning models need an explicit request, otherwise
      // OpenRouter returns only the final answer (no thinking_delta / UI block).
      if (enableReasoning) {
        body['reasoning'] = { enabled: true, effort: 'high' };
      }
    }
    return body;
  }

  /**
   * Fetch with exponential backoff retry.
   *
   * OpenRouter guidance (https://openrouter.ai/docs/api_reference/limits):
   * - 429 / 503 are transient — retry with exponential backoff; honor `Retry-After`
   * - Other 4xx (auth/billing) are not retried
   * - 5xx / network errors are retried (unless skipRetry — used after stream body
   *   would already be in flight; 429/503 still retry because they fail before body)
   */
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    skipRetry = false,
    retries = MAX_RETRIES,
  ): Promise<Response> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < retries; attempt++) {
      let res: Response | undefined;
      try {
        res = await fetch(url, init);

        if (res.ok) return res;

        const retriableStatus = res.status === 429 || res.status === 503;
        // Other 4xx (401/402/403/…) are permanent for this request.
        if (res.status >= 400 && res.status < 500 && !retriableStatus) {
          return res;
        }

        log.warn(`OpenRouter/Markus HTTP ${res.status} (attempt ${attempt + 1}/${retries})`, {
          retryAfter: res.headers.get('retry-after'),
          rateLimitRemaining: res.headers.get('x-ratelimit-remaining'),
          rateLimitReset: res.headers.get('x-ratelimit-reset'),
        });
        lastError = new Error(`Markus proxy error ${res.status}`);

        // skipRetry: do not re-issue after a 5xx once a stream body may exist.
        // 429/503 still retry — they reject before useful SSE starts.
        if (skipRetry && !retriableStatus) return res;

        if (attempt >= retries - 1) return res;

        // Drain body before retry so the socket can close cleanly.
        const errText = await res.text().catch(() => '');
        if (errText) log.warn('Response body', { body: errText.slice(0, 200) });

        const delay = retryDelayMs(res, attempt);
        log.info(`Waiting ${delay}ms before retry (Retry-After / backoff)`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        log.warn(`Markus proxy network error (attempt ${attempt + 1}/${retries})`, { error: lastError.message });
        if (skipRetry || attempt >= retries - 1) break;
        const delay = retryDelayMs(undefined, attempt);
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
    let content = typeof message?.content === 'string' ? message.content : '';

    const toolCallsData = message?.tool_calls as Array<Record<string, unknown>> | undefined;
    let toolCalls = toolCallsData?.map((tc: Record<string, unknown>) => ({
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
    let finishReason = finishMap[String(choice.finish_reason ?? 'stop')] ?? 'end_turn';

    // Recover tool calls the model emitted as text (see recoverTextToolCalls).
    if (!toolCalls?.length) {
      const recovered = recoverTextToolCalls(content);
      if (recovered.toolCalls.length) {
        log.warn('Recovered text-emitted tool calls from content', {
          count: recovered.toolCalls.length,
          names: recovered.toolCalls.map(t => t.name),
        });
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

    if (usage?.prompt_tokens && usage.prompt_tokens > 0) {
      this.lastPromptTokensEstimate = usage.prompt_tokens;
    }

    const result: LLMResponse = {
      content,
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
      },
      finishReason,
    };
    if (reasoningContent) result.reasoningContent = reasoningContent;
    return result;
  }

  /** Record CU usage for diagnostic tracking within the provider. */
  private recordCU(response: LLMResponse): void {
    this.cuCache.add(response.usage.inputTokens, response.usage.outputTokens);
  }

  /**
   * Multimodal (image/tts/stt/video) requires OpenRouter credentials.
   * Media endpoints require real OpenRouter media slugs.
   *
   * OpenRouter response shapes (normalized here before tools see them):
   *   - Image  POST /images            → JSON `{ data: [{ b64_json, media_type }] }`
   *   - TTS    POST /audio/speech      → raw audio bytes (mp3|pcm)
   *   - STT    POST /audio/transcriptions → JSON `{ text }` (send `input_audio`)
   *   - Video  POST /videos (async)    → job + poll → content URL (auth download)
   */
  getCapabilities(): ProviderCapabilities {
    const or = this.hasOpenRouterCreds();
    return {
      chat: true,
      vision: true,
      imageGeneration: or,
      tts: or,
      stt: or,
      videoGeneration: or,
      embedding: false,
      reasoning: true,
      promptCaching: true,
    };
  }

  getToolSchemas(): MultiModalToolSchemas {
    const providerParam = {
      type: 'string',
      description:
        'Provider for THIS call (e.g. "markus", "openai", "minimax-cn"). Combine with model= for one-shot use; omit to use capability-routing default.',
    };
    return {
      generate_image: {
        description:
          'Generate images from text, with optional reference images. Pass provider+model on this call (e.g. provider: "markus", model: "openai/gpt-image-1") — no need to reconfigure routing first. ' +
          'Result is saved locally — use the returned filePath/markdown (never invent data-URI/base64). ' +
          'For image-to-image: pass input_references with HTTPS or base64 data URLs.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Detailed text description of the image to generate (REQUIRED)' },
            provider: providerParam,
            model: { type: 'string', description: 'Image model for THIS call on the chosen provider (e.g. "openai/gpt-image-1"). Preferred over capability routing.' },
            size: { type: 'string', description: 'Size shorthand: pixels ("1024x1024"), resolution tier ("1K"|"2K"|"4K"), or aspect ratio ("16:9")' },
            quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'], description: 'Rendering quality when the model supports it' },
            n: { type: 'number', description: 'Number of images (1–10, default 1)' },
            seed: { type: 'number', description: 'Seed for deterministic generation (not guaranteed by all providers)' },
            output_format: { type: 'string', enum: ['png', 'jpeg', 'webp', 'svg'], description: 'Encoding of returned image bytes. Use png/webp for transparent backgrounds.' },
            output_compression: { type: 'number', description: 'Compression level 0-100 for webp/jpeg. Ignored for png.' },
            background: { type: 'string', enum: ['auto', 'transparent', 'opaque'], description: 'Background treatment. transparent requires png/webp.' },
            input_references: {
              type: 'array',
              description: 'Reference images for image-to-image generation (up to 16). Provide HTTPS URLs or base64 data URLs.',
              items: {
                type: 'object',
                properties: {
                  url: { type: 'string', description: 'HTTPS URL or base64 data URL of the reference image' },
                  weight: { type: 'number', description: 'Optional weight 0-1 for this reference' },
                },
                required: ['url'],
              },
            },
          },
          required: ['prompt'],
        },
      },
      text_to_speech: {
        description:
          'Convert text to speech via OpenRouter /audio/speech (synchronous). One request blocks until the full audio bytestream returns — ' +
          'not an async job. Longer text is slower (often tens of seconds; client waits up to ~3 min). ' +
          'For paragraphs/long narration, split into short sentences and call multiple times. ' +
          'Pass provider+model on this call (e.g. model: "deepgram/aura-2" or "minimax/speech-2.8-hd"). Returns a local audio file path. ' +
          'Voice is model-specific and strongly recommended (upstream often requires it).',
        inputSchema: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description:
                'Text to synthesize (REQUIRED). Keep each call short. Do not send long paragraphs in one request — split first. Sync wait until audio is ready.',
            },
            provider: providerParam,
            model: { type: 'string', description: 'TTS model for THIS call (e.g. "deepgram/aura-2", "minimax/speech-2.8-hd", "tts-1"). Preferred over capability routing.' },
            voice: {
              type: 'string',
              description:
                'Voice id for the chosen model (strongly recommended). Deepgram: aura-2-thalia-en; OpenAI: alloy/nova; MiniMax: "Chinese (Mandarin)_Gentle_Youth".',
            },
            speed: { type: 'number', description: 'Playback speed when supported (e.g. OpenAI TTS)' },
            response_format: { type: 'string', enum: ['mp3', 'pcm', 'opus', 'aac', 'flac', 'wav'], description: 'Audio encoding format. Default provider-dependent.' },
          },
          required: ['text'],
        },
      },
      speech_to_text: {
        description:
          'Transcribe speech to text. Pass provider+model on this call (e.g. provider: "markus", model: "deepgram/nova-3" or provider: "openai", model: "whisper-1") — no need to reconfigure routing first.',
        inputSchema: {
          type: 'object',
          properties: {
            audio_url: { type: 'string', description: 'URL or local file path of the audio to transcribe (REQUIRED)' },
            provider: providerParam,
            model: { type: 'string', description: 'STT model for THIS call (e.g. "deepgram/nova-3", "whisper-1"). Preferred over capability routing.' },
            language: { type: 'string', description: 'Optional ISO-639-1 language hint (e.g. "en", "zh")' },
          },
          required: ['audio_url'],
        },
      },
      generate_video: {
        description:
          'Generate a short video from text, with optional reference images/audio/video. ' +
          'Pass provider+model on this call (e.g. provider: "markus", model: "x-ai/grok-imagine-video-1.5") — no need to reconfigure routing first. ' +
          'To use references: pass input_references (style guidance) or frame_images (exact first/last frame). May take 30s–several minutes.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Detailed description of the video to generate (REQUIRED)' },
            provider: providerParam,
            model: { type: 'string', description: 'Video model for THIS call (e.g. "x-ai/grok-imagine-video-1.5"). Preferred over capability routing.' },
            duration: { type: 'number', description: 'Duration in seconds when the model supports it' },
            size: { type: 'string', description: 'Resolution ("720p"|"1080p"), pixels ("1280x720"), or aspect ratio ("16:9")' },
            input_references: {
              type: 'array',
              description:
                'Reference assets for style/content guidance. Each item needs a "url" (publicly accessible) ' +
                'and "type" ("image", "audio", or "video"). ' +
                'Use publicly accessible, directly-downloadable URLs (no auth walls).',
              items: {
                type: 'object',
                properties: {
                  url: { type: 'string', description: 'Publicly accessible URL of the reference asset' },
                  type: { type: 'string', enum: ['image', 'audio', 'video'], description: 'Asset type' },
                  weight: { type: 'number', description: 'Optional weight 0-1 for this reference relative to others' },
                },
                required: ['url', 'type'],
              },
            },
            frame_images: {
              type: 'array',
              description:
                'Images for first/last frame (image-to-video). Takes precedence over input_references. ' +
                'Each item needs "url" and "frame_type" ("first_frame" or "last_frame"). Max 2 items.',
              items: {
                type: 'object',
                properties: {
                  url: { type: 'string', description: 'Publicly accessible image URL' },
                  frame_type: { type: 'string', enum: ['first_frame', 'last_frame'] },
                },
                required: ['url', 'frame_type'],
              },
            },
            generate_audio: {
              type: 'boolean',
              description: 'Whether to generate audio alongside the video. Defaults to provider default.',
            },
            seed: {
              type: 'number',
              description: 'Seed for deterministic generation (not guaranteed by all providers).',
            },
          },
          required: ['prompt'],
        },
      },
    };
  }

  /** OpenAI-compatible path under the OpenRouter base URL. */
  private openaiCompatUrl(suffix: string): string {
    const base = this.effectiveOpenRouterBase();
    return /\/v\d+$/.test(base) ? `${base}/${suffix}` : `${base}/v1/${suffix}`;
  }

  private bearerOpenRouter(): string {
    return `Bearer ${this.effectiveOpenRouterKey()}`;
  }

  /**
   * Resolve the model id for a media (image/tts/stt/video) request.
   *
   * Media flows through OpenRouter, so the id must be an OpenRouter-served slug.
   * The provider's own `this.model` is typically a *text* slug and is not a valid
   * media model — falling back to it produces a confusing upstream error. Require
   * an explicit media slug and fail loudly otherwise.
   */
  private resolveMediaModel(rawModel: string | undefined, capabilityLabel: string, example: string): string {
    const model = stripMarkusNamespace(rawModel ?? this.model);
    // Historical bare markus-* aliases are never valid media (or chat) OR slugs.
    const isNativeMarkusId = /^markus[-_]/i.test(model);
    if (!model || isNativeMarkusId) {
      throw new Error(
        `No ${capabilityLabel} model configured for Markus. ${capabilityLabel} runs via OpenRouter — ` +
        `set capability routing to an OpenRouter-served model (e.g. ${example}). ` +
        `Text models like "${model || this.model}" cannot be used here.`,
      );
    }
    return model;
  }

  private generatedDir(kind: 'images' | 'videos' | 'audio'): string {
    try {
      const dir = join(homedir(), '.markus', 'generated', kind);
      mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      const dir = join(tmpdir(), `markus-${kind}`);
      mkdirSync(dir, { recursive: true });
      return dir;
    }
  }

  // ---------------------------------------------------------------------------
  // Multi-modal (OpenRouter only)
  // ---------------------------------------------------------------------------

  /**
   * OpenRouter unified Image API: `POST /api/v1/images`.
   * Always returns `data[].b64_json` (+ optional `media_type`) — never a durable URL.
   * We decode + persist immediately so callers never need to shuttle megabytes of base64.
   */
  async generateImage(prompt: string, options?: ImageGenOptions, _retried = false): Promise<ImageResult[]> {
    if (!this.hasOpenRouterCreds()) {
      throw new Error('Image generation requires Markus OpenRouter credentials (Hub connect)');
    }
    await this.assertCreditsAvailable();
    const model = this.resolveMediaModel(options?.model, 'image generation', 'openai/gpt-image-1');
    const endpoint = this.openaiCompatUrl('images');
    const body: Record<string, unknown> = {
      model,
      prompt,
      n: options?.n ?? 1,
    };
    Object.assign(body, mapOpenRouterImageSize(options?.size));
    if (options?.quality) body['quality'] = options.quality;
    if (options?.output_format) body['output_format'] = options.output_format;
    if (options?.outputCompression !== undefined) body['output_compression'] = options.outputCompression;
    if (options?.background) body['background'] = options.background;
    if (options?.seed !== undefined && options.seed !== null) body['seed'] = options.seed;
    if (options?.inputReferences && options.inputReferences.length > 0) {
      body['input_references'] = options.inputReferences.map(ref => {
        const item: Record<string, unknown> = { url: ref.url };
        if (ref.weight !== undefined) item['weight'] = ref.weight;
        return item;
      });
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: this.bearerOpenRouter() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) {
      const errText = await res.text();
      // Same as chat: never claim CU_EXCEEDED from OR 402 alone — Hub may still
      // have budget (stale key / per-request reservation). Confirm via cu/sync.
      if (isCreditExhaustedHttp(res.status, errText)) {
        const outcome = await this.resolveCreditHttpError(res.status, errText, _retried);
        if (outcome.retry) return this.generateImage(prompt, options, true);
      }
      throw new Error(`Image generation API error ${formatUpstreamMediaError(res.status, errText)}`);
    }
    const data = await res.json() as {
      data?: Array<{
        b64_json?: string;
        url?: string;
        media_type?: string;
        revised_prompt?: string;
      }>;
    };
    const items = data.data ?? [];
    if (!items.length) {
      throw new Error('Image generation returned no images');
    }

    const results: ImageResult[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const mediaType = item.media_type;
      const ext = mediaTypeToImageExt(mediaType) ?? guessImageExtFromB64(item.b64_json);
      let path: string | undefined;
      let bytes: Buffer | undefined;

      if (item.b64_json) {
        const raw = item.b64_json.includes(',') ? item.b64_json.split(',').pop()! : item.b64_json;
        bytes = Buffer.from(raw, 'base64');
      } else if (item.url?.startsWith('data:')) {
        const raw = item.url.split(',').pop() ?? '';
        bytes = Buffer.from(raw, 'base64');
      } else if (item.url) {
        try {
          const imgRes = await fetch(item.url, { signal: AbortSignal.timeout(60_000) });
          if (imgRes.ok) bytes = Buffer.from(await imgRes.arrayBuffer());
        } catch (err) {
          log.warn(`Failed to download image url: ${err}`);
        }
      }

      if (bytes?.length) {
        path = join(this.generatedDir('images'), `img-${Date.now()}-${i}.${ext}`);
        writeFileSync(path, bytes);
      }

      results.push({
        // Prefer path; keep url only as fallback when we could not persist.
        path,
        url: path ? undefined : item.url,
        // Do not forward megabyte base64 to the tool/agent layer.
        base64: path ? undefined : item.b64_json,
        mediaType,
        revisedPrompt: item.revised_prompt,
      });
    }
    return results;
  }

  /**
   * OpenRouter TTS: `POST /api/v1/audio/speech` → raw audio bytestream (not JSON).
   * Formats: `mp3` | `pcm` (default upstream is pcm — we always request mp3 unless overridden).
   */
  async generateSpeech(text: string, options?: TTSOptions, _retried = false): Promise<AudioResult> {
    if (!this.hasOpenRouterCreds()) {
      throw new Error('TTS requires Markus OpenRouter credentials (Hub connect)');
    }
    await this.assertCreditsAvailable();
    const endpoint = this.openaiCompatUrl('audio/speech');
    const model = this.resolveMediaModel(options?.model, 'TTS', 'deepgram/aura-2');
    // OpenRouter only documents mp3|pcm. Coerce other OpenAI-style formats to mp3.
    const requested = options?.responseFormat ?? 'mp3';
    const format = requested === 'pcm' ? 'pcm' : 'mp3';
    // Voice is provider-specific. Never blindly send "alloy" (an OpenAI voice) to
    // e.g. a Deepgram model — that yields a hard 400. Use the caller's voice, else
    // a family-appropriate default, else omit and let the upstream decide.
    const voice = options?.voice ?? defaultVoiceForModel(model);
    const body: Record<string, unknown> = {
      model,
      input: text,
      response_format: format,
    };
    if (voice) body['voice'] = voice;
    if (options?.speed) body['speed'] = options.speed;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: this.bearerOpenRouter() },
      body: JSON.stringify(body),
      // Long narration + MiniMax/Deepgram synthesis often exceeds 60s.
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) {
      const errText = await res.text();
      if (isCreditExhaustedHttp(res.status, errText)) {
        const outcome = await this.resolveCreditHttpError(res.status, errText, _retried);
        if (outcome.retry) return this.generateSpeech(text, options, true);
      }
      throw new Error(
        `TTS API error for model "${model}": ${formatUpstreamMediaError(res.status, errText)}. ` +
          `Retry with a different model arg (e.g. deepgram/aura-2 or minimax/speech-2.8-hd).`,
      );
    }
    const arrayBuf = await res.arrayBuffer();
    if (!arrayBuf.byteLength) {
      throw new Error(`TTS API returned empty audio body for model "${model}"`);
    }
    // Prefer the request format; fall back to Content-Type if the body looks mismatched.
    const contentType = res.headers.get('content-type') ?? '';
    const resolvedFormat = contentType.includes('pcm') ? 'pcm'
      : contentType.includes('mpeg') || contentType.includes('mp3') ? 'mp3'
      : format;
    return { audio: Buffer.from(arrayBuf), format: resolvedFormat };
  }

  /**
   * OpenRouter STT: `POST /api/v1/audio/transcriptions` with JSON `input_audio`
   * (`data` = raw base64, `format` = wav|mp3|…). Response is `{ text }`.
   * Multipart also works, but JSON is the documented primary path and avoids the 25MB multipart cap.
   */
  async transcribeSpeech(audio: Buffer, options?: STTOptions, _retried = false): Promise<string> {
    if (!this.hasOpenRouterCreds()) {
      throw new Error('STT requires Markus OpenRouter credentials (Hub connect)');
    }
    await this.assertCreditsAvailable();
    const endpoint = this.openaiCompatUrl('audio/transcriptions');
    const model = this.resolveMediaModel(options?.model, 'STT', 'deepgram/nova-3');
    const format = detectAudioFormat(audio);
    const body: Record<string, unknown> = {
      model,
      input_audio: {
        data: audio.toString('base64'),
        format,
      },
      // OpenRouter rejects text/srt/vtt; json is the safe default.
      response_format: 'json',
    };
    if (options?.language) body['language'] = options.language;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: this.bearerOpenRouter() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const errText = await res.text();
      if (isCreditExhaustedHttp(res.status, errText)) {
        const outcome = await this.resolveCreditHttpError(res.status, errText, _retried);
        if (outcome.retry) return this.transcribeSpeech(audio, options, true);
      }
      throw new Error(`STT API error ${formatUpstreamMediaError(res.status, errText)}`);
    }
    const data = await res.json() as { text?: string };
    if (typeof data.text !== 'string') {
      throw new Error('STT API returned no transcript text');
    }
    return data.text;
  }

  /**
   * OpenRouter video generation — async job API.
   *
   * Models like `alibaba/happyhorse-1.1` / `google/veo-3.1-fast` list
   * `output_modalities: ["video"]` and are NOT chat-completion models.
   * Workflow: POST /videos → poll polling_url → download unsigned_urls[0].
   */
  async generateVideo(prompt: string, options?: VideoGenOptions, _retried = false): Promise<VideoResult> {
    if (!this.hasOpenRouterCreds()) {
      throw new Error('Video generation requires Markus OpenRouter credentials (Hub connect)');
    }
    await this.assertCreditsAvailable();
    const model = this.resolveMediaModel(options?.model, 'video generation', 'alibaba/happyhorse-1.1');
    const endpoint = this.openaiCompatUrl('videos');
    const body: Record<string, unknown> = { model, prompt };
    if (options?.duration !== undefined && options.duration !== null) body['duration'] = options.duration;
    if (options?.size) {
      const size = options.size.trim();
      if (/^\d+x\d+$/i.test(size)) body['size'] = size;
      else if (/^\d+p$/i.test(size) || /^(1|2|4)k$/i.test(size)) body['resolution'] = size;
      else if (/^\d+:\d+$/.test(size)) body['aspect_ratio'] = size;
      else body['resolution'] = size;
    }
    if (options?.inputReferences && options.inputReferences.length > 0) {
      body['input_references'] = options.inputReferences.map(ref => {
        const item: Record<string, unknown> = { url: ref.url, type: ref.type };
        if (ref.weight !== undefined) item['weight'] = ref.weight;
        return item;
      });
    }
    if (options?.frameImages && options.frameImages.length > 0) {
      body['frame_images'] = options.frameImages.map(f => ({ url: f.url, frame_type: f.frame_type }));
    }
    if (options?.generateAudio !== undefined) body['generate_audio'] = options.generateAudio;
    if (options?.seed !== undefined) body['seed'] = options.seed;

    const createRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: this.bearerOpenRouter() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!createRes.ok) {
      const errText = await createRes.text();
      if (isCreditExhaustedHttp(createRes.status, errText)) {
        const outcome = await this.resolveCreditHttpError(createRes.status, errText, _retried);
        if (outcome.retry) return this.generateVideo(prompt, options, true);
      }
      throw new Error(`Video generation API error ${formatUpstreamMediaError(createRes.status, errText)}`);
    }
    const created = await createRes.json() as {
      id?: string;
      polling_url?: string;
      status?: string;
      error?: string | { message?: string };
    };
    const jobId = created.id;
    const pollingUrl = created.polling_url
      ?? (jobId ? this.openaiCompatUrl(`videos/${jobId}`) : undefined);
    if (!jobId || !pollingUrl) {
      throw new Error('Video generation returned no job id / polling_url');
    }
    log.info('OpenRouter video job submitted', { jobId, model, status: created.status });

    const authHeaders = { Authorization: this.bearerOpenRouter() };
    // Video jobs commonly take minutes; poll every 5s up to ~30 min.
    const maxAttempts = 360;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 5_000));
      const pollRes = await fetch(pollingUrl, {
        method: 'GET',
        headers: authHeaders,
        signal: AbortSignal.timeout(30_000),
      });
      if (!pollRes.ok) {
        const errText = await pollRes.text();
        // Transient upstream blips — keep polling unless it's a hard client error.
        if (pollRes.status >= 400 && pollRes.status < 500 && pollRes.status !== 429) {
          throw new Error(`Video generation poll error ${formatUpstreamMediaError(pollRes.status, errText)}`);
        }
        continue;
      }
      const status = await pollRes.json() as {
        id?: string;
        status?: string;
        unsigned_urls?: string[];
        error?: string | { message?: string };
      };
      const state = (status.status ?? '').toLowerCase();
      if (state === 'completed') {
        const contentUrl = status.unsigned_urls?.[0]
          ?? this.openaiCompatUrl(`videos/${jobId}/content`);
        const localPath = await this.downloadVideoToDisk(contentUrl, jobId);
        return {
          url: contentUrl,
          path: localPath,
          taskId: jobId,
          status: 'completed',
          durationSeconds: options?.duration,
        };
      }
      if (state === 'failed' || state === 'cancelled' || state === 'expired') {
        const errMsg = typeof status.error === 'string'
          ? status.error
          : status.error?.message ?? state;
        throw new Error(`Video generation ${state}: ${errMsg}`);
      }
    }
    return { taskId: jobId, status: 'processing', durationSeconds: options?.duration };
  }

  /** Download OpenRouter video content (auth required) into ~/.markus/generated/videos. */
  private async downloadVideoToDisk(contentUrl: string, jobId: string): Promise<string | undefined> {
    try {
      const res = await fetch(contentUrl, {
        headers: { Authorization: this.bearerOpenRouter() },
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) {
        log.warn('Video content download failed', { status: res.status, jobId });
        return undefined;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (!bytes.length) return undefined;
      const filepath = join(this.generatedDir('videos'), `vid-${jobId}.mp4`);
      writeFileSync(filepath, bytes);
      return filepath;
    } catch (err) {
      log.warn(`Video content download error: ${err}`);
      return undefined;
    }
  }
}

/** Map Markus `size` option onto OpenRouter Image API fields. */
function mapOpenRouterImageSize(size?: string): Record<string, string> {
  if (!size?.trim()) return { size: '1024x1024' };
  const s = size.trim();
  if (/^\d+x\d+$/i.test(s)) return { size: s };
  if (/^(512|1k|2k|4k)$/i.test(s)) {
    const tier = s.toUpperCase().replace(/K$/i, 'K');
    return { resolution: tier === '512' ? '512' : tier };
  }
  if (/^\d+:\d+$/.test(s)) return { aspect_ratio: s };
  return { size: s };
}

function mediaTypeToImageExt(mediaType?: string): string | undefined {
  if (!mediaType) return undefined;
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
  };
  return map[mediaType.toLowerCase()];
}

function guessImageExtFromB64(b64?: string): string {
  if (!b64) return 'png';
  const raw = b64.includes(',') ? b64.split(',').pop()! : b64;
  if (raw.startsWith('/9j/')) return 'jpg';
  if (raw.startsWith('iVBOR')) return 'png';
  if (raw.startsWith('R0lGOD')) return 'gif';
  if (raw.startsWith('UklGR')) return 'webp';
  if (raw.startsWith('PHN2Zy') || raw.startsWith('PD94bW')) return 'svg';
  return 'png';
}

/** Best-effort audio container detection for OpenRouter STT `input_audio.format`. */
function detectAudioFormat(audio: Buffer): string {
  if (audio.length >= 12) {
    // RIFF....WAVE
    if (audio.toString('ascii', 0, 4) === 'RIFF' && audio.toString('ascii', 8, 12) === 'WAVE') return 'wav';
    // OggS
    if (audio.toString('ascii', 0, 4) === 'OggS') return 'ogg';
    // fLaC
    if (audio.toString('ascii', 0, 4) === 'fLaC') return 'flac';
    // ID3 tag or MPEG frame sync
    if (audio.toString('ascii', 0, 3) === 'ID3') return 'mp3';
    if (audio[0] === 0xff && (audio[1]! & 0xe0) === 0xe0) return 'mp3';
    // ftyp.... (m4a/mp4)
    if (audio.toString('ascii', 4, 8) === 'ftyp') return 'm4a';
  }
  return 'wav';
}

/** Empty until Hub catalog loads — avoids sending obsolete aliases. */
const FALLBACK_MODELS: MarkusModelInfo[] = [];
