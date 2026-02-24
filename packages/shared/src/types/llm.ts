export type LLMProvider = 'anthropic' | 'openai' | 'deepseek' | 'google' | 'ollama' | 'custom';

export interface LLMProviderConfig {
  provider: LLMProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LLMRequest {
  messages: LLMMessage[];
  tools?: LLMTool[];
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: LLMToolCall[];
}

export interface LLMTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  toolCalls?: LLMToolCall[];
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  finishReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
}
