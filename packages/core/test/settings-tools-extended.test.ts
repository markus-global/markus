import { describe, it, expect, vi } from 'vitest';
import { createSettingsTools } from '../src/tools/settings.js';
import type { LLMRouter } from '../src/llm/router.js';

function createMockRouter(overrides: Partial<LLMRouter> = {}): LLMRouter {
  const mockProvider = {
    configure: vi.fn(),
  };
  return {
    getEnhancedSettings: vi.fn(() => ({
      defaultProvider: 'openai',
      providers: {
        openai: {
          displayName: 'OpenAI',
          model: 'gpt-4o',
          configured: true,
          enabled: true,
          models: [],
        },
      },
    })),
    getActiveModelName: vi.fn(() => 'gpt-4o'),
    setProviderModel: vi.fn(),
    getDefaultProvider: vi.fn(() => 'openai'),
    setDefaultProvider: vi.fn(),
    registerProviderFromConfig: vi.fn(),
    getProvider: vi.fn((name: string) => (name === 'openai' ? mockProvider : undefined)),
    addCustomModel: vi.fn(),
    capabilityRouting: { assignments: {} },
    routingDefaultModel: 'gpt-4o',
    setCapabilityRouting: vi.fn(),
    ...overrides,
  } as unknown as LLMRouter;
}

function findTool(router: LLMRouter, name: string, persistConfig?: ReturnType<typeof vi.fn>) {
  const tools = createSettingsTools({ llmRouter: router, persistConfig });
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool;
}

