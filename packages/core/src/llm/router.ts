import { createLogger, type LLMRequest, type LLMResponse, type LLMStreamEvent, type LLMProviderConfig, type ModelDefinition, type ModelCostConfig, type EnhancedProviderSettings, type EnhancedLLMSettings } from '@markus/shared';
import type { LLMProviderInterface } from './provider.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { GoogleProvider } from './google.js';
import { OllamaProvider } from './ollama.js';

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
 * - All other OpenAI-compatible providers (deepseek, siliconflow, openrouter, etc.)
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
      // OpenAI-compatible providers (deepseek, siliconflow, openrouter, etc.)
      tiers.push({ name, complexity: ['simple', 'moderate'] });
    }
  }

  return tiers;
}

interface ProviderHealth {
  consecutiveFailures: number;
  lastFailureAt: number;
  degraded: boolean;
}

export class LLMRouter {
  private providers = new Map<string, LLMProviderInterface>();
  private defaultProvider: string;
  private autoSelect = false;
  private providerTiers: ProviderTier[] = [];
  private fallbackOrder: string[] = [];
  private health = new Map<string, ProviderHealth>();
  private customModelConfigs = new Map<string, { contextWindow?: number; maxOutputTokens?: number; cost?: ModelCostConfig }>();

  // After this many consecutive failures, mark provider as degraded and skip it
  private readonly CIRCUIT_OPEN_AFTER = 2;
  // How long (ms) to keep a provider degraded before retrying
  private readonly CIRCUIT_RESET_MS = 5 * 60 * 1000;

  constructor(defaultProvider?: string) {
    this.defaultProvider = defaultProvider ?? 'anthropic';
  }

  get defaultProviderName(): string {
    return this.defaultProvider;
  }

  private getHealth(name: string): ProviderHealth {
    if (!this.health.has(name)) {
      this.health.set(name, { consecutiveFailures: 0, lastFailureAt: 0, degraded: false });
    }
    return this.health.get(name)!;
  }

  private recordSuccess(name: string): void {
    const h = this.getHealth(name);
    h.consecutiveFailures = 0;
    h.degraded = false;
  }

  private recordFailure(name: string): void {
    const h = this.getHealth(name);
    h.consecutiveFailures++;
    h.lastFailureAt = Date.now();
    if (h.consecutiveFailures >= this.CIRCUIT_OPEN_AFTER && !h.degraded) {
      h.degraded = true;
      log.warn(`Provider ${name} marked as degraded after ${h.consecutiveFailures} failures — skipping for ${this.CIRCUIT_RESET_MS / 60000} min`);
    }
  }

  private isAvailable(name: string): boolean {
    const h = this.getHealth(name);
    if (!h.degraded) return true;
    if (Date.now() - h.lastFailureAt > this.CIRCUIT_RESET_MS) {
      log.info(`Provider ${name} circuit reset — will retry`);
      h.degraded = false;
      h.consecutiveFailures = 0;
      return true;
    }
    return false;
  }

