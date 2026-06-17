// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModelPicker } from './ModelPicker.tsx';
import type { CatalogModel } from '../api.ts';

function makeModel(overrides: Partial<CatalogModel> & { id: string }): CatalogModel {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    provider: overrides.provider ?? 'test-provider',
    tier: overrides.tier ?? 'pro',
    maxInputTokens: overrides.maxInputTokens ?? 8000,
    maxOutputTokens: overrides.maxOutputTokens ?? 4096,
    inputCostPer1MTokens: overrides.inputCostPer1MTokens ?? 0,
    outputCostPer1MTokens: overrides.outputCostPer1MTokens ?? 0,
    capabilities: {
      functionCalling: overrides.capabilities?.functionCalling ?? false,
      vision: overrides.capabilities?.vision ?? false,
      reasoning: overrides.capabilities?.reasoning ?? false,
      promptCaching: overrides.capabilities?.promptCaching ?? false,
      webSearch: overrides.capabilities?.webSearch ?? false,
    },
  };
}

const sampleModels: CatalogModel[] = [
  makeModel({ id: 'claude-sonnet-4', tier: 'max', maxInputTokens: 200000, inputCostPer1MTokens: 3, outputCostPer1MTokens: 15, capabilities: { functionCalling: true, vision: true, reasoning: true, promptCaching: true, webSearch: false } }),
  makeModel({ id: 'claude-haiku-3', tier: 'base', maxInputTokens: 200000, inputCostPer1MTokens: 0.25, outputCostPer1MTokens: 1.25, capabilities: { functionCalling: true, vision: true, reasoning: false, promptCaching: true, webSearch: false } }),
  makeModel({ id: 'gpt-4o', tier: 'max', maxInputTokens: 128000, inputCostPer1MTokens: 2.5, outputCostPer1MTokens: 10, capabilities: { functionCalling: true, vision: true, reasoning: false, promptCaching: false, webSearch: true } }),
  makeModel({ id: 'gpt-4o-mini', tier: 'base', maxInputTokens: 128000, inputCostPer1MTokens: 0.15, outputCostPer1MTokens: 0.6, capabilities: { functionCalling: true, vision: true, reasoning: false, promptCaching: false, webSearch: false } }),
  makeModel({ id: 'deepseek-v3', tier: 'pro', maxInputTokens: 64000, inputCostPer1MTokens: 0.5, outputCostPer1MTokens: 1.5, capabilities: { functionCalling: true, vision: false, reasoning: true, promptCaching: false, webSearch: false } }),
  makeModel({ id: 'gemini-2.5-flash', tier: 'base', maxInputTokens: 1000000, inputCostPer1MTokens: 0.1, outputCostPer1MTokens: 0.4, capabilities: { functionCalling: true, vision: true, reasoning: true, promptCaching: false, webSearch: true } }),
];

