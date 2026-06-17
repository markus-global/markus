// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ModelRoutingSection } from './ModelRoutingSection.tsx';

// ── Mock i18next ──
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'modelRouting.loadingCatalog': 'Loading catalog...',
        'modelRouting.noChanges': 'No changes',
        'modelRouting.defaultModel': 'Default Model',
        'modelRouting.refresh': '↻ Refresh',
        'modelRouting.refreshing': '↻ Refreshing...',
        'modelRouting.selectDefaultModel': 'Select a default model...',
        'modelRouting.autoStrategy': 'Auto Strategy',
        'modelRouting.defaultTier': 'Default Tier',
        'modelRouting.strategies.alwaysMax': 'Always Max',
        'modelRouting.strategies.alwaysMaxDesc': 'Always use max model',
        'modelRouting.strategies.alwaysCheapest': 'Always Cheapest',
        'modelRouting.strategies.alwaysCheapestDesc': 'Always use cheapest',
        'modelRouting.strategies.balanced': 'Balanced',
        'modelRouting.strategies.balancedDesc': 'Best balance',
        'modelRouting.strategies.cacheOptimized': 'Cache Optimized',
        'modelRouting.strategies.cacheOptimizedDesc': 'Optimize for cache',
        'modelRouting.tiers.base': 'Base',
        'modelRouting.tiers.baseDesc': 'Entry-level models',
        'modelRouting.tiers.pro': 'Pro',
        'modelRouting.tiers.proDesc': 'Mid-range models',
        'modelRouting.tiers.max': 'Max',
        'modelRouting.tiers.maxDesc': 'Best models',
        'modelRouting.taskTypeRouting': 'Task Type Routing',
        'modelRouting.saveSuccess': 'Saved successfully',
        'modelRouting.saveFailed': 'Save failed',
        'modelRouting.refreshSuccess': 'Models refreshed at',
        'modelRouting.refreshFailed': 'Refresh failed',
        'modelRouting.suggest': 'Suggest',
        'modelRouting.apply': 'Apply',
        'modelRouting.close': 'Close',
        'modelRouting.refreshDone': 'Done',
        'modelRouting.unsavedChanges': 'You have unsaved changes',
        'modelRouting.cancel': 'Cancel',
        'modelRouting.save': 'Save',
        'modelRouting.saving': 'Saving...',
        'modelRouting.suggestLoading': 'Loading...',
        'modelRouting.clearFallback': 'Clear',
        'modelRouting.taskTypes.text_chat': 'Chat',
        'modelRouting.taskTypes.text_reasoning': 'Reasoning',
        'modelRouting.taskTypes.text_coding': 'Coding',
        'modelRouting.taskTypes.text_translation': 'Translation',
        'modelRouting.taskTypes.text_summary': 'Summary',
        'modelRouting.taskTypes.image_recognition': 'Image Recognition',
        'modelRouting.taskTypes.image_generation': 'Image Generation',
        'modelRouting.taskTypes.audio_tts': 'TTS',
        'modelRouting.taskTypes.audio_stt': 'STT',
        'modelRouting.taskTypes.video_generation': 'Video Generation',
        'modelRouting.taskTypes.embedding': 'Embedding',
        'modelRouting.taskTypes.web_search': 'Web Search',
      };
      return map[key] ?? key;
    },
  }),
}));

// ── Mock API ──
const mockGetAll = vi.fn();
const mockGetRouting = vi.fn();
const mockSaveRouting = vi.fn();
const mockGetSuggestedAssignments = vi.fn();

vi.mock('../api', () => ({
  api: {
    modelCatalog: {
      getAll: (...args: unknown[]) => mockGetAll(...args),
      getRouting: (...args: unknown[]) => mockGetRouting(...args),
      saveRouting: (...args: unknown[]) => mockSaveRouting(...args),
      getSuggestedAssignments: (...args: unknown[]) => mockGetSuggestedAssignments(...args),
    },
  },
}));

// ── Sample data ──
const sampleModels = [
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'anthropic', tier: 'max', maxInputTokens: 200000, maxOutputTokens: 8192, inputCostPer1MTokens: 3, outputCostPer1MTokens: 15, capabilities: { functionCalling: true, vision: true, reasoning: true, promptCaching: true, webSearch: false } },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', tier: 'max', maxInputTokens: 128000, maxOutputTokens: 4096, inputCostPer1MTokens: 2.5, outputCostPer1MTokens: 10, capabilities: { functionCalling: true, vision: true, reasoning: false, promptCaching: false, webSearch: true } },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai', tier: 'base', maxInputTokens: 128000, maxOutputTokens: 4096, inputCostPer1MTokens: 0.15, outputCostPer1MTokens: 0.6, capabilities: { functionCalling: true, vision: true, reasoning: false, promptCaching: false, webSearch: false } },
  { id: 'deepseek-v3', name: 'DeepSeek V3', provider: 'deepseek', tier: 'pro', maxInputTokens: 64000, maxOutputTokens: 4096, inputCostPer1MTokens: 0.5, outputCostPer1MTokens: 1.5, capabilities: { functionCalling: true, vision: false, reasoning: true, promptCaching: false, webSearch: false } },
];

