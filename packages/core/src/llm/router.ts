import { createLogger, getTextContent, LLM_CIRCUIT_RESET_RATE_LIMIT_MS, LLM_MAX_CONCURRENT_PER_PROVIDER, LLM_CONCURRENCY_JITTER_BASE_MS, type LLMRequest, type LLMResponse, type LLMStreamEvent, type LLMProviderConfig, type ModelDefinition, type ModelCostConfig, type EnhancedProviderSettings, type EnhancedLLMSettings, type AuthProfile, type ModelTier, type ModelCapabilityType, type CostTier, type CapabilityRoutingConfig, type CapabilityModelAssignment, type ProviderCapabilities, getProviderBootstrapModel, MODEL_CAPABILITY_TYPES } from '@markus/shared';
import { startSpan } from '../tracing.js';
import { DEFAULT_REQUEST_MAX_TOKENS, type LLMProviderInterface, type MultiModalProviderInterface } from './provider.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider, type TokenResolver } from './openai.js';
import { MiniMaxProvider } from './minimax.js';
import { DashScopeProvider } from './dashscope.js';
import { FireworksProvider } from './fireworks.js';
import { CodexResponsesProvider } from './openai-codex.js';
import { GoogleProvider } from './google.js';
import { OllamaProvider } from './ollama.js';
import { MarkusProvider, clearMarkusModelListCache } from './markus-provider.js';
import { findCatalogEntry } from './router-catalog-match.js';
import { isObsoleteMarkusModel } from './hub-recommended-routing.js';
import { discoverProviderModels, PROVIDER_DEFAULT_BASE_URLS } from './model-discovery.js';
import { AuthProfileStore } from './auth-profiles.js';
import { OAuthManager } from './oauth-manager.js';
import type { ModelCatalogService } from './model-catalog.js';
import { isChatCapableModel } from './model-capabilities.js';


const log = createLogger('llm-router');

// -- Local Ollama model probing ------------------------------------------------
// `/api/tags` lists pulled models but NOT their context length, and a
// contextWindow of 0 would trip the fail-loud `getModelContextWindow` guard
// (agent budget planning aborts). So we probe each model's real context via
// `/api/show` (model_info["*.context_length"]). This runs only on the settings
// refresh / provider re-register path (not per chat turn) and local Ollama
// responds in ms, so no caching is needed (and a module-level cache would leak
// stale model lists between tests).
const OLLAMA_DEFAULT_CONTEXT_WINDOW = 8192;
const OLLAMA_DEFAULT_MAX_OUTPUT = 4096;

/**
 * Fallback values for provider/model pairs with no catalog entry. ANY real
 * model must get a usable context budget — a private/BYOK/local/unknown model
 * that is absent from the built-in or Hub catalog must still work. We return a
 * sane default (never throw) and log a warning so the operator can configure a
 * precise value. `DEFAULT_CONTEXT_WINDOW_FALLBACK` is kept comfortably larger
 * than `DEFAULT_MAX_OUTPUT_FALLBACK` so the derived message budget never goes
 * negative.
 *
 * P1-7: this used to be 1_000_000. A catalog miss therefore handed an unlisted
 * model a 1M window, which made the packing budget systematically optimistic:
 * small-window models were over-packed every turn until the upstream returned
 * 400 (observed live: `[CONTEXT] window 1000k`). Fail closed to a conservative
 * window instead; operators who actually have a larger model can raise it
 * explicitly via `MARKUS_FALLBACK_CONTEXT_WINDOW`.
 */
export const DEFAULT_CONTEXT_WINDOW_FALLBACK = 32_768;
const DEFAULT_MAX_OUTPUT_FALLBACK = 8_192;
/**
 * Upper sanity bound for a resolved context window. Real models top out around
 * 1M today; anything above this is a catalog/config error and would again
 * produce absurd packing budgets, so we clamp and warn.
 */
const MAX_CONTEXT_WINDOW_SANITY = 2_000_000;

/**
 * Resolve the conservative catalog-miss fallback window, allowing an explicit
 * operator override. Kept as a function (not a const) so the env var is read at
 * call time and clamped to the sanity bound.
 */
function resolveFallbackContextWindow(): number {
  const raw = process.env['MARKUS_FALLBACK_CONTEXT_WINDOW'];
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.min(n, MAX_CONTEXT_WINDOW_SANITY);
  }
  return DEFAULT_CONTEXT_WINDOW_FALLBACK;
}

const CAPABILITY_KEY_MAP: Partial<Record<ModelCapabilityType, keyof ProviderCapabilities>> = {
  image_generation: 'imageGeneration',
  image_recognition: 'vision',
  audio_tts: 'tts',
  audio_stt: 'stt',
  video_generation: 'videoGeneration',
  decision: 'decision',
};

/**
 * How long a successful live model-list sync stays authoritative before we ask
 * the provider again. Long enough to avoid hammering `/models` on every
 * settings render, short enough that a new model release shows up on its own.
 */
export const LIVE_MODEL_SYNC_TTL_MS = 10 * 60 * 1000;

const MINIMAX_NAMES = new Set(['minimax', 'minimax-cn']);
const DASHSCOPE_NAMES = new Set(['dashscope']);
const FIREWORKS_NAMES = new Set(['fireworks_ai', 'fireworks']);

/**
 * Factory: instantiate the correct OpenAI-compatible provider subclass.
 * Providers with non-standard multimodal APIs get their own subclass;
 * everything else falls back to the generic OpenAIProvider.
 */
function createOpenAICompatible(
  name: string,
  config: LLMProviderConfig,
  tokenResolver?: TokenResolver,
): OpenAIProvider {
  const effectiveName = name as any;
  const cfg = { ...config, provider: effectiveName };
  if (MINIMAX_NAMES.has(name) || config.baseUrl?.includes('minimax')) {
    return new MiniMaxProvider(cfg, tokenResolver);
  }
  if (DASHSCOPE_NAMES.has(name) || config.baseUrl?.includes('dashscope')) {
    return new DashScopeProvider(cfg, tokenResolver);
  }
  if (FIREWORKS_NAMES.has(name) || config.baseUrl?.includes('fireworks.ai')) {
    return new FireworksProvider(cfg, tokenResolver);
  }
  return new OpenAIProvider(cfg, tokenResolver);
}

export interface ChatOptions {
  sessionId?: string;
  capabilityType?: ModelCapabilityType;
}

/** Regional variants that share the same model catalog as their parent provider. */
const REGIONAL_PROVIDER_ALIASES: Record<string, string> = {
  'minimax-cn': 'minimax',
  'siliconflow-intl': 'siliconflow',
};

