import { createLogger, getTextContent, LLM_CIRCUIT_RESET_RATE_LIMIT_MS, LLM_MAX_CONCURRENT_PER_PROVIDER, LLM_CONCURRENCY_JITTER_BASE_MS, type LLMRequest, type LLMResponse, type LLMStreamEvent, type LLMProviderConfig, type ModelDefinition, type ModelCostConfig, type EnhancedProviderSettings, type EnhancedLLMSettings, type AuthProfile, type ModelTier, type ModelCapabilityType, type CostTier, type CapabilityRoutingConfig, type CapabilityModelAssignment, type ProviderCapabilities } from '@markus/shared';
import { startSpan } from '../tracing.js';
import type { LLMProviderInterface, MultiModalProviderInterface } from './provider.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider, type TokenResolver } from './openai.js';
import { MiniMaxProvider } from './minimax.js';
import { DashScopeProvider } from './dashscope.js';
import { FireworksProvider } from './fireworks.js';
import { CodexResponsesProvider } from './openai-codex.js';
import { GoogleProvider } from './google.js';
import { OllamaProvider } from './ollama.js';
import { MarkusProvider } from './markus-provider.js';
import { AuthProfileStore } from './auth-profiles.js';
import { OAuthManager } from './oauth-manager.js';
import type { ModelCatalogService } from './model-catalog.js';


const log = createLogger('llm-router');

