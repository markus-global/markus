import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createLogger, type CatalogModel, type CatalogStatus, type LiteLLMRawModelEntry } from '@markus/shared';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// data/ lives at packages/core/data/ regardless of whether we're running from src/ or dist/
const DATA_DIR = join(__dirname, '..', '..', 'data');

const log = createLogger('model-catalog');

const LITELLM_JSON_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const LITELLM_MIRROR_URLS = [
  'https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json',
  'https://raw.gitmirror.com/BerriAI/litellm/main/model_prices_and_context_window.json',
];
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const RETRY_BACKOFF_MS = 4 * 60 * 60 * 1000;  // 4 hours after failure (avoid spamming)
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
  private lastUpdated: string | null = null;
  private source: CatalogStatus['source'] = 'baseline';
  private markusDir: string;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private mirrorUrl?: string;
  private consecutiveFailures = 0;
  private lastFailureAt = 0;

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

  async refresh(): Promise<boolean> {
    // Back off if we've been failing repeatedly
    if (this.consecutiveFailures > 0 && Date.now() - this.lastFailureAt < RETRY_BACKOFF_MS) {
      return false;
    }

    const urls = this.mirrorUrl
      ? [this.mirrorUrl]
      : [LITELLM_JSON_URL, ...LITELLM_MIRROR_URLS];

    for (const url of urls) {
      try {
        log.info(`Refreshing model catalog from ${url}`);
        const response = await fetch(url, {
          signal: AbortSignal.timeout(30000),
        });

        if (!response.ok) {
          log.warn(`Failed to fetch model catalog from ${url}: HTTP ${response.status}`);
          continue;
        }

        const rawText = await response.text();
        const rawData = JSON.parse(rawText) as Record<string, LiteLLMRawModelEntry>;

        this.parseAndLoad(rawData, 'remote');
        this.persistCache(rawText);
        this.consecutiveFailures = 0;
        log.info(`Model catalog refreshed: ${this.models.size} chat models loaded`);
        return true;
      } catch (err) {
        log.warn(`Failed to fetch model catalog from ${url}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }

    this.consecutiveFailures++;
    this.lastFailureAt = Date.now();
    if (this.consecutiveFailures === 1) {
      log.warn('All model catalog sources unreachable. Using bundled baseline data. Will retry in 4 hours.');
    }
    return false;
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

  private refreshInBackground(): void {
    void this.refresh().catch(() => {});
  }
}