const defaultRouting = {
  defaultModel: 'gpt-4o',
  autoStrategy: 'balanced',
  defaultTier: 'pro',
  taskRouting: [
    { taskType: 'text_chat', enabled: true, assignment: { provider: 'openai', model: 'gpt-4o-mini' } },
    { taskType: 'image_generation', enabled: true, assignment: { provider: 'openai', model: 'dall-e-3' } },
  ],
};

describe('ModelRoutingSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAll.mockResolvedValue({ models: sampleModels, providers: {} });
    mockGetRouting.mockResolvedValue(defaultRouting);
    mockSaveRouting.mockResolvedValue({});
    mockGetSuggestedAssignments.mockResolvedValue({ assignments: [] });
  });

  // ── Loading state ──
  describe('loading state', () => {
    it('shows loading indicator while fetching data', () => {
      mockGetAll.mockImplementation(() => new Promise(() => {})); // never resolves
      mockGetRouting.mockImplementation(() => new Promise(() => {}));

      render(<ModelRoutingSection />);
      expect(screen.getByText('Loading catalog...')).toBeTruthy();
    });
  });

  // ── Initial render after load ──
  describe('initial render', () => {
    it('renders default model section after loading', async () => {
      render(<ModelRoutingSection />);

      await waitFor(() => {
        expect(screen.getByText('Default Model')).toBeTruthy();
      });

      expect(screen.getByText('↻ Refresh')).toBeTruthy();
      expect(screen.getByText('Auto Strategy')).toBeTruthy();
      expect(screen.getByText('Default Tier')).toBeTruthy();
      expect(screen.getByText('Task Type Routing')).toBeTruthy();
    });

    it('displays task types from routing config', async () => {
      render(<ModelRoutingSection />);

      await waitFor(() => {
        // Chat is rendered as "💬 Chat" — use regex to match partially
        expect(screen.getByText(/Chat/)).toBeTruthy();
      });

      expect(screen.getByText(/Image Generation/)).toBeTruthy();
    });

    it('displays strategy dropdown with saved value', async () => {
      render(<ModelRoutingSection />);

      await waitFor(() => {
        const select = screen.getByDisplayValue('Balanced') as HTMLSelectElement;
        expect(select).toBeTruthy();
      });
    });
  });

  // ── Refresh button (P0 fix) ──
  describe('refresh button (P0)', () => {
    it('calls getAll() when refresh is clicked', async () => {
      render(<ModelRoutingSection />);

      await waitFor(() => {
        expect(screen.getByText('↻ Refresh')).toBeTruthy();
      });

      fireEvent.click(screen.getByText('↻ Refresh'));
      expect(mockGetAll).toHaveBeenCalledTimes(2); // initial load + refresh
    });

    it('shows refreshing state while reloading', async () => {
      // Hold the refresh call to see loading state
      let resolveRefresh: () => void;
      mockGetAll.mockResolvedValueOnce({ models: sampleModels, providers: {} }); // initial
      mockGetAll.mockImplementationOnce(() => new Promise<void>(r => { resolveRefresh = r; })); // refresh hold

      render(<ModelRoutingSection />);

      await waitFor(() => {
        expect(screen.getByText('↻ Refresh')).toBeTruthy();
      });

      fireEvent.click(screen.getByText('↻ Refresh'));

      // After clicking, the button should show Refreshing
      await waitFor(() => {
        expect(screen.getByText('↻ Refreshing...')).toBeTruthy();
      });
    });

    it('shows success message after refresh completes', async () => {
      render(<ModelRoutingSection />);

      await waitFor(() => {
        expect(screen.getByText('↻ Refresh')).toBeTruthy();
      });

      fireEvent.click(screen.getByText('↻ Refresh'));

      await waitFor(() => {
        expect(screen.getByText(/Models refreshed/)).toBeTruthy();
      });
    });
  });

  // ── Save / Cancel ──
  describe('save and cancel', () => {
    it('shows unsaved changes indicator when modified', async () => {
      render(<ModelRoutingSection />);

      await waitFor(() => {
        expect(screen.getByText('Default Model')).toBeTruthy();
      });

      // Change strategy to trigger dirty state
      const strategySelect = screen.getByDisplayValue('Balanced') as HTMLSelectElement;
      fireEvent.change(strategySelect, { target: { value: 'always_max' } });

      await waitFor(() => {
        expect(screen.getByText('You have unsaved changes')).toBeTruthy();
      });
    });

    it('resets draft on error fetch gracefully', async () => {
      mockGetAll.mockRejectedValue(new Error('Network error'));
      render(<ModelRoutingSection />);

      await waitFor(() => {
        // When getAll fails but getRouting succeeds, it should still try to render
        expect(screen.getByText('No changes')).toBeTruthy();
      });
    });
  });

  // ── Error handling ──
  describe('error handling', () => {
    it('shows fallback message when both initial loads fail', async () => {
      // Make BOTH API calls fail — draft stays null, component shows "No changes"
      mockGetAll.mockRejectedValue(new Error('Failed to fetch models'));
      mockGetRouting.mockRejectedValue(new Error('Failed to fetch routing'));

      render(<ModelRoutingSection />);

      await waitFor(() => {
        // Component catches error but draft never set, so shows fallback
        expect(screen.getByText('No changes')).toBeTruthy();
      });
    });
  });
});
