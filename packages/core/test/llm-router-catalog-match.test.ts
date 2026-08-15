import { describe, it, expect } from 'vitest';
import {
  normalizeCatalogId,
  findCatalogEntry,
} from '../src/llm/router-catalog-match.js';
import type { ModelDefinition } from '@markus/shared';

function def(partial: Partial<ModelDefinition> & { id: string }): ModelDefinition {
  return {
    name: partial.id,
    provider: 'deepseek',
    contextWindow: 0,
    maxOutputTokens: 0,
    cost: { input: 0, output: 0 },
    inputTypes: ['text'],
    tier: 'pro',
    ...partial,
  } as ModelDefinition;
}

const BUILTIN: ModelDefinition[] = [
  def({ id: 'deepseek-v4-flash', provider: 'deepseek', contextWindow: 1_000_000, maxOutputTokens: 384_000 }),
  def({ id: 'claude-opus-4-6', provider: 'anthropic', contextWindow: 1_000_000 }),
  def({ id: 'google/gemini-3-1-pro', provider: 'openrouter', contextWindow: 1_000_000 }),
];

// Hub catalog for the Markus provider uses OpenRouter slugs as ids.
const HUB: ModelDefinition[] = [
  def({ id: 'deepseek/deepseek-v4-flash', provider: 'markus', contextWindow: 1_000_000, maxOutputTokens: 393_216 }),
  def({ id: 'anthropic/claude-opus-4-6', provider: 'markus', contextWindow: 1_000_000 }),
];

describe('normalizeCatalogId', () => {
  it('strips a markus/ namespace', () => {
    expect(normalizeCatalogId('markus/deepseek/deepseek-v4-flash')).toBe('deepseek-v4-flash');
  });
  it('strips a known vendor prefix', () => {
    expect(normalizeCatalogId('deepseek/deepseek-v4-flash')).toBe('deepseek-v4-flash');
  });
  it('does NOT strip org/model forms (deepseek-ai/DeepSeek-V3)', () => {
    expect(normalizeCatalogId('deepseek-ai/DeepSeek-V3')).toBe('deepseek-ai/DeepSeek-V3');
  });
  it('leaves bare ids untouched', () => {
    expect(normalizeCatalogId('claude-opus-4-6')).toBe('claude-opus-4-6');
  });
});

describe('findCatalogEntry — Markus provider (Hub = sole source)', () => {
  it('resolves a Hub slug by exact id when the catalog is loaded', () => {
    const entry = findCatalogEntry('markus', 'deepseek/deepseek-v4-flash', { builtin: BUILTIN, hub: HUB });
    expect(entry?.contextWindow).toBe(1_000_000);
    expect(entry?.maxOutputTokens).toBe(393_216);
  });
  it('returns undefined when the Hub catalog is empty (no cross-provider borrow)', () => {
    const entry = findCatalogEntry('markus', 'deepseek/deepseek-v4-flash', { builtin: BUILTIN, hub: [] });
    expect(entry).toBeUndefined();
  });
  it('does NOT borrow the builtin deepseek entry for a markus model', () => {
    const entry = findCatalogEntry('markus', 'deepseek-v4-flash', { builtin: BUILTIN, hub: [] });
    expect(entry).toBeUndefined();
  });
  it('resolves via normalized id when the hub stores a bare id', () => {
    const bareHub = [def({ id: 'deepseek-v4-flash', provider: 'markus', contextWindow: 1_000_000 })];
    const entry = findCatalogEntry('markus', 'deepseek/deepseek-v4-flash', { builtin: BUILTIN, hub: bareHub });
    expect(entry?.contextWindow).toBe(1_000_000);
  });
});

describe('findCatalogEntry — builtin providers', () => {
  it('exact id for the matching provider', () => {
    const entry = findCatalogEntry('deepseek', 'deepseek-v4-flash', { builtin: BUILTIN, hub: [] });
    expect(entry?.contextWindow).toBe(1_000_000);
  });
  it('does NOT match an id under the wrong provider', () => {
    const entry = findCatalogEntry('anthropic', 'deepseek-v4-flash', { builtin: BUILTIN, hub: [] });
    expect(entry).toBeUndefined();
  });
  it('normalizes vendor-prefixed ids for the native provider', () => {
    const entry = findCatalogEntry('deepseek', 'deepseek/deepseek-v4-flash', { builtin: BUILTIN, hub: [] });
    expect(entry?.contextWindow).toBe(1_000_000);
  });
  it('treats missing/empty model ids as unresolved', () => {
    expect(findCatalogEntry('deepseek', '', { builtin: BUILTIN, hub: [] })).toBeUndefined();
    expect(findCatalogEntry('deepseek', null, { builtin: BUILTIN, hub: [] })).toBeUndefined();
  });
});
