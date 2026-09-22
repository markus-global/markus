import { describe, it, expect } from 'vitest';
import {
  CHAT_CAPABILITY,
  NON_CHAT_CAPABILITIES,
  isChatCapableModel,
} from '../src/llm/model-capabilities.js';

describe('isChatCapableModel', () => {
  it('treats an undeclared model as chat (legacy default, must not regress)', () => {
    expect(isChatCapableModel({})).toBe(true);
    expect(isChatCapableModel({ capabilities: [] })).toBe(true);
  });

  it('rejects every dedicated media endpoint', () => {
    for (const tag of NON_CHAT_CAPABILITIES) {
      expect(isChatCapableModel({ capabilities: [tag] })).toBe(false);
    }
  });

  it('keeps the local qwen-image-2.1 shape out of chat', () => {
    // The real declaration that produced `404 not found: /v1/chat/completions`.
    expect(isChatCapableModel({ capabilities: ['imageGeneration'] })).toBe(false);
  });

  it('honours the explicit chat tag alongside media tags', () => {
    expect(isChatCapableModel({ capabilities: ['imageGeneration', CHAT_CAPABILITY] })).toBe(true);
    expect(isChatCapableModel({ capabilities: [CHAT_CAPABILITY] })).toBe(true);
  });

  it('lets an explicit chat tag beat a non-chat catalog mode', () => {
    expect(isChatCapableModel({ capabilities: [CHAT_CAPABILITY], mode: 'image_generation' })).toBe(true);
  });

  it('respects a non-chat catalog mode when nothing is declared', () => {
    expect(isChatCapableModel({ mode: 'image_generation' })).toBe(false);
    expect(isChatCapableModel({ mode: 'audio_speech' })).toBe(false);
    expect(isChatCapableModel({ mode: 'chat' })).toBe(true);
  });

  it('does not treat descriptive tags as media endpoints', () => {
    // vision / reasoning describe a chat model; decision is a different shape.
    expect(isChatCapableModel({ capabilities: ['vision', 'reasoning'] })).toBe(true);
    expect(isChatCapableModel({ capabilities: ['decision'] })).toBe(true);
  });
});
