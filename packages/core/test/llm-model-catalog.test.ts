import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockStatSync = vi.fn();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    statSync: (...args: unknown[]) => mockStatSync(...args),
  };
});

describe('ModelCatalogService', () => {
  beforeEach(() => {
    vi.resetModules();
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
    mockExistsSync.mockReset();
    mockMkdirSync.mockReset();
    mockStatSync.mockReset();
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function loadService(mirrorUrl?: string) {
    const { ModelCatalogService } = await import('../src/llm/model-catalog.js');
    return new ModelCatalogService(mirrorUrl ? { mirrorUrl } : undefined);
  }

  const sampleCatalog = {
    'anthropic/claude-opus-4-6': {
      litellm_provider: 'anthropic',
      mode: 'chat',
      max_input_tokens: 200000,
      max_output_tokens: 8192,
      input_cost_per_token: 0.000015,
      output_cost_per_token: 0.000075,
      supports_vision: true,
      supports_function_calling: true,
    },
    'openai/gpt-4o': {
      litellm_provider: 'openai',
      mode: 'chat',
      max_input_tokens: 128000,
      max_output_tokens: 16384,
      input_cost_per_token: 0.0000025,
      output_cost_per_token: 0.00001,
    },
    'deepseek-ai/DeepSeek-V3': {
      litellm_provider: 'deepseek',
      mode: 'chat',
      max_input_tokens: 64000,
      max_output_tokens: 8192,
      input_cost_per_token: 0.00000014,
      output_cost_per_token: 0.00000028,
    },
  };

  describe('stripProviderPrefix', () => {
    it('strips known LiteLLM provider prefix', async () => {
      const { ModelCatalogService } = await import('../src/llm/model-catalog.js');
      expect(ModelCatalogService.stripProviderPrefix('anthropic/claude-opus-4-6')).toBe('claude-opus-4-6');
      expect(ModelCatalogService.stripProviderPrefix('openai/gpt-4o')).toBe('gpt-4o');
    });

    it('preserves org/model paths for unknown prefixes', async () => {
      const { ModelCatalogService } = await import('../src/llm/model-catalog.js');
      expect(ModelCatalogService.stripProviderPrefix('deepseek-ai/DeepSeek-V3')).toBe('deepseek-ai/DeepSeek-V3');
    });

    it('returns id unchanged when no slash', async () => {
      const { ModelCatalogService } = await import('../src/llm/model-catalog.js');
      expect(ModelCatalogService.stripProviderPrefix('gpt-4o')).toBe('gpt-4o');
    });
  });

  it('refresh loads models from remote fetch', async () => {
    const service = await loadService('https://mirror.example/catalog.json');
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(sampleCatalog)),
    });
    vi.stubGlobal('fetch', mockFetch);

    const ok = await service.refresh();
    expect(ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith('https://mirror.example/catalog.json', expect.any(Object));

    const anthropicModels = service.getModelsByProvider('anthropic');
    expect(anthropicModels.some(m => m.id === 'claude-opus-4-6')).toBe(true);

    const status = service.getStatus();
    expect(status.source).toBe('remote');
    expect(status.totalModels).toBeGreaterThan(0);
  });

  it('getModelsByProvider resolves regional aliases', async () => {
    const service = await loadService('https://mirror.example/catalog.json');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({
        'minimax/MiniMax-M3': {
          litellm_provider: 'minimax',
          mode: 'chat',
          max_input_tokens: 512000,
          max_output_tokens: 128000,
          input_cost_per_token: 0.0000006,
          output_cost_per_token: 0.0000024,
        },
      })),
    }));
    await service.refresh();

    const cnModels = service.getModelsByProvider('minimax-cn');
    expect(cnModels.some(m => m.id === 'MiniMax-M3')).toBe(true);
  });

  it('searchModels filters by query and optional provider', async () => {
    const service = await loadService('https://mirror.example/catalog.json');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(sampleCatalog)),
    }));
    await service.refresh();

    const gptResults = service.searchModels('gpt');
    expect(gptResults.some(m => m.id === 'gpt-4o')).toBe(true);

    const anthropicGpt = service.searchModels('gpt', 'anthropic');
    expect(anthropicGpt).toHaveLength(0);
  });

  it('refresh returns false when all sources fail', async () => {
    const service = await loadService('https://mirror.example/catalog.json');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    const ok = await service.refresh();
    expect(ok).toBe(false);
    expect(service.getStatus().totalModels).toBe(0);
  });

  it('shutdown clears refresh timer', async () => {
    const service = await loadService();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue(JSON.stringify(sampleCatalog));
    await service.initialize();
    service.shutdown();
  });
});
