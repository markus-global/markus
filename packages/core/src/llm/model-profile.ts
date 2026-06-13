import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  createLogger,
  type ModelProfile,
  type ModelTier,
  type CostTier,
  type ModelTaskType,
  type CatalogModel,
  type CatalogModelCapabilities,
  type NormalizedCost,
  type ModelQuality,
} from '@markus/shared';
import { ModelScoreService } from './model-scores.js';
import { costTierFromPrice, estimateQualityScore, getModelTaskTypes, tierFromQualityScore } from './router.js';

const log = createLogger('model-profile');

const CACHE_FILE = 'model-profiles-cache.json';

/**
 * ModelProfileService builds unified ModelProfile objects by merging data from:
 * 1. ModelCatalogService (LiteLLM -- pricing, capabilities, specs)
 * 2. ModelScoreService (Arena AI -- quality benchmarks)
 * 3. BUILTIN_MODEL_CATALOG (static curated data with tier overrides)
 *
 * Profiles are rebuilt whenever either data source refreshes.
 */
export class ModelProfileService {
  private profiles = new Map<string, ModelProfile>();
  private stateDir: string;
  private cachePath: string;

  constructor(
    private scoreService: ModelScoreService,
    stateDir?: string,
  ) {
    this.stateDir = stateDir ?? join(homedir(), '.markus');
    this.cachePath = join(this.stateDir, CACHE_FILE);
  }

  /**
   * Build profiles from catalog models. Call this after catalog + scores refresh.
   */
  build(catalogModels: CatalogModel[], builtinTierOverrides?: Map<string, ModelTier>): void {
    this.profiles.clear();
    let built = 0;

    for (const model of catalogModels) {
      const profile = this.buildProfile(model, builtinTierOverrides);
      this.profiles.set(profile.id, profile);
      built++;
    }

    this.saveToCache();
    log.info(`Built ${built} model profiles`);
  }

  getProfile(modelId: string): ModelProfile | undefined {
    return this.profiles.get(modelId);
  }

  getAllProfiles(): ModelProfile[] {
    return [...this.profiles.values()];
  }

  getByTier(tier: ModelTier): ModelProfile[] {
    return this.getAllProfiles().filter(p => p.quality.tier === tier);
  }

  getByProvider(provider: string): ModelProfile[] {
    return this.getAllProfiles().filter(p => p.provider === provider);
  }

  getByTaskType(taskType: ModelTaskType): ModelProfile[] {
    return this.getAllProfiles().filter(p => p.taskTypes.includes(taskType));
  }

  /**
   * Get profiles sorted by cost efficiency (best value first).
   */
  getByCostEfficiency(taskType?: ModelTaskType): ModelProfile[] {
    let profiles = this.getAllProfiles();
    if (taskType) {
      profiles = profiles.filter(p => p.taskTypes.includes(taskType));
    }
    return profiles.sort((a, b) => b.derived.costEfficiency - a.derived.costEfficiency);
  }

  private buildProfile(model: CatalogModel, builtinTierOverrides?: Map<string, ModelTier>): ModelProfile {
    const scoreEntry = this.scoreService.getOrEstimate(model.id, model.capabilities.reasoning, model.inputCostPer1MTokens);

    const overrideTier = builtinTierOverrides?.get(model.id);
    const tier: ModelTier = overrideTier ?? scoreEntry.tier;

    const quality: ModelQuality = {
      overallElo: scoreEntry.overallElo,
      codingElo: scoreEntry.codingElo,
      visionElo: scoreEntry.visionElo,
      qualityScore: scoreEntry.qualityScore,
      tier,
      lastUpdated: new Date().toISOString(),
      source: overrideTier ? 'user_override' : scoreEntry.source,
    };

    const cost: NormalizedCost = this.buildNormalizedCost(model);
    const taskTypes = getModelTaskTypes(model.mode, model.capabilities);
    const family = this.inferFamily(model.id, model.provider);
    const displayName = this.inferDisplayName(model.id, model.provider);

    const inputCost = cost.inputPer1MTokens ?? 0;
    const costEfficiency = inputCost > 0 ? quality.qualityScore / inputCost : quality.qualityScore * 100;

    return {
      id: model.id,
      provider: model.provider,
      displayName,
      family,
      mode: model.mode,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      cost,
      capabilities: model.capabilities,
      quality,
      taskTypes,
      derived: {
        costEfficiency,
        costTier: costTierFromPrice(inputCost),
        latencyClass: this.inferLatencyClass(model),
      },
    };
  }

  private buildNormalizedCost(model: CatalogModel): NormalizedCost {
    const isFree = model.inputCostPer1MTokens === 0 && model.outputCostPer1MTokens === 0;
    const isLocal = model.provider === 'ollama';

    return {
      inputPer1MTokens: model.inputCostPer1MTokens,
      outputPer1MTokens: model.outputCostPer1MTokens,
      cachedReadPer1MTokens: model.cacheReadCostPer1MTokens,
      cachedWritePer1MTokens: model.cacheWriteCostPer1MTokens,
      pricingType: isLocal ? 'local' : isFree ? 'free' : 'token',
      isFree,
      isLocal,
      priceConfidence: 'exact',
    };
  }

  private inferFamily(modelId: string, provider: string): string {
    const id = modelId.toLowerCase();
    if (id.includes('claude') || provider === 'anthropic') return 'claude';
    if (id.includes('gpt') || id.includes('o3') || id.includes('o4')) return 'gpt';
    if (id.includes('gemini')) return 'gemini';
    if (id.includes('deepseek')) return 'deepseek';
    if (id.includes('qwen')) return 'qwen';
    if (id.includes('llama')) return 'llama';
    if (id.includes('mistral') || id.includes('mixtral')) return 'mistral';
    if (id.includes('minimax')) return 'minimax';
    if (id.includes('grok')) return 'grok';
    if (id.includes('glm')) return 'glm';
    if (id.includes('kimi') || id.includes('moonshot')) return 'kimi';
    if (id.includes('doubao')) return 'doubao';
    return provider;
  }

  private inferDisplayName(modelId: string, _provider: string): string {
    return modelId
      .replace(/^[a-z-]+\//, '')
      .replace(/-(\d{8})$/, '')
      .replace(/-latest$/, '');
  }

  private inferLatencyClass(model: CatalogModel): 'fast' | 'medium' | 'slow' {
    if (model.capabilities.reasoning) return 'slow';
    const inputCost = model.inputCostPer1MTokens;
    if (inputCost <= 0.5) return 'fast';
    if (inputCost <= 3) return 'medium';
    return 'slow';
  }

  private saveToCache(): void {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      const data = {
        builtAt: new Date().toISOString(),
        count: this.profiles.size,
        profiles: Object.fromEntries(this.profiles),
      };
      writeFileSync(this.cachePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      log.warn(`Failed to save profile cache: ${err}`);
    }
  }

  loadFromCache(): boolean {
    try {
      if (!existsSync(this.cachePath)) return false;
      const raw = readFileSync(this.cachePath, 'utf-8');
      const data = JSON.parse(raw) as { builtAt: string; profiles: Record<string, ModelProfile> };
      for (const [key, profile] of Object.entries(data.profiles)) {
        this.profiles.set(key, profile);
      }
      log.info(`Loaded ${this.profiles.size} model profiles from cache`);
      return true;
    } catch (err) {
      log.warn(`Failed to load profile cache: ${err}`);
      return false;
    }
  }
}
