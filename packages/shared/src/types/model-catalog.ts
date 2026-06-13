// ---------------------------------------------------------------------------
// Model Tier & Task Routing types
// ---------------------------------------------------------------------------

export type ModelTier = 'base' | 'pro' | 'max';

export type CostTier = '$' | '$$' | '$$$' | '$$$$';

export type ModelTaskType =
  | 'text_chat'
  | 'text_reasoning'
  | 'text_coding'
  | 'text_translation'
  | 'text_summary'
  | 'image_recognition'
  | 'image_generation'
  | 'audio_tts'
  | 'audio_stt'
  | 'video_generation'
  | 'embedding'
  | 'web_search';

export type RoutingStrategy =
  | 'always_max'
  | 'always_cheapest'
  | 'balanced'
  | 'cache_optimized';

export type MultiModalStrategy = 'unified' | 'specialized';

export type PricingType = 'token' | 'request' | 'image' | 'audio' | 'video' | 'free' | 'local' | 'variable' | 'unknown';

export type PriceConfidence = 'exact' | 'estimated' | 'unknown';

export interface TaskModelAssignment {
  provider: string;
  model: string;
  fallback?: { provider: string; model: string };
}

export interface TaskRoutingConfig {
  mode: 'auto' | 'manual' | 'hybrid';
  assignments: Partial<Record<ModelTaskType, TaskModelAssignment>>;
  autoStrategy: RoutingStrategy;
  defaultTier: ModelTier;
  multiModalStrategy?: MultiModalStrategy;
}

export interface RoutingConfig {
  strategy: RoutingStrategy;
  defaultTier: ModelTier;
  tierOverrides?: Record<string, ModelTier>;
  budgetLimit?: number;
  preferCacheHit: boolean;
  taskRouting?: TaskRoutingConfig;
}

// ---------------------------------------------------------------------------
// Normalized cost for multi-modal models (token, image, audio, video, etc.)
// ---------------------------------------------------------------------------

export interface NormalizedCost {
  inputPer1MTokens?: number;
  outputPer1MTokens?: number;
  cachedReadPer1MTokens?: number;
  cachedWritePer1MTokens?: number;
  perRequest?: number;
  perImage?: number;
  perMinute?: number;
  per1MChars?: number;
  perSecond?: number;
  pricingType: PricingType;
  isFree: boolean;
  isLocal: boolean;
  priceConfidence: PriceConfidence;
}

// ---------------------------------------------------------------------------
// Model quality scores (from benchmarks like Arena AI)
// ---------------------------------------------------------------------------

export interface ModelQuality {
  overallElo?: number;
  codingElo?: number;
  visionElo?: number;
  qualityScore: number;
  tier: ModelTier;
  lastUpdated: string;
  source?: 'arena' | 'heuristic' | 'user_override';
}

// ---------------------------------------------------------------------------
// Unified ModelProfile: merges catalog + benchmark + cost data
// ---------------------------------------------------------------------------

export interface ModelProfile {
  id: string;
  provider: string;
  displayName: string;
  family: string;
  mode: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  cost: NormalizedCost;
  capabilities: CatalogModelCapabilities;
  quality: ModelQuality;
  taskTypes: ModelTaskType[];
  derived: {
    costEfficiency: number;
    costTier: CostTier;
    latencyClass: 'fast' | 'medium' | 'slow';
  };
}

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
// Catalog types (existing, enhanced)
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
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  supports_vision?: boolean;
  supports_function_calling?: boolean;
  supports_reasoning?: boolean;
  supports_prompt_caching?: boolean;
  supports_web_search?: boolean;
  supports_audio_input?: boolean;
  supports_audio_output?: boolean;
  deprecation_date?: string;
}
