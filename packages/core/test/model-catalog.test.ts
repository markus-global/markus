import { describe, it, expect, beforeEach } from 'vitest';
import { ModelCatalogService, type ArenaEntry } from '../src/llm/model-catalog.js';
import type { CatalogModel } from '@markus/shared';

describe('ModelCatalogService', () => {
  let service: ModelCatalogService;

  beforeEach(() => {
    service = new ModelCatalogService();
  });

  // -------------------------------------------------------------------------
  // Constructor & lifecycle
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('should construct without throwing', () => {
      expect(service).toBeInstanceOf(ModelCatalogService);
    });

    it('should accept an optional mirrorUrl option', () => {
      const s = new ModelCatalogService({ mirrorUrl: 'https://mirror.example.com/catalog.json' });
      expect(s).toBeInstanceOf(ModelCatalogService);
    });
  });

  // -------------------------------------------------------------------------
  // loadArena() — consume arena JSON files (Issue 1 fix)
  // -------------------------------------------------------------------------

  describe('loadArena', () => {
    it('should load arena text data with non-empty entries', () => {
      const map = service.loadArena('text');
      expect(map).toBeInstanceOf(Map);
      expect(map.size).toBeGreaterThan(0);
    });

    it('should load arena code data with non-empty entries', () => {
      const map = service.loadArena('code');
      expect(map).toBeInstanceOf(Map);
      expect(map.size).toBeGreaterThan(0);
    });

    it('should load arena vision data with non-empty entries', () => {
      const map = service.loadArena('vision');
      expect(map).toBeInstanceOf(Map);
      expect(map.size).toBeGreaterThan(0);
    });

    it('should cache arena data across calls (same Map returned)', () => {
      const first = service.loadArena('text');
      const second = service.loadArena('text');
      expect(second).toBe(first);
    });

    it('should expose well-formed ArenaEntry rows with required numeric fields', () => {
      const map = service.loadArena('text');
      const sample = map.values().next().value as ArenaEntry | undefined;
      expect(sample).toBeDefined();
      if (sample) {
        expect(typeof sample.model).toBe('string');
        expect(typeof sample.provider).toBe('string');
        expect(typeof sample.elo).toBe('number');
        expect(sample.elo).toBeGreaterThan(0);
        expect(typeof sample.ranking).toBe('number');
        expect(sample.ranking).toBeGreaterThan(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // enrichModel() — uses Wave 0 types (Issue 2 fix)
  // -------------------------------------------------------------------------

  describe('enrichModel', () => {
    const baseModel: CatalogModel = {
      id: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      mode: 'chat',
      maxInputTokens: 200000,
      maxOutputTokens: 8192,
      inputCostPer1MTokens: 3,
      outputCostPer1MTokens: 15,
      capabilities: {
        vision: true,
        functionCalling: true,
        reasoning: true,
        promptCaching: true,
        webSearch: false,
        audioInput: false,
        audioOutput: false,
      },
    };

    it('should return enrichment with all required fields', () => {
      const result = service.enrichModel(baseModel);
      expect(result).toHaveProperty('tier');
      expect(result).toHaveProperty('costTier');
      expect(result).toHaveProperty('taskTypes');
      expect(result).toHaveProperty('quality');
      expect(result).toHaveProperty('normalizedCost');
    });

    it('should return taskTypes as a typed array including text_chat baseline', () => {
      const result = service.enrichModel(baseModel);
      expect(Array.isArray(result.taskTypes)).toBe(true);
      expect(result.taskTypes).toContain('text_chat');
      // Reasoning-capable models should be tagged with text_reasoning
      expect(result.taskTypes).toContain('text_reasoning');
      // Function-calling capable models should be tagged with text_coding
      expect(result.taskTypes).toContain('text_coding');
    });

    it('should populate arena Elo fields when arena data is available', () => {
      // claude-sonnet-4-20250514 is in arena-text.json with elo 1452
      const result = service.enrichModel(baseModel);
      expect(result.quality.overallElo).toBe(1452);
      expect(result.quality.source).toBe('arena');
    });

    it('should derive qualityScore from Elo when arena data is available', () => {
      const result = service.enrichModel(baseModel);
      expect(typeof result.quality.qualityScore).toBe('number');
      expect(result.quality.qualityScore).toBeGreaterThanOrEqual(0);
      expect(result.quality.qualityScore).toBeLessThanOrEqual(100);
    });

    it('should fall back to heuristic scoring for models without arena data', () => {
      const unknownModel: CatalogModel = {
        ...baseModel,
        id: 'totally-fake-model-xyz',
      };
      const result = service.enrichModel(unknownModel);
      expect(result.quality.overallElo).toBeUndefined();
      expect(result.quality.source).toBe('heuristic');
    });

    it('should classify max-tier for expensive + reasoning models', () => {
      const maxModel: CatalogModel = {
        ...baseModel,
        id: 'claude-opus-4-6',
        inputCostPer1MTokens: 15,
        outputCostPer1MTokens: 75,
      };
      const result = service.enrichModel(maxModel);
      // avgCost = (15 + 75) / 2 = 45 > 10, has reasoning => 'max'
      expect(result.tier).toBe('max');
    });

    it('should classify costTier correctly for given pricing', () => {
      const result = service.enrichModel(baseModel);
      // avgCost = (3 + 15) / 2 = 9 falls in (3, 10] => '$$$'
      expect(result.costTier).toBe('$$$');
    });

    it('should populate normalizedCost with pricing metadata', () => {
      const result = service.enrichModel(baseModel);
      expect(result.normalizedCost.inputPer1MTokens).toBe(3);
      expect(result.normalizedCost.outputPer1MTokens).toBe(15);
      expect(result.normalizedCost.pricingType).toBe('token');
      expect(result.normalizedCost.isFree).toBe(false);
      expect(result.normalizedCost.priceConfidence).toBe('estimated');
    });
  });

  // -------------------------------------------------------------------------
  // Public query API
  // -------------------------------------------------------------------------

  describe('public query API', () => {
    it('should return empty results before initialize() loads the catalog', () => {
      expect(service.getModelInfo('claude-sonnet-4-20250514')).toBeUndefined();
      expect(service.getModelsByProvider('anthropic')).toEqual([]);
      expect(service.searchModels('claude')).toEqual([]);
    });

    it('should report zero models in status before initialize()', () => {
      const status = service.getStatus();
      expect(status.totalModels).toBe(0);
      expect(status.chatModels).toBe(0);
      expect(status.providers).toEqual([]);
      expect(status.source).toBe('baseline');
    });

    it('should return sorted providers list', () => {
      const providers = service.getAllProviders();
      expect(Array.isArray(providers)).toBe(true);
      // Empty before initialize, but should be sorted if non-empty
      const sorted = [...providers].sort();
      expect(providers).toEqual(sorted);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases — what Code Reviewer flagged
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should not throw when enriching a model with zero pricing', () => {
      const freeModel: CatalogModel = {
        id: 'free-test-model',
        provider: 'ollama',
        mode: 'chat',
        maxInputTokens: 32000,
        maxOutputTokens: 4000,
        inputCostPer1MTokens: 0,
        outputCostPer1MTokens: 0,
        capabilities: {
          vision: false,
          functionCalling: false,
          reasoning: false,
          promptCaching: false,
          webSearch: false,
          audioInput: false,
          audioOutput: false,
        },
      };
      const result = service.enrichModel(freeModel);
      expect(result.normalizedCost.isFree).toBe(true);
      expect(result.normalizedCost.isLocal).toBe(true);
      expect(result.normalizedCost.pricingType).toBe('local');
      // avgCost = 0 => tier should be 'base'
      expect(result.tier).toBe('base');
      // avgCost = 0 => costTier should be '$'
      expect(result.costTier).toBe('$');
    });

    it('should classify pro-tier for mid-cost + function-calling models', () => {
      const midModel: CatalogModel = {
        id: 'mid-tier-model',
        provider: 'deepseek',
        mode: 'chat',
        maxInputTokens: 32000,
        maxOutputTokens: 4000,
        inputCostPer1MTokens: 1.5,
        outputCostPer1MTokens: 1.5,
        capabilities: {
          vision: false,
          functionCalling: true,
          reasoning: false,
          promptCaching: false,
          webSearch: false,
          audioInput: false,
          audioOutput: false,
        },
      };
      const result = service.enrichModel(midModel);
      // avgCost = 1.5, has functionCalling => 'pro' per estimateTier rule
      expect(result.tier).toBe('pro');
      // avgCost = 1.5 falls in (0.5, 3] => '$$'
      expect(result.costTier).toBe('$$');
    });
  });
});
