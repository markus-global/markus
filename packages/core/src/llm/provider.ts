import type { LLMRequest, LLMResponse, LLMStreamEvent, LLMProviderConfig } from '@markus/shared';

export interface LLMProviderInterface {
  readonly name: string;
  readonly model: string;
  chat(request: LLMRequest): Promise<LLMResponse>;
  chatStream?(request: LLMRequest, onEvent: (event: LLMStreamEvent) => void): Promise<LLMResponse>;
  configure(config: LLMProviderConfig): void;
}