function maskApiKey(key: string): string | undefined {
  if (!key) return undefined;
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

export type ComplexityLevel = 'simple' | 'moderate' | 'complex';

export interface ProviderTier {
  name: string;
  complexity: ComplexityLevel[];
}

const ALL_COMPLEXITY: ComplexityLevel[] = ['simple', 'moderate', 'complex'];

/**
 * Build provider tiers for auto-selection.
 * - The default provider covers all complexity levels (highest priority).
 * - anthropic (when not default) covers complex only — suited for hard reasoning tasks.
 * - openai (when not default) covers complex + moderate.
 * - All other OpenAI-compatible providers (siliconflow, minimax, etc.)
 *   cover simple + moderate when not default.
 */
function buildTiers(providerNames: string[], defaultProvider: string): ProviderTier[] {
  const tiers: ProviderTier[] = [];

  // Default provider always first and covers every complexity level
  if (providerNames.includes(defaultProvider)) {
    tiers.push({ name: defaultProvider, complexity: ALL_COMPLEXITY });
  }

  for (const name of providerNames) {
    if (name === defaultProvider) continue;
    if (name === 'anthropic') {
      tiers.push({ name, complexity: ['complex'] });
    } else if (name === 'openai') {
      tiers.push({ name, complexity: ['complex', 'moderate'] });
    } else {
      // OpenAI-compatible providers (siliconflow, minimax, minimax-cn, etc.)
      tiers.push({ name, complexity: ['simple', 'moderate'] });
    }
  }

  return tiers;
}

interface ModelHealth {
  consecutiveFailures: number;
  lastFailureAt: number;
  degraded: boolean;
  /** Per-entry reset interval; longer for non-retryable (billing/auth) failures */
  resetMs?: number;
}

export class LLMRouter {
  private providers = new Map<string, LLMProviderInterface>();
  private defaultProvider: string;
  private autoSelect = false;
  private providerTiers: ProviderTier[] = [];
  private fallbackOrder: string[] = [];
  /** Off by default: fail loud so users see the real error and switch manually. */
  private _autoFallback = false;
  /** Health tracked per model: key = "providerName:modelId" */
  private modelHealth = new Map<string, ModelHealth>();
  /** Provider-level degradation for non-retryable (auth/billing) errors */
  private providerDegraded = new Map<string, { degraded: boolean; lastFailureAt: number; resetMs: number }>();
  private customModelConfigs = new Map<string, { contextWindow?: number; maxOutputTokens?: number; cost?: ModelCostConfig }>();
  private customModelCatalog = new Map<string, ModelDefinition[]>();
  /**
   * Providers whose `customModelCatalog` entry came from a live model-list
   * discovery call. For those, the discovered list is authoritative for
   * conversational models and the static BUILTIN_MODEL_CATALOG is only merged
   * in for multimodal-only entries (image / TTS / STT / video) that the usual
   * `/models` endpoint does not advertise.
   */
  private liveModelProviders = new Set<string>();
  /** Last successful live discovery per provider (throttles repeat syncs). */
  private liveModelSyncedAt = new Map<string, number>();
  private disabledProviders = new Set<string>();

  /** Per-provider in-flight request counter for concurrency-aware jitter */
  private inFlight = new Map<string, number>();

  private _profileStore?: AuthProfileStore;
  private _oauthManager?: OAuthManager;
  private _modelCatalogService?: ModelCatalogService;

  // -- Model routing config --
  private _capabilityRouting: CapabilityRoutingConfig = {
    assignments: {},
  };
  private _routingDefaultModel?: { provider: string; model: string };
  /** Hub is_default (or first catalog id) from the last Markus catalog refresh. */
  private _markusCatalogPreferredId?: string;
  /**
   * True once a NON-empty Markus Hub catalog has been written to
   * `customModelCatalog`. Used by the async preflight
   * ({@link ensureMarkusCatalogLoaded}) for an O(1) fast path: once the catalog
   * is ready there is no reason to touch the network again on every turn.
   * The synchronous lookups ({@link getModelContextWindow} /
   * {@link getModelMaxOutput}) deliberately do NOT consult this flag — they must
   * stay non-blocking and simply return their documented fallback until a
   * refresh lands.
   */
  private _markusCatalogLoaded = false;
  /**
   * Single-flight guard for {@link refreshMarkusCatalog}: the promise of the one
   * refresh currently in progress. A second caller joins this promise instead of
   * starting a competing fetch, which both de-duplicates the Hub round-trip and
   * serializes the write-back to `customModelCatalog`.
   */
  private _markusCatalogInFlight: Promise<number> | null = null;

  private readonly CIRCUIT_OPEN_AFTER = 2;
  private readonly CIRCUIT_RESET_MS = 5 * 60 * 1000;
  /** Rate-limit (429) failures recover much faster than generic errors */
  private readonly CIRCUIT_RESET_RATE_LIMIT_MS = LLM_CIRCUIT_RESET_RATE_LIMIT_MS;
  /** Non-retryable failures (auth, billing, region) get a longer cooldown */
  private readonly CIRCUIT_RESET_FATAL_MS = 30 * 60 * 1000;

  private logCallback?: (entry: {
    timestamp: string;
    agentId?: string;
    taskId?: string;
    sessionId?: string;
    provider: string;
    model: string;
    messages: Array<{ role: string; content: string }>;
    tools?: Array<{ name: string }>;
    responseContent: string;
    responseToolCalls?: Array<{ name: string; args: string }>;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    finishReason: string;
    cuCost?: number;
  }) => void;

  setLogCallback(cb: typeof this.logCallback): void {
    this.logCallback = cb;
  }

  constructor(defaultProvider?: string) {
    this.defaultProvider = defaultProvider ?? 'anthropic';
  }

  get profileStore(): AuthProfileStore | undefined {
    return this._profileStore;
  }

  get oauthManager(): OAuthManager | undefined {
    return this._oauthManager;
  }

  initOAuth(stateDir?: string): { profileStore: AuthProfileStore; oauthManager: OAuthManager } {
    if (!this._profileStore) {
      this._profileStore = new AuthProfileStore(stateDir);
    }
    if (!this._oauthManager) {
      this._oauthManager = new OAuthManager(this._profileStore);
    }
    return { profileStore: this._profileStore, oauthManager: this._oauthManager };
  }

  /**
   * Register an OpenAI-compatible provider backed by an OAuth auth profile.
   * The provider dynamically resolves its Bearer token from the OAuthManager.
   */
  registerOAuthProvider(name: string, profile: AuthProfile, config?: Partial<LLMProviderConfig>): void {
    if (!this._oauthManager) throw new Error('OAuth not initialized — call initOAuth() first');
    const oauthMgr = this._oauthManager;
    const profileId = profile.id;

    const tokenResolver = async () => oauthMgr.getValidToken(profileId);
    let provider: LLMProviderInterface;

    if (name === 'openai-codex' || profile.provider === 'openai-codex') {
      const providerConfig: LLMProviderConfig = {
        provider: 'openai-codex',
        model: config?.model ?? 'gpt-5.5',
        baseUrl: config?.baseUrl ?? 'https://chatgpt.com/backend-api/codex',
        timeoutMs: config?.timeoutMs,
      };
      provider = new CodexResponsesProvider(
        providerConfig,
        tokenResolver,
        profile.oauth?.accountId,
      );
    } else {
      const providerConfig: LLMProviderConfig = {
        provider: (config?.provider ?? name) as any,
        model: config?.model ?? 'gpt-5.5',
        baseUrl: config?.baseUrl ?? 'https://api.openai.com',
        maxTokens: config?.maxTokens,
        timeoutMs: config?.timeoutMs,
      };
      provider = createOpenAICompatible(
        name,
        { ...providerConfig, provider: name as any },
        tokenResolver,
      );
    }

    this.registerProvider(name, provider);
    log.info(`Registered OAuth-backed provider: ${name}`, { profileId, model: (provider as any).model });
  }

  get defaultProviderName(): string {
    return this.defaultProvider;
  }

  /** Attach provider:model context to an error so upstream loggers can identify the source. */
  private static enrichError(error: unknown, provider: string, model: string): Error {
    const prefix = `[${provider}:${model}]`;
    if (error instanceof Error) {
      if (!error.message.startsWith(prefix)) {
        try {
          error.message = `${prefix} ${error.message}`;
        } catch {
          const wrapped = new Error(`${prefix} ${error.message}`);
          wrapped.stack = error.stack;
          wrapped.cause = error;
          return wrapped;
        }
      }
      return error;
    }
    return new Error(`${prefix} ${String(error)}`);
  }

  /**
   * Detect errors that will never succeed on retry (billing, auth, region restrictions).
   * These should immediately degrade the provider instead of waiting for CIRCUIT_OPEN_AFTER.
   */
  private static isNonRetryableError(error: unknown): boolean {
    // Credit / key-limit exhaustion must NOT degrade the whole provider —
    // multimodal tools still need the configured assignment, and the UI maps
    // CU_EXCEEDED to a recharge hint. Auth/region failures still degrade.
    if (LLMRouter.isCUExceededError(error)) return false;
    const msg = error instanceof Error ? error.message : String(error);
    if (/key limit exceeded|total limit/i.test(msg)) return false;
    return /\b(401|403)\b/.test(msg) ||
      /insufficient balance/i.test(msg) ||
      /not available in your region/i.test(msg) ||
      /invalid.*api.*key/i.test(msg) ||
      /authentication/i.test(msg) ||
      /\b400\b.*invalid_request_error/i.test(msg) ||
      /reasoning_content.*must be passed back/i.test(msg);
  }

  /**
   * Keep a requested model only when it belongs to the target provider.
   * Prevents OpenRouter-style slugs (e.g. `z-ai/glm-5.2`) from being forced onto
   * Ollama/Anthropic/etc. during auto-select or cross-provider fallback.
   */
  private resolveModelForProvider(providerName: string, requestedModel?: string): string | undefined {
    if (!requestedModel) return undefined;
    const provider = this.providers.get(providerName);
    if (!provider) return undefined;

    // Markus / OpenRouter catalogs use vendor/model slugs natively.
    if (providerName === 'markus' || provider instanceof MarkusProvider) return requestedModel;
    if (providerName === 'openrouter') return requestedModel;

    if (provider.model === requestedModel) return requestedModel;

    const catalog = this.getProviderModels(providerName);
    if (catalog.some(m => m.id === requestedModel)) return requestedModel;

    log.warn('Ignoring cross-provider model id', {
      providerName,
      requestedModel,
      using: provider.model || '(provider default)',
    });
    return undefined;
  }

  /** Strip request.model so the target provider uses its own configured model. */
  private requestForProvider(providerName: string, request: LLMRequest, model?: string): LLMRequest {
    const resolved = this.resolveModelForProvider(providerName, model ?? request.model);
    if (resolved) return { ...request, model: resolved };
    if (!request.model) return request;
    const { model: _drop, ...rest } = request;
    return rest;
  }

  /**
   * Prefer the original (primary) failure when fallback only produced a
   * misleading "model not found" from forcing a foreign model id.
   */
  private static preferPrimaryError(primary: unknown, last: unknown): Error {
    const primaryMsg = primary instanceof Error ? primary.message : String(primary);
    const lastMsg = last instanceof Error ? last.message : String(last);
    if (
      primaryMsg &&
      lastMsg !== primaryMsg &&
      (/not available in your region/i.test(primaryMsg) ||
        /\b(401|403)\b/.test(primaryMsg) ||
        /model ['`][^'`]+['`] not found/i.test(lastMsg))
    ) {
      return primary instanceof Error ? primary : new Error(primaryMsg);
    }
    return last instanceof Error ? last : new Error(lastMsg);
  }

  /** Detect rate-limit (429) errors which should use a shorter circuit breaker cooldown. */
  private static isRateLimitError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return /\b429\b/.test(msg) || /rate.limit/i.test(msg);
  }

  /** Detect CU-exhausted errors — return friendly error, do NOT fall back to direct mode. */
  static isCUExceededError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return msg.includes('CU_EXCEEDED:')
      || msg.includes('CU_MONTHLY_EXCEEDED')
      || /key limit exceeded|total limit/i.test(msg);
  }

  /** Detect Markus-specific rate limit or 5h window exceeded (separate from generic 429). */
  static isMarkusRateLimited(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return msg.includes('MARKUS_RATE_LIMITED:') || msg.includes('CU_WINDOW_EXCEEDED:');
  }

  /**
   * Apply random jitter when a provider has many concurrent in-flight requests.
   * Spreads burst traffic to avoid thundering-herd 429 cascades.
   */
  private async applyJitter(providerName: string): Promise<void> {
    const current = this.inFlight.get(providerName) ?? 0;
    if (current >= LLM_MAX_CONCURRENT_PER_PROVIDER) {
      const jitter = Math.round(LLM_CONCURRENCY_JITTER_BASE_MS + Math.random() * LLM_CONCURRENCY_JITTER_BASE_MS * 2);
      await new Promise(r => setTimeout(r, jitter));
    }
    this.inFlight.set(providerName, (this.inFlight.get(providerName) ?? 0) + 1);
  }

  private releaseInflight(providerName: string): void {
    const current = this.inFlight.get(providerName) ?? 0;
    this.inFlight.set(providerName, Math.max(0, current - 1));
  }

  private static healthKey(provider: string, model: string): string {
    return `${provider}:${model}`;
  }

  private getModelHealth(provider: string, model: string): ModelHealth {
    const key = LLMRouter.healthKey(provider, model);
    if (!this.modelHealth.has(key)) {
      this.modelHealth.set(key, { consecutiveFailures: 0, lastFailureAt: 0, degraded: false });
    }
    return this.modelHealth.get(key)!;
  }

  private recordSuccess(provider: string, model: string): void {
    const h = this.getModelHealth(provider, model);
    h.consecutiveFailures = 0;
    h.degraded = false;
  }

  private recordFailure(provider: string, model: string, error?: unknown): void {
    const fatal = LLMRouter.isNonRetryableError(error);

    if (fatal) {
      const pd = this.providerDegraded.get(provider);
      if (!pd?.degraded) {
        this.providerDegraded.set(provider, { degraded: true, lastFailureAt: Date.now(), resetMs: this.CIRCUIT_RESET_FATAL_MS });
        log.warn(`Provider ${provider} immediately degraded (non-retryable auth/billing error) — skipping for ${this.CIRCUIT_RESET_FATAL_MS / 60000} min`);
      }
      return;
    }

    const isRateLimit = LLMRouter.isRateLimitError(error);
    const h = this.getModelHealth(provider, model);
    h.consecutiveFailures++;
    h.lastFailureAt = Date.now();

    if (h.consecutiveFailures >= this.CIRCUIT_OPEN_AFTER && !h.degraded) {
      h.degraded = true;
      h.resetMs = isRateLimit ? this.CIRCUIT_RESET_RATE_LIMIT_MS : this.CIRCUIT_RESET_MS;
      const cooldownSec = h.resetMs / 1000;
      log.warn(`Model ${provider}:${model} marked as degraded after ${h.consecutiveFailures} failures (${isRateLimit ? 'rate-limit' : 'error'}) — skipping for ${cooldownSec}s`);
    }
  }

  /** Check if a specific model on a provider is available */
  private isModelAvailable(provider: string, model: string): boolean {
    if (this.disabledProviders.has(provider)) return false;

    const pd = this.providerDegraded.get(provider);
    if (pd?.degraded) {
      if (Date.now() - pd.lastFailureAt > pd.resetMs) {
        log.info(`Provider ${provider} circuit reset — will retry`);
        pd.degraded = false;
      } else {
        return false;
      }
    }

    const h = this.getModelHealth(provider, model);
    if (!h.degraded) return true;
    const resetMs = h.resetMs ?? this.CIRCUIT_RESET_MS;
    if (Date.now() - h.lastFailureAt > resetMs) {
      log.info(`Model ${provider}:${model} circuit reset — will retry`);
      h.degraded = false;
      h.consecutiveFailures = 0;
      return true;
    }
    return false;
  }

  /** Check if a provider has at least one available model (for tier selection) */
  private isAvailable(name: string): boolean {
    if (this.disabledProviders.has(name)) return false;

    const pd = this.providerDegraded.get(name);
    if (pd?.degraded) {
      if (Date.now() - pd.lastFailureAt > pd.resetMs) {
        pd.degraded = false;
      } else {
        return false;
      }
    }

    const provider = this.providers.get(name);
    if (!provider) return false;

    if (this.isModelAvailable(name, provider.model)) return true;

    const catalog = this.getProviderModels(name);
    return catalog.some(m => m.id !== provider.model && this.isModelAvailable(name, m.id));
  }

  /** Get all model definitions for a provider (builtin + custom), enriched with live catalog pricing */
  private getProviderModels(providerName: string): ModelDefinition[] {
    // Markus Provider: once the Hub geo-aware OR catalog is loaded, it is the
    // sole source of truth (OpenRouter slugs). Bare markus-* aliases are obsolete.
    if (providerName === 'markus') {
      const hubModels = this.customModelCatalog.get('markus') ?? [];
      if (hubModels.length > 0) {
        return hubModels.map(m => this.enrichModelFromCatalog(m));
      }
    }
    // Ollama: prefer locally-discovered models (pulled images) over the static
    // builtin catalog. If the local service hasn't been probed yet (catalog
    // empty), fall back to the builtin catalog so the picker is never empty.
    if (providerName === 'ollama') {
      const localModels = this.customModelCatalog.get('ollama');
      if (localModels && localModels.length > 0) {
        return localModels.map(m => this.enrichModelFromCatalog(m));
      }
    }

    // Live-discovered providers: the provider's own list is authoritative for
    // conversational models, so we never fall back to the static catalog's
    // guessed ids for them (that is the whole point of discovery).
    if (this.liveModelProviders.has(providerName)) {
      const live = this.customModelCatalog.get(providerName);
      if (live && live.length > 0) {
        return live.map(m => this.enrichModelFromCatalog({ ...m, source: 'live' as const }));
      }
    }

    let builtinModels = BUILTIN_MODEL_CATALOG.filter(m => m.provider === providerName);
    // For regional aliases, inherit the parent provider's catalog with provider field swapped
    if (builtinModels.length === 0 && REGIONAL_PROVIDER_ALIASES[providerName]) {
      const parent = REGIONAL_PROVIDER_ALIASES[providerName];
      builtinModels = BUILTIN_MODEL_CATALOG.filter(m => m.provider === parent)
        .map(m => ({ ...m, provider: providerName }));
    }
    const customModels = this.customModelCatalog.get(providerName) ?? [];
    const merged = [...builtinModels, ...customModels.filter(cm => !builtinModels.some(bm => bm.id === cm.id))];
    // The static table above carries only non-discoverable entries (media models
    // and OAuth-only Codex), so a chat provider whose listing has not been
    // fetched yet — no key, offline, or first run — would otherwise render an
    // empty picker. Seed it with the registry's documented bootstrap model and
    // label it 'builtin' so the UI says where it came from.
    const hasChatModel = merged.some(m => isChatCapableModel(m) && m.contextWindow > 0);
    if (!hasChatModel) {
      const bootstrapId = getProviderBootstrapModel(providerName);
      if (bootstrapId && !merged.some(m => m.id === bootstrapId)) {
        merged.push({
          id: bootstrapId,
          name: bootstrapId,
          provider: providerName,
          contextWindow: 0,
          maxOutputTokens: 0,
          cost: { input: 0, output: 0 },
          source: 'builtin',
        });
      }
    }
    // Offline / pre-discovery path: everything here comes from Markus' own
    // metadata table, so it is 'builtin'. The live listing is authoritative and
    // overrides this as soon as it has been fetched once.
    return merged.map(m => this.enrichModelFromCatalog({ ...m, source: m.source ?? ('builtin' as const) }));
  }

  /**
   * Fetch the Hub-served OR model catalog into the Markus provider's picker.
   * Keeps the current active model when it still exists in the catalog;
   * only when the active model is missing/obsolete does it fall back to Hub default.
   *
   * Single-flight: while a refresh is in flight, concurrent callers — the
   * fire-and-forget refresh kicked off at provider-registration time, the
   * Settings warm-up, and the per-turn preflight — join the SAME promise
   * instead of starting a second Hub round-trip. Besides de-duplicating the
   * (relatively expensive) fetch, this serializes the write-back to
   * `customModelCatalog`, so two overlapping refreshes can no longer interleave
   * and clobber each other's result.
   */
  async refreshMarkusCatalog(): Promise<number> {
    if (this._markusCatalogInFlight) return this._markusCatalogInFlight;
    const flight = this.loadMarkusCatalog();
    this._markusCatalogInFlight = flight;
    try {
      return await flight;
    } finally {
      // Only the owner clears the slot; joiners merely awaited the shared promise.
      if (this._markusCatalogInFlight === flight) this._markusCatalogInFlight = null;
    }
  }

  /** Actual Hub fetch + write-back. Always reached through the single-flight wrapper. */
  private async loadMarkusCatalog(): Promise<number> {
    const provider = this.providers.get('markus');
    if (!(provider instanceof MarkusProvider)) return 0;

    clearMarkusModelListCache();
    const models = await provider.fetchModels();
    const defs: ModelDefinition[] = models.map(m => {
      const caps = m.capabilities ?? [];
      const hasVision = m.supports_vision || caps.includes('vision')
        || (m.input_modalities?.includes('image') ?? false);
      return {
        id: m.id,
        name: m.display_name || m.id,
        provider: 'markus',
        contextWindow: m.context_window,
        maxOutputTokens: m.max_output_tokens,
        cost: { input: 0, output: 0 },
        reasoning: m.supports_reasoning,
        inputTypes: hasVision ? ['text', 'image'] as Array<'text' | 'image'> : ['text' as const],
        capabilities: caps.length > 0
          ? caps
          : (hasVision ? ['vision'] : undefined),
        tier: m.tier === 'flash' || m.tier === 'base' ? 'base'
          : m.tier === 'pro' ? 'pro'
          : m.tier === 'premium' || m.tier === 'high' || m.tier === 'max' ? 'max'
          : 'pro',
        description: m.display_name,
        route: m.route === 'openrouter' ? m.route : undefined,
      };
    });

    if (defs.length === 0) {
      // Never overwrite a previously loaded catalog with an empty one (Hub
      // disconnect / transient empty response). Keep the last-good state so the
      // runtime keeps working until the Hub is reachable again.
      log.warn('Markus Hub catalog returned 0 models — keeping previously loaded catalog intact.');
      return this.customModelCatalog.get('markus')?.length ?? 0;
    }

    this.customModelCatalog.set('markus', defs);
    this._markusCatalogLoaded = true;

    const ids = new Set(defs.map(d => d.id));
    const preferred = models.find(m => m.is_default)?.id ?? defs[0]!.id;
    this._markusCatalogPreferredId = preferred;
    const healed = this.healMarkusRoutingAgainstCatalog(ids, preferred);
    if (healed) {
      log.info('Markus routing healed from Hub catalog', {
        activeModel: provider.model,
        routingDefaultModel: this._routingDefaultModel,
        count: defs.length,
      });
    } else {
      log.info('Markus Hub catalog refreshed', { model: provider.model, count: defs.length });
    }
    return defs.length;
  }

  /** True once a NON-empty Markus Hub catalog has been loaded successfully. */
  isMarkusCatalogLoaded(): boolean {
    return this._markusCatalogLoaded;
  }

  /**
   * Await Markus Hub catalog readiness. This is the async half of the cold-start
   * fix: the context-window / max-output lookups stay SYNCHRONOUS (their callers
   * do not await), so they cannot block on the network, and instead return their
   * documented fallback until a catalog lands. The "wait for readiness" work is
   * therefore pushed here, into an async PREFLIGHT that runs before the packing
   * budget is derived — so the turn that triggers the load already sees the real
   * Hub values.
   *
   * Contract:
   *   - already loaded (and not `force`)  → O(1) return, no network.
   *   - otherwise race the single-flight refresh against a bounded timeout
   *     (default 3000ms).
   *   - ALL failures — Hub unreachable, malformed payload, timeout — are
   *     swallowed with a warn. This method NEVER rejects, so a cold/offline Hub
   *     can never abort an agent turn; the sync lookups just use their fallback
   *     until a later refresh succeeds.
   */
  async ensureMarkusCatalogLoaded(opts?: { timeoutMs?: number; force?: boolean }): Promise<void> {
    if (this._markusCatalogLoaded && !opts?.force) return;
    const timeoutMs = opts?.timeoutMs ?? 3000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.refreshMarkusCatalog(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`markus catalog load timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } catch (err) {
      log.warn('Markus catalog not ready before budget planning — using fallback values', {
        error: String(err),
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Probe a local Ollama server (/api/tags) and record the actually-pulled
   * models into the provider's custom catalog. This makes local models appear
   * in both the Settings panel and the chat model picker (which both read
   * getEnhancedSettings / getProviderModels). On success the local list
   * REPLACES the static catalog for Ollama (only real models are usable).
   * On failure we keep any previously-cached local models (last-good), so a
   * transient Ollama stop does not wipe the picker.
   */
  async refreshOllamaLocalModels(baseUrl?: string): Promise<number> {
    const provider = this.providers.get('ollama');
    const effectiveBase =
      baseUrl
      ?? (provider as any)?.baseUrl
      ?? process.env['OLLAMA_BASE_URL']
      ?? 'http://localhost:11434';
    const base = String(effectiveBase).replace(/\/+$/, '');
    try {
      const ctrl = new AbortController();
      const tmr = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${base}/api/tags`, {
        signal: ctrl.signal,
      });
      clearTimeout(tmr);
      if (!res.ok) {
        log.warn('Ollama /api/tags HTTP error', { baseUrl: base, status: res.status });
        return this.customModelCatalog.get('ollama')?.length ?? 0;
      }
      const data = await res.json() as {
        models?: Array<{
          name: string;
          details?: { parameter_size?: string; family?: string; quantization_level?: string };
        }>;
      };
      const models: ModelDefinition[] = await Promise.all((data.models ?? []).map(async m => {
        const d = m.details;
        const tag = d?.parameter_size || d?.quantization_level;
        const info = await this.probeOllamaModel(base, m.name);
        const caps = info.capabilities;
        const hasVision = caps.includes('vision');
        const hasReasoning = caps.includes('thinking');
        return {
          id: m.name,
          name: m.name,
          provider: 'ollama',
          contextWindow: info.contextWindow,
          maxOutputTokens: OLLAMA_DEFAULT_MAX_OUTPUT,
          cost: { input: 0, output: 0 },
          reasoning: hasReasoning || undefined,
          inputTypes: hasVision ? ['text', 'image'] as Array<'text' | 'image'> : ['text' as const],
          capabilities: caps.length > 0 ? caps : undefined,
          description: tag ? tag : undefined,
        };
      }));
      this.customModelCatalog.set('ollama', models);
      log.info(`Synced ${models.length} local Ollama models`, { baseUrl: base });
      return models.length;
    } catch (err) {
      log.warn('Ollama local model sync failed', { error: String(err), baseUrl: base });
      return this.customModelCatalog.get('ollama')?.length ?? 0;
    }
  }

  /**
   * Probe a local Ollama model's real context length and capabilities via `/api/show`.
   * Reads `model_info["*.context_length"]` (key name varies by model family,
   * e.g. `llama.context_length`, `qwen3_5.context_length`) for the context window,
   * plus the top-level `capabilities` array (e.g. `['completion','vision','tools','thinking']`)
   * for multimodal / function-calling / reasoning support. Falls back to a sane
   * default so a probe failure never blocks agent budget planning.
   */
  private async probeOllamaModel(base: string, modelId: string): Promise<{ contextWindow: number; capabilities: string[] }> {
    try {
      const ctrl = new AbortController();
      const tmr = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(`${base}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId }),
        signal: ctrl.signal,
      });
      clearTimeout(tmr);
      if (!res.ok) return { contextWindow: OLLAMA_DEFAULT_CONTEXT_WINDOW, capabilities: [] };
      const data = await res.json() as { model_info?: Record<string, unknown>; capabilities?: string[] };
      const vals = Object.entries(data.model_info ?? {})
        .filter(([k]) => k.toLowerCase().includes('context_length'))
        .map(([, v]) => Number(v))
        .filter(n => Number.isFinite(n) && n > 0);
      const ctx = vals.length ? Math.max(...vals) : 0;
      const capabilities = Array.isArray(data.capabilities) ? data.capabilities : [];
      if (ctx > 0) log.info(`Ollama local model ${modelId}: context_window=${ctx}, capabilities=${capabilities.join(',')}`);
      return {
        contextWindow: ctx > 0 ? ctx : OLLAMA_DEFAULT_CONTEXT_WINDOW,
        capabilities,
      };
    } catch {
      return { contextWindow: OLLAMA_DEFAULT_CONTEXT_WINDOW, capabilities: [] };
    }
  }

  /**
   * Pull a live /v1/models list for an OpenAI-compatible provider into its
   * custom catalog. Used for newly-added providers that have no builtin entry
   * (and therefore would otherwise show zero models in pickers). If the
   * provider already has a usable catalog (builtin/custom) we skip the call.
   */
  async refreshProviderLiveModels(
    providerName: string,
    baseUrl?: string,
    apiKey?: string,
    opts?: { force?: boolean },
  ): Promise<number> {
    // Markus Cloud models come from the Hub catalog (Hub owns the upstream key
    // and the geo filtering) — never from an OpenAI-compatible /models call.
    if (providerName === 'markus') return 0;
    // Ollama has no /v1/models; its own list is /api/tags (+ /api/show probing).
    if (providerName === 'ollama') return this.refreshOllamaLocalModels(baseUrl);

    const provider = this.providers.get(providerName);
    const configuredBase =
      baseUrl
      ?? (provider as any)?.baseUrl
      ?? PROVIDER_DEFAULT_BASE_URLS[providerName];
    if (!configuredBase) return 0;

    // A recent successful sync is reused — unless the caller forces a refresh
    // (settings "reload models"). Keeps every settings render from hitting the
    // network while still letting a new model appear without a restart.
    const lastSync = this.liveModelSyncedAt.get(providerName) ?? 0;
    if (
      !opts?.force
      && this.liveModelProviders.has(providerName)
      && Date.now() - lastSync < LIVE_MODEL_SYNC_TTL_MS
    ) {
      return this.customModelCatalog.get(providerName)?.length ?? 0;
    }

    // Only this provider's own credential is ever sent. The provider instance
    // resolves its key from its own config (a user-supplied endpoint must never
    // receive an unrelated env key such as OPENAI_API_KEY).
    const effectiveKey = String(apiKey ?? (provider as any)?.apiKey ?? '').trim();

    try {
      const discovered = await discoverProviderModels({
        provider: providerName,
        baseUrl: configuredBase,
        apiKey: effectiveKey,
      });

      if (discovered.length === 0) {
        log.warn(`Live model list for ${providerName} returned no usable models — keeping previous list`, {
          baseUrl: configuredBase,
        });
        return this.customModelCatalog.get(providerName)?.length ?? 0;
      }

      const defs: ModelDefinition[] = discovered.map(m => ({
        id: m.id,
        name: m.name ?? m.id,
        provider: providerName,
        contextWindow: m.contextWindow ?? 0,
        maxOutputTokens: m.maxOutputTokens ?? 0,
        cost: { input: 0, output: 0 },
        reasoning: m.reasoning || undefined,
        inputTypes: m.vision
          ? (['text', 'image'] as Array<'text' | 'image'>)
          : (['text'] as Array<'text' | 'image'>),
      }));

      this.customModelCatalog.set(providerName, this.withBuiltinMediaModels(providerName, defs));
      this.liveModelProviders.add(providerName);
      this.liveModelSyncedAt.set(providerName, Date.now());
      log.info(`Synced ${defs.length} live models for provider ${providerName}`, {
        baseUrl: configuredBase,
      });
      return defs.length;
    } catch (err) {
      // Keep the last-known-good list: an offline provider or a bad key must
      // not empty the picker.
      log.warn(`Live model sync failed for provider ${providerName}`, {
        error: String(err),
        baseUrl: configuredBase,
      });
      return this.customModelCatalog.get(providerName)?.length ?? 0;
    }
  }

  /**
   * Merge the curated multimodal-only builtin entries (image / TTS / STT /
   * video) into a live-discovered list.
   *
   * Those models are served from side endpoints and are usually absent from
   * `/models`, but the builtin entries we ship for them are hand-checked, so
   * keeping them alongside the live chat list preserves multimodal routing
   * without resurrecting the guessed conversational ids.
   */
  private withBuiltinMediaModels(providerName: string, live: ModelDefinition[]): ModelDefinition[] {
    const byId = new Map(live.map(m => [m.id, m]));
    const builtinFamily = BUILTIN_MODEL_CATALOG.filter(m => m.provider === providerName);
    const aliasParent = REGIONAL_PROVIDER_ALIASES[providerName];
    if (aliasParent) {
      for (const m of BUILTIN_MODEL_CATALOG.filter(x => x.provider === aliasParent)) {
        builtinFamily.push({ ...m, provider: providerName });
      }
    }
    for (const m of builtinFamily) {
      const isMediaOnly = (m.capabilities?.length ?? 0) > 0 && !(m.contextWindow > 0);
      // Media models (image / TTS / STT / video) are served from separate
      // endpoints and never appear in a /models listing, so they remain
      // 'builtin' — the one place where the static table is still the source.
      if (isMediaOnly && !byId.has(m.id)) byId.set(m.id, { ...m, provider: providerName, source: 'builtin' });
    }
    // Everything else came from the provider's own listing.
    for (const [id, m] of byId) {
      if (!m.source) byId.set(id, { ...m, source: 'live' });
    }
    return [...byId.values()];
  }

  /**
   * Drop sticky Markus defaults that are no longer in the Hub catalog
   * (e.g. CN geo-filter removes anthropic/claude-opus-5 while chip still shows it).
   * Returns true when active model and/or routingDefaultModel were rewritten.
   */
  healMarkusRoutingAgainstCatalog(ids?: Set<string>, preferred?: string): boolean {
    const provider = this.providers.get('markus');
    if (!provider) return false;

    const catalogIds = ids ?? new Set((this.customModelCatalog.get('markus') ?? []).map(d => d.id));
    if (catalogIds.size === 0) return false;

    const fallback = preferred
      ?? this._markusCatalogPreferredId
      ?? (this.customModelCatalog.get('markus') ?? [])[0]?.id;
    if (!fallback) return false;

    let healed = false;
    const activeObsolete = isObsoleteMarkusModel(provider.model) || !catalogIds.has(provider.model);
    if (activeObsolete) {
      provider.configure({ provider: 'markus', model: fallback });
      healed = true;
    }

    const rdm = this._routingDefaultModel;
    if (
      rdm
      && rdm.provider === 'markus'
      && (isObsoleteMarkusModel(rdm.model) || !catalogIds.has(rdm.model))
    ) {
      this._routingDefaultModel = { provider: 'markus', model: fallback };
      healed = true;
    }

    return healed;
  }

  /**
   * Overlay live pricing from ModelCatalogService onto a builtin model definition.
   * The catalog (from LiteLLM) is refreshed every 24h so prices stay current.
   */
  private enrichModelFromCatalog(model: ModelDefinition): ModelDefinition {
    const service = this._modelCatalogService;
    if (!service) return model;
    // Try exact ID, then provider-prefixed ID
    const catalogEntry = service.getModelInfo(model.id)
      ?? service.getModelInfo(`${model.provider}/${model.id}`);
    if (!catalogEntry) return model;

    const hasPricing = catalogEntry.inputCostPer1MTokens > 0 || catalogEntry.outputCostPer1MTokens > 0;
    // Capability flags come from the maintained catalog as well. The static
    // metadata table no longer carries conversational models, so vision /
    // reasoning support has to be resolved from here rather than from a
    // hand-written id list that goes stale every release.
    const caps = catalogEntry.capabilities;
    const isChatModel = isChatCapableModel(model);
    const inputTypes = isChatModel && caps
      ? (caps.vision ? (['text', 'image'] as Array<'text' | 'image'>) : (['text'] as Array<'text' | 'image'>))
      : undefined;

    if (!hasPricing && !inputTypes && !catalogEntry.maxInputTokens) return model;

    return {
      ...model,
      contextWindow: catalogEntry.maxInputTokens || model.contextWindow,
      maxOutputTokens: catalogEntry.maxOutputTokens || model.maxOutputTokens,
      reasoning: isChatModel ? (caps?.reasoning ?? model.reasoning) : model.reasoning,
      inputTypes: inputTypes ?? model.inputTypes,
      cost: hasPricing ? {
        input: catalogEntry.inputCostPer1MTokens || model.cost?.input || 0,
        output: catalogEntry.outputCostPer1MTokens || model.cost?.output || 0,
        cacheRead: catalogEntry.cacheReadCostPer1MTokens ?? model.cost?.cacheRead,
        cacheWrite: catalogEntry.cacheWriteCostPer1MTokens ?? model.cost?.cacheWrite,
      } : model.cost,
    };
  }

  /**
   * Try alternate models on the same provider when the active model is degraded.
   * Returns the model ID to use, or null if no healthy alternative exists.
   */
  private findHealthyModel(providerName: string): string | null {
    const provider = this.providers.get(providerName);
    if (!provider) return null;

    if (this.isModelAvailable(providerName, provider.model)) return provider.model;

    const catalog = this.getProviderModels(providerName);
    for (const m of catalog) {
      if (m.id !== provider.model && this.isModelAvailable(providerName, m.id)) {
        log.info(`Model ${providerName}:${provider.model} degraded, trying alternate model: ${m.id}`);
        return m.id;
      }
    }
    return null;
  }

  registerProvider(name: string, provider: LLMProviderInterface): void {
    this.providers.set(name, provider);
    log.info(`Registered LLM provider: ${name}`, { model: provider.model });
  }

  unregisterProvider(name: string): void {
    this.providers.delete(name);
    for (const key of this.modelHealth.keys()) {
      if (key.startsWith(`${name}:`)) this.modelHealth.delete(key);
    }
    this.providerDegraded.delete(name);
    this.customModelConfigs.delete(name);
    this.disabledProviders.delete(name);
    log.info(`Unregistered LLM provider: ${name}`);

    if (this.defaultProvider === name) {
      const remaining = this.listProviders();
      this.defaultProvider = remaining[0] ?? 'anthropic';
    }
    this.refreshTiers();
  }

  /**
   * Create and register a provider from config at runtime.
   * Uses the appropriate provider class based on the name.
   */
  registerProviderFromConfig(name: string, config: LLMProviderConfig): void {
    let provider: LLMProviderInterface;
    if (name === 'anthropic') {
      provider = new AnthropicProvider(config);
    } else if (name === 'google') {
      provider = new GoogleProvider(config);
    } else if (name === 'ollama') {
      provider = new OllamaProvider(config);
    } else if (name === 'markus') {
      provider = new MarkusProvider(config);
    } else {
      provider = createOpenAICompatible(name, config);
    }
    this.registerProvider(name, provider);
    this.refreshTiers();
    if (name === 'markus') {
      void this.refreshMarkusCatalog().catch(err =>
        log.warn('Failed to refresh Markus Hub catalog after register', { error: String(err) }),
      );
    }
  }

  private refreshTiers(): void {
    const providerNames = this.listProviders();
    if (providerNames.length > 1) {
      this.autoSelect = true;
      this.providerTiers = buildTiers(providerNames, this.defaultProvider);
      this.fallbackOrder = [this.defaultProvider, ...providerNames.filter(n => n !== this.defaultProvider)];
    } else {
      this.autoSelect = false;
      this.providerTiers = [];
      this.fallbackOrder = [];
    }
  }

  addCustomModel(providerName: string, model: ModelDefinition): void {
    if (!model.id) {
      log.warn(`Skipping custom model with missing id for provider ${providerName}`);
      return;
    }
    const existing = this.customModelCatalog.get(providerName) ?? [];
    const filtered = existing.filter(m => m.id !== model.id);
    filtered.push(model);
    this.customModelCatalog.set(providerName, filtered);
    log.info(`Added custom model ${model.id} for provider ${providerName}`);
  }

  removeCustomModel(providerName: string, modelId: string): void {
    const existing = this.customModelCatalog.get(providerName);
    if (!existing) return;
    this.customModelCatalog.set(providerName, existing.filter(m => m.id !== modelId));
    log.info(`Removed custom model ${modelId} from provider ${providerName}`);
  }

  /** Get CU quota info from the Markus provider (if available). */
  getMarkusQuotaInfo(): {
    cuCost: number;
    cuRemaining: number;
    cuLimit: number;
    totalCuUsed: number;
    cuUsedToday: number;
    lastCuCost: number;
  } | null {
    const provider = this.providers.get('markus');
    if (provider && 'getCuUsageStats' in provider) {
      const stats = (provider as MarkusProvider).getCuUsageStats();
      return {
        cuCost: stats.lastCuCost,
        cuRemaining: stats.cuRemaining,
        cuLimit: stats.cuLimit,
        totalCuUsed: stats.totalCuUsed,
        cuUsedToday: stats.cuUsedToday,
        lastCuCost: stats.lastCuCost,
      };
    }
    return null;
  }

  /**
   * Soft-stop hint from Hub plan remaining CU (entitlement − ledger).
   * Propagated to MarkusProvider; 0 blocks new chat locally.
   */
  setMarkusHubRemainingHint(remaining: number | null): void {
    // Keep search-tool priority in sync (web_search reads MARKUS_CU_REMAINING).
    if (remaining === null || remaining === undefined) {
      delete process.env['MARKUS_CU_REMAINING'];
    } else {
      process.env['MARKUS_CU_REMAINING'] = String(Math.max(0, Math.floor(remaining)));
    }
    const provider = this.providers.get('markus');
    if (provider instanceof MarkusProvider) {
      provider.setHubRemainingHint(remaining);
    }
  }

  /** Get cumulative CU usage stats from the Markus provider. */
  getMarkusCuUsage(): {
    totalCuUsed: number;
    cuUsedToday: number;
    cuRemaining: number;
    cuLimit: number;
    lastCuCost: number;
  } | null {
    const provider = this.providers.get('markus');
    if (provider && 'getCuUsageStats' in provider) {
      return (provider as MarkusProvider).getCuUsageStats();
    }
    return null;
  }

  enableAutoSelect(tiers?: ProviderTier[]): void {
    this.autoSelect = true;
    if (tiers) {
      this.providerTiers = tiers;
    }
  }

  setFallbackOrder(order: string[]): void {
    this.fallbackOrder = order.filter(n => this.providers.has(n));
  }

  get autoFallback(): boolean { return this._autoFallback; }
  setAutoFallback(enabled: boolean): void { this._autoFallback = enabled; }

  static assessComplexity(request: LLMRequest): ComplexityLevel {
    const totalChars = request.messages.reduce((s, m) => s + getTextContent(m.content).length, 0);
    const toolCount = request.tools?.length ?? 0;
    const msgCount = request.messages.length;

    if (toolCount > 5 || totalChars > 8000 || msgCount > 15) return 'complex';
    if (toolCount > 0 || totalChars > 2000 || msgCount > 5) return 'moderate';
    return 'simple';
  }

  /**
   * Infer the capability type from a request based on tools, keywords, and context.
   */
  static inferCapability(request: LLMRequest): ModelCapabilityType {
    const hasImage = request.messages.some(m =>
      Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'),
    );
    if (hasImage) return 'image_recognition';
    return 'text';
  }

  // ---------------------------------------------------------------------------
  // Routing config
  // ---------------------------------------------------------------------------

  get routingDefaultModel(): { provider: string; model: string } | undefined { return this._routingDefaultModel; }

  setRoutingDefaultModel(defaultModel?: { provider: string; model: string }): void {
    this._routingDefaultModel = defaultModel;
    if (defaultModel) {
      log.info('Routing default model set', defaultModel);
    }
  }

  setModelCatalogService(service: ModelCatalogService): void {
    this._modelCatalogService = service;
  }

  get capabilityRouting(): CapabilityRoutingConfig { return this._capabilityRouting; }

  setCapabilityRouting(config: Partial<CapabilityRoutingConfig>): void {
    // Derived from the canonical list in @markus/shared. Do NOT re-list the
    // capabilities here: this hardcoded copy previously omitted `decision`, so
    // routing assignments for it were silently dropped on the floor.
    const VALID_CAPABILITY_TYPES: ReadonlySet<string> = new Set<string>(MODEL_CAPABILITY_TYPES);

    // Drop already-persisted junk keys (e.g. literal "undefined" from bad tool calls).
    const base: CapabilityRoutingConfig['assignments'] = {};
    for (const [key, val] of Object.entries(this._capabilityRouting.assignments)) {
      if (VALID_CAPABILITY_TYPES.has(key)) {
        base[key as ModelCapabilityType] = val;
      } else {
        log.warn('Dropping invalid capability type from existing routing', { capabilityType: key });
      }
    }

    const incoming = config.assignments ?? {};
    const cleaned: CapabilityRoutingConfig['assignments'] = {};
    for (const [key, val] of Object.entries(incoming)) {
      if (VALID_CAPABILITY_TYPES.has(key)) {
        cleaned[key as ModelCapabilityType] = val;
      } else {
        log.warn('Ignoring invalid capability type in routing assignment', { capabilityType: key });
      }
    }

    this._capabilityRouting = { assignments: { ...base, ...cleaned } };
    log.info('Capability routing updated', { assignments: Object.keys(this._capabilityRouting.assignments) });
  }

  /**
   * Look up the routing assignment for a specific capability type.
   * Returns the assignment if set, else undefined (falls through to default model).
   */
  getCapabilityAssignment(capabilityType: ModelCapabilityType): CapabilityModelAssignment | undefined {
    return this._capabilityRouting.assignments[capabilityType];
  }

  /**
   * Select a provider+model for a given capability type.
   * Pure lookup: explicit assignment -> default model -> any available provider.
   */
  selectForCapability(capabilityType: ModelCapabilityType, request: LLMRequest, _sessionId?: string): { provider: string; model?: string } {
    // Enabled in Settings (not merely circuit-healthy). Circuit-degraded providers
    // are still returned so the real upstream error surfaces instead of a silent switch.
    const isEnabled = (name: string) => this.providers.has(name) && !this.disabledProviders.has(name);

    // 1. Check explicit assignment
    const assignment = this._capabilityRouting.assignments[capabilityType];
    if (assignment) {
      if (isEnabled(assignment.provider)) {
        return { provider: assignment.provider, model: assignment.model };
      }
      if (this._autoFallback && assignment.fallback && isEnabled(assignment.fallback.provider)) {
        log.warn(`Capability ${capabilityType} primary ${assignment.provider} unavailable, using fallback`);
        return { provider: assignment.fallback.provider, model: assignment.fallback.model };
      }
      log.warn(`Capability ${capabilityType} assignment ${assignment.provider} unavailable, falling through to default`);
    }

    // 2. Routing default model (honor even when circuit-degraded)
    if (this._routingDefaultModel && isEnabled(this._routingDefaultModel.provider)) {
      return { provider: this._routingDefaultModel.provider, model: this._routingDefaultModel.model };
    }

    // 3. Last resort: any provider
    return { provider: this.selectProvider(request) };
  }

  /**
   * Resolve a provider instance for a non-text modality (image_generation, audio_tts, etc.).
   * Returns the provider and the assigned model name WITHOUT mutating provider state.
   * The caller is responsible for passing `model` into the API call options.
   *
   * For non-text capabilities this NEVER falls back to the global text routing
   * default model id (deepseek/gpt-4o/…): posting a chat id to an image/tts/stt
   * endpoint yields a confusing upstream 404 ("model not found" / "not served for
   * this capability"). Unassigned capabilities resolve to the provider only; the
   * provider's own modality-appropriate default (or an explicit per-call model)
   * is used instead.
   */
  resolveModalityProvider(capabilityType: ModelCapabilityType): { provider: MultiModalProviderInterface; model?: string } | undefined {
    const isText = capabilityType === 'text';
    const assignment = this._capabilityRouting.assignments[capabilityType];
    if (assignment) {
      const provider = this.providers.get(assignment.provider);
      if (provider && this.isAvailable(assignment.provider)) {
        return { provider: provider as MultiModalProviderInterface, model: assignment.model };
      }
      if (assignment.fallback) {
        const fallbackProvider = this.providers.get(assignment.fallback.provider);
        if (fallbackProvider && this.isAvailable(assignment.fallback.provider)) {
          return { provider: fallbackProvider as MultiModalProviderInterface, model: assignment.fallback.model };
        }
      }
    }

    // Fallback: try routingDefaultModel, then defaultProvider. Only text routing
    // carries the default text model id; non-text capabilities must NOT reuse it
    // (see class doc above) — except when the routing default model provably
    // serves the capability (declared in its catalog entry), so a sensible
    // media default like "image-01" still resolves instead of posting a chat id
    // like "deepseek/deepseek-v4-flash-0731" to an image endpoint (upstream 404).
    if (this._routingDefaultModel) {
      const p = this.providers.get(this._routingDefaultModel.provider);
      if (p && this.isAvailable(this._routingDefaultModel.provider)) {
        const model = isText || this.routingDefaultModelServesCapability(capabilityType)
          ? this._routingDefaultModel.model
          : undefined;
        return { provider: p as MultiModalProviderInterface, ...(model ? { model } : {}) };
      }
    }
    const p = this.providers.get(this.defaultProvider);
    return p && this.isAvailable(this.defaultProvider) ? { provider: p as MultiModalProviderInterface } : undefined;
  }

  /**
   * True when the routing default model's catalog entry declares the requested
   * capability. Used to decide whether a non-text fallback may carry the model
   * id — a text/chat model must never be POSTed to a media endpoint.
   */
  private routingDefaultModelServesCapability(capabilityType: ModelCapabilityType): boolean {
    const r = this._routingDefaultModel;
    if (!r) return false;
    try {
      const entry = this.getProviderModels(r.provider).find(m => m.id === r.model);
      if (!entry) return false;
      switch (capabilityType) {
        case 'image_generation': return !!entry.capabilities?.includes('imageGeneration');
        case 'audio_tts': return !!entry.capabilities?.includes('tts');
        case 'audio_stt': return !!entry.capabilities?.includes('stt');
        case 'video_generation': return !!entry.capabilities?.includes('videoGeneration');
        case 'decision': return !!entry.capabilities?.includes('decision');
        case 'image_recognition':
          return !!entry.inputTypes?.includes('image') || !!entry.capabilities?.includes('vision');
        default: return false;
      }
    } catch {
      return false;
    }
  }

  /**
   * Look up any registered provider by name for one-shot tool overrides
   * (`provider=` + `model=` on generate_image / text_to_speech / …).
   * Does not require the provider to already be in capability routing.
   */
  resolveProviderByName(name: string): { provider: MultiModalProviderInterface; name: string } | undefined {
    const key = name.trim();
    if (!key) return undefined;
    const p = this.providers.get(key);
    if (!p || !this.isAvailable(key)) return undefined;
    return { provider: p as MultiModalProviderInterface, name: key };
  }

  /** Names of registered, enabled, available providers (for tool error hints / one-shot pick). */
  listRegisteredProviderNames(): string[] {
    return [...this.providers.keys()].filter(n => this.isAvailable(n)).sort();
  }

  /** True when the provider exists in the registry but its Settings switch is off. */
  isProviderDisabled(providerName: string): boolean {
    return this.providers.has(providerName) && this.disabledProviders.has(providerName);
  }

  /**
   * Return an ordered list of provider candidates for a capability.
   * Always includes: assignment -> assignment.fallback -> routingDefaultModel -> defaultProvider.
   * When autoFallback is ON, appends all remaining available providers in fallback order.
   */
  resolveModalityCandidates(capabilityType: ModelCapabilityType): Array<{ provider: MultiModalProviderInterface; model?: string; name: string }> {
    const candidates: Array<{ provider: MultiModalProviderInterface; model?: string; name: string }> = [];
    const seen = new Set<string>();

    const add = (name: string, model?: string) => {
      if (seen.has(name)) return;
      const p = this.providers.get(name);
      if (!p || !this.isAvailable(name)) return;
      candidates.push({ provider: p as MultiModalProviderInterface, model, name });
      seen.add(name);
    };

    const capKey = CAPABILITY_KEY_MAP[capabilityType];
    const needsCapFilter = capabilityType !== 'text' && !!capKey;

    const addIfCapable = (name: string, model?: string) => {
      if (seen.has(name)) return;
      if (needsCapFilter) {
        const p = this.providers.get(name) as MultiModalProviderInterface | undefined;
        if (!p || typeof p.getCapabilities !== 'function') return;
        const caps = p.getCapabilities();
        if (!caps[capKey!]) return;
      }
      add(name, model);
    };

    // Explicit assignment — always trust the user's choice. Include even when the
    // provider is circuit-degraded so credit/auth failures surface as real errors
    // instead of a misleading "No provider configured".
    const addAssigned = (name: string, model?: string) => {
      if (seen.has(name)) return;
      const p = this.providers.get(name);
      if (!p) return;
      candidates.push({ provider: p as MultiModalProviderInterface, model, name });
      seen.add(name);
    };
    const assignment = this._capabilityRouting.assignments[capabilityType];
    if (assignment) {
      addAssigned(assignment.provider, assignment.model);
      if (assignment.fallback) addAssigned(assignment.fallback.provider, assignment.fallback.model);
    }

    // routingDefaultModel / defaultProvider are TEXT routing defaults;
    // for non-text tasks, only add them if they actually support the modality.
    // Critically, `routingDefaultModel.model` is a *text* model — we must NOT
    // carry it as the model for a media capability,
    // or we end up POSTing a text id to an image/tts/stt endpoint (yielding a
    // confusing "model does not exist" 400). For non-text capabilities we
    // contribute only the PROVIDER and let it resolve a modality-appropriate
    // model (or fail loudly if none is configured).
    if (this._routingDefaultModel) {
      addIfCapable(
        this._routingDefaultModel.provider,
        needsCapFilter ? undefined : this._routingDefaultModel.model,
      );
    }
    addIfCapable(this.defaultProvider);

    if (this._autoFallback) {
      const order = this.fallbackOrder.length > 0 ? this.fallbackOrder : [...this.providers.keys()];
      for (const name of order) addIfCapable(name);
    }

    return candidates;
  }

  private selectProvider(request: LLMRequest, explicit?: string): string {
    // Honour an explicit provider pin (Chat UI / agent override) even when the
    // circuit breaker marked it degraded — fail loud with the real error instead
    // of silently switching to another provider (which previously reused the
    // foreign model id and produced confusing "model not found" errors).
    if (explicit && this.providers.has(explicit) && !this.disabledProviders.has(explicit)) {
      if (!this.isAvailable(explicit)) {
        log.warn(`Explicit provider ${explicit} is circuit-degraded — still using it (no silent switch)`);
      }
      return explicit;
    }
    if (explicit && this.disabledProviders.has(explicit)) {
      log.warn(`Explicit provider ${explicit} is disabled — falling through to auto-select`);
    }

    if (!this.autoSelect || this.providerTiers.length === 0) {
      if (this.isAvailable(this.defaultProvider) && this.providers.has(this.defaultProvider)) {
        return this.defaultProvider;
      }
      const healthy = [...this.providers.keys()].find(n => this.isAvailable(n));
      if (healthy) return healthy;
      // Last resort: prefer any enabled (even degraded) provider over a disabled one
      const enabledAny = [...this.providers.keys()].find(n => !this.disabledProviders.has(n));
      if (enabledAny) {
        log.warn(`All providers degraded — using enabled provider ${enabledAny} as last resort`);
        return enabledAny;
      }
      log.warn('All providers disabled or degraded — using default as last resort');
      return this.defaultProvider;
    }

    const complexity = LLMRouter.assessComplexity(request);

    const match = this.providerTiers.find(t =>
      t.complexity.includes(complexity) &&
      this.providers.has(t.name) &&
      this.isAvailable(t.name),
    );

    if (match) {
      log.debug(`Auto-selected provider: ${match.name}`, { complexity });
      return match.name;
    }

    const healthy = [...this.providers.keys()].find(n => this.isAvailable(n));
    if (healthy) {
      log.warn(`All tiered providers degraded for complexity=${complexity}, falling back to: ${healthy}`);
      return healthy;
    }

    // Last resort: prefer any enabled (even degraded) provider over a disabled one
    const enabledAny = [...this.providers.keys()].find(n => !this.disabledProviders.has(n));
    if (enabledAny) {
      log.warn(`All providers degraded — using enabled provider ${enabledAny} as last resort`);
      return enabledAny;
    }
    log.warn('All providers disabled or degraded — using default as last resort');
    return this.defaultProvider;
  }

  private getFallbacks(primary: string): string[] {
    if (!this._autoFallback) return [];
    const order = this.fallbackOrder.length > 0
      ? this.fallbackOrder
      : [...this.providers.keys()];
    return order.filter(n => n !== primary && this.isAvailable(n));
  }

  static createDefault(configs?: Record<string, LLMProviderConfig>, defaultProvider?: string, stateDir?: string): LLMRouter {
    const router = new LLMRouter(defaultProvider);

    router.initOAuth(stateDir);

    const anthropicConfig = configs?.['anthropic'];
    if (anthropicConfig?.apiKey) {
      router.registerProvider('anthropic', new AnthropicProvider(anthropicConfig));
    }

    const openaiConfig = configs?.['openai'];
    if (openaiConfig?.apiKey) {
      router.registerProvider('openai', new OpenAIProvider(openaiConfig));
    }

    const googleConfig = configs?.['google'];
    if (googleConfig?.apiKey) {
      router.registerProvider('google', new GoogleProvider(googleConfig));
    }

    const ollamaConfig = configs?.['ollama'];
    if (ollamaConfig?.baseUrl || ollamaConfig?.model) {
      router.registerProvider('ollama', new OllamaProvider(ollamaConfig));
    }

    const markusConfig = configs?.['markus'];
    if (markusConfig?.apiKey) {
      router.registerProvider('markus', new MarkusProvider(markusConfig));
      void router.refreshMarkusCatalog().catch(err =>
        log.warn('Failed to refresh Markus Hub catalog on createDefault', { error: String(err) }),
      );
    }

    for (const [name, cfg] of Object.entries(configs ?? {})) {
      if (['anthropic', 'openai', 'google', 'ollama', 'markus'].includes(name)) continue;
      if (!cfg?.apiKey) continue;
      try {
        router.registerProvider(name, createOpenAICompatible(name, cfg));
      } catch (err) {
        // A single unusable provider (e.g. a custom one persisted without a
        // baseUrl) must not abort router construction and brick startup.
        // Skip it loudly; the provider stays absent until it is fixed.
        log.warn(`Skipping provider "${name}" during startup registration`, { error: String(err) });
      }
    }

    // Auto-register OAuth-backed providers from stored auth profiles
    if (router._profileStore) {
      const profiles = router._profileStore.listProfiles();
      for (const profile of profiles) {
        if (profile.authType !== 'oauth' || !profile.oauth) continue;
        const providerName = profile.provider;
        if (router.providers.has(providerName)) continue;

        const cfg = configs?.[providerName];
        try {
          router.registerOAuthProvider(providerName, profile, {
            model: cfg?.model,
            baseUrl: cfg?.baseUrl,
            maxTokens: cfg?.maxTokens,
            timeoutMs: cfg?.timeoutMs,
          });
        } catch (err) {
          log.warn(`Failed to auto-register OAuth provider ${providerName}`, { error: String(err) });
        }
      }
    }

    // Auto-configure tiers if multiple providers available.
    const providerNames = router.listProviders();
    if (providerNames.length > 1) {
      const effectiveDefault = defaultProvider ?? providerNames[0];
      router.enableAutoSelect(buildTiers(providerNames, effectiveDefault));

      const fallbackOrder = [
        effectiveDefault,
        ...providerNames.filter(n => n !== effectiveDefault),
      ].filter(n => providerNames.includes(n));
      router.setFallbackOrder(fallbackOrder);
      log.info('Auto-select enabled with fallback', { providers: providerNames, defaultProvider: effectiveDefault, fallbackOrder });
    }

    return router;
  }

  /**
   * Decide whether to put `max_tokens` on the wire.
   *
   * Catalog `max_output_tokens` is the model's absolute ceiling (DeepSeek V4
   * Flash reports 393216 via OpenRouter). That value is for context budgeting
   * (`getModelMaxOutput`), NOT a per-request reservation. OpenRouter prepaid /
   * member keys reserve credits against `max_tokens` before the call — injecting
   * the catalog ceiling made every chat look unaffordable while Markus CU still
   * had balance.
   *
   * Policy: only honor an explicit `request.maxTokens` from the caller (agent
   * config, tool, etc.). Otherwise leave unset so the provider omits the field
   * (Markus/OpenRouter) or applies its own constructor default
   * (`DEFAULT_REQUEST_MAX_TOKENS` = 32k for Anthropic/OpenAI/Google/Ollama,
   * which require the field on the wire). Never copy the catalog ceiling onto
   * the wire.
   */
  private resolveMaxTokens(request: LLMRequest, _providerName: string): LLMRequest {
    return request;
  }

  /**
   * Try a chat request on a specific provider, optionally with an alternate model.
   * Returns the response or throws on failure (after recording health).
   */
  /**
   * Strip image parts from a request destined for a model that cannot accept
   * images. Guards against residual image_url parts in session history being
   * re-sent every turn to a text-only model (which upstream rejects with 404
   * "No endpoints found that support image input"). Keeps the model string so
   * the agent is told the images were dropped and how to recover (describe_image).
   */
  private stripImagesForTextModel(
    request: LLMRequest,
    providerName: string,
    model?: string,
  ): { request: LLMRequest; stripped: boolean } {
    // IMPORTANT: judge vision capability by the model ACTUALLY sent on the
    // wire, not the provider's default model. MarkusProvider routes per
    // request.model (Chat UI override / capability routing / auto-select), so
    // provider.model can be a vision model while the real request targets a
    // text-only model. Checking providerName alone re-introduces the upstream
    // 404 ("No endpoints found that support image input").
    const effectiveModel = model ?? (request.model as string | undefined);
    const supportsVision = this.getModelInputTypes(providerName, effectiveModel).includes('image');
    if (supportsVision) return { request, stripped: false };
    const hadImage = request.messages.some(m =>
      Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'),
    );
    if (!hadImage) return { request, stripped: false };
    const note = `\n\n[SYSTEM] The active chat model (${effectiveModel ?? providerName}) does NOT support image input, so ${'imag'
      + 'e'} attachment(s) were omitted from this request. Use the describe_image tool with each attachment's local path (listed in the [USER ATTACHED ...] anchor) to view it, or ask the user to switch to a vision-capable model. Do NOT fabricate image content.`;
    const messages = request.messages.map(m => {
      if (!Array.isArray(m.content)) return m;
      const textParts = m.content.filter(p => p.type === 'text')
        .map(p => (p as { type: 'text'; text: string }).text);
      return { ...m, content: textParts.join('\n') + note };
    });
    log.warn(`Stripped image parts for text-only model ${effectiveModel ?? providerName}`, {
      messageCount: messages.length,
    });
    return { request: { ...request, messages }, stripped: true };
  }

  private async tryChat(providerName: string, request: LLMRequest, altModel?: string): Promise<{ response: LLMResponse; model: string }> {
    const provider = this.providers.get(providerName)!;
    const originalModel = provider.model;
    // MarkusProvider resolves route/credentials per request.model — avoid mutating
    // shared provider.model (concurrent Worker + OR chats would cross-contaminate).
    const useRequestModelOnly = providerName === 'markus' || provider instanceof MarkusProvider;
    const activeModel = altModel ?? originalModel;
    const chatRequest = altModel ? { ...request, model: altModel } : request;
    if (!useRequestModelOnly && altModel && altModel !== originalModel) {
      provider.configure({ provider: providerName as any, model: altModel });
    }
    await this.applyJitter(providerName);
    try {
      // Effective wire model: altModel wins, else the request's own model
      // (MarkusProvider routes per request.model), else the provider default.
      const effectiveWireModel = chatRequest.model ?? provider.model;
      const { request: safeRequest } = this.stripImagesForTextModel(chatRequest, providerName, effectiveWireModel);
      const response = await provider.chat(safeRequest);
      this.recordSuccess(providerName, activeModel);
      return { response, model: activeModel };
    } catch (error) {
      if (!LLMRouter.isCUExceededError(error)) {
        this.recordFailure(providerName, activeModel, error);
      }
      throw LLMRouter.enrichError(error, providerName, activeModel);
    } finally {
      if (!useRequestModelOnly && altModel && altModel !== originalModel) {
        provider.configure({ provider: providerName as any, model: originalModel });
      }
      this.releaseInflight(providerName);
    }
  }

  async chat(request: LLMRequest, providerName?: string, options?: ChatOptions): Promise<LLMResponse> {
    let primary: string;
    let routedModel: string | undefined;

    if (providerName) {
      primary = this.selectProvider(request, providerName);
      // Explicit request.model (Chat UI session/turn override) wins.
      if (request.model) {
        routedModel = request.model;
      } else if (
        // Explicit provider pin still honors the global text routing model when
        // it targets the same provider (e.g. Markus + Hub recommended text).
        this._routingDefaultModel &&
        this._routingDefaultModel.provider === primary &&
        !this._capabilityRouting.assignments.text
      ) {
        routedModel = this._routingDefaultModel.model;
      }
    } else {
      const capabilityType = options?.capabilityType ?? LLMRouter.inferCapability(request);
      // Always use selectForCapability for text so routingDefaultModel is applied.
      // (Previously text-without-assignment called selectProvider and ignored it,
      // leaving agents stuck on the provider's active flash model.)
      const routeResult = this.selectForCapability(capabilityType, request, options?.sessionId);
      primary = routeResult.provider;
      routedModel = routeResult.model;
    }

    const provider = this.providers.get(primary);
    if (!provider) {
      throw new Error(`LLM provider not found: ${primary}. Available: ${[...this.providers.keys()].join(', ')}`);
    }
    routedModel = this.resolveModelForProvider(primary, routedModel);
    request = this.requestForProvider(primary, request, routedModel);
    request = this.resolveMaxTokens(request, primary);

    log.debug(`Sending request to ${primary}`, { model: routedModel ?? provider.model, messageCount: request.messages.length });

    const span = startSpan('llm.chat', { provider: primary, model: routedModel ?? provider.model });
    const startTime = Date.now();
    let lastError: unknown = null;
    let primaryError: unknown = null;

    // Try primary provider's active model (or routed model)
    try {
      const { response, model } = await this.tryChat(primary, request, routedModel);
      span.end({ inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, finishReason: response.finishReason });
      log.debug(`Response from ${primary}`, { tokens: response.usage, finishReason: response.finishReason });
      this.emitLog(primary, model, request, response, Date.now() - startTime);
      return response;
    } catch (error) {
      lastError = error;
      primaryError = error;
      log.error(`LLM request failed for ${primary}:${routedModel ?? provider.model}`, { error: String(error) });

      // CU_EXCEEDED / MARKUS_RATE_LIMITED are Markus-specific — do NOT fall back to BYOK providers
      if (LLMRouter.isCUExceededError(error) || LLMRouter.isMarkusRateLimited(error)) {
        throw lastError;
      }

      // Try alternate models on the same provider (only when auto-fallback is enabled)
      if (this._autoFallback && !LLMRouter.isNonRetryableError(error)) {
        const altModel = this.findHealthyModel(primary);
        if (altModel && altModel !== provider.model) {
          log.info(`Trying alternate model ${altModel} on ${primary}`);
          try {
            const { response, model } = await this.tryChat(primary, request, altModel);
            span.end({ inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, finishReason: response.finishReason });
            log.info(`Alternate model ${altModel} on ${primary} succeeded`);
            this.emitLog(primary, model, request, response, Date.now() - startTime);
            return response;
          } catch (altError) {
            lastError = altError;
            log.error(`Alternate model ${altModel} on ${primary} also failed`, { error: String(altError) });
          }
        }
      }

      // Fallback to other providers — always use that provider's own model
      for (const fallbackName of this.getFallbacks(primary)) {
        const fb = this.providers.get(fallbackName)!;
        const fbRequest = this.requestForProvider(fallbackName, request);
        log.info(`Falling back to ${fallbackName}`, { model: fb.model });
        try {
          const { response, model } = await this.tryChat(fallbackName, fbRequest);
          span.end({ inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, finishReason: response.finishReason });
          log.info(`Fallback to ${fallbackName} succeeded`);
          this.emitLog(fallbackName, model, request, response, Date.now() - startTime);
          return response;
        } catch (fbError) {
          lastError = fbError;
          log.error(`Fallback ${fallbackName} also failed`, { error: String(fbError) });
        }
      }

      const finalError = LLMRouter.preferPrimaryError(primaryError, lastError);
      span.setError(finalError);
      span.end();
      throw finalError;
    }
  }

  /**
   * Direct chat with a specific provider — no fallback, no auto-select.
   * Used by the test endpoint to verify a single provider's connectivity.
   * Also returns the baseUrl used for diagnostics.
   */
  async chatDirect(request: LLMRequest, providerName: string, altModel?: string): Promise<LLMResponse & { _providerBaseUrl?: string; _model?: string }> {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Provider "${providerName}" not registered`);
    }
    if (this.disabledProviders.has(providerName)) {
      throw new Error(`Provider "${providerName}" is disabled`);
    }
    request = this.resolveMaxTokens(request, providerName);
    // Mirror tryStream's model-switch semantics: most providers put their
    // configured model on the wire (ignoring request.model), so temporarily
    // configure the target model and restore afterward. For Markus, the
    // provider routes per request.model (Hub/OpenRouter slugs).
    const originalModel = provider.model;
    const useRequestModelOnly = providerName === 'markus' || provider instanceof MarkusProvider;
    const activeModel = altModel ?? originalModel;
    let switched = false;
    if (!useRequestModelOnly && altModel && altModel !== originalModel) {
      provider.configure({ provider: providerName as any, model: altModel });
      switched = true;
    }
    const directRequest = (useRequestModelOnly && altModel) ? { ...request, model: altModel } : request;
    try {
      const response = await provider.chat(directRequest);
      const baseUrl = (provider as any).baseUrl ?? (provider as any).config?.baseUrl;
      return Object.assign(response, { _providerBaseUrl: baseUrl, _model: activeModel });
    } finally {
      if (switched) {
        provider.configure({ provider: providerName as any, model: originalModel });
      }
    }
  }

  /**
   * Try a streaming chat on a specific provider, optionally with an alternate model.
   */
  private async tryStream(
    providerName: string, request: LLMRequest,
    onEvent: (event: LLMStreamEvent) => void, signal?: AbortSignal, altModel?: string,
  ): Promise<{ response: LLMResponse; model: string }> {
    const provider = this.providers.get(providerName)!;
    const originalModel = provider.model;
    const useRequestModelOnly = providerName === 'markus' || provider instanceof MarkusProvider;
    const activeModel = altModel ?? originalModel;
    const streamRequest = altModel ? { ...request, model: altModel } : request;
    if (!useRequestModelOnly && altModel && altModel !== originalModel) {
      provider.configure({ provider: providerName as any, model: altModel });
    }
    await this.applyJitter(providerName);
    try {
      let response: LLMResponse;
      // Effective wire model: altModel wins, else the request's own model
      // (MarkusProvider routes per request.model), else the provider default.
      const effectiveWireModel = streamRequest.model ?? provider.model;
      const { request: safeRequest } = this.stripImagesForTextModel(streamRequest, providerName, effectiveWireModel);
      if (provider.chatStream) {
        response = await provider.chatStream(safeRequest, onEvent, signal);
      } else {
        response = await provider.chat(safeRequest);
        if (response.content) onEvent({ type: 'text_delta', text: response.content });
        onEvent({ type: 'message_end', usage: response.usage, finishReason: response.finishReason });
      }
      this.recordSuccess(providerName, activeModel);
      return { response, model: activeModel };
    } catch (error) {
      if (!LLMRouter.isCUExceededError(error)) {
        this.recordFailure(providerName, activeModel, error);
      }
      throw LLMRouter.enrichError(error, providerName, activeModel);
    } finally {
      if (!useRequestModelOnly && altModel && altModel !== originalModel) {
        provider.configure({ provider: providerName as any, model: originalModel });
      }
      this.releaseInflight(providerName);
    }
  }

  async chatStream(request: LLMRequest, onEvent: (event: LLMStreamEvent) => void, providerName?: string, signal?: AbortSignal, options?: ChatOptions): Promise<LLMResponse> {
    let primary: string;
    let routedModel: string | undefined;

    if (providerName) {
      primary = this.selectProvider(request, providerName);
      if (request.model) {
        routedModel = request.model;
      } else if (
        this._routingDefaultModel &&
        this._routingDefaultModel.provider === primary &&
        !this._capabilityRouting.assignments.text
      ) {
        routedModel = this._routingDefaultModel.model;
      }
    } else {
      const capabilityType = options?.capabilityType ?? LLMRouter.inferCapability(request);
      const routeResult = this.selectForCapability(capabilityType, request, options?.sessionId);
      primary = routeResult.provider;
      routedModel = routeResult.model;
    }

    const provider = this.providers.get(primary);
    if (!provider) {
      throw new Error(`LLM provider not found: ${primary}. Available: ${[...this.providers.keys()].join(', ')}`);
    }
    routedModel = this.resolveModelForProvider(primary, routedModel);
    request = this.requestForProvider(primary, request, routedModel);
    request = this.resolveMaxTokens(request, primary);

    const span = startSpan('llm.chatStream', { provider: primary, model: routedModel ?? provider.model });
    const startTime = Date.now();

    let lastError: unknown = null;
    let primaryError: unknown = null;

    // Try primary provider's routed model (or its default model)
    try {
      const { response, model } = await this.tryStream(primary, request, onEvent, signal, routedModel);
      span.end({ inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, finishReason: response.finishReason });
      this.emitLog(primary, model, request, response, Date.now() - startTime);
      return response;
    } catch (error) {
      lastError = error;
      primaryError = error;
      if (signal?.aborted) {
        span.setError(lastError instanceof Error ? lastError : String(lastError));
        span.end();
        throw lastError;
      }
      log.error(`LLM stream request failed for ${primary}:${routedModel ?? provider.model}`, { error: String(error) });

      // CU_EXCEEDED / MARKUS_RATE_LIMITED are Markus-specific — do NOT fall back to BYOK providers
      if (LLMRouter.isCUExceededError(error) || LLMRouter.isMarkusRateLimited(error)) {
        span.setError(lastError instanceof Error ? lastError : String(lastError));
        span.end();
        throw lastError;
      }

      // Try alternate models on the same provider (only when auto-fallback is enabled)
      if (this._autoFallback && !LLMRouter.isNonRetryableError(error)) {
        const altModel = this.findHealthyModel(primary);
        if (altModel && altModel !== provider.model) {
          log.info(`Stream: trying alternate model ${altModel} on ${primary}`);
          try {
            const { response, model } = await this.tryStream(primary, request, onEvent, signal, altModel);
            span.end({ inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, finishReason: response.finishReason });
            log.info(`Stream: alternate model ${altModel} on ${primary} succeeded`);
            this.emitLog(primary, model, request, response, Date.now() - startTime);
            return response;
          } catch (altError) {
            lastError = altError;
            if (signal?.aborted) {
              span.setError(lastError instanceof Error ? lastError : String(lastError));
              span.end();
              throw lastError;
            }
            log.error(`Stream: alternate model ${altModel} on ${primary} also failed`, { error: String(altError) });
          }
        }
      }

      // Fallback to other providers — always use that provider's own model
      for (const fallbackName of this.getFallbacks(primary)) {
        const fb = this.providers.get(fallbackName)!;
        const fbRequest = this.requestForProvider(fallbackName, request);
        log.info(`Stream fallback to ${fallbackName}`, { model: fb.model });
        try {
          const { response, model } = await this.tryStream(fallbackName, fbRequest, onEvent, signal);
          span.end({ inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, finishReason: response.finishReason });
          this.emitLog(fallbackName, model, request, response, Date.now() - startTime);
          log.info(`Stream fallback to ${fallbackName} succeeded`);
          return response;
        } catch (fbError) {
          lastError = fbError;
          if (signal?.aborted) break;
          log.error(`Stream fallback ${fallbackName} failed`, { error: String(fbError) });
        }
      }

      const finalError = LLMRouter.preferPrimaryError(primaryError, lastError);
      span.setError(finalError);
      span.end();
      throw finalError;
    }
  }

  getProvider(name: string): LLMProviderInterface | undefined {
    return this.providers.get(name);
  }

  /** Hub credentials from the markus provider. Used by upload_reference tool. */
  getHubCredentials(): { baseUrl: string; token: string } | undefined {
    const markus = this.providers.get('markus') as MarkusProvider | undefined;
    if (!markus) return undefined;
    const baseUrl = markus.resolveHubBase();
    const token = markus.resolveHubToken();
    if (!baseUrl || !token) return undefined;
    return { baseUrl, token };
  }

  /**
   * OpenRouter prompt-token afford ceiling from a prior 402, used to pack
   * context below key credit limits (not the model window).
   */
  getPromptAffordTokens(providerName?: string): number | null {
    const name = providerName ?? this.defaultProvider;
    const provider = this.providers.get(name) as
      | { getLastPromptAffordTokens?: () => number | null }
      | undefined;
    return provider?.getLastPromptAffordTokens?.() ?? null;
  }

  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  getDefaultProvider(): string {
    return this.defaultProvider;
  }

  /**
   * Update the default provider at runtime (e.g. from Settings UI).
   * Also refreshes the auto-select tier configuration so the new default
   * gets priority for all complexity levels.
   */
  setDefaultProvider(name: string): void {
    if (!this.providers.has(name)) {
      throw new Error(`Cannot set default to unknown provider: ${name}. Available: ${[...this.providers.keys()].join(', ')}`);
    }
    this.defaultProvider = name;
    log.info(`Default LLM provider updated to: ${name}`);

    // Keep the global routing default model in sync with the default provider.
    // Text routing prefers `_routingDefaultModel` over `defaultProvider`, so if
    // it still points at the *previous* provider's model, agents would keep
    // using the old provider after a switch. When the default model is unset or
    // belongs to a different provider, retarget it at the new provider's model.
    const current = this._routingDefaultModel;
    if (!current || current.provider !== name) {
      const model = this.getProviderDefaultModel(name);
      if (model) {
        this._routingDefaultModel = { provider: name, model };
        log.info(`Routing default model synced to new default provider: ${name}:${model}`);
      }
    }

    // Re-run tier configuration with the new default
    const providerNames = this.listProviders();
    if (this.autoSelect && providerNames.length > 1) {
      this.providerTiers = buildTiers(providerNames, name);
      this.fallbackOrder = [name, ...providerNames.filter(n => n !== name)];
    }
  }

  /**
   * The model a provider uses by default: its configured active model, or the
   * first model in its catalog. Returns undefined for an unknown provider.
   */
  getProviderDefaultModel(name: string): string | undefined {
    const provider = this.providers.get(name);
    if (!provider) return undefined;
    if (provider.model) return provider.model;
    return this.getProviderModels(name)[0]?.id;
  }

  /**
   * Returns info about all configured providers and the current default,
   * for use by the settings API.
   */
  getSettings(): { defaultProvider: string; providers: Record<string, { model: string; configured: boolean }> } {
    const providers: Record<string, { model: string; configured: boolean }> = {};
    for (const [name, p] of this.providers.entries()) {
      providers[name] = { model: p.model, configured: true };
    }
    for (const name of ['anthropic', 'openai', 'openai-codex', 'google', 'ollama', 'minimax', 'minimax-cn', 'siliconflow', 'siliconflow-intl', 'openrouter', 'zai', 'deepseek', 'markus']) {
      if (!providers[name]) {
        providers[name] = { model: '', configured: false };
      }
    }
    return { defaultProvider: this.defaultProvider, providers };
  }

  getEnhancedSettings(): EnhancedLLMSettings {
    const providers: Record<string, EnhancedProviderSettings> = {};

    for (const [name, p] of this.providers.entries()) {
      const enrichedModels = this.getProviderModels(name);
      const modelDef = enrichedModels.find(m => m.id === p.model) ?? enrichedModels[0];
      const customModels = this.customModelConfigs.get(name);
      const oauthProfile = this._profileStore?.getDefaultProfile(name);
      const tieredModels = enrichedModels.map(m => {
        if (m.tier) return m;
        const score = estimateQualityScore(m.id, m.reasoning);
        return { ...m, tier: tierFromQualityScore(score) };
      });
      const rawKey: string = (p as any).apiKey ?? '';
      const keySource = oauthProfile?.authType === 'oauth' ? 'oauth' as const : rawKey ? 'config' as const : undefined;
      providers[name] = {
        name,
        displayName: PROVIDER_DISPLAY_NAMES[name] ?? name,
        model: p.model,
        baseUrl: (p as any).baseUrl,
        configured: true,
        enabled: this.isProviderEnabled(name),
        apiKeyPreview: maskApiKey(rawKey),
        apiKeySource: keySource,
        contextWindow: customModels?.contextWindow ?? modelDef?.contextWindow,
        maxOutputTokens: customModels?.maxOutputTokens ?? modelDef?.maxOutputTokens,
        cost: customModels?.cost ?? modelDef?.cost,
        models: tieredModels,
        authType: oauthProfile?.authType,
        oauthConnected: oauthProfile?.authType === 'oauth' && !!oauthProfile?.oauth,
        oauthAccountId: oauthProfile?.oauth?.accountId,
      };
    }

    for (const name of ['anthropic', 'openai', 'openai-codex', 'google', 'ollama', 'minimax', 'minimax-cn', 'siliconflow', 'siliconflow-intl', 'openrouter', 'zai', 'deepseek', 'markus']) {
      if (!providers[name]) {
        const oauthProfile = this._profileStore?.getDefaultProfile(name);
        const enrichedModels = this.getProviderModels(name);
        providers[name] = {
          name,
          displayName: PROVIDER_DISPLAY_NAMES[name] ?? name,
          model: '',
          configured: false,
          enabled: this.isProviderEnabled(name),
          models: enrichedModels,
          authType: oauthProfile?.authType,
          oauthConnected: oauthProfile?.authType === 'oauth' && !!oauthProfile?.oauth,
          oauthAccountId: oauthProfile?.oauth?.accountId,
        };
      }
    }

    return {
      defaultProvider: this.defaultProvider,
      autoFallback: this._autoFallback,
      routingDefaultModel: this._routingDefaultModel ?? null,
      providers,
    };
  }

  updateProviderModelConfig(providerName: string, config: { contextWindow?: number; maxOutputTokens?: number; cost?: ModelCostConfig }): void {
    this.customModelConfigs.set(providerName, {
      ...(this.customModelConfigs.get(providerName) ?? {}),
      ...config,
    });
    log.info(`Updated model config for ${providerName}`, config);
  }

  /**
   * Change the active model for a registered provider at runtime.
   * Calls the provider's configure() method and optionally updates the custom
   * model config (context window, max output, cost) from the built-in catalog.
   */
  setProviderModel(providerName: string, modelId: string): void {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Provider not found: ${providerName}. Available: ${[...this.providers.keys()].join(', ')}`);
    }
    const oldModel = provider.model;
    provider.configure({ provider: providerName as any, model: modelId });
    log.info(`Provider ${providerName} model changed: ${oldModel} → ${modelId}`);

    const catalogEntry = BUILTIN_MODEL_CATALOG.find(
      m => m.id === modelId && m.provider === providerName,
    ) ?? this.customModelCatalog.get(providerName)?.find(m => m.id === modelId);
    if (catalogEntry) {
      this.customModelConfigs.set(providerName, {
        contextWindow: catalogEntry.contextWindow,
        maxOutputTokens: catalogEntry.maxOutputTokens,
        cost: catalogEntry.cost,
      });
    }
  }

  setProviderEnabled(providerName: string, enabled: boolean): void {
    if (enabled) {
      this.disabledProviders.delete(providerName);
    } else {
      this.disabledProviders.add(providerName);
      if (this.defaultProvider === providerName) {
        const replacement = [...this.providers.keys()].find(n => !this.disabledProviders.has(n));
        if (replacement) {
          log.info(`Default provider ${providerName} disabled — switching default to ${replacement}`);
          this.defaultProvider = replacement;
        }
      }
    }
    log.info(`Provider ${providerName} ${enabled ? 'enabled' : 'disabled'}`);
  }

  isProviderEnabled(providerName: string): boolean {
    return !this.disabledProviders.has(providerName);
  }

  getModelCatalog(): ModelDefinition[] {
    const all = BUILTIN_MODEL_CATALOG.map(m => this.enrichModelFromCatalog(m));
    for (const models of this.customModelCatalog.values()) {
      for (const m of models) {
        if (!all.some(b => b.id === m.id && b.provider === m.provider)) {
          all.push(m);
        }
      }
    }
    return all;
  }

  /**
   * Returns the context window (in tokens) for a specific provider, or the
   * active default if no provider name is given.
   *
   * P1-8: `model` is the model actually used for this request
   * ({@link Agent.getEffectiveModel}, possibly session-overridden). When omitted
   * we keep the old behaviour of using the provider's configured model.
   */
  getActiveModelContextWindow(): number {
    return this.getModelContextWindow();
  }

  getModelContextWindow(providerName?: string, model?: string): number {
    const name = providerName ?? this.defaultProvider;
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Cannot resolve context window: provider "${name}" is not registered. Available: ${[...this.providers.keys()].join(', ') || '(none)'}.`);
    }
    const effectiveModel = model ?? provider.model;
    const custom = this.customModelConfigs.get(name);
    // Provider-level custom config only applies to the provider's own model; an
    // explicit effective model must be resolved through the catalog.
    if (custom?.contextWindow && custom.contextWindow > 0 && !model) return custom.contextWindow;
    const catalogEntry = findCatalogEntry(name, effectiveModel, {
      builtin: BUILTIN_MODEL_CATALOG,
      hub: this.customModelCatalog.get(name),
    });
    const ctx = catalogEntry?.contextWindow;
    if (!ctx || ctx <= 0) {
      // Any real model must be usable. A model absent from the built-in/Hub
      // catalog (private BYOK, local Ollama, self-hosted endpoint) should NOT
      // take the whole agent turn down — fall back to a CONSERVATIVE window and
      // warn so the operator can configure an exact value for accurate
      // budgeting. Never silently assume a 1M window (P1-7).
      const fallback = resolveFallbackContextWindow();
      log.warn(`No context_window for provider "${name}" model "${effectiveModel || '(unset)'}" — using conservative fallback ${fallback} (NOT 1M). Register the model or set MARKUS_FALLBACK_CONTEXT_WINDOW for accurate budgeting.`);
      return fallback;
    }
    if (ctx > MAX_CONTEXT_WINDOW_SANITY) {
      log.warn(`context_window ${ctx} for "${name}/${effectiveModel}" exceeds sanity bound ${MAX_CONTEXT_WINDOW_SANITY} — clamping.`);
      return MAX_CONTEXT_WINDOW_SANITY;
    }
    return ctx;
  }

  getActiveModelMaxOutput(): number {
    return this.getModelMaxOutput();
  }

  getModelMaxOutput(providerName?: string, model?: string): number {
    const name = providerName ?? this.defaultProvider;
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Cannot resolve max output tokens: provider "${name}" is not registered. Available: ${[...this.providers.keys()].join(', ') || '(none)'}.`);
    }
    const effectiveModel = model ?? provider.model;
    const custom = this.customModelConfigs.get(name);
    if (custom?.maxOutputTokens && custom.maxOutputTokens > 0 && !model) return custom.maxOutputTokens;
    const catalogEntry = findCatalogEntry(name, effectiveModel, {
      builtin: BUILTIN_MODEL_CATALOG,
      hub: this.customModelCatalog.get(name),
    });
    const out = catalogEntry?.maxOutputTokens;
    if (!out || out <= 0) {
      // Mirror the context-window policy: a missing output cap is not fatal —
      // many upstreams legitimately omit it. Fall back instead of throwing so
      // unknown/private models keep working.
      log.warn(`No max_output_tokens for provider "${name}" model "${effectiveModel || '(unset)'}" — using fallback ${DEFAULT_MAX_OUTPUT_FALLBACK}.`);
      return DEFAULT_MAX_OUTPUT_FALLBACK;
    }
    return out;
  }

  getActiveModelName(providerName?: string): string {
    const name = providerName ?? this.defaultProvider;
    const provider = this.providers.get(name);
    return provider?.model ?? '';
  }

  getModelCost(providerName?: string): ModelCostConfig | undefined {
    const name = providerName ?? this.defaultProvider;
    const provider = this.providers.get(name);
    if (!provider) return undefined;
    const custom = this.customModelConfigs.get(name);
    if (custom?.cost) return custom.cost;

    // Prefer the provider's own (enriched) entry: pricing now comes from the
    // maintained catalog rather than the static table.
    const discovered = this.getProviderModels(name).find(m => m.id === provider.model);
    if (discovered?.cost && (discovered.cost.input > 0 || discovered.cost.output > 0)) {
      return discovered.cost;
    }

    const catalogEntry = findCatalogEntry(name, provider.model, {
      builtin: BUILTIN_MODEL_CATALOG,
      hub: this.customModelCatalog.get(name),
    });
    return catalogEntry?.cost;
  }

  /**
   * Resolve the input types (text / image) for a provider+model pair.
   *
   * @param providerName provider to check
   * @param modelId      OPTIONAL explicit model id. CRITICAL: when omitted the
   *                     provider's DEFAULT model is used, which is NOT the model
   *                     actually sent on the wire when a request carries
   *                     `request.model` (Chat UI session override, capability
   *                     routing, etc.). Callers that already know the effective
   *                     model MUST pass it here, otherwise a vision-capable
   *                     default model can mask a text-only routed model and the
   *                     image parts sail through to an upstream 404.
   */
  getModelInputTypes(providerName?: string, modelId?: string): Array<'text' | 'image'> {
    const name = providerName ?? this.defaultProvider;
    const provider = this.providers.get(name);
    if (!provider) return ['text'];
    const effectiveId = modelId ?? provider.model;

    // 1. The provider's own listing, enriched from the maintained catalog —
    //    this is the primary source now that conversational models are no longer
    //    hard-coded in the static table.
    const discovered = this.getProviderModels(name).find(m => m.id === effectiveId);
    if (discovered?.inputTypes && discovered.inputTypes.length > 0) return discovered.inputTypes;

    // 2. Static metadata table (media models, OAuth-only Codex) plus any
    //    user/Hub catalog entry.
    const catalogEntry = findCatalogEntry(name, effectiveId, {
      builtin: BUILTIN_MODEL_CATALOG,
      hub: this.customModelCatalog.get(name),
    });
    if (catalogEntry?.inputTypes) return catalogEntry.inputTypes;
    // No metadata for this model — be CONSERVATIVE and assume text-only.
    // Previously this defaulted to ['text','image'], which made text-only models
    // look vision-capable and caused upstream 404 ("No endpoints found that
    // support image input") when the agent pushed image_url parts to them.
    return ['text'];
  }

  modelSupportsVision(providerName?: string, modelId?: string): boolean {
    return this.getModelInputTypes(providerName, modelId).includes('image');
  }

  isAutoSelectEnabled(): boolean {
    return this.autoSelect;
  }

  /**
   * Check if the active provider supports Anthropic server-side compaction.
   * Claude Opus / Sonnet 4 and later expose the compact beta. Match the
   * generation number instead of a fixed id list, which went stale the moment
   * Anthropic shipped 5.x.
   */
  isCompactionSupported(providerName?: string): boolean {
    const name = providerName ?? this.defaultProvider;
    const provider = this.providers.get(name);
    if (!provider) return false;
    const m = provider.model.match(/^claude-(opus|sonnet)-(\d+)/);
    if (!m) return false;
    return Number(m[2]) >= 4;
  }

  private emitLog(providerName: string, model: string, request: LLMRequest, response: LLMResponse, durationMs: number): void {
    if (!this.logCallback) return;
    try {
      this.logCallback({
        timestamp: new Date().toISOString(),
        agentId: request.metadata?.agentId,
        taskId: request.metadata?.taskId,
        sessionId: request.metadata?.sessionId,
        provider: providerName,
        model,
        messages: request.messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })),
        tools: request.tools?.map(t => ({ name: t.name })),
        responseContent: response.content,
        responseToolCalls: response.toolCalls?.map(tc => ({ name: tc.name, args: JSON.stringify(tc.arguments) })),
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        durationMs,
        finishReason: response.finishReason,
        cuCost: response.cuCost,
      });
    } catch { /* logging should never crash the app */ }
  }
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  markus: 'Markus',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-codex': 'OpenAI Codex (OAuth)',
  google: 'Google Gemini',
  ollama: 'Ollama (Local)',
  siliconflow: 'SiliconFlow (中国)',
  'siliconflow-intl': 'SiliconFlow (Global)',
  minimax: 'MiniMax (Global)',
  'minimax-cn': 'MiniMax (中国)',
  openrouter: 'OpenRouter',
  zai: 'ZAI (GLM)',
  deepseek: 'DeepSeek',
  xai: 'xAI (Grok)',
  mistral: 'Mistral AI',
  groq: 'Groq',
  perplexity: 'Perplexity',
  cohere: 'Cohere',
  together_ai: 'Together AI',
  fireworks_ai: 'Fireworks AI',
  moonshot: 'Moonshot (Kimi)',
  volcengine: 'Volcengine (Doubao)',
  dashscope: 'DashScope (Qwen)',
};

