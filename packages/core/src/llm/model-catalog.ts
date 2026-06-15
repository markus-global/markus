import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createLogger, type CatalogModel, type CatalogStatus, type LiteLLMRawModelEntry, type ModelTier, type CostTier, type ModelTaskType, type NormalizedCost, type PriceConfidence, type PricingType, type ModelQuality } from '@markus/shared';

/** Arena category — maps to the three arena JSON data files. */
export type ArenaCategory = 'text' | 'code' | 'vision';

/** Single arena Elo entry parsed from the data files. */
export interface ArenaEntry {
  model: string;
  provider: string;
  elo: number;
  ranking: number;
  votes: number;
  lastUpdated: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// data/ lives at packages/core/data/ regardless of whether we're running from src/ or dist/
const DATA_DIR = join(__dirname, '..', '..', 'data');

const log = createLogger('model-catalog');

const LITELLM_JSON_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_FILENAME = 'model-catalog-cache.json';

const PROVIDER_MAP: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  deepseek: 'deepseek',
  gemini: 'google',
  vertex_ai: 'google',
  'vertex_ai-language-models': 'google',
  'vertex_ai-anthropic_models': 'anthropic',
  minimax: 'minimax',
  ollama: 'ollama',
  ollama_chat: 'ollama',
  openrouter: 'openrouter',
  siliconflow: 'siliconflow',
  zai: 'zai',
  xai: 'xai',
  mistral: 'mistral',
  groq: 'groq',
  perplexity: 'perplexity',
  cohere: 'cohere',
  cohere_chat: 'cohere',
  together_ai: 'together_ai',
  fireworks_ai: 'fireworks_ai',
  text_completion_fireworks_ai: 'fireworks_ai',
  volcengine: 'volcengine',
  moonshot: 'moonshot',
  dashscope: 'dashscope',
};

export class ModelCatalogService {
  private models: Map<string, CatalogModel> = new Map();
  private arenaCache: Map<ArenaCategory, Map<string, ArenaEntry>> = new Map();
  private lastUpdated: string | null = null;
  private source: CatalogStatus['source'] = 'baseline';
  private markusDir: string;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private mirrorUrl?: string;

  constructor(options?: { mirrorUrl?: string }) {
    this.markusDir = join(homedir(), '.markus');
    this.mirrorUrl = options?.mirrorUrl;
  }

  async initialize(): Promise<void> {
    const cachePath = this.getCachePath();

    if (this.isCacheValid(cachePath)) {
      this.loadFromFile(cachePath, 'cache');
      this.refreshInBackground();
    } else {
      this.loadBaseline();
      this.refreshInBackground();
    }

    this.refreshTimer = setInterval(() => {
      this.refreshInBackground();
    }, CACHE_MAX_AGE_MS);
  }

