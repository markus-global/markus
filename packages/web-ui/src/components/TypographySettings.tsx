import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

export interface TypographyConfig {
  fontFamily: 'default' | 'serif' | 'sans-serif' | 'mono';
  fontSize: number;
  headingScale: 'compact' | 'standard' | 'large';
}

const STORAGE_KEY = 'markus-copy-typography';

const DEFAULT_CONFIG: TypographyConfig = {
  fontFamily: 'default',
  fontSize: 15,
  headingScale: 'standard',
};

export function loadTypographyConfig(): TypographyConfig {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
  } catch { /* ignore */ }
  return DEFAULT_CONFIG;
}

function saveTypographyConfig(config: TypographyConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function resolveTypographyCSS(config: TypographyConfig): { fontFamily: string; fontSize: string; headingScales: { h1: number; h2: number; h3: number; h4: number } } {
  const fontFamilyMap: Record<string, string> = {
    default: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', Times, serif",
    'sans-serif': "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
    mono: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
  };

  const headingScaleMap: Record<string, { h1: number; h2: number; h3: number; h4: number }> = {
    compact: { h1: 1.3, h2: 1.15, h3: 1.05, h4: 1.0 },
    standard: { h1: 1.6, h2: 1.35, h3: 1.15, h4: 1.0 },
    large: { h1: 2.0, h2: 1.6, h3: 1.3, h4: 1.1 },
  };

  return {
    fontFamily: fontFamilyMap[config.fontFamily] ?? fontFamilyMap.default,
    fontSize: `${config.fontSize}px`,
    headingScales: headingScaleMap[config.headingScale] ?? headingScaleMap.standard,
  };
}

interface TypographySettingsProps {
  onClose: () => void;
}

export function TypographySettings({ onClose }: TypographySettingsProps) {
  const { t } = useTranslation('common');
  const [config, setConfig] = useState<TypographyConfig>(loadTypographyConfig);

  useEffect(() => {
    saveTypographyConfig(config);
  }, [config]);

  const update = useCallback(<K extends keyof TypographyConfig>(key: K, value: TypographyConfig[K]) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  }, []);

  return (
    <div className="px-3 py-2 space-y-3 max-w-[260px]">
      <div className="flex items-center justify-between mb-1">
        <span className="font-medium text-fg-primary text-xs">{t('markdown.typographySettings')}</span>
        <button onClick={onClose} className="text-fg-tertiary hover:text-fg-primary p-0.5">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>
      <p className="text-[10px] text-fg-tertiary">{t('markdown.typographyDesc')}</p>

      {/* Font family */}
      <div>
        <label className="text-[10px] text-fg-tertiary font-medium block mb-1">{t('markdown.fontFamily')}</label>
        <select
          value={config.fontFamily}
          onChange={e => update('fontFamily', e.target.value as TypographyConfig['fontFamily'])}
          className="w-full px-2 py-1 text-xs rounded bg-surface-primary border border-border-subtle text-fg-secondary focus:outline-none focus:ring-1 focus:ring-brand-500/50"
        >
          <option value="default">{t('markdown.fontDefault')}</option>
          <option value="serif">{t('markdown.fontSerif')}</option>
          <option value="sans-serif">{t('markdown.fontSansSerif')}</option>
          <option value="mono">{t('markdown.fontMono')}</option>
        </select>
      </div>

      {/* Font size */}
      <div>
        <label className="text-[10px] text-fg-tertiary font-medium block mb-1">{t('markdown.fontSize')}: {config.fontSize}px</label>
        <input
          type="range"
          min={10}
          max={24}
          step={1}
          value={config.fontSize}
          onChange={e => update('fontSize', Number(e.target.value))}
          className="w-full h-1 rounded-full appearance-none bg-border-subtle [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-brand-500"
        />
        <div className="flex justify-between text-[9px] text-fg-tertiary mt-0.5">
          <span>10px</span>
          <span>24px</span>
        </div>
      </div>

      {/* Heading scale */}
      <div>
        <label className="text-[10px] text-fg-tertiary font-medium block mb-1">{t('markdown.headingScale')}</label>
        <div className="flex gap-1">
          {(['compact', 'standard', 'large'] as const).map(scale => (
            <button
              key={scale}
              onClick={() => update('headingScale', scale)}
              className={`flex-1 px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                config.headingScale === scale
                  ? 'bg-brand-600/20 text-brand-500'
                  : 'bg-surface-primary text-fg-tertiary hover:text-fg-secondary border border-border-subtle'
              }`}
            >
              {t(`markdown.scale${scale.charAt(0).toUpperCase() + scale.slice(1)}`)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
