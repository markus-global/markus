import { describe, it, expect } from 'vitest';
import {
  applyHubRecommendedRouting,
  isGreenfieldLlmConfig,
  isObsoleteMarkusModel,
  recommendedUrlFromModelsUrl,
} from '../src/llm/hub-recommended-routing.js';

const RECS = {
  text: 'deepseek/deepseek-v4-flash',
  image_recognition: 'openai/gpt-4.1-mini',
  image_generation: 'openai/gpt-image-2',
  audio_tts: 'openai/tts-1',
  audio_stt: 'openai/whisper-1',
  video_generation: null as string | null,
};

describe('isObsoleteMarkusModel', () => {
  it('flags bare markus-* ids; keeps OR slugs', () => {
    expect(isObsoleteMarkusModel('markus-old')).toBe(true);
    expect(isObsoleteMarkusModel('markus-base')).toBe(true);
    expect(isObsoleteMarkusModel('')).toBe(true);
    expect(isObsoleteMarkusModel(null)).toBe(true);
    expect(isObsoleteMarkusModel('deepseek/deepseek-v4-flash')).toBe(false);
    expect(isObsoleteMarkusModel('openai/gpt-4.1-mini')).toBe(false);
  });
});

describe('isGreenfieldLlmConfig', () => {
  it('treats empty BYOK + factory default as greenfield', () => {
    expect(isGreenfieldLlmConfig({
      defaultProvider: 'anthropic',
      providers: {},
    })).toBe(true);
  });

  it('treats markus-only key as still greenfield', () => {
    expect(isGreenfieldLlmConfig({
      defaultProvider: 'anthropic',
      providers: { markus: { apiKey: 'sk-or-v1-xxx' } },
    })).toBe(true);
  });

  it('rejects upgrade users with third-party API keys', () => {
    expect(isGreenfieldLlmConfig({
      defaultProvider: 'anthropic',
      providers: { anthropic: { apiKey: 'sk-ant-xxx' } },
    })).toBe(false);
  });

  it('rejects users who changed defaultProvider', () => {
    expect(isGreenfieldLlmConfig({
      defaultProvider: 'openai',
      providers: {},
    })).toBe(false);
  });

  it('rejects users with existing routing defaults', () => {
    expect(isGreenfieldLlmConfig({
      defaultProvider: 'anthropic',
      providers: {},
      routingDefaultModel: { provider: 'anthropic', model: 'claude-opus-4-6' },
    })).toBe(false);
  });

  it('treats bare markus-* routing as still greenfield', () => {
    expect(isGreenfieldLlmConfig({
      defaultProvider: 'markus',
      providers: { markus: { apiKey: 'sk-or-v1-xxx' } },
      routingDefaultModel: { provider: 'markus', model: 'markus-old' },
    })).toBe(true);
  });
});