// Sources:
// - Anthropic: https://docs.anthropic.com/claude/reference/input-and-output-sizes
// - OpenAI: https://developers.openai.com/api/docs/models
// - Google: https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini
// - MiniMax: https://platform.minimax.io/docs/api-reference/api-overview
const BUILTIN_MODEL_CATALOG: ModelDefinition[] = [
  // Anthropic conversational models: NOT listed here. `GET /v1/models` is
  // authoritative and models are discovered at runtime (model-discovery.ts).
  // OpenAI conversational models: NOT listed here — `GET /v1/models` is
  // authoritative and they are discovered at runtime.
  // OpenAI multimodal (image / TTS / STT): NOT listed here. These ids could not
  // be verified against OpenAI's docs from this environment (Cloudflare-blocked,
  // and api.openai.com is unreachable without a key), and `GET /v1/models`
  // returns them anyway — so they are discovered, not hard-coded. Guessing a
  // retired id would hand the user a broken image/TTS/STT button.
  // OpenAI Codex: NOT listed here. The Codex backend (ChatGPT subscription over
  // OAuth) exposes no model-list endpoint, and the ids previously listed here
  // could not be verified against any official source. Offering an unverified
  // id would fail on first use, so the provider stays empty until the user adds
  // a model explicitly — not providing is better than providing something wrong.
  // Google conversational models: NOT listed here — `GET /v1beta/models` is
  // authoritative and they are discovered at runtime.
  // Google multimodal (image / video): NOT listed here. `GET /v1beta/models`
  // lists the imagen-* / veo-* families, so they are discovered rather than
  // hard-coded — the ids that used to live here (imagen-3.0-generate-002,
  // veo-2.0-generate-001) could not be verified and are two generations behind.
  // MiniMax Global conversational models: NOT listed here — they are discovered
  // from the provider's own model list at runtime.
  // MiniMax Multimodal — image, TTS, video.
  // Verified against https://platform.minimax.io/docs/api-reference/api-overview
  // (2026-09): the Hailuo 2.3 video ids and bare `speech-02` are retired — the
  // current families are MiniMax-H3 / H3-Max and speech-2.8 / 2.6 / 02.
  { id: 'image-01', name: 'MiniMax Image-01', provider: 'minimax', contextWindow: 0, maxOutputTokens: 0, cost: { input: 0, output: 0 }, inputTypes: [], tier: 'pro', capabilities: ['imageGeneration'] },
  { id: 'speech-2.8-hd', name: 'MiniMax Speech 2.8 HD', provider: 'minimax', contextWindow: 0, maxOutputTokens: 0, cost: { input: 0, output: 0 }, inputTypes: [], tier: 'pro', capabilities: ['tts'] },
  { id: 'speech-2.8-turbo', name: 'MiniMax Speech 2.8 Turbo', provider: 'minimax', contextWindow: 0, maxOutputTokens: 0, cost: { input: 0, output: 0 }, inputTypes: [], tier: 'pro', capabilities: ['tts'] },
  { id: 'speech-02-hd', name: 'MiniMax Speech-02-HD', provider: 'minimax', contextWindow: 0, maxOutputTokens: 0, cost: { input: 0, output: 0 }, inputTypes: [], tier: 'base', capabilities: ['tts'] },
  { id: 'MiniMax-H3', name: 'MiniMax H3', provider: 'minimax', contextWindow: 0, maxOutputTokens: 0, cost: { input: 0, output: 0 }, inputTypes: [], tier: 'max', capabilities: ['videoGeneration'] },
  { id: 'MiniMax-H3-Max', name: 'MiniMax H3 Max', provider: 'minimax', contextWindow: 0, maxOutputTokens: 0, cost: { input: 0, output: 0 }, inputTypes: [], tier: 'pro', capabilities: ['videoGeneration'] },
  // MiniMax China shares the same models as MiniMax Global (resolved via REGIONAL_PROVIDER_ALIASES)
  // OpenRouter conversational models: NOT listed here. `GET /api/v1/models` is
  // public, authoritative and returns pricing/context directly — the previous
  // hand-maintained entries (xiaomi/mimo-v2-pro, anthropic/claude-opus-4-6, …)
  // had already drifted away from the live list.
  // DeepSeek conversational models: NOT listed here. `GET /models` returns the
  // live ids (deepseek-chat / deepseek-reasoner / …); pricing comes from the
  // LiteLLM catalog used by enrichModelFromCatalog().
  // SiliconFlow conversational models: NOT listed here — the provider's own
  // model list (hundreds of re-hosted ids) is authoritative.
  // SiliconFlow multimodal (STT): NOT listed here — unverified id, dropped on
  // purpose. SiliconFlow's own model list is authoritative.
  // SiliconFlow Global shares the same models as SiliconFlow China (resolved via REGIONAL_PROVIDER_ALIASES)
  // ZAI conversational models: NOT listed here — discovered from the provider.
  // Markus Cloud — model list is loaded dynamically from Hub
  // (`/api/models/live/markus` → original OpenRouter ids). No static aliases.
];

