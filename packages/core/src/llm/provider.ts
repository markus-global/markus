import type { LLMRequest, LLMResponse, LLMProviderConfig } from '@markus/shared';

export interface LLMProviderInterface {
  readonly name: string;
  readonly model: string;
  chat(request: LLMRequest): Promise<LLMResponse>;
  configure(config: LLMProviderConfig): void;
}
