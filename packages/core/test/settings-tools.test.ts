import { describe, it, expect, vi } from 'vitest';
import { createSettingsTools } from '../src/tools/settings.js';
import type { LLMRouter } from '../src/llm/router.js';

function createMockRouter(overrides: Partial<LLMRouter> = {}): LLMRouter {
  const capabilityRouting = {
    assignments: {} as Record<string, { provider: string; model: string; fallback?: { provider: string; model: string } } | undefined>,
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
          models: [
            {
              id: 'gpt-4o',
              name: 'GPT-4o',
              contextWindow: 128000,
              maxOutputTokens: 16384,
              cost: { input: 2.5, output: 10 },
              reasoning: false,
              inputTypes: ['text', 'image'],
            },
            {
              id: 'gpt-image-1',
              name: 'GPT Image',
              contextWindow: 0,
              maxOutputTokens: 0,
              cost: { input: 0, output: 0 },
            },
            {
              id: 'tts-1',
              name: 'TTS',
              contextWindow: 0,
              maxOutputTokens: 0,
              cost: { input: 0, output: 0 },
            },
          ],
        },
        anthropic: {
          displayName: 'Anthropic',
          model: 'claude-sonnet-4',
          configured: false,
          enabled: false,
          models: [],
        },
      },
    })),
    getActiveModelName: vi.fn(() => 'gpt-4o'),
    setProviderModel: vi.fn(),
    getDefaultProvider: vi.fn(() => 'openai'),
    setDefaultProvider: vi.fn(),
    registerProviderFromConfig: vi.fn(),
    getProvider: vi.fn(),
    addCustomModel: vi.fn(),
    capabilityRouting,
    routingDefaultModel: 'gpt-4o',
    setCapabilityRouting: vi.fn((routing) => {
      Object.assign(capabilityRouting, routing);
    }),
    ...overrides,
  } as unknown as LLMRouter;
}

function findTool(router: LLMRouter, name: string, persistConfig?: ReturnType<typeof vi.fn>) {
  const tools = createSettingsTools({ llmRouter: router, persistConfig });
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool;
}

describe('createSettingsTools', () => {
  it('returns expected tools', () => {
    const router = createMockRouter();
    const tools = createSettingsTools({ llmRouter: router });
    expect(tools.map(t => t.name)).toEqual([
      'llm_list_providers',
      'llm_switch_model',
      'llm_switch_default_provider',
      'llm_add_provider',
      'llm_edit_provider',
      'llm_add_model',
      'llm_get_capability_routing',
      'llm_set_capability_routing',
    ]);
  });

  describe('llm_list_providers', () => {
    it('lists only enabled providers by default', async () => {
      const router = createMockRouter();
      const tool = findTool(router, 'llm_list_providers');
      const result = JSON.parse(await tool.execute({}));
      expect(result.defaultProvider).toBe('openai');
      expect(result.enabled_count).toBe(1);
      expect(result.total_count).toBe(1);
      expect(result.providers).toHaveLength(1);
      expect(result.providers[0].name).toBe('openai');
      expect(result.providers[0].isDefault).toBe(true);
      expect(result.providers[0].availableModels[0].vision).toBe(true);
    });

    it('includes disabled providers when show_all is true', async () => {
      const router = createMockRouter();
      const tool = findTool(router, 'llm_list_providers');
      const result = JSON.parse(await tool.execute({ show_all: true }));
      expect(result.total_count).toBe(2);
      expect(result.providers.some((p: { name: string }) => p.name === 'anthropic')).toBe(true);
    });
  });

  describe('detectModelCapabilityMismatch (via llm_set_capability_routing)', () => {
    it('rejects text model for image_generation capability', async () => {
      const router = createMockRouter();
      const tool = findTool(router, 'llm_set_capability_routing');
      const result = JSON.parse(await tool.execute({
        capability_type: 'image_generation',
        provider: 'openai',
        model: 'gpt-4o',
      }));
      expect(result.status).toBe('error');
      expect(result.error).toContain('text/chat model');
      expect(result.error).toContain('image_generation');
      expect(result.hint).toContain('image_generation');
    });

    it('accepts matching image model for image_generation', async () => {
      const router = createMockRouter();
      const persistConfig = vi.fn();
      const tool = findTool(router, 'llm_set_capability_routing', persistConfig);
      const result = JSON.parse(await tool.execute({
        capability_type: 'image_generation',
        provider: 'openai',
        model: 'gpt-image-1',
      }));
      expect(result.status).toBe('success');
      expect(result.capability_type).toBe('image_generation');
      expect(router.setCapabilityRouting).toHaveBeenCalled();
      expect(persistConfig).toHaveBeenCalled();
    });

    it('rejects text model for audio_tts capability', async () => {
      const router = createMockRouter();
      const tool = findTool(router, 'llm_set_capability_routing');
      const result = JSON.parse(await tool.execute({
        capability_type: 'audio_tts',
        provider: 'openai',
        model: 'claude-sonnet-4',
      }));
      expect(result.status).toBe('error');
      expect(result.error).toContain('text/chat model');
    });

    it('accepts whisper model for audio_stt', async () => {
      const router = createMockRouter();
      const tool = findTool(router, 'llm_set_capability_routing');
      const result = JSON.parse(await tool.execute({
        capability_type: 'audio_stt',
        provider: 'openai',
        model: 'whisper-1',
      }));
      expect(result.status).toBe('success');
    });

    it('does not validate text capability type', async () => {
      const router = createMockRouter();
      const tool = findTool(router, 'llm_set_capability_routing');
      const result = JSON.parse(await tool.execute({
        capability_type: 'text',
        provider: 'openai',
        model: 'gpt-4o',
      }));
      expect(result.status).toBe('success');
    });

    it('allows unknown model names without text pattern match', async () => {
      const router = createMockRouter();
      const tool = findTool(router, 'llm_set_capability_routing');
      const result = JSON.parse(await tool.execute({
        capability_type: 'image_generation',
        provider: 'custom',
        model: 'my-custom-image-model-v2',
      }));
      expect(result.status).toBe('success');
    });
  });

  describe('llm_set_capability_routing validation', () => {
    it('clears assignment when provider and model are empty', async () => {
      const router = createMockRouter();
      router.capabilityRouting.assignments.image_generation = { provider: 'openai', model: 'gpt-image-1' };
      const persistConfig = vi.fn();
      const tool = findTool(router, 'llm_set_capability_routing', persistConfig);
      const result = JSON.parse(await tool.execute({
        capability_type: 'image_generation',
        provider: '',
        model: '',
      }));
      expect(result.status).toBe('success');
      expect(result.message).toContain('Cleared capability routing');
      expect(router.setCapabilityRouting).toHaveBeenCalled();
    });

    it('sets fallback provider when provided', async () => {
      const router = createMockRouter();
      const tool = findTool(router, 'llm_set_capability_routing');
      const result = JSON.parse(await tool.execute({
        capability_type: 'audio_tts',
        provider: 'openai',
        model: 'tts-1',
        fallback_provider: 'openai',
        fallback_model: 'tts-1-hd',
      }));
      expect(result.status).toBe('success');
      expect(result.fallback).toEqual({ provider: 'openai', model: 'tts-1-hd' });
    });

    it('returns llm_get_capability_routing with capability types', async () => {
      const router = createMockRouter();
      const tool = findTool(router, 'llm_get_capability_routing');
      const result = JSON.parse(await tool.execute({}));
      expect(result.routing_default_model).toBe('gpt-4o');
      expect(result.capability_types).toContain('image_generation');
      expect(result.capability_types).toContain('audio_stt');
    });
  });
});