  registerProvider(name: string, provider: LLMProviderInterface): void {
    this.providers.set(name, provider);
    log.info(`Registered LLM provider: ${name}`, { model: provider.model });
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
    const totalChars = request.messages.reduce((s, m) => s + m.content.length, 0);
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

  static createDefault(configs?: Record<string, LLMProviderConfig>, defaultProvider?: string): LLMRouter {
    const router = new LLMRouter(defaultProvider);

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

    // Auto-configure tiers if multiple providers available.
    // Priority order: defaultProvider is always first in the tier for its complexity levels,
    // ensuring the preferred provider is selected when healthy.
    const providerNames = router.listProviders();
    if (providerNames.length > 1) {
      const effectiveDefault = defaultProvider ?? providerNames[0];
      router.enableAutoSelect(buildTiers(providerNames, effectiveDefault));

      // Fallback order: put the defaultProvider first so it's tried first when another is primary and fails
      const fallbackOrder = [
        effectiveDefault,
        ...providerNames.filter(n => n !== effectiveDefault),
      ].filter(n => providerNames.includes(n));
      router.setFallbackOrder(fallbackOrder);
      log.info('Auto-select enabled with fallback', { providers: providerNames, defaultProvider: effectiveDefault, fallbackOrder });
    }

    return router;
  }

  async chat(request: LLMRequest, providerName?: string): Promise<LLMResponse> {
    const primary = this.selectProvider(request, providerName);
    const provider = this.providers.get(primary);
    if (!provider) {
      throw new Error(`LLM provider not found: ${primary}. Available: ${[...this.providers.keys()].join(', ')}`);
    }

    log.debug(`Sending request to ${primary}`, { model: provider.model, messageCount: request.messages.length });

    let lastError: unknown = null;
    try {
      const response = await provider.chat(request);
      this.recordSuccess(primary);
      log.debug(`Response from ${primary}`, { tokens: response.usage, finishReason: response.finishReason });
      return response;
    } catch (error) {
      lastError = error;
      this.recordFailure(primary);
      log.error(`LLM request failed for ${primary}`, { error: String(error) });

      // Fallback to other providers
      for (const fallbackName of this.getFallbacks(primary)) {
        const fb = this.providers.get(fallbackName)!;
        log.info(`Falling back to ${fallbackName}`, { model: fb.model });
        try {
          const response = await fb.chat(request);
          this.recordSuccess(fallbackName);
          log.info(`Fallback to ${fallbackName} succeeded`);
          return response;
        } catch (fbError) {
          lastError = fbError;
          this.recordFailure(fallbackName);
          log.error(`Fallback ${fallbackName} also failed`, { error: String(fbError) });
        }
      }

      throw lastError;
    }
  }

  async chatStream(request: LLMRequest, onEvent: (event: LLMStreamEvent) => void, providerName?: string): Promise<LLMResponse> {
    const primary = this.selectProvider(request, providerName);
    const provider = this.providers.get(primary);
    if (!provider) {
      throw new Error(`LLM provider not found: ${primary}. Available: ${[...this.providers.keys()].join(', ')}`);
    }

    if (!provider.chatStream) {
      log.debug(`Provider ${primary} does not support streaming, falling back to non-stream`);
      const response = await provider.chat(request);
      if (response.content) onEvent({ type: 'text_delta', text: response.content });
      onEvent({ type: 'message_end', usage: response.usage, finishReason: response.finishReason });
      return response;
    }

    let lastError: unknown = null;
    try {
      const response = await provider.chatStream(request, onEvent);
      this.recordSuccess(primary);
      return response;
    } catch (error) {
      lastError = error;
      this.recordFailure(primary);
      log.error(`LLM stream request failed for ${primary}`, { error: String(error) });

      for (const fallbackName of this.getFallbacks(primary)) {
        const fb = this.providers.get(fallbackName)!;
        log.info(`Stream fallback to ${fallbackName}`);
        try {
          let response: LLMResponse;
          if (fb.chatStream) {
            response = await fb.chatStream(request, onEvent);
          } else {
            response = await fb.chat(request);
            if (response.content) onEvent({ type: 'text_delta', text: response.content });
            onEvent({ type: 'message_end', usage: response.usage, finishReason: response.finishReason });
          }
          this.recordSuccess(fallbackName);
          log.info(`Stream fallback to ${fallbackName} succeeded`);
          return response;
        } catch (fbError) {
          lastError = fbError;
          this.recordFailure(fallbackName);
          log.error(`Stream fallback ${fallbackName} failed`, { error: String(fbError) });
        }
      }

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
    for (const name of ['anthropic', 'openai', 'google', 'ollama', 'deepseek', 'siliconflow', 'openrouter']) {
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
      providers[name] = {
        name,
        displayName: PROVIDER_DISPLAY_NAMES[name] ?? name,
        model: p.model,
        configured: true,
        contextWindow: customModels?.contextWindow ?? modelDef?.contextWindow,
        maxOutputTokens: customModels?.maxOutputTokens ?? modelDef?.maxOutputTokens,
        cost: customModels?.cost ?? modelDef?.cost,
        models: BUILTIN_MODEL_CATALOG.filter(m => m.provider === name),
      };
    }

    for (const name of ['anthropic', 'openai', 'google', 'ollama', 'deepseek', 'siliconflow', 'openrouter']) {
      if (!providers[name]) {
        providers[name] = {
          name,
          displayName: PROVIDER_DISPLAY_NAMES[name] ?? name,
          model: '',
          configured: false,
          models: BUILTIN_MODEL_CATALOG.filter(m => m.provider === name),
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

  getModelCatalog(): ModelDefinition[] {
    return [...BUILTIN_MODEL_CATALOG];
  }

  isAutoSelectEnabled(): boolean {
    return this.autoSelect;
  }
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google Gemini',
  ollama: 'Ollama (Local)',
  deepseek: 'DeepSeek',
  siliconflow: 'SiliconFlow',
  openrouter: 'OpenRouter',
};

const BUILTIN_MODEL_CATALOG: ModelDefinition[] = [
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'anthropic', contextWindow: 200000, maxOutputTokens: 64000, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, reasoning: false, inputTypes: ['text', 'image'] },
  { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', provider: 'anthropic', contextWindow: 200000, maxOutputTokens: 32000, cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }, reasoning: true, inputTypes: ['text', 'image'] },
  { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', provider: 'anthropic', contextWindow: 200000, maxOutputTokens: 8192, cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }, reasoning: false, inputTypes: ['text', 'image'] },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', contextWindow: 128000, maxOutputTokens: 16384, cost: { input: 2.5, output: 10 }, reasoning: false, inputTypes: ['text', 'image'] },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai', contextWindow: 128000, maxOutputTokens: 16384, cost: { input: 0.15, output: 0.6 }, reasoning: false, inputTypes: ['text', 'image'] },
  { id: 'o3', name: 'o3', provider: 'openai', contextWindow: 200000, maxOutputTokens: 100000, cost: { input: 10, output: 40 }, reasoning: true, inputTypes: ['text', 'image'] },
  { id: 'o4-mini', name: 'o4-mini', provider: 'openai', contextWindow: 200000, maxOutputTokens: 100000, cost: { input: 1.1, output: 4.4 }, reasoning: true, inputTypes: ['text', 'image'] },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'google', contextWindow: 1048576, maxOutputTokens: 65536, cost: { input: 1.25, output: 10 }, reasoning: true, inputTypes: ['text', 'image'] },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google', contextWindow: 1048576, maxOutputTokens: 65536, cost: { input: 0.15, output: 0.6 }, reasoning: true, inputTypes: ['text', 'image'] },
  { id: 'deepseek-chat', name: 'DeepSeek V3', provider: 'deepseek', contextWindow: 64000, maxOutputTokens: 8192, cost: { input: 0.27, output: 1.1, cacheRead: 0.07 }, reasoning: false, inputTypes: ['text'] },
  { id: 'deepseek-reasoner', name: 'DeepSeek R1', provider: 'deepseek', contextWindow: 64000, maxOutputTokens: 8192, cost: { input: 0.55, output: 2.19, cacheRead: 0.14 }, reasoning: true, inputTypes: ['text'] },
];
