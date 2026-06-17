// ---------------------------------------------------------------------------
// Model Tier & Capability Routing types
// ---------------------------------------------------------------------------

export type ModelTier = 'base' | 'pro' | 'max';

export type CostTier = '$' | '$$' | '$$$' | '$$$$';

export type ModelCapabilityType =
  | 'text'
  | 'image_recognition'
  | 'image_generation'
  | 'audio_tts'
  | 'audio_stt'
  | 'video_generation';

/** @deprecated Use ModelCapabilityType instead */
export type ModelTaskType = ModelCapabilityType;

export interface CapabilityModelAssignment {
  provider: string;
  model: string;
  fallback?: { provider: string; model: string };
}

/** @deprecated Use CapabilityModelAssignment instead */
export type TaskModelAssignment = CapabilityModelAssignment;

export interface CapabilityRoutingConfig {
  assignments: Partial<Record<ModelCapabilityType, CapabilityModelAssignment>>;
}

/** @deprecated Use CapabilityRoutingConfig instead */
export type TaskRoutingConfig = CapabilityRoutingConfig;

// ---------------------------------------------------------------------------
// Provider capability declaration
// ---------------------------------------------------------------------------

export interface ProviderCapabilities {
  chat: boolean;
  vision: boolean;
  imageGeneration: boolean;
  tts: boolean;
  stt: boolean;
  videoGeneration: boolean;
  embedding: boolean;
  reasoning: boolean;
  promptCaching: boolean;
}

// ---------------------------------------------------------------------------
// Catalog types
// ---------------------------------------------------------------------------

export interface CatalogModelCapabilities {
  vision: boolean;
  functionCalling: boolean;
  reasoning: boolean;
  promptCaching: boolean;
  webSearch: boolean;
  audioInput: boolean;
  audioOutput: boolean;
}

export interface CatalogModel {
  id: string;
  provider: string;
  mode: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  inputCostPer1MTokens: number;
  outputCostPer1MTokens: number;
  cacheReadCostPer1MTokens?: number;
  cacheWriteCostPer1MTokens?: number;
  capabilities: CatalogModelCapabilities;
  supportedEndpoints?: string[];
  deprecationDate?: string;
}

export interface CatalogStatus {
  totalModels: number;
  chatModels: number;
  providers: string[];
  lastUpdated: string | null;
  source: 'cache' | 'remote' | 'baseline' | 'supplements';
}

export interface ValidateKeyRequest {
  provider: string;
  apiKey: string;
  baseUrl?: string;
}

export interface ValidateKeyResponse {
  valid: boolean;
  error?: string;
  models: CatalogModel[];
}

/**
 * Raw model entry shape from LiteLLM's model_prices_and_context_window.json
 */
export interface LiteLLMRawModelEntry {
  litellm_provider: string;
  mode?: string;
  max_input_tokens?: number;
  max_output_tokens?: number;
  max_tokens?: number;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  input_cost_per_character?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  supported_endpoints?: string[];
  supports_vision?: boolean;
  supports_function_calling?: boolean;
  supports_reasoning?: boolean;
  supports_prompt_caching?: boolean;
  supports_web_search?: boolean;
  supports_audio_input?: boolean;
  supports_audio_output?: boolean;
  deprecation_date?: string;
}