describe('ModelPicker', () => {
  // ── Empty / loading states ──
  describe('loading and empty states', () => {
    it('shows loading spinner when loading=true', () => {
      const { container } = render(
        <ModelPicker provider="test" models={[]} onSelect={() => {}} loading />
      );
      expect(container.querySelector('.animate-spin')).toBeTruthy();
    });

    it('shows empty message when no models', () => {
      render(
        <ModelPicker provider="test" models={[]} onSelect={() => {}} />
      );
      expect(screen.getByText('No models available for this provider.')).toBeTruthy();
    });
  });

  // ── Model list rendering ──
  describe('model list', () => {
    it('renders all model IDs', () => {
      render(
        <ModelPicker provider="test" models={sampleModels} onSelect={() => {}} />
      );
      expect(screen.getByText('claude-sonnet-4')).toBeTruthy();
      expect(screen.getByText('gpt-4o')).toBeTruthy();
      expect(screen.getByText('deepseek-v3')).toBeTruthy();
    });

    it('highlights selected model', () => {
      render(
        <ModelPicker provider="test" models={sampleModels} selectedModel="gpt-4o" onSelect={() => {}} />
      );
      const selected = screen.getByText('gpt-4o').closest('button');
      expect(selected?.className).toContain('brand-500');
      expect(screen.getByText('Active')).toBeTruthy();
    });

    it('shows context window and cost for models with metadata', () => {
      render(
        <ModelPicker provider="test" models={sampleModels} onSelect={() => {}} />
      );
      // Multiple models have 128K ctx (gpt-4o, gpt-4o-mini)
      // Use getAllByText + assert count >= 2
      const ctxElements = screen.getAllByText('128K ctx');
      expect(ctxElements.length).toBeGreaterThanOrEqual(2);
      // Also verify cost formatting appears
      const costElements = screen.getAllByText(/\$[\d.]+/);
      expect(costElements.length).toBeGreaterThan(0);
    });

    it('renders capability badges in non-compact mode', () => {
      render(
        <ModelPicker provider="test" models={[sampleModels[0]]} onSelect={() => {}} />
      );
      expect(screen.getByText('Tools')).toBeTruthy();
      expect(screen.getByText('Vision')).toBeTruthy();
      expect(screen.getByText('Reasoning')).toBeTruthy();
      expect(screen.getByText('Caching')).toBeTruthy();
    });
  });

  // ── Filter functionality ──
  describe('filtering', () => {
    it('filters models by search text', () => {
      render(
        <ModelPicker provider="test" models={sampleModels} onSelect={() => {}} />
      );
      const input = screen.getByPlaceholderText('Filter models...');
      fireEvent.change(input, { target: { value: 'claude' } });

      expect(screen.getByText('claude-sonnet-4')).toBeTruthy();
      expect(screen.getByText('claude-haiku-3')).toBeTruthy();
      expect(screen.queryByText('gpt-4o')).toBeNull();
    });

    it('shows filter input only when > 5 models', () => {
      const fewModels = [sampleModels[0]];
      const { container } = render(
        <ModelPicker provider="test" models={fewModels} onSelect={() => {}} />
      );
      expect(container.querySelector('input')).toBeNull();
    });
  });

  // ── Tier filter tabs ──
  describe('tier filtering', () => {
    it('shows tier filter tabs when multiple tiers present', () => {
      render(
        <ModelPicker provider="test" models={sampleModels} onSelect={() => {}} />
      );
      expect(screen.getByText('All')).toBeTruthy();
      expect(screen.getByText('max')).toBeTruthy();
      expect(screen.getByText('base')).toBeTruthy();
      expect(screen.getByText('pro')).toBeTruthy();
    });

    it('hides tier tabs when all models have same tier', () => {
      const sameTier = sampleModels.slice(0, 2).map(m => ({ ...m, tier: 'pro' }));
      render(
        <ModelPicker provider="test" models={sameTier} onSelect={() => {}} />
      );
      expect(screen.queryByText('All')).toBeNull();
    });

    it('filters by selected tier', () => {
      render(
        <ModelPicker provider="test" models={sampleModels} onSelect={() => {}} />
      );
      fireEvent.click(screen.getByText('base'));

      expect(screen.getByText('claude-haiku-3')).toBeTruthy();
      expect(screen.getByText('gpt-4o-mini')).toBeTruthy();
      expect(screen.queryByText('deepseek-v3')).toBeNull();
      expect(screen.queryByText('claude-sonnet-4')).toBeNull();
    });
  });

  // ── Show all / collapse ──
  describe('show all / collapse', () => {
    it('shows "Show all" when models exceed maxVisible', () => {
      render(
        <ModelPicker provider="test" models={sampleModels} onSelect={() => {}} maxVisible={3} />
      );
      expect(screen.getByText(/Show all/)).toBeTruthy();
    });

    it('renders all models after clicking "Show all"', () => {
      render(
        <ModelPicker provider="test" models={sampleModels} onSelect={() => {}} maxVisible={3} />
      );
      fireEvent.click(screen.getByText(/Show all/));
      expect(screen.getByText('Show less')).toBeTruthy();
    });
  });

  // ── Model selection callback ──
  describe('selection callback', () => {
    it('calls onSelect when a model is clicked', () => {
      const onSelect = vi.fn();
      render(
        <ModelPicker provider="test" models={sampleModels} onSelect={onSelect} />
      );
      fireEvent.click(screen.getByText('deepseek-v3'));
      expect(onSelect).toHaveBeenCalledWith('deepseek-v3');
    });

    it('calls onRefresh when refresh button is clicked', () => {
      const onRefresh = vi.fn();
      render(
        <ModelPicker provider="test" models={sampleModels} onSelect={() => {}} onRefresh={onRefresh} />
      );
      fireEvent.click(screen.getByText('Refresh'));
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });
  });

});
