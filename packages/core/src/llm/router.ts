import { createLogger, getTextContent, LLM_CIRCUIT_RESET_RATE_LIMIT_MS, LLM_MAX_CONCURRENT_PER_PROVIDER, LLM_CONCURRENCY_JITTER_BASE_MS, type LLMRequest, type LLMResponse, type LLMStreamEvent, type LLMProviderConfig, type ModelDefinition, type ModelCostConfig, type EnhancedProviderSettings, type EnhancedLLMSettings, type AuthProfile } from '@markus/shared';
import { startSpan } from '../tracing.js';
import type { LLMProviderInterface } from './provider.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { GoogleProvider } from './google.js';
import { OllamaProvider } from './ollama.js';
import { AuthProfileStore } from './auth-profiles.js';
import { OAuthManager } from './oauth-manager.js';

const log = createLogger('llm-router');

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
      // OpenAI-compatible providers (siliconflow, minimax, etc.)
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

    const providerConfig: LLMProviderConfig = {
      provider: (config?.provider ?? name) as any,
      model: config?.model ?? 'gpt-5.4',
      baseUrl: config?.baseUrl ?? 'https://api.openai.com',
      maxTokens: config?.maxTokens,
      timeoutMs: config?.timeoutMs,
    };

    const provider = new OpenAIProvider(
      { ...providerConfig, provider: name as any },
      async () => oauthMgr.getValidToken(profileId),
    );

    this.registerProvider(name, provider);
    log.info(`Registered OAuth-backed provider: ${name}`, { profileId, model: providerConfig.model });
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
    return /\b(402|403|401)\b/.test(msg) ||
      /insufficient balance/i.test(msg) ||
      /not available in your region/i.test(msg) ||
      /invalid.*api.*key/i.test(msg) ||
      /authentication/i.test(msg);
  }

  /** Detect rate-limit (429) errors which should use a shorter circuit breaker cooldown. */
  private static isRateLimitError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return /\b429\b/.test(msg) || /rate.limit/i.test(msg);
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

  /** Get all model definitions for a provider (builtin + custom) */
  private getProviderModels(providerName: string): ModelDefinition[] {
    const builtinModels = BUILTIN_MODEL_CATALOG.filter(m => m.provider === providerName);
    const customModels = this.customModelCatalog.get(providerName) ?? [];
    return [...builtinModels, ...customModels.filter(cm => !builtinModels.some(bm => bm.id === cm.id))];
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
    } else {
      provider = new OpenAIProvider({ ...config, provider: name as any });
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

  static assessComplexity(request: LLMRequest): ComplexityLevel {
    const totalChars = request.messages.reduce((s, m) => s + getTextContent(m.content).length, 0);
    const toolCount = request.tools?.length ?? 0;
    const msgCount = request.messages.length;

    if (toolCount > 5 || totalChars > 8000 || msgCount > 15) return 'complex';
    if (toolCount > 0 || totalChars > 2000 || msgCount > 5) return 'moderate';
    return 'simple';
  }

  private selectProvider(request: LLMRequest, explicit?: string): string {
    if (explicit) return explicit;

    if (!this.autoSelect || this.providerTiers.length === 0) {
      // No tiers — use defaultProvider if available, otherwise any healthy provider
      if (this.isAvailable(this.defaultProvider) && this.providers.has(this.defaultProvider)) {
        return this.defaultProvider;
      }
      const healthy = [...this.providers.keys()].find(n => this.isAvailable(n));
      return healthy ?? this.defaultProvider;
    }

    const complexity = LLMRouter.assessComplexity(request);

    // Find first healthy tiered provider for this complexity
    const match = this.providerTiers.find(t =>
      t.complexity.includes(complexity) &&
      this.providers.has(t.name) &&
      this.isAvailable(t.name),
    );

    if (match) {
      log.debug(`Auto-selected provider: ${match.name}`, { complexity });
      return match.name;
    }

    // All tiered providers degraded — fall back to any healthy provider
    const healthy = [...this.providers.keys()].find(n => this.isAvailable(n));
    if (healthy) {
      log.warn(`All tiered providers degraded for complexity=${complexity}, falling back to: ${healthy}`);
      return healthy;
    }

    // Everything degraded — last resort, will likely fail but worth trying
    log.warn('All providers degraded — using default as last resort');
    return this.defaultProvider;
  }

  private getFallbacks(primary: string): string[] {
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

    for (const [name, cfg] of Object.entries(configs ?? {})) {
      if (['anthropic', 'openai', 'google', 'ollama'].includes(name)) continue;
      if (cfg?.apiKey) {
        router.registerProvider(name, new OpenAIProvider(cfg));
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
      if (altModel && altModel !== originalModel) {
        provider.configure({ provider: providerName as any, model: originalModel });
      }
      throw LLMRouter.enrichError(error, providerName, activeModel);
    } finally {
      this.releaseInflight(providerName);
    }
  }

  async chat(request: LLMRequest, providerName?: string): Promise<LLMResponse> {
    const primary = this.selectProvider(request, providerName);
    const provider = this.providers.get(primary);
    if (!provider) {
      throw new Error(`LLM provider not found: ${primary}. Available: ${[...this.providers.keys()].join(', ')}`);
    }
    request = this.resolveMaxTokens(request, primary);

    log.debug(`Sending request to ${primary}`, { model: provider.model, messageCount: request.messages.length });

    const span = startSpan('llm.chat', { provider: primary, model: provider.model });
    const startTime = Date.now();
    let lastError: unknown = null;

    // Try primary provider's active model
    try {
      const { response, model } = await this.tryChat(primary, request);
      span.end({ inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, finishReason: response.finishReason });
      log.debug(`Response from ${primary}`, { tokens: response.usage, finishReason: response.finishReason });
      this.emitLog(primary, model, request, response, Date.now() - startTime);
      return response;
    } catch (error) {
      lastError = error;
      log.error(`LLM request failed for ${primary}:${provider.model}`, { error: String(error) });

      // Try alternate models on the same provider
      if (!LLMRouter.isNonRetryableError(error)) {
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
      if (altModel && altModel !== originalModel) {
        provider.configure({ provider: providerName as any, model: originalModel });
      }
      throw LLMRouter.enrichError(error, providerName, activeModel);
    } finally {
      this.releaseInflight(providerName);
    }
  }

  async chatStream(request: LLMRequest, onEvent: (event: LLMStreamEvent) => void, providerName?: string, signal?: AbortSignal): Promise<LLMResponse> {
    const primary = this.selectProvider(request, providerName);
    const provider = this.providers.get(primary);
    if (!provider) {
      throw new Error(`LLM provider not found: ${primary}. Available: ${[...this.providers.keys()].join(', ')}`);
    }
    request = this.resolveMaxTokens(request, primary);

    const span = startSpan('llm.chatStream', { provider: primary, model: provider.model });
    const startTime = Date.now();

    let lastError: unknown = null;

    // Try primary provider's active model
    try {
      const { response, model } = await this.tryStream(primary, request, onEvent, signal);
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

      // Try alternate models on the same provider
      if (!LLMRouter.isNonRetryableError(error)) {
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
    for (const name of ['anthropic', 'openai', 'openai-codex', 'google', 'ollama', 'minimax', 'siliconflow', 'openrouter', 'zai']) {
      if (!providers[name]) {
        providers[name] = { model: '', configured: false };
      }
    }
    return { defaultProvider: this.defaultProvider, providers };
  }

  getEnhancedSettings(): EnhancedLLMSettings {
    const providers: Record<string, EnhancedProviderSettings> = {};

    for (const [name, p] of this.providers.entries()) {
      const modelDef = BUILTIN_MODEL_CATALOG.find(m => m.id === p.model || m.provider === name);
      const customModels = this.customModelConfigs.get(name);
      const oauthProfile = this._profileStore?.getDefaultProfile(name);
      const builtinModels = BUILTIN_MODEL_CATALOG.filter(m => m.provider === name);
      const customCatalogModels = this.customModelCatalog.get(name) ?? [];
      const mergedModels = [...builtinModels, ...customCatalogModels.filter(cm => !builtinModels.some(bm => bm.id === cm.id))];
      providers[name] = {
        name,
        displayName: PROVIDER_DISPLAY_NAMES[name] ?? name,
        model: p.model,
        baseUrl: (p as any).baseUrl,
        configured: true,
        enabled: this.isProviderEnabled(name),
        contextWindow: customModels?.contextWindow ?? modelDef?.contextWindow,
        maxOutputTokens: customModels?.maxOutputTokens ?? modelDef?.maxOutputTokens,
        cost: customModels?.cost ?? modelDef?.cost,
        models: mergedModels,
        authType: oauthProfile?.authType,
        oauthConnected: oauthProfile?.authType === 'oauth' && !!oauthProfile?.oauth,
        oauthAccountId: oauthProfile?.oauth?.accountId,
      };
    }

    for (const name of ['anthropic', 'openai', 'openai-codex', 'google', 'ollama', 'minimax', 'siliconflow', 'openrouter', 'zai']) {
      if (!providers[name]) {
        const oauthProfile = this._profileStore?.getDefaultProfile(name);
        const builtinModels = BUILTIN_MODEL_CATALOG.filter(m => m.provider === name);
        const customCatalogModels = this.customModelCatalog.get(name) ?? [];
        const mergedModels = [...builtinModels, ...customCatalogModels.filter(cm => !builtinModels.some(bm => bm.id === cm.id))];
        providers[name] = {
          name,
          displayName: PROVIDER_DISPLAY_NAMES[name] ?? name,
          model: '',
          configured: false,
          enabled: this.isProviderEnabled(name),
          models: mergedModels,
          authType: oauthProfile?.authType,
          oauthConnected: oauthProfile?.authType === 'oauth' && !!oauthProfile?.oauth,
          oauthAccountId: oauthProfile?.oauth?.accountId,
        };
      }
    }

    return { defaultProvider: this.defaultProvider, providers };
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
    }
    log.info(`Provider ${providerName} ${enabled ? 'enabled' : 'disabled'}`);
  }

  isProviderEnabled(providerName: string): boolean {
    return !this.disabledProviders.has(providerName);
  }

  getModelCatalog(): ModelDefinition[] {
    const all = [...BUILTIN_MODEL_CATALOG];
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
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-codex': 'OpenAI Codex (OAuth)',
  google: 'Google Gemini',
  ollama: 'Ollama (Local)',
  siliconflow: 'SiliconFlow',
  minimax: 'MiniMax',
  openrouter: 'OpenRouter',
  zai: 'ZAI',
};

// Sources:
// - Anthropic: https://docs.anthropic.com/claude/reference/input-and-output-sizes
// - OpenAI: https://developers.openai.com/api/docs/models
// - Google: https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini
// - MiniMax: https://platform.minimax.io/docs/api-reference/api-overview
const BUILTIN_MODEL_CATALOG: ModelDefinition[] = [
  // Anthropic — https://docs.anthropic.com/claude/reference/input-and-output-sizes
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'anthropic', contextWindow: 1000000, maxOutputTokens: 128000, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, reasoning: true, inputTypes: ['text', 'image'] },
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'anthropic', contextWindow: 200000, maxOutputTokens: 64000, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, reasoning: false, inputTypes: ['text', 'image'] },
  { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', provider: 'anthropic', contextWindow: 200000, maxOutputTokens: 64000, cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }, reasoning: false, inputTypes: ['text', 'image'] },
  // OpenAI — https://developers.openai.com/api/docs/models
  { id: 'gpt-5.4', name: 'GPT-5.4', provider: 'openai', contextWindow: 1100000, maxOutputTokens: 128000, cost: { input: 2.5, output: 15, cacheRead: 0.25 }, reasoning: true, inputTypes: ['text', 'image'] },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', contextWindow: 128000, maxOutputTokens: 16384, cost: { input: 2.5, output: 10 }, reasoning: false, inputTypes: ['text', 'image'] },
  { id: 'o4-mini', name: 'o4-mini', provider: 'openai', contextWindow: 200000, maxOutputTokens: 100000, cost: { input: 1.1, output: 4.4 }, reasoning: true, inputTypes: ['text', 'image'] },
  // OpenAI Codex (OAuth — uses ChatGPT subscription)
  { id: 'gpt-5.4', name: 'GPT-5.4 (Codex)', provider: 'openai-codex', contextWindow: 1100000, maxOutputTokens: 128000, cost: { input: 0, output: 0 }, reasoning: true, inputTypes: ['text', 'image'], description: 'Uses ChatGPT subscription via OAuth' },
  { id: 'gpt-4o', name: 'GPT-4o (Codex)', provider: 'openai-codex', contextWindow: 128000, maxOutputTokens: 16384, cost: { input: 0, output: 0 }, reasoning: false, inputTypes: ['text', 'image'], description: 'Uses ChatGPT subscription via OAuth' },
  // Google — https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini
  { id: 'gemini-3-1-pro', name: 'Gemini 3.1 Pro', provider: 'google', contextWindow: 1000000, maxOutputTokens: 65536, cost: { input: 2, output: 12 }, reasoning: true, inputTypes: ['text', 'image'] },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google', contextWindow: 1048576, maxOutputTokens: 65536, cost: { input: 0.15, output: 0.6 }, reasoning: true, inputTypes: ['text', 'image'] },
  // MiniMax — https://platform.minimax.io/docs/api-reference/api-overview
  { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', provider: 'minimax', contextWindow: 204800, maxOutputTokens: 128000, cost: { input: 0.3, output: 1.2 }, reasoning: true, inputTypes: ['text'] },
  { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', provider: 'minimax', contextWindow: 204800, maxOutputTokens: 128000, cost: { input: 0.2, output: 0.95 }, reasoning: false, inputTypes: ['text'] },
  // OpenRouter — https://openrouter.ai/models (pass-through pricing varies by upstream provider)
  { id: 'xiaomi/mimo-v2-pro', name: 'MiMo-V2-Pro', provider: 'openrouter', contextWindow: 1048576, maxOutputTokens: 131072, cost: { input: 1, output: 3, cacheRead: 0.2 }, reasoning: true, inputTypes: ['text'] },
  { id: 'anthropic/claude-opus-4-6', name: 'Claude Opus 4.6 (via OpenRouter)', provider: 'openrouter', contextWindow: 1000000, maxOutputTokens: 128000, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, reasoning: true, inputTypes: ['text', 'image'] },
  { id: 'openai/gpt-5.4', name: 'GPT-5.4 (via OpenRouter)', provider: 'openrouter', contextWindow: 1100000, maxOutputTokens: 128000, cost: { input: 2.5, output: 15, cacheRead: 0.25 }, reasoning: true, inputTypes: ['text', 'image'] },
  { id: 'google/gemini-3-1-pro', name: 'Gemini 3.1 Pro (via OpenRouter)', provider: 'openrouter', contextWindow: 1000000, maxOutputTokens: 65536, cost: { input: 2, output: 12 }, reasoning: true, inputTypes: ['text', 'image'] },
];
