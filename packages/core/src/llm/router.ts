import type { LLMRequest, LLMResponse, LLMProviderConfig } from '@markus/shared';
import type { LLMProviderInterface } from './provider.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { createLogger } from '@markus/shared';

const log = createLogger('llm-router');

export class LLMRouter {
  private providers = new Map<string, LLMProviderInterface>();
  private defaultProvider: string;

  constructor(defaultProvider?: string) {
    this.defaultProvider = defaultProvider ?? 'anthropic';
  }

  registerProvider(name: string, provider: LLMProviderInterface): void {
    this.providers.set(name, provider);
    log.info(`Registered LLM provider: ${name}`, { model: provider.model });
  }

  static createDefault(configs?: Record<string, LLMProviderConfig>): LLMRouter {
    const router = new LLMRouter();

    const anthropicConfig = configs?.['anthropic'];
    router.registerProvider('anthropic', new AnthropicProvider(anthropicConfig));

    const openaiConfig = configs?.['openai'];
    router.registerProvider('openai', new OpenAIProvider(openaiConfig));

    return router;
  }

  async chat(request: LLMRequest, providerName?: string): Promise<LLMResponse> {
    const name = providerName ?? this.defaultProvider;
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`LLM provider not found: ${name}. Available: ${[...this.providers.keys()].join(', ')}`);
    }

    log.debug(`Sending request to ${name}`, { model: provider.model, messageCount: request.messages.length });

    try {
      const response = await provider.chat(request);
      log.debug(`Response from ${name}`, {
        tokens: response.usage,
        finishReason: response.finishReason,
      });
      return response;
    } catch (error) {
      log.error(`LLM request failed for ${name}`, { error: String(error) });
      throw error;
    }
  }

  getProvider(name: string): LLMProviderInterface | undefined {
    return this.providers.get(name);
  }

  listProviders(): string[] {
    return [...this.providers.keys()];
  }
}