describe('applyHubRecommendedRouting', () => {
  it('greenfield fills default + all recommended slots', () => {
    const result = applyHubRecommendedRouting(
      { defaultProvider: 'anthropic', capabilityRouting: { assignments: {} } },
      RECS,
      { greenfield: true, force: false },
    );
    expect(result.changed).toBe(true);
    expect(result.defaultProvider).toBe('markus');
    expect(result.routingDefaultModel).toEqual({
      provider: 'markus',
      model: 'deepseek/deepseek-v4-flash',
    });
    expect(result.capabilityRouting.assignments.image_recognition).toEqual({
      provider: 'markus',
      model: 'openai/gpt-4.1-mini',
    });
    expect(result.capabilityRouting.assignments.image_generation?.model).toBe('openai/gpt-image-2');
    expect(result.capabilityRouting.assignments.video_generation).toBeUndefined();
  });

  it('upgrade does not change defaultProvider and skips filled slots', () => {
    const result = applyHubRecommendedRouting(
      {
        defaultProvider: 'anthropic',
        routingDefaultModel: { provider: 'anthropic', model: 'claude-opus-4-6' },
        capabilityRouting: {
          assignments: {
            image_recognition: { provider: 'openai', model: 'gpt-4o' },
          },
        },
      },
      RECS,
      { greenfield: false, force: false },
    );
    expect(result.defaultProvider).toBeUndefined();
    expect(result.routingDefaultModel).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
    });
    expect(result.capabilityRouting.assignments.image_recognition).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
    });
    expect(result.capabilityRouting.assignments.image_generation).toEqual({
      provider: 'markus',
      model: 'openai/gpt-image-2',
    });
  });

  it('replaces bare markus-* ids with Hub OR slug', () => {
    for (const obsolete of ['markus-old', 'markus-base'] as const) {
      const result = applyHubRecommendedRouting(
        {
          defaultProvider: 'markus',
          routingDefaultModel: { provider: 'markus', model: obsolete },
          capabilityRouting: { assignments: {} },
        },
        RECS,
        { greenfield: false, force: false },
      );
      expect(result.routingDefaultModel?.model).toBe('deepseek/deepseek-v4-flash');
    }
  });

  it('keeps valid OR slug without force', () => {
    const keep = applyHubRecommendedRouting(
      {
        defaultProvider: 'markus',
        routingDefaultModel: { provider: 'markus', model: 'anthropic/claude-sonnet-4' },
        capabilityRouting: { assignments: {} },
      },
      RECS,
      { greenfield: false, force: false },
    );
    expect(keep.routingDefaultModel?.model).toBe('anthropic/claude-sonnet-4');
  });

  it('force overwrites user choices and sets default to markus', () => {
    const result = applyHubRecommendedRouting(
      {
        defaultProvider: 'openai',
        routingDefaultModel: { provider: 'openai', model: 'gpt-4o' },
        capabilityRouting: {
          assignments: {
            image_generation: { provider: 'openai', model: 'dall-e-3' },
          },
        },
      },
      RECS,
      { force: true },
    );
    expect(result.defaultProvider).toBe('markus');
    expect(result.routingDefaultModel?.model).toBe('deepseek/deepseek-v4-flash');
    expect(result.capabilityRouting.assignments.image_generation?.model).toBe('openai/gpt-image-2');
  });

  it('force clears assignments when Hub recommends null for that capability', () => {
    const result = applyHubRecommendedRouting(
      {
        defaultProvider: 'markus',
        routingDefaultModel: { provider: 'markus', model: 'markus-old' },
        capabilityRouting: {
          assignments: {
            image_recognition: { provider: 'markus', model: 'google/gemini-3.1-flash-lite-image' },
            audio_tts: { provider: 'markus', model: 'google/lyria-3-pro-preview' },
            image_generation: { provider: 'markus', model: 'openai/gpt-image-1' },
          },
        },
      },
      {
        text: 'deepseek/deepseek-v4-flash',
        image_recognition: null,
        image_generation: 'openai/gpt-image-1',
        audio_tts: 'deepgram/aura-2',
        audio_stt: 'deepgram/nova-3',
        video_generation: null,
      },
      { force: true },
    );
    expect(result.changed).toBe(true);
    expect(result.routingDefaultModel).toEqual({
      provider: 'markus',
      model: 'deepseek/deepseek-v4-flash',
    });
    expect(result.capabilityRouting.assignments.image_recognition).toBeUndefined();
    expect(result.capabilityRouting.assignments.video_generation).toBeUndefined();
    expect(result.capabilityRouting.assignments.audio_tts).toEqual({
      provider: 'markus',
      model: 'deepgram/aura-2',
    });
    expect(result.capabilityRouting.assignments.image_generation?.model).toBe('openai/gpt-image-1');
  });

  it('Hub null multimodal leaves slots empty and clears prior Markus assignments without force', () => {
    const result = applyHubRecommendedRouting(
      {
        defaultProvider: 'markus',
        routingDefaultModel: { provider: 'markus', model: 'deepseek/deepseek-v4-flash' },
        capabilityRouting: {
          assignments: {
            image_generation: { provider: 'markus', model: 'openai/gpt-image-1' },
            audio_tts: { provider: 'markus', model: 'deepgram/aura-2' },
            image_recognition: { provider: 'openai', model: 'gpt-4o' },
          },
        },
      },
      {
        text: 'deepseek/deepseek-v4-flash',
        image_recognition: null,
        image_generation: null,
        audio_tts: null,
        audio_stt: null,
        video_generation: null,
      },
      { force: false, greenfield: false },
    );
    expect(result.changed).toBe(true);
    // Markus-sourced factory defaults cleared when Hub has no recommendation
    expect(result.capabilityRouting.assignments.image_generation).toBeUndefined();
    expect(result.capabilityRouting.assignments.audio_tts).toBeUndefined();
    // BYOK assignment preserved when Hub slot is null (non-force)
    expect(result.capabilityRouting.assignments.image_recognition).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
    });
  });

  it('greenfield with all-null Hub multimodal does not invent defaults', () => {
    const result = applyHubRecommendedRouting(
      { defaultProvider: 'anthropic', capabilityRouting: { assignments: {} } },
      {
        text: 'deepseek/deepseek-v4-flash',
        image_recognition: null,
        image_generation: null,
        audio_tts: null,
        audio_stt: null,
        video_generation: null,
      },
      { greenfield: true, force: false },
    );
    expect(result.changed).toBe(true);
    expect(result.routingDefaultModel?.model).toBe('deepseek/deepseek-v4-flash');
    expect(result.capabilityRouting.assignments.image_generation).toBeUndefined();
    expect(result.capabilityRouting.assignments.audio_tts).toBeUndefined();
    expect(result.capabilityRouting.assignments.audio_stt).toBeUndefined();
    expect(result.capabilityRouting.assignments.image_recognition).toBeUndefined();
    expect(result.capabilityRouting.assignments.video_generation).toBeUndefined();
  });

  it('Hub text recommendation OR slug becomes routingDefaultModel', () => {
    const greenfield = applyHubRecommendedRouting(
      { defaultProvider: 'anthropic', capabilityRouting: { assignments: {} } },
      RECS,
      { greenfield: true, force: false },
    );
    expect(greenfield.routingDefaultModel).toEqual({
      provider: 'markus',
      model: 'deepseek/deepseek-v4-flash',
    });

    const forcePro = applyHubRecommendedRouting(
      {
        defaultProvider: 'markus',
        routingDefaultModel: { provider: 'markus', model: 'deepseek/deepseek-v4-flash' },
        capabilityRouting: { assignments: {} },
      },
      { ...RECS, text: 'deepseek/deepseek-v4-pro' },
      { force: true },
    );
    expect(forcePro.routingDefaultModel).toEqual({
      provider: 'markus',
      model: 'deepseek/deepseek-v4-pro',
    });
  });
});

describe('recommendedUrlFromModelsUrl', () => {
  it('maps live catalog URL to recommended endpoint', () => {
    expect(recommendedUrlFromModelsUrl('https://markus.global/api/models/live/markus'))
      .toBe('https://markus.global/api/models/recommended');
  });
});

describe('markusCatalogUrlFromHub / isLegacyMarkusProxyBaseUrl', () => {
  it('builds catalog URL from hub base', async () => {
    const { markusCatalogUrlFromHub, isLegacyMarkusProxyBaseUrl } = await import('../src/llm/hub-recommended-routing.js');
    expect(markusCatalogUrlFromHub('http://localhost:3003'))
      .toBe('http://localhost:3003/api/models/live/markus');
    expect(isLegacyMarkusProxyBaseUrl('http://localhost:8787')).toBe(true);
    expect(isLegacyMarkusProxyBaseUrl('https://openrouter.ai/api/v1')).toBe(false);
  });
});