const CAPABILITY_KEY_MAP: Partial<Record<ModelCapabilityType, keyof ProviderCapabilities>> = {
  image_generation: 'imageGeneration',
  image_recognition: 'vision',
  audio_tts: 'tts',
  audio_stt: 'stt',
  video_generation: 'videoGeneration',
};

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
  private _autoFallback = true;
  /** Health tracked per model: key = "providerName:modelId" */
  private modelHealth = new Map<string, ModelHealth>();
  /** Provider-level degradation for non-retryable (auth/billing) errors */
  private providerDegraded = new Map<string, { degraded: boolean; lastFailureAt: number; resetMs: number }>();
  private customModelConfigs = new Map<string, { contextWindow?: number; maxOutputTokens?: number; cost?: ModelCostConfig }>();
  private customModelCatalog = new Map<string, ModelDefinition[]>();
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
    const msg = error instanceof Error ? error.message : String(error);
    return /\b(401|402|403)\b/.test(msg) ||
      /insufficient balance/i.test(msg) ||
      /not available in your region/i.test(msg) ||
      /invalid.*api.*key/i.test(msg) ||
      /authentication/i.test(msg) ||
      /\b400\b.*invalid_request_error/i.test(msg) ||
      /reasoning_content.*must be passed back/i.test(msg);
  }

  /** Detect rate-limit (429) errors which should use a shorter circuit breaker cooldown. */
  private static isRateLimitError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return /\b429\b/.test(msg) || /rate.limit/i.test(msg);
  }

  /** Detect CU-exhausted errors — return friendly error, do NOT fall back to direct mode. */
  static isCUExceededError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return msg.includes('CU_EXCEEDED:');
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
    let builtinModels = BUILTIN_MODEL_CATALOG.filter(m => m.provider === providerName);
    // For regional aliases, inherit the parent provider's catalog with provider field swapped
    if (builtinModels.length === 0 && REGIONAL_PROVIDER_ALIASES[providerName]) {
      const parent = REGIONAL_PROVIDER_ALIASES[providerName];
      builtinModels = BUILTIN_MODEL_CATALOG.filter(m => m.provider === parent)
        .map(m => ({ ...m, provider: providerName }));
    }
    const customModels = this.customModelCatalog.get(providerName) ?? [];
    const merged = [...builtinModels, ...customModels.filter(cm => !builtinModels.some(bm => bm.id === cm.id))];
    return merged.map(m => this.enrichModelFromCatalog(m));
  }

  /**
   * Overlay live pricing from ModelCatalogService onto a builtin model definition.
   * The catalog (from LiteLLM) is refreshed every 24h so prices stay current.
   */
  private enrichModelFromCatalog(model: ModelDefinition): ModelDefinition {
    if (!this._modelCatalogService) return model;
    // Try exact ID, then provider-prefixed ID
    const catalogEntry = this._modelCatalogService.getModelInfo(model.id)
      ?? this._modelCatalogService.getModelInfo(`${model.provider}/${model.id}`);
    if (!catalogEntry) return model;
    if (catalogEntry.inputCostPer1MTokens <= 0 && catalogEntry.outputCostPer1MTokens <= 0) return model;
    return {
      ...model,
      contextWindow: catalogEntry.maxInputTokens || model.contextWindow,
      maxOutputTokens: catalogEntry.maxOutputTokens || model.maxOutputTokens,
      cost: {
        input: catalogEntry.inputCostPer1MTokens || model.cost?.input || 0,
        output: catalogEntry.outputCostPer1MTokens || model.cost?.output || 0,
        cacheRead: catalogEntry.cacheReadCostPer1MTokens ?? model.cost?.cacheRead,
        cacheWrite: catalogEntry.cacheWriteCostPer1MTokens ?? model.cost?.cacheWrite,
      },
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
    const VALID_CAPABILITY_TYPES: Set<string> = new Set([
      'text', 'image_recognition', 'image_generation',
      'audio_tts', 'audio_stt', 'video_generation',
    ]);

    const incoming = config.assignments ?? {};
    const cleaned: CapabilityRoutingConfig['assignments'] = {};
    for (const [key, val] of Object.entries(incoming)) {
      if (VALID_CAPABILITY_TYPES.has(key)) {
        cleaned[key as ModelCapabilityType] = val;
      } else {
        log.warn('Ignoring invalid capability type in routing assignment', { capabilityType: key });
      }
    }

    this._capabilityRouting = { assignments: { ...this._capabilityRouting.assignments, ...cleaned } };
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
    // 1. Check explicit assignment
    const assignment = this._capabilityRouting.assignments[capabilityType];
    if (assignment) {
      if (this.isAvailable(assignment.provider)) {
        return { provider: assignment.provider, model: assignment.model };
      }
      if (assignment.fallback && this.isAvailable(assignment.fallback.provider)) {
        log.warn(`Capability ${capabilityType} primary ${assignment.provider} unavailable, using fallback`);
        return { provider: assignment.fallback.provider, model: assignment.fallback.model };
      }
      log.warn(`Capability ${capabilityType} assignment ${assignment.provider} unavailable, falling through to default`);
    }

    // 2. Fallback to default model
    if (this._routingDefaultModel && this.providers.has(this._routingDefaultModel.provider) && this.isAvailable(this._routingDefaultModel.provider)) {
      return { provider: this._routingDefaultModel.provider, model: this._routingDefaultModel.model };
    }

    // 3. Final fallback: any available provider
    return { provider: this.selectProvider(request) };
  }

  /**
   * Resolve a provider instance for a non-text modality (image_generation, audio_tts, etc.).
   * Returns the provider and the assigned model name WITHOUT mutating provider state.
   * The caller is responsible for passing `model` into the API call options.
   */
  resolveModalityProvider(capabilityType: ModelCapabilityType): { provider: MultiModalProviderInterface; model?: string } | undefined {
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

    // Fallback: try routingDefaultModel, then defaultProvider
    if (this._routingDefaultModel) {
      const p = this.providers.get(this._routingDefaultModel.provider);
      if (p && this.isAvailable(this._routingDefaultModel.provider)) {
        return { provider: p as MultiModalProviderInterface, model: this._routingDefaultModel.model };
      }
    }
    const p = this.providers.get(this.defaultProvider);
    return p && this.isAvailable(this.defaultProvider) ? { provider: p as MultiModalProviderInterface } : undefined;
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

    // Explicit assignment — always trust the user's choice
    const assignment = this._capabilityRouting.assignments[capabilityType];
    if (assignment) {
      add(assignment.provider, assignment.model);
      if (assignment.fallback) add(assignment.fallback.provider, assignment.fallback.model);
    }

    // routingDefaultModel / defaultProvider are TEXT routing defaults;
    // for non-text tasks, only add them if they actually support the modality.
    if (this._routingDefaultModel) {
      addIfCapable(this._routingDefaultModel.provider, this._routingDefaultModel.model);
    }
    addIfCapable(this.defaultProvider);

    if (this._autoFallback) {
      const order = this.fallbackOrder.length > 0 ? this.fallbackOrder : [...this.providers.keys()];
      for (const name of order) addIfCapable(name);
    }

    return candidates;
  }

  private selectProvider(request: LLMRequest, explicit?: string): string {
    // If an explicit provider is requested AND it is available, honour the request.
    // If it is disabled/degraded, fall through to normal selection so we don't
    // send traffic to a provider the user intentionally turned off.
    if (explicit && this.isAvailable(explicit)) return explicit;
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
    }

    for (const [name, cfg] of Object.entries(configs ?? {})) {
      if (['anthropic', 'openai', 'google', 'ollama', 'markus'].includes(name)) continue;
      if (cfg?.apiKey) {
        router.registerProvider(name, createOpenAICompatible(name, cfg));
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

  private resolveMaxTokens(request: LLMRequest, providerName: string): LLMRequest {
    if (request.maxTokens) return request;
    const catalogMax = this.getModelMaxOutput(providerName);
    if (catalogMax && catalogMax > 4096) {
      return { ...request, maxTokens: catalogMax };
    }
    return request;
  }

  /**
   * Try a chat request on a specific provider, optionally with an alternate model.
   * Returns the response or throws on failure (after recording health).
   */
  private async tryChat(providerName: string, request: LLMRequest, altModel?: string): Promise<{ response: LLMResponse; model: string }> {
    const provider = this.providers.get(providerName)!;
    const originalModel = provider.model;
    if (altModel && altModel !== originalModel) {
      provider.configure({ provider: providerName as any, model: altModel });
    }
    const activeModel = provider.model;
    await this.applyJitter(providerName);
    try {
      const response = await provider.chat(request);
      this.recordSuccess(providerName, activeModel);
      return { response, model: activeModel };
    } catch (error) {
      this.recordFailure(providerName, activeModel, error);
      throw LLMRouter.enrichError(error, providerName, activeModel);
    } finally {
      if (altModel && altModel !== originalModel) {
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
    } else {
      const capabilityType = options?.capabilityType ?? LLMRouter.inferCapability(request);
      if (capabilityType === 'text' && !this._capabilityRouting.assignments.text) {
        primary = this.selectProvider(request);
      } else {
        const routeResult = this.selectForCapability(capabilityType, request, options?.sessionId);
        primary = routeResult.provider;
        routedModel = routeResult.model;
      }
    }

    const provider = this.providers.get(primary);
    if (!provider) {
      throw new Error(`LLM provider not found: ${primary}. Available: ${[...this.providers.keys()].join(', ')}`);
    }
    request = this.resolveMaxTokens(request, primary);

    log.debug(`Sending request to ${primary}`, { model: routedModel ?? provider.model, messageCount: request.messages.length });

    const span = startSpan('llm.chat', { provider: primary, model: routedModel ?? provider.model });
    const startTime = Date.now();
    let lastError: unknown = null;

    // Try primary provider's active model (or routed model)
    try {
      const { response, model } = await this.tryChat(primary, request, routedModel);
      span.end({ inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, finishReason: response.finishReason });
      log.debug(`Response from ${primary}`, { tokens: response.usage, finishReason: response.finishReason });
      this.emitLog(primary, model, request, response, Date.now() - startTime);
      return response;
    } catch (error) {
      lastError = error;
      log.error(`LLM request failed for ${primary}:${routedModel ?? provider.model}`, { error: String(error) });

      // CU_EXCEEDED is fatal — do NOT fall back to other providers
      if (LLMRouter.isCUExceededError(error)) {
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

      // Fallback to other providers
      for (const fallbackName of this.getFallbacks(primary)) {
        const fb = this.providers.get(fallbackName)!;
        log.info(`Falling back to ${fallbackName}`, { model: fb.model });
        try {
          const { response, model } = await this.tryChat(fallbackName, request);
          span.end({ inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, finishReason: response.finishReason });
          log.info(`Fallback to ${fallbackName} succeeded`);
          this.emitLog(fallbackName, model, request, response, Date.now() - startTime);
          return response;
        } catch (fbError) {
          lastError = fbError;
          log.error(`Fallback ${fallbackName} also failed`, { error: String(fbError) });
        }
      }

      span.setError(lastError instanceof Error ? lastError : String(lastError));
      span.end();
      throw lastError;
    }
  }

  /**
   * Direct chat with a specific provider — no fallback, no auto-select.
   * Used by the test endpoint to verify a single provider's connectivity.
   * Also returns the baseUrl used for diagnostics.
   */
  async chatDirect(request: LLMRequest, providerName: string): Promise<LLMResponse & { _providerBaseUrl?: string }> {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Provider "${providerName}" not registered`);
    }
    if (this.disabledProviders.has(providerName)) {
      throw new Error(`Provider "${providerName}" is disabled`);
    }
    request = this.resolveMaxTokens(request, providerName);
    const response = await provider.chat(request);
    const baseUrl = (provider as any).baseUrl ?? (provider as any).config?.baseUrl;
    return Object.assign(response, { _providerBaseUrl: baseUrl });
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
    if (altModel && altModel !== originalModel) {
      provider.configure({ provider: providerName as any, model: altModel });
    }
    const activeModel = provider.model;
    await this.applyJitter(providerName);
    try {
      let response: LLMResponse;
      if (provider.chatStream) {
        response = await provider.chatStream(request, onEvent, signal);
      } else {
        response = await provider.chat(request);
        if (response.content) onEvent({ type: 'text_delta', text: response.content });
        onEvent({ type: 'message_end', usage: response.usage, finishReason: response.finishReason });
      }
      this.recordSuccess(providerName, activeModel);
      return { response, model: activeModel };
    } catch (error) {
      this.recordFailure(providerName, activeModel, error);
      throw LLMRouter.enrichError(error, providerName, activeModel);
    } finally {
      if (altModel && altModel !== originalModel) {
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
    } else {
      const capabilityType = options?.capabilityType ?? LLMRouter.inferCapability(request);
      if (capabilityType === 'text' && !this._capabilityRouting.assignments.text) {
        primary = this.selectProvider(request);
      } else {
        const routeResult = this.selectForCapability(capabilityType, request, options?.sessionId);
        primary = routeResult.provider;
        routedModel = routeResult.model;
      }
    }

    const provider = this.providers.get(primary);
    if (!provider) {
      throw new Error(`LLM provider not found: ${primary}. Available: ${[...this.providers.keys()].join(', ')}`);
    }
    request = this.resolveMaxTokens(request, primary);

    const span = startSpan('llm.chatStream', { provider: primary, model: routedModel ?? provider.model });
    const startTime = Date.now();

    let lastError: unknown = null;

    // Try primary provider's routed model (or its default model)
    try {
      const { response, model } = await this.tryStream(primary, request, onEvent, signal, routedModel);
      span.end({ inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, finishReason: response.finishReason });
      this.emitLog(primary, model, request, response, Date.now() - startTime);
      return response;
    } catch (error) {
      lastError = error;
      if (signal?.aborted) {
        span.setError(lastError instanceof Error ? lastError : String(lastError));
        span.end();
        throw lastError;
      }
      log.error(`LLM stream request failed for ${primary}:${provider.model}`, { error: String(error) });

      // CU_EXCEEDED is fatal — do NOT fall back to other providers
      if (LLMRouter.isCUExceededError(error)) {
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

      // Fallback to other providers
      for (const fallbackName of this.getFallbacks(primary)) {
        log.info(`Stream fallback to ${fallbackName}`);
        try {
          const { response, model } = await this.tryStream(fallbackName, request, onEvent, signal);
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

      span.setError(lastError instanceof Error ? lastError : String(lastError));
      span.end();
      throw lastError;
    }
  }

  getProvider(name: string): LLMProviderInterface | undefined {
    return this.providers.get(name);
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

    // Re-run tier configuration with the new default
    const providerNames = this.listProviders();
    if (this.autoSelect && providerNames.length > 1) {
      this.providerTiers = buildTiers(providerNames, name);
      this.fallbackOrder = [name, ...providerNames.filter(n => n !== name)];
    }
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

    return { defaultProvider: this.defaultProvider, autoFallback: this._autoFallback, providers };
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
   */
  getActiveModelContextWindow(): number {
    return this.getModelContextWindow();
  }

  getModelContextWindow(providerName?: string): number {
    const name = providerName ?? this.defaultProvider;
    const provider = this.providers.get(name);
    if (!provider) return 64000;
    const custom = this.customModelConfigs.get(name);
    if (custom?.contextWindow) return custom.contextWindow;
    const catalogEntry = BUILTIN_MODEL_CATALOG.find(m => m.id === provider.model || m.provider === name)
      ?? this.customModelCatalog.get(name)?.find(m => m.id === provider.model);
    return catalogEntry?.contextWindow ?? 64000;
  }

  getActiveModelMaxOutput(): number {
    return this.getModelMaxOutput();
  }

  getModelMaxOutput(providerName?: string): number {
    const name = providerName ?? this.defaultProvider;
    const provider = this.providers.get(name);
    if (!provider) return 4096;
    const custom = this.customModelConfigs.get(name);
    if (custom?.maxOutputTokens) return custom.maxOutputTokens;
    const catalogEntry = BUILTIN_MODEL_CATALOG.find(m => m.id === provider.model || m.provider === name)
      ?? this.customModelCatalog.get(name)?.find(m => m.id === provider.model);
    return catalogEntry?.maxOutputTokens ?? 4096;
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
    const catalogEntry = BUILTIN_MODEL_CATALOG.find(m => m.id === provider.model && m.provider === name)
      ?? BUILTIN_MODEL_CATALOG.find(m => m.id === provider.model)
      ?? this.customModelCatalog.get(name)?.find(m => m.id === provider.model);
    return catalogEntry?.cost;
  }

  getModelInputTypes(providerName?: string): Array<'text' | 'image'> {
    const name = providerName ?? this.defaultProvider;
    const provider = this.providers.get(name);
    if (!provider) return ['text'];
    const catalogEntry = BUILTIN_MODEL_CATALOG.find(m => m.id === provider.model && m.provider === name)
      ?? BUILTIN_MODEL_CATALOG.find(m => m.id === provider.model)
      ?? this.customModelCatalog.get(name)?.find(m => m.id === provider.model);
    return catalogEntry?.inputTypes ?? ['text', 'image'];
  }

  modelSupportsVision(providerName?: string): boolean {
    return this.getModelInputTypes(providerName).includes('image');
  }

  isAutoSelectEnabled(): boolean {
    return this.autoSelect;
  }

  /**
   * Check if the active provider supports Anthropic server-side compaction.
   * Only Claude Opus 4.x and Sonnet 4.x models support the compact_20260112 beta.
   */
  isCompactionSupported(providerName?: string): boolean {
    const name = providerName ?? this.defaultProvider;
    const provider = this.providers.get(name);
    if (!provider) return false;
    return provider.model.startsWith('claude-opus-4') || provider.model.startsWith('claude-sonnet-4');
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
  // Anthropic — https://docs.anthropic.com/claude/reference/input-and-output-sizes
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'anthropic', contextWindow: 1000000, maxOutputTokens: 128000, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, reasoning: true, inputTypes: ['text', 'image'], tier: 'max' },
  { id: 'claude-sonnet-4-6-20260514', name: 'Claude Sonnet 4.6', provider: 'anthropic', contextWindow: 1000000, maxOutputTokens: 64000, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, reasoning: false, inputTypes: ['text', 'image'], tier: 'max' },
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4 (legacy)', provider: 'anthropic', contextWindow: 200000, maxOutputTokens: 64000, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, reasoning: false, inputTypes: ['text', 'image'], tier: 'pro' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: 'anthropic', contextWindow: 200000, maxOutputTokens: 64000, cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }, reasoning: false, inputTypes: ['text', 'image'], tier: 'pro' },
  { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku (legacy)', provider: 'anthropic', contextWindow: 200000, maxOutputTokens: 64000, cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }, reasoning: false, inputTypes: ['text', 'image'], tier: 'base' },
  // OpenAI — https://developers.openai.com/api/docs/models
  { id: 'gpt-5.4', name: 'GPT-5.4', provider: 'openai', contextWindow: 1100000, maxOutputTokens: 128000, cost: { input: 2.5, output: 15, cacheRead: 0.25 }, reasoning: true, inputTypes: ['text', 'image'], tier: 'max' },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', contextWindow: 128000, maxOutputTokens: 16384, cost: { input: 2.5, output: 10 }, reasoning: false, inputTypes: ['text', 'image'], tier: 'max' },
  { id: 'o4-mini', name: 'o4-mini', provider: 'openai', contextWindow: 200000, maxOutputTokens: 100000, cost: { input: 1.1, output: 4.4 }, reasoning: true, inputTypes: ['text', 'image'], tier: 'pro' },
  // OpenAI Multimodal — image, TTS, STT
  { id: 'gpt-image-1', name: 'GPT Image 1', provider: 'openai', contextWindow: 0, maxOutputTokens: 0, cost: { input: 0, output: 0 }, inputTypes: [], tier: 'pro', capabilities: ['imageGeneration'] },
  { id: 'dall-e-3', name: 'DALL-E 3', provider: 'openai', contextWindow: 0, maxOutputTokens: 0, cost: { input: 0, output: 0 }, inputTypes: [], tier: 'pro', capabilities: ['imageGeneration'] },
  { id: 'tts-1-hd', name: 'TTS-1 HD', provider: 'openai', contextWindow: 0, maxOutputTokens: 0, cost: { input: 0, output: 0 }, inputTypes: [], tier: 'pro', capabilities: ['tts'] },
  { id: 'tts-1', name: 'TTS-1', provider: 'openai', contextWindow: 0, maxOutputTokens: 0, cost: { input: 0, output: 0 }, inputTypes: [], tier: 'base', capabilities: ['tts'] },
  { id: 'whisper-1', name: 'Whisper-1', provider: 'openai', contextWindow: 0, maxOutputTokens: 0, cost: { input: 0, output: 0 }, inputTypes: [], tier: 'pro', capabilities: ['stt'] },
  // OpenAI Codex (OAuth — uses ChatGPT subscription)
  { id: 'gpt-5.5', name: 'GPT-5.5 (Codex)', provider: 'openai-codex', contextWindow: 1100000, maxOutputTokens: 128000, cost: { input: 0, output: 0 }, reasoning: true, inputTypes: ['text', 'image'], tier: 'max', description: 'Uses ChatGPT subscription via OAuth' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini (Codex)', provider: 'openai-codex', contextWindow: 512000, maxOutputTokens: 64000, cost: { input: 0, output: 0 }, reasoning: true, inputTypes: ['text', 'image'], tier: 'pro', description: 'Uses ChatGPT subscription via OAuth — fast' },
  { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Spark (Codex)', provider: 'openai-codex', contextWindow: 128000, maxOutputTokens: 64000, cost: { input: 0, output: 0 }, reasoning: false, inputTypes: ['text', 'image'], tier: 'base', description: 'Uses ChatGPT subscription via OAuth — Pro only, real-time' },
  // Google — https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini
  { id: 'gemini-3-1-pro', name: 'Gemini 3.1 Pro', provider: 'google', contextWindow: 1000000, maxOutputTokens: 65536, cost: { input: 2, output: 12 }, reasoning: true, inputTypes: ['text', 'image'], tier: 'max' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google', contextWindow: 1048576, maxOutputTokens: 65536, cost: { input: 0.30, output: 2.50 }, reasoning: true, inputTypes: ['text', 'image'], tier: 'pro' },
  // Google Multimodal — image, video
  { id: 'imagen-3.0-generate-002', name: 'Imagen 3', provider: 'google', contextWindow: 0, maxOutputTokens: 0, cost: { input: 0, output: 0 }, inputTypes: [], tier: 'pro', capabilities: ['imageGeneration'] },
  { id: 'veo-2.0-generate-001', name: 'Veo 2', provider: 'google', contextWindow: 0, maxOutputTokens: 0, cost: { input: 0, output: 0 }, inputTypes: [], tier: 'max', capabilities: ['videoGeneration'] },
  // MiniMax Global — https://platform.minimax.io
  { id: 'MiniMax-M3', name: 'MiniMax M3', provider: 'minimax', contextWindow: 512000, maxOutputTokens: 128000, cost: { input: 0.6, output: 2.4, cacheRead: 0.12 }, reasoning: true, inputTypes: ['text', 'image'], tier: 'max' },
  { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', provider: 'minimax', contextWindow: 204800, maxOutputTokens: 128000, cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 }, reasoning: true, inputTypes: ['text'], tier: 'pro' },
  { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', provider: 'minimax', contextWindow: 1000000, maxOutputTokens: 128000, cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.375 }, reasoning: true, inputTypes: ['text'], tier: 'base' },
  // MiniMax Multimodal — image, TTS, video
  { id: 'image-01', name: 'MiniMax Image-01', provider: 'minimax', contextWindow: 0, maxOutputTokens: 0, cost: { input: 0, output: 0 }, inputTypes: [], tier: 'pro', capabilities: ['imageGeneration'] },
  { id: 'speech-02-hd', name: 'MiniMax Speech-02-HD', provider: 'minimax', contextWindow: 0, maxOutputTokens: 0, cost: { input: 0, output: 0 }, inputTypes: [], tier: 'pro', capabilities: ['tts'] },
  { id: 'speech-02', name: 'MiniMax Speech-02', provider: 'minimax', contextWindow: 0, maxOutputTokens: 0, cost: { input: 0, output: 0 }, inputTypes: [], tier: 'base', capabilities: ['tts'] },
  { id: 'MiniMax-Hailuo-2.3', name: 'Hailuo 2.3', provider: 'minimax', contextWindow: 0, maxOutputTokens: 0, cost: { input: 0, output: 0 }, inputTypes: [], tier: 'max', capabilities: ['videoGeneration'] },
  { id: 'MiniMax-Hailuo-2.3-Fast', name: 'Hailuo 2.3 Fast', provider: 'minimax', contextWindow: 0, maxOutputTokens: 0, cost: { input: 0, output: 0 }, inputTypes: [], tier: 'pro', capabilities: ['videoGeneration'] },
  // MiniMax China shares the same models as MiniMax Global (resolved via REGIONAL_PROVIDER_ALIASES)
  // OpenRouter — https://openrouter.ai/models (pass-through pricing varies by upstream provider)
  { id: 'xiaomi/mimo-v2-pro', name: 'MiMo-V2-Pro', provider: 'openrouter', contextWindow: 1048576, maxOutputTokens: 131072, cost: { input: 1, output: 3, cacheRead: 0.2 }, reasoning: true, inputTypes: ['text'], tier: 'pro' },
  { id: 'anthropic/claude-opus-4-6', name: 'Claude Opus 4.6 (via OpenRouter)', provider: 'openrouter', contextWindow: 1000000, maxOutputTokens: 128000, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, reasoning: true, inputTypes: ['text', 'image'], tier: 'max' },
  { id: 'openai/gpt-5.4', name: 'GPT-5.4 (via OpenRouter)', provider: 'openrouter', contextWindow: 1100000, maxOutputTokens: 128000, cost: { input: 2.5, output: 15, cacheRead: 0.25 }, reasoning: true, inputTypes: ['text', 'image'], tier: 'max' },
  { id: 'google/gemini-3-1-pro', name: 'Gemini 3.1 Pro (via OpenRouter)', provider: 'openrouter', contextWindow: 1000000, maxOutputTokens: 65536, cost: { input: 2, output: 12 }, reasoning: true, inputTypes: ['text', 'image'], tier: 'max' },
  // DeepSeek — https://api-docs.deepseek.com/
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', provider: 'deepseek', contextWindow: 1000000, maxOutputTokens: 384000, cost: { input: 0.14, output: 0.28, cacheRead: 0.0028 }, reasoning: true, inputTypes: ['text'], tier: 'pro' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', provider: 'deepseek', contextWindow: 1000000, maxOutputTokens: 384000, cost: { input: 0.435, output: 0.87, cacheRead: 0.003625 }, reasoning: true, inputTypes: ['text'], tier: 'max' },
  { id: 'deepseek-chat', name: 'DeepSeek-Chat (legacy)', provider: 'deepseek', contextWindow: 1000000, maxOutputTokens: 384000, cost: { input: 0.14, output: 0.28, cacheRead: 0.0028 }, reasoning: false, inputTypes: ['text'], tier: 'base' },
  { id: 'deepseek-reasoner', name: 'DeepSeek-Reasoner (legacy)', provider: 'deepseek', contextWindow: 1000000, maxOutputTokens: 384000, cost: { input: 0.14, output: 0.28, cacheRead: 0.0028 }, reasoning: true, inputTypes: ['text'], tier: 'base' },
  // SiliconFlow China — https://docs.siliconflow.cn/docs/model-library
  { id: 'Qwen/Qwen3.5-35B-A3B', name: 'Qwen3.5-35B-A3B', provider: 'siliconflow', contextWindow: 131072, maxOutputTokens: 8192, cost: { input: 0.24, output: 1.80 }, reasoning: true, inputTypes: ['text'], tier: 'pro' },
  { id: 'Qwen/Qwen3.5-122B-A10B', name: 'Qwen3.5-122B-A10B', provider: 'siliconflow', contextWindow: 262144, maxOutputTokens: 262144, cost: { input: 0.26, output: 2.08 }, reasoning: true, inputTypes: ['text', 'image'], tier: 'max' },
  { id: 'Qwen/Qwen3.5-27B', name: 'Qwen3.5-27B', provider: 'siliconflow', contextWindow: 262144, maxOutputTokens: 262144, cost: { input: 0.25, output: 2.00 }, reasoning: true, inputTypes: ['text'], tier: 'pro' },
  { id: 'Qwen/Qwen3.5-9B', name: 'Qwen3.5-9B', provider: 'siliconflow', contextWindow: 262144, maxOutputTokens: 262144, cost: { input: 0.10, output: 0.15 }, reasoning: true, inputTypes: ['text'], tier: 'base' },
  { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek-V3 (via SiliconFlow)', provider: 'siliconflow', contextWindow: 163840, maxOutputTokens: 163840, cost: { input: 0.25, output: 1.00 }, reasoning: false, inputTypes: ['text'], tier: 'base' },
  { id: 'deepseek-ai/DeepSeek-V3.2', name: 'DeepSeek-V3.2 (via SiliconFlow)', provider: 'siliconflow', contextWindow: 163840, maxOutputTokens: 163840, cost: { input: 0.27, output: 0.42 }, reasoning: false, inputTypes: ['text'], tier: 'base' },
  { id: 'moonshotai/Kimi-K2.5', name: 'Kimi-K2.5 (via SiliconFlow)', provider: 'siliconflow', contextWindow: 131072, maxOutputTokens: 8192, cost: { input: 0.60, output: 3.00 }, reasoning: true, inputTypes: ['text'], tier: 'pro' },
  // SiliconFlow Multimodal — STT
  { id: 'FunAudioLLM/SenseVoiceSmall', name: 'SenseVoice Small', provider: 'siliconflow', contextWindow: 0, maxOutputTokens: 0, cost: { input: 0, output: 0 }, inputTypes: [], tier: 'pro', capabilities: ['stt'] },
  // SiliconFlow Global shares the same models as SiliconFlow China (resolved via REGIONAL_PROVIDER_ALIASES)
  // ZAI (Zhipu) — https://docs.z.ai/guides/overview/pricing
  { id: 'glm-5.1', name: 'GLM-5.1', provider: 'zai', contextWindow: 200000, maxOutputTokens: 16384, cost: { input: 1.4, output: 4.4, cacheRead: 0.26 }, reasoning: true, inputTypes: ['text'], tier: 'max' },
  { id: 'glm-5', name: 'GLM-5', provider: 'zai', contextWindow: 205000, maxOutputTokens: 16384, cost: { input: 1.0, output: 3.2, cacheRead: 0.2 }, reasoning: true, inputTypes: ['text', 'image'], tier: 'pro' },
  { id: 'glm-4.7-flashx', name: 'GLM-4.7 FlashX', provider: 'zai', contextWindow: 200000, maxOutputTokens: 16384, cost: { input: 0.07, output: 0.4 }, reasoning: true, inputTypes: ['text'], tier: 'base' },
  // Markus (token-billing gateway — routes through CF Worker Proxy)
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash (Markus)', provider: 'markus', contextWindow: 200000, maxOutputTokens: 64000, cost: { input: 0.10, output: 0.40, cacheRead: 0.01 }, reasoning: false, inputTypes: ['text', 'image'], tier: 'base', description: 'Via Markus billing gateway (1x CU)' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro (Markus)', provider: 'markus', contextWindow: 200000, maxOutputTokens: 64000, cost: { input: 0.30, output: 1.20, cacheRead: 0.03 }, reasoning: true, inputTypes: ['text', 'image'], tier: 'pro', description: 'Via Markus billing gateway (3x CU)' },
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

