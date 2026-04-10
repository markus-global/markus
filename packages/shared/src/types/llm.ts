export type LLMProvider = 'anthropic' | 'openai' | 'openai-codex' | 'siliconflow' | 'openrouter' | 'google' | 'ollama' | 'minimax' | 'zai' | 'custom';

export type LLMAuthType = 'api-key' | 'oauth' | 'setup-token';

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  accountId?: string;
}

export interface OAuthProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scope?: string;
  callbackPort?: number;
}

export interface AuthProfile {
  id: string;
  provider: string;
  authType: LLMAuthType;
  label?: string;
  createdAt: number;
  updatedAt: number;
  apiKey?: string;
  oauth?: OAuthTokens;
  setupToken?: string;
}

export interface LLMProviderConfig {
  provider: LLMProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  /** Request timeout in milliseconds (default: 90s for chat, 120s for streaming) */
  timeoutMs?: number;
  authType?: LLMAuthType;
  authProfileId?: string;
}

export interface ModelCostConfig {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelDefinition {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxOutputTokens: number;
  cost: ModelCostConfig;
  reasoning?: boolean;
  inputTypes?: Array<'text' | 'image'>;
  description?: string;
}

export interface EnhancedProviderSettings {
  name: string;
  displayName?: string;
  model: string;
  baseUrl?: string;
  configured: boolean;
  enabled: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  cost?: ModelCostConfig;
  models?: ModelDefinition[];
  authType?: LLMAuthType;
  oauthConnected?: boolean;
  oauthAccountId?: string;
}

export interface EnhancedLLMSettings {
  defaultProvider: string;
  providers: Record<string, EnhancedProviderSettings>;
}

export interface LLMRequest {
  messages: LLMMessage[];
  tools?: LLMTool[];
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  metadata?: {
    agentId?: string;
    taskId?: string;
    sessionId?: string;
  };
  /** Enable Anthropic server-side context compaction (beta) */
  compaction?: boolean;
}

export type LLMContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | LLMContentPart[];
  toolCallId?: string;
  toolCalls?: LLMToolCall[];
}

/** Extract plain text from a message's content (ignoring image parts). */
export function getTextContent(content: string | LLMContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<LLMContentPart, { type: 'text' }> => p.type === 'text')
    .map(p => p.text)
    .join('');
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
  /** Anthropic compaction summary (present when compaction triggers) */
  compactionContent?: string;
}

export interface SubagentProgressEvent {
  eventType: 'started' | 'tool_start' | 'tool_end' | 'thinking' | 'iteration' | 'completed' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface LLMStreamEvent {
  type: 'text_delta' | 'tool_call_start' | 'tool_call_delta' | 'tool_call_end' | 'message_end' | 'agent_tool' | 'thinking_delta' | 'tool_output' | 'subagent_progress';
  text?: string;
  thinking?: string;
  toolCall?: Partial<LLMToolCall>;
  usage?: { inputTokens: number; outputTokens: number };
  finishReason?: LLMResponse['finishReason'];
  // agent_tool event fields
  tool?: string;
  phase?: 'start' | 'end';
  success?: boolean;
  arguments?: unknown;
  result?: string;
  error?: string;
  durationMs?: number;
  // subagent_progress event fields
  subagentEvent?: SubagentProgressEvent;
}