  shutdown(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  getModelsByProvider(provider: string): CatalogModel[] {
    const results: CatalogModel[] = [];
    for (const model of this.models.values()) {
      if (model.provider === provider) {
        results.push(model);
      }
    }
    return results.sort((a, b) => a.id.localeCompare(b.id));
  }

  getModelInfo(modelId: string): CatalogModel | undefined {
    return this.models.get(modelId);
  }

  searchModels(query: string, provider?: string): CatalogModel[] {
    const q = query.toLowerCase();
    const results: CatalogModel[] = [];
    for (const model of this.models.values()) {
      if (provider && model.provider !== provider) continue;
      if (model.id.toLowerCase().includes(q)) {
        results.push(model);
      }
    }
    return results.sort((a, b) => a.id.localeCompare(b.id));
  }

  getAllProviders(): string[] {
    const providers = new Set<string>();
    for (const model of this.models.values()) {
      providers.add(model.provider);
    }
    return Array.from(providers).sort();
  }

  getStatus(): CatalogStatus {
    let chatModels = 0;
    for (const model of this.models.values()) {
      if (model.mode === 'chat') chatModels++;
    }
    return {
      totalModels: this.models.size,
      chatModels,
      providers: this.getAllProviders(),
      lastUpdated: this.lastUpdated,
      source: this.source,
    };
  }

  async refresh(retryCount = 0): Promise<boolean> {
    const maxRetries = 3;
    try {
      const url = this.mirrorUrl || LITELLM_JSON_URL;
      log.info(`Refreshing model catalog from ${url}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(url, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        log.warn(`Failed to fetch model catalog: HTTP ${response.status}`);
        if (retryCount < maxRetries && response.status >= 500) {
          const backoff = Math.min(1000 * Math.pow(2, retryCount), 10000);
          log.info(`Retrying in ${backoff}ms (attempt ${retryCount + 1}/${maxRetries})...`);
          await new Promise(r => setTimeout(r, backoff));
          return this.refresh(retryCount + 1);
        }
        return false;
      }

      const rawText = await response.text();
      const rawData = JSON.parse(rawText) as Record<string, LiteLLMRawModelEntry>;

      this.parseAndLoad(rawData, 'remote');
      this.persistCache(rawText);
      log.info(`Model catalog refreshed: ${this.models.size} chat models loaded`);
      return true;
    } catch (err) {
      if (retryCount < maxRetries) {
        const backoff = Math.min(1000 * Math.pow(2, retryCount), 10000);
        log.info(`Retry ${retryCount + 1}/${maxRetries} after error in ${backoff}ms...`);
        await new Promise(r => setTimeout(r, backoff));
        return this.refresh(retryCount + 1);
      }
      log.warn(`Failed to refresh model catalog: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private loadBaseline(): void {
    try {
      const baselinePath = join(DATA_DIR, 'model-catalog-baseline.json');
      const data = readFileSync(baselinePath, 'utf-8');
      const rawData = JSON.parse(data) as Record<string, LiteLLMRawModelEntry>;
      this.parseAndLoad(rawData, 'baseline');
      log.info(`Loaded baseline catalog: ${this.models.size} chat models`);
    } catch (err) {
      log.error(`Failed to load baseline catalog: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private loadSupplements(): void {
    try {
      const supplementsPath = join(DATA_DIR, 'model-catalog-supplements.json');
      const data = readFileSync(supplementsPath, 'utf-8');
      const rawData = JSON.parse(data) as Record<string, LiteLLMRawModelEntry & { _meta?: unknown }>;

      for (const [key, entry] of Object.entries(rawData)) {
        if (key === '_meta' || !entry.litellm_provider) continue;
        const markusProvider = PROVIDER_MAP[entry.litellm_provider];
        if (!markusProvider) continue;
        if (entry.mode && entry.mode !== 'chat') continue;

        // For supplements, strip provider prefix for the model ID shown to user
        const modelId = key.startsWith(`${entry.litellm_provider}/`)
          ? key.slice(entry.litellm_provider.length + 1)
          : key;

        const model = this.convertEntry(modelId, entry, markusProvider);
        if (model) {
          this.models.set(modelId, model);
        }
      }
    } catch (err) {
      log.warn(`Failed to load supplements: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private loadFromFile(path: string, source: 'cache' | 'baseline'): void {
    try {
      const data = readFileSync(path, 'utf-8');
      const rawData = JSON.parse(data) as Record<string, LiteLLMRawModelEntry>;
      this.parseAndLoad(rawData, source);
      log.info(`Loaded catalog from ${source}: ${this.models.size} chat models`);
    } catch (err) {
      log.warn(`Failed to load catalog from ${source}: ${err instanceof Error ? err.message : String(err)}`);
      if (source === 'cache') {
        this.loadBaseline();
      }
    }
  }

  private parseAndLoad(rawData: Record<string, LiteLLMRawModelEntry>, source: CatalogStatus['source']): void {
    this.models.clear();

    for (const [key, entry] of Object.entries(rawData)) {
      if (key === 'sample_spec') continue;
      if (!entry.litellm_provider) continue;
      if (entry.mode && entry.mode !== 'chat') continue;
      // Skip entries without mode that look non-chat (image gen prefixes, etc.)
      if (!entry.mode && key.match(/^\d+.*x.*\d+/)) continue;

      const markusProvider = PROVIDER_MAP[entry.litellm_provider];
      if (!markusProvider) continue;

      const model = this.convertEntry(key, entry, markusProvider);
      if (model) {
        this.models.set(key, model);
      }
    }

    // Load supplements on top
    this.loadSupplements();

    this.lastUpdated = new Date().toISOString();
    this.source = source;
  }

  private convertEntry(id: string, entry: LiteLLMRawModelEntry, provider: string): CatalogModel | null {
    const maxInput = entry.max_input_tokens ?? entry.max_tokens ?? 0;
    const maxOutput = entry.max_output_tokens ?? entry.max_tokens ?? 0;

    if (maxInput === 0 && maxOutput === 0) return null;

    return {
      id,
      provider,
      mode: entry.mode || 'chat',
      maxInputTokens: maxInput,
      maxOutputTokens: maxOutput,
      inputCostPer1MTokens: (entry.input_cost_per_token ?? 0) * 1_000_000,
      outputCostPer1MTokens: (entry.output_cost_per_token ?? 0) * 1_000_000,
      cacheReadCostPer1MTokens: entry.cache_read_input_token_cost
        ? entry.cache_read_input_token_cost * 1_000_000
        : undefined,
      cacheWriteCostPer1MTokens: entry.cache_creation_input_token_cost
        ? entry.cache_creation_input_token_cost * 1_000_000
        : undefined,
      capabilities: {
        vision: entry.supports_vision ?? false,
        functionCalling: entry.supports_function_calling ?? false,
        reasoning: entry.supports_reasoning ?? false,
        promptCaching: entry.supports_prompt_caching ?? false,
        webSearch: entry.supports_web_search ?? false,
        audioInput: entry.supports_audio_input ?? false,
        audioOutput: entry.supports_audio_output ?? false,
      },
      deprecationDate: entry.deprecation_date,
    };
  }

  private getCachePath(): string {
    return join(this.markusDir, CACHE_FILENAME);
  }

  private isCacheValid(cachePath: string): boolean {
    try {
      if (!existsSync(cachePath)) return false;
      const stat = statSync(cachePath);
      const age = Date.now() - stat.mtimeMs;
      return age < CACHE_MAX_AGE_MS;
    } catch {
      return false;
    }
  }

  private persistCache(rawText: string): void {
    try {
      if (!existsSync(this.markusDir)) {
        mkdirSync(this.markusDir, { recursive: true });
      }
      writeFileSync(this.getCachePath(), rawText, 'utf-8');
    } catch (err) {
      log.warn(`Failed to persist catalog cache: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Enrich a CatalogModel with derived fields (tier, costTier, task types, quality).
   * Uses Arena Elo data when available, falls back to heuristic scoring.
   */
  enrichModel(model: CatalogModel): {
    tier: ModelTier;
    costTier: CostTier;
    taskTypes: ModelTaskType[];
    quality: ModelQuality;
    normalizedCost: NormalizedCost;
  } {
    // --- Tier estimation based on capabilities and pricing ---
    const tier = this.estimateTier(model);

    // --- Cost tier ---
    const costTier = this.estimateCostTier(model);

    // --- Task type inference (typed against Wave 0 ModelTaskType) ---
    const taskTypes = this.inferTaskTypes(model);

    // --- Quality score: prefer Arena Elo over heuristic ---
    const arenaElo = this.lookupArenaElo(model);
    const quality: ModelQuality = {
      overallElo: arenaElo?.overall,
      codingElo: arenaElo?.coding,
      visionElo: arenaElo?.vision,
      qualityScore: arenaElo?.overall
        ? this.eloToQualityScore(arenaElo.overall)
        : this.estimateQualityScore(model, tier),
      tier,
      lastUpdated: this.lastUpdated ?? new Date().toISOString(),
      source: arenaElo ? 'arena' : 'heuristic',
    };

    // --- Normalized cost ---
    const normalizedCost = this.buildNormalizedCost(model);

    return { tier, costTier, taskTypes, quality, normalizedCost };
  }

  /**
   * Produce a list of all models with enrichment applied,
   * ready for ModelProfile construction.
   */
  getAllEnrichedModels(): Array<CatalogModel & ReturnType<ModelCatalogService['enrichModel']>> {
    const results: Array<CatalogModel & ReturnType<ModelCatalogService['enrichModel']>> = [];
    for (const model of this.models.values()) {
      const enrichment = this.enrichModel(model);
      results.push({ ...model, ...enrichment });
    }
    return results.sort((a, b) => b.quality.qualityScore - a.quality.qualityScore);
  }

  /**
   * Get models filtered by task type (e.g. 'text_chat', 'text_coding').
   */
  getModelsByTaskType(taskType: ModelTaskType): CatalogModel[] {
    return Array.from(this.models.values()).filter(m => {
      const types = this.inferTaskTypes(m);
      return types.includes(taskType);
    });
  }

  /**
   * Get models that match a given tier and (optionally) task type.
   */
  getModelsByTier(tier: ModelTier, taskType?: ModelTaskType): CatalogModel[] {
    return Array.from(this.models.values()).filter(m => {
      const t = this.estimateTier(m);
      if (t !== tier) return false;
      if (taskType) {
        const types = this.inferTaskTypes(m);
        return types.includes(taskType);
      }
      return true;
    });
  }

  /**
   * Estimate model tier based on pricing and capabilities.
   * base: cheapest models
   * pro: moderate pricing with function calling
   * max: expensive models with advanced capabilities
   */
  private estimateTier(model: CatalogModel): ModelTier {
    const avgCost = (model.inputCostPer1MTokens + model.outputCostPer1MTokens) / 2;
    const hasAdvanced = model.capabilities.reasoning || model.capabilities.audioInput;

    if (avgCost > 10 && hasAdvanced) return 'max';
    if (avgCost > 2 || model.capabilities.functionCalling) return 'pro';
    return 'base';
  }

  /**
   * Estimate cost tier for UI display.
   */
  private estimateCostTier(model: CatalogModel): CostTier {
    const avgCost = (model.inputCostPer1MTokens + model.outputCostPer1MTokens) / 2;
    const d = String.fromCodePoint(36);
    if (avgCost <= 0.5) return d as CostTier;
    if (avgCost <= 3) return (d + d) as CostTier;
    if (avgCost <= 10) return (d + d + d) as CostTier;
    return (d + d + d + d) as CostTier;
  }

  private inferTaskTypes(model: CatalogModel): ModelTaskType[] {
    const types: ModelTaskType[] = ['text_chat'];
    if (model.capabilities.reasoning) types.push('text_reasoning');
    if (model.capabilities.functionCalling) types.push('text_coding');
    if (model.capabilities.vision) types.push('image_recognition');
    if (model.capabilities.webSearch) types.push('web_search');
    if (model.capabilities.audioInput) types.push('audio_stt');
    if (model.capabilities.audioOutput) types.push('audio_tts');
    return types;
  }

  /**
   * Load Arena Elo data for a given category. Cached on first call.
   * Returns Map keyed by model ID, or empty Map on missing/corrupt file.
   */
  loadArena(category: ArenaCategory): Map<string, ArenaEntry> {
    const cached = this.arenaCache.get(category);
    if (cached) return cached;

    const fileMap: Record<ArenaCategory, string> = {
      text: 'arena-text.json',
      code: 'arena-code.json',
      vision: 'arena-vision.json',
    };

    const path = join(DATA_DIR, fileMap[category]);
    const empty = new Map<string, ArenaEntry>();
    if (!existsSync(path)) {
      log.warn(`Arena data file not found: ${path}`);
      this.arenaCache.set(category, empty);
      return empty;
    }

    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as {
        meta?: { lastUpdated?: string };
        models?: ArenaEntry[];
      };
      const map = new Map<string, ArenaEntry>();
      for (const entry of raw.models ?? []) {
        map.set(entry.model, entry);
      }
      this.arenaCache.set(category, map);
      log.info(`Loaded arena ${category}: ${map.size} models`);
      return map;
    } catch (err) {
      log.warn(`Failed to load arena ${category}: ${err instanceof Error ? err.message : String(err)}`);
      this.arenaCache.set(category, empty);
      return empty;
    }
  }

  /**
   * Look up Arena Elo scores across all categories for a given model.
   * Returns per-category Elo (or undefined) for fields with data.
   */
  private lookupArenaElo(model: CatalogModel): { overall?: number; coding?: number; vision?: number } | null {
    const textMap = this.loadArena('text');
    const codeMap = this.loadArena('code');
    const visionMap = this.loadArena('vision');

    const overall = textMap.get(model.id)?.elo;
    const coding = codeMap.get(model.id)?.elo;
    const vision = visionMap.get(model.id)?.elo;

    if (overall === undefined && coding === undefined && vision === undefined) {
      return null;
    }
    return { overall, coding, vision };
  }

  /**
   * Convert Arena Elo (typically 1200-1500) to 0-100 quality score.
   * Mapping: elo 1200 -> 30, elo 1500 -> 95 (linear).
   */
  private eloToQualityScore(elo: number): number {
    const MIN_ELO = 1200;
    const MAX_ELO = 1500;
    const ratio = (elo - MIN_ELO) / (MAX_ELO - MIN_ELO);
    return Math.max(0, Math.min(100, Math.round(ratio * 65 + 30)));
  }

  private estimateQualityScore(model: CatalogModel, tier: ModelTier): number {
    const tierBase: Record<ModelTier, number> = { base: 30, pro: 60, max: 85 };
    let score = tierBase[tier] ?? 50;
    const premiumProviders = ['anthropic', 'openai', 'google'];
    if (premiumProviders.includes(model.provider)) score += 8;
    if (model.capabilities.reasoning) score += 5;
    const avgCost = (model.inputCostPer1MTokens + model.outputCostPer1MTokens) / 2;
    if (avgCost < 0.1 && !premiumProviders.includes(model.provider)) score -= 10;
    return Math.max(0, Math.min(100, score));
  }

  private buildNormalizedCost(model: CatalogModel): NormalizedCost {
    const isLocal = model.provider === 'ollama';
    const isFree = isLocal || (model.inputCostPer1MTokens === 0 && model.outputCostPer1MTokens === 0);
    let pricingType: PricingType = 'token';
    if (isLocal) pricingType = 'local';
    else if (isFree) pricingType = 'free';
    return {
      inputPer1MTokens: model.inputCostPer1MTokens || undefined,
      outputPer1MTokens: model.outputCostPer1MTokens || undefined,
      cachedReadPer1MTokens: model.cacheReadCostPer1MTokens,
      cachedWritePer1MTokens: model.cacheWriteCostPer1MTokens,
      pricingType,
      isFree,
      isLocal,
      priceConfidence: 'estimated' as PriceConfidence,
    };
  }

  private refreshInBackground(): void {
    void this.refresh().catch(() => {});
  }
}