describe('settings tools extended coverage', () => {
  it('llm_switch_model switches and persists', async () => {
    const router = createMockRouter();
    const persistConfig = vi.fn();
    const tool = findTool(router, 'llm_switch_model', persistConfig);
    const result = JSON.parse(await tool.execute({ provider: 'openai', model: 'gpt-4o-mini' }));
    expect(result.status).toBe('success');
    expect(result.newModel).toBe('gpt-4o-mini');
    expect(persistConfig).toHaveBeenCalled();
  });

  it('llm_switch_model handles router errors', async () => {
    const router = createMockRouter({
      setProviderModel: vi.fn(() => { throw new Error('invalid model'); }),
    });
    const tool = findTool(router, 'llm_switch_model');
    const result = JSON.parse(await tool.execute({ provider: 'openai', model: 'bad' }));
    expect(result.status).toBe('error');
  });

  it('llm_switch_model survives persist failure', async () => {
    const router = createMockRouter();
    const persistConfig = vi.fn(() => { throw new Error('disk full'); });
    const tool = findTool(router, 'llm_switch_model', persistConfig);
    const result = JSON.parse(await tool.execute({ provider: 'openai', model: 'gpt-4o' }));
    expect(result.status).toBe('success');
  });

  it('llm_switch_default_provider changes default', async () => {
    const router = createMockRouter();
    const persistConfig = vi.fn();
    const tool = findTool(router, 'llm_switch_default_provider', persistConfig);
    const result = JSON.parse(await tool.execute({ provider: 'anthropic' }));
    expect(result.status).toBe('success');
    expect(result.newDefault).toBe('anthropic');
  });

  it('llm_add_provider registers new provider', async () => {
    const router = createMockRouter();
    const persistConfig = vi.fn();
    const tool = findTool(router, 'llm_add_provider', persistConfig);
    const result = JSON.parse(await tool.execute({
      name: 'deepseek',
      model: 'deepseek-chat',
      api_key: 'sk-test',
      base_url: 'https://api.deepseek.com',
    }));
    expect(result.status).toBe('success');
    expect(router.registerProviderFromConfig).toHaveBeenCalled();
  });

  it('llm_edit_provider updates existing provider', async () => {
    const router = createMockRouter();
    const persistConfig = vi.fn();
    const tool = findTool(router, 'llm_edit_provider', persistConfig);
    const result = JSON.parse(await tool.execute({
      provider: 'openai',
      model: 'gpt-4.1',
      api_key: 'new-key',
    }));
    expect(result.status).toBe('success');
  });

  it('llm_edit_provider returns error when provider missing', async () => {
    const router = createMockRouter({ getProvider: vi.fn(() => undefined) });
    const tool = findTool(router, 'llm_edit_provider');
    const result = JSON.parse(await tool.execute({ provider: 'missing' }));
    expect(result.status).toBe('error');
  });

  it('llm_add_model adds custom model definition', async () => {
    const router = createMockRouter();
    const persistConfig = vi.fn();
    const tool = findTool(router, 'llm_add_model', persistConfig);
    const result = JSON.parse(await tool.execute({
      provider: 'openai',
      id: 'custom-model',
      name: 'Custom Model',
      context_window: 128000,
      max_output_tokens: 8192,
      cost_input: 1,
      cost_output: 2,
      reasoning: true,
      vision: true,
    }));
    expect(result.status).toBe('success');
    expect(router.addCustomModel).toHaveBeenCalled();
  });

  it('llm_add_model forwards capabilities declaration', async () => {
    const router = createMockRouter();
    const persistConfig = vi.fn();
    const tool = findTool(router, 'llm_add_model', persistConfig);
    const result = JSON.parse(await tool.execute({
      provider: 'localfn',
      id: 'qwen-image-2.1',
      name: 'Qwen Image 2.1 (local)',
      context_window: 0,
      max_output_tokens: 0,
      cost_input: 0,
      cost_output: 0,
      capabilities: ['imageGeneration'],
    }));
    expect(result.status).toBe('success');
    expect(router.addCustomModel).toHaveBeenCalledWith(
      'localfn',
      expect.objectContaining({
        id: 'qwen-image-2.1',
        capabilities: ['imageGeneration'],
      }),
    );
  });

  it('llm_add_model persists capabilities', async () => {
    const router = createMockRouter();
    const persistConfig = vi.fn();
    const tool = findTool(router, 'llm_add_model', persistConfig);
    await tool.execute({
      provider: 'openai',
      id: 'custom-tts',
      name: 'Custom TTS',
      context_window: 0,
      max_output_tokens: 0,
      cost_input: 0,
      cost_output: 0,
      capabilities: ['tts'],
    });
    const persisted = persistConfig.mock.calls[0][0];
    const model = persisted.llm.customModels.openai[0];
    expect(model.capabilities).toEqual(['tts']);
  });

  it('llm_add_provider forwards media timeout config and persists it', async () => {
    const router = createMockRouter();
    const persistConfig = vi.fn();
    const tool = findTool(router, 'llm_add_provider', persistConfig);
    const result = JSON.parse(await tool.execute({
      name: 'local-image',
      model: 'qwen-image-2.1',
      api_key: 'local',
      base_url: 'http://127.0.0.1:8391/v1',
      image_generation_timeout_ms: 300000,
      tts_timeout_ms: 240000,
    }));
    expect(result.status).toBe('success');
    expect(router.registerProviderFromConfig).toHaveBeenCalledWith(
      'local-image',
      expect.objectContaining({
        imageGenerationTimeoutMs: 300000,
        ttsTimeoutMs: 240000,
      }),
    );
    const persisted = persistConfig.mock.calls[0][0];
    expect(persisted.llm.providers['local-image'].imageGenerationTimeoutMs).toBe(300000);
  });

  it('llm_edit_provider forwards media timeout config to configure and persist', async () => {
    const router = createMockRouter();
    const persistConfig = vi.fn();
    const tool = findTool(router, 'llm_edit_provider', persistConfig);
    const result = JSON.parse(await tool.execute({
      provider: 'openai',
      image_generation_timeout_ms: 240000,
      decision_timeout_ms: 90000,
    }));
    expect(result.status).toBe('success');
    const provider = router.getProvider('openai') as { configure: ReturnType<typeof vi.fn> };
    expect(provider.configure).toHaveBeenCalledWith(
      expect.objectContaining({ imageGenerationTimeoutMs: 240000, decisionTimeoutMs: 90000 }),
    );
    const persisted = persistConfig.mock.calls[0][0];
    expect(persisted.llm.providers.openai.imageGenerationTimeoutMs).toBe(240000);
  });
});
