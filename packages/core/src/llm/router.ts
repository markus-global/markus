import type { LLMRequest, LLMResponse, LLMStreamEvent, LLMProviderConfig } from '@markus/shared';
import type { LLMProviderInterface } from './provider.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { createLogger } from '@markus/shared';

const log = createLogger('llm-router');

export type ComplexityLevel = 'simple' | 'moderate' | 'complex';

export interface ProviderTier {
  name: string;
  complexity: ComplexityLevel[];
}

export class LLMRouter {
  private providers = new Map<string, LLMProviderInterface>();
  private defaultProvider: string;
  private autoSelect = false;
  private providerTiers: ProviderTier[] = [];
  private fallbackOrder: string[] = [];

  constructor(defaultProvider?: string) {
    this.defaultProvider = defaultProvider ?? 'anthropic';
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
    if (!this.autoSelect || this.providerTiers.length === 0) return this.defaultProvider;

    const complexity = LLMRouter.assessComplexity(request);
    const match = this.providerTiers.find(t => t.complexity.includes(complexity) && this.providers.has(t.name));
    const selected = match?.name ?? this.defaultProvider;
    log.debug(`Auto-selected provider: ${selected}`, { complexity });
    return selected;
  }

  private getFallbacks(primary: string): string[] {
    if (this.fallbackOrder.length > 0) {
      return this.fallbackOrder.filter(n => n !== primary);
    }
    return [...this.providers.keys()].filter(n => n !== primary);
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

    for (const [name, cfg] of Object.entries(configs ?? {})) {
      if (name === 'anthropic' || name === 'openai') continue;
      if (cfg?.apiKey) {
        router.registerProvider(name, new OpenAIProvider(cfg));
      }
    }

    // Auto-configure tiers if multiple providers available
    const providerNames = router.listProviders();
    if (providerNames.length > 1) {
      router.enableAutoSelect([
        ...providerNames.includes('deepseek') ? [{ name: 'deepseek', complexity: ['simple' as ComplexityLevel, 'moderate' as ComplexityLevel] }] : [],
        ...providerNames.includes('anthropic') ? [{ name: 'anthropic', complexity: ['complex' as ComplexityLevel] }] : [],
        ...providerNames.includes('openai') ? [{ name: 'openai', complexity: ['complex' as ComplexityLevel, 'moderate' as ComplexityLevel] }] : [],
      ]);
      router.setFallbackOrder(providerNames);
      log.info('Auto-select enabled with fallback', { providers: providerNames });
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

    try {
      const response = await provider.chat(request);
      log.debug(`Response from ${primary}`, { tokens: response.usage, finishReason: response.finishReason });
      return response;
    } catch (error) {
      log.error(`LLM request failed for ${primary}`, { error: String(error) });

      // Fallback to other providers
      for (const fallbackName of this.getFallbacks(primary)) {
        const fb = this.providers.get(fallbackName)!;
        log.info(`Falling back to ${fallbackName}`, { model: fb.model });
        try {
          const response = await fb.chat(request);
          log.info(`Fallback to ${fallbackName} succeeded`);
          return response;
        } catch (fbError) {
          log.error(`Fallback ${fallbackName} also failed`, { error: String(fbError) });
        }
      }

      throw error;
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

    try {
      return await provider.chatStream(request, onEvent);
    } catch (error) {
      log.error(`LLM stream request failed for ${primary}`, { error: String(error) });

      for (const fallbackName of this.getFallbacks(primary)) {
        const fb = this.providers.get(fallbackName)!;
        log.info(`Stream fallback to ${fallbackName}`);
        try {
          if (fb.chatStream) {
            return await fb.chatStream(request, onEvent);
          }
          const response = await fb.chat(request);
          if (response.content) onEvent({ type: 'text_delta', text: response.content });
          onEvent({ type: 'message_end', usage: response.usage, finishReason: response.finishReason });
          return response;
        } catch (fbError) {
          log.error(`Stream fallback ${fallbackName} failed`, { error: String(fbError) });
        }
      }

      throw error;
    }
  }

  getProvider(name: string): LLMProviderInterface | undefined {
    return this.providers.get(name);
  }

  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  isAutoSelectEnabled(): boolean {
    return this.autoSelect;
  }
}