// ---------------------------------------------------------------------------
// Tier classification helpers
// ---------------------------------------------------------------------------

/**
 * Estimate a quality score (0-100) for a model when no explicit tier is set.
 * Uses pricing as primary signal, parameter count from name as secondary.
 */
export function estimateQualityScore(_modelId: string, reasoning?: boolean, inputCostPer1M?: number): number {
  let score = 40;

  if (inputCostPer1M !== undefined && inputCostPer1M > 0) {
    if (inputCostPer1M >= 3) score = 80;
    else if (inputCostPer1M >= 0.5) score = 55;
    else score = 38;
  }

  const paramMatch = (_modelId ?? '').match(/(\d+)[bB]\b/);
  if (paramMatch) {
    const params = parseInt(paramMatch[1], 10);
    if (params >= 70) score = Math.max(score, 75);
    else if (params >= 30) score = Math.max(score, 55);
    else if (params <= 7) score = Math.min(score, 40);
  }

  if (reasoning && score < 55) score += 10;

  return Math.min(100, score);
}

/** Determine tier from quality score */
export function tierFromQualityScore(score: number): ModelTier {
  if (score >= 75) return 'max';
  if (score >= 50) return 'pro';
  return 'base';
}

/** Determine cost tier badge from input cost per 1M tokens */
export function costTierFromPrice(inputPer1M: number): CostTier {
  if (inputPer1M <= 0) return '$';
  if (inputPer1M < 0.5) return '$';
  if (inputPer1M < 2) return '$$';
  if (inputPer1M < 5) return '$$$';
  return '$$$$';
}

