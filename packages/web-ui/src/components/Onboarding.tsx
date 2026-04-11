import { useState, useEffect, useRef } from 'react';
import type { ThemeMode } from '../hooks/useTheme.ts';

interface Props {
  onComplete: () => void;
  theme: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
}

interface EnvModelDetected {
  provider: string; displayName: string; apiKeySet: boolean; apiKeyPreview: string;
  model: string; baseUrl?: string; envVars: Record<string, string>;
}
interface EnvModelsResponse { detected: EnvModelDetected[]; timeoutMs?: number }
interface OpenClawPreview { found: boolean; summary: { configPath: string; models?: { providerCount: number; providers: Array<{ name: string; modelCount: number; baseUrl?: string }> } } }

const LLM_STEP = 2;

export function Onboarding({ onComplete, theme, onThemeChange }: Props) {
  const [step, setStep] = useState(0);

  // LLM setup state
  const [envModels, setEnvModels] = useState<EnvModelsResponse | null>(null);
  const [envLoading, setEnvLoading] = useState(false);
  const [envSelected, setEnvSelected] = useState<Record<string, boolean>>({});
  const [envApplying, setEnvApplying] = useState(false);
  const [openclawPreview, setOpenclawPreview] = useState<OpenClawPreview | null>(null);
  const [openclawLoading, setOpenclawLoading] = useState(false);
  const [llmConfigured, setLlmConfigured] = useState(false);
  const [setupMsg, setSetupMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const envDetected = useRef(false);

  const authHeaders = (): Record<string, string> => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${localStorage.getItem('markus_token') ?? ''}`,
  });

  useEffect(() => {
    fetch('/api/settings/llm')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.providers && Object.values(d.providers as Record<string, { configured: boolean }>).some(p => p.configured)) {
          setLlmConfigured(true);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (step === LLM_STEP && !envDetected.current && !llmConfigured) {
      envDetected.current = true;
      void detectEnvModels();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, llmConfigured]);

  const detectEnvModels = async () => {
    setEnvLoading(true);
    try {
      const res = await fetch('/api/settings/env-models', { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json() as EnvModelsResponse;
        setEnvModels(data);
        if (data.detected.length > 0) {
          const sel: Record<string, boolean> = {};
          for (const d of data.detected) sel[d.provider] = true;
          setEnvSelected(sel);
        }
      }
    } catch { /* ignore */ }
    finally { setEnvLoading(false); }
  };

  const applyEnvModels = async () => {
    if (!envModels) return;
    const selected = envModels.detected.filter(d => envSelected[d.provider]);
    if (selected.length === 0) return;
    setEnvApplying(true); setSetupMsg(null);
    try {
      const res = await fetch('/api/settings/env-models', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({
          providers: selected.map(d => ({ provider: d.provider, model: d.model, baseUrl: d.baseUrl, enabled: true })),
        }),
      });
      if (res.ok) {
        const data = await res.json() as { applied: string[]; message: string };
        setSetupMsg({ type: 'ok', text: data.message });
        setLlmConfigured(true);
      } else {
        setSetupMsg({ type: 'err', text: 'Failed to apply' });
      }
    } catch { setSetupMsg({ type: 'err', text: 'Network error' }); }
    finally { setEnvApplying(false); }
  };

  const detectOpenclaw = async () => {
    setOpenclawLoading(true);
    try {
      const res = await fetch('/api/settings/import/openclaw', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ preview: true }),
      });
      const data = await res.json() as OpenClawPreview | { error: string };
      if (!('error' in data)) setOpenclawPreview(data);
    } catch { /* ignore */ }
    finally { setOpenclawLoading(false); }
  };

  const importOpenclaw = async () => {
    setOpenclawLoading(true); setSetupMsg(null);
    try {
      const res = await fetch('/api/settings/import/openclaw', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ preview: false }),
      });
      const data = await res.json() as { applied: boolean; appliedModels: number } | { error: string };
      if ('error' in data) {
        setSetupMsg({ type: 'err', text: data.error });
      } else {
        setSetupMsg({ type: 'ok', text: `Imported ${data.appliedModels} model configs` });
        setLlmConfigured(true);
      }
    } catch { setSetupMsg({ type: 'err', text: 'Import failed' }); }
    finally { setOpenclawLoading(false); }
  };

  const themeOptions: Array<{ value: ThemeMode; label: string; icon: string; desc: string }> = [
    { value: 'system', label: 'System', icon: '💻', desc: 'Follow your OS setting' },
    { value: 'light', label: 'Light', icon: '☀️', desc: 'Always light background' },
    { value: 'dark', label: 'Dark', icon: '🌙', desc: 'Always dark background' },
    { value: 'cyberpunk', label: 'Cyberpunk', icon: '🔮', desc: 'Neon pink, dark violet' },
    { value: 'midnight', label: 'Midnight', icon: '🌊', desc: 'Deep ocean, teal accents' },
  ];

  const steps = [
    // Step 0: Welcome
    {
      title: 'Welcome to Markus',
      subtitle: 'Your AI workforce, ready in minutes',
      content: (
        <div className="space-y-4 text-fg-secondary text-sm leading-relaxed">
          <p>Markus runs <strong className="text-fg-primary">complete AI teams</strong> — developers, researchers, writers, analysts that work autonomously, collaborate with each other, and deliver results around the clock.</p>
          <div className="grid grid-cols-2 gap-3 mt-6">
            {[
              ['24/7 Operation', 'Agents work while you sleep via heartbeat'],
              ['Team Collaboration', 'Agents delegate, review, and coordinate'],
              ['Persistent Memory', 'Five memory layers survive restarts'],
              ['Any LLM Provider', 'Anthropic, OpenAI, Google, Ollama & more'],
            ].map(([title, desc]) => (
              <div key={title} className="bg-surface-elevated/50 rounded-lg p-3">
                <div className="font-medium text-fg-primary text-xs">{title}</div>
                <div className="text-fg-secondary text-xs mt-1">{desc}</div>
              </div>
            ))}
          </div>
        </div>
      ),
    },
    // Step 1: Appearance
    {
      title: 'Choose Your Theme',
      subtitle: 'You can change this anytime in Settings',
      content: (
        <div className="grid grid-cols-3 gap-3">
          {themeOptions.map(opt => (
            <button
              key={opt.value}
              onClick={() => onThemeChange(opt.value)}
              className={`flex flex-col items-center gap-2 rounded-xl border-2 p-5 transition-all ${
                theme === opt.value
                  ? 'border-brand-500 bg-brand-500/10'
                  : 'border-border-default hover:border-fg-tertiary bg-surface-elevated/30'
              }`}
            >
              <span className="text-2xl">{opt.icon}</span>
              <span className="text-sm font-medium text-fg-primary">{opt.label}</span>
              <span className="text-[11px] text-fg-tertiary leading-tight text-center">{opt.desc}</span>
            </button>
          ))}
        </div>
      ),
    },
    // Step 2: LLM Setup
    {
      title: 'Configure LLM',
      subtitle: 'Agents need an LLM to think and act',
      content: llmConfigured ? (
        <div className="flex items-center gap-3 bg-green-500/10 border border-green-500/30 rounded-xl p-4">
          <span className="text-green-600 text-lg">&#10003;</span>
          <div>
            <div className="text-sm font-medium text-green-600">LLM provider configured</div>
            <div className="text-xs text-fg-secondary mt-0.5">You can manage providers anytime in Settings.</div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="text-xs text-fg-secondary uppercase tracking-wider">From Environment Variables</div>
            {envLoading && <div className="text-xs text-fg-tertiary animate-pulse">Detecting API keys...</div>}
            {envModels && envModels.detected.length > 0 && (
              <div className="space-y-2">
                {envModels.detected.map(d => (
                  <label key={d.provider} className="flex items-center gap-3 bg-surface-elevated/40 rounded-lg px-3 py-2.5 cursor-pointer hover:bg-surface-elevated/60 transition-colors">
                    <input type="checkbox" checked={envSelected[d.provider] ?? false}
                      onChange={e => setEnvSelected({ ...envSelected, [d.provider]: e.target.checked })}
                      className="w-4 h-4 rounded bg-surface-overlay border-gray-600 text-brand-500 focus:ring-brand-500" />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm text-fg-primary">{d.displayName}</span>
                      <span className="text-xs text-fg-tertiary ml-2">{d.model}</span>
                    </div>
                    <code className="text-[10px] text-fg-tertiary">{d.apiKeyPreview}</code>
                  </label>
                ))}
                <button onClick={() => void applyEnvModels()}
                  disabled={envApplying || Object.values(envSelected).filter(Boolean).length === 0}
                  className="w-full px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white text-sm rounded-lg transition-colors">
                  {envApplying ? 'Applying...' : `Apply ${Object.values(envSelected).filter(Boolean).length} Provider(s)`}
                </button>
              </div>
            )}
            {envModels && envModels.detected.length === 0 && !envLoading && (
              <div className="text-xs text-fg-tertiary bg-surface-elevated/30 rounded-lg p-3">
                No API keys found. Set <code className="text-fg-secondary">ANTHROPIC_API_KEY</code>, <code className="text-fg-secondary">OPENAI_API_KEY</code>, etc. in your <code className="text-fg-secondary">.env</code> file and restart.
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-border-default" />
            <span className="text-xs text-fg-tertiary">or</span>
            <div className="flex-1 h-px bg-border-default" />
          </div>

          <div className="space-y-2">
            <div className="text-xs text-fg-secondary uppercase tracking-wider">From OpenClaw</div>
            {!openclawPreview ? (
              <button onClick={() => void detectOpenclaw()} disabled={openclawLoading}
                className="px-4 py-2 border border-border-default hover:bg-surface-elevated disabled:opacity-40 text-fg-secondary text-sm rounded-lg transition-colors w-full">
                {openclawLoading ? 'Detecting...' : 'Detect OpenClaw Config'}
              </button>
            ) : openclawPreview.found ? (
              <div className="space-y-2">
                <div className="text-xs text-green-600">Found: <code className="text-fg-secondary">{openclawPreview.summary.configPath}</code>
                  {openclawPreview.summary.models && <span className="text-fg-tertiary ml-1">({openclawPreview.summary.models.providerCount} providers)</span>}
                </div>
                <button onClick={() => void importOpenclaw()} disabled={openclawLoading}
                  className="w-full px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white text-sm rounded-lg transition-colors">
                  {openclawLoading ? 'Importing...' : 'Import Model Configs'}
                </button>
              </div>
            ) : (
              <div className="text-xs text-fg-tertiary bg-surface-elevated/30 rounded-lg p-3">No OpenClaw config found.</div>
            )}
          </div>

          {setupMsg && (
            <div className={`text-xs px-3 py-2 rounded-lg ${setupMsg.type === 'ok' ? 'bg-green-500/10 text-green-600 border border-green-500/30' : 'bg-red-500/10 text-red-500 border border-red-500/30'}`}>
              {setupMsg.text}
            </div>
          )}
        </div>
      ),
    },
    // Step 3: Done
    {
      title: 'You\'re All Set',
      subtitle: 'Start building your AI workforce',
      content: (
        <div className="space-y-2 text-fg-secondary text-sm">
          {[
            ['Chat', 'Talk to agents or use Smart Route to auto-delegate tasks'],
            ['Projects', 'Create projects with requirements, tasks, and deliverables'],
            ['Builder', 'Hire new agents from templates or build custom roles'],
            ['Settings', 'Manage LLM providers, integrations, and governance'],
          ].map(([title, desc]) => (
            <div key={title} className="flex gap-3 bg-surface-elevated/50 rounded-lg p-3">
              <div className="text-brand-500 mt-0.5 shrink-0">&#x2192;</div>
              <div>
                <div className="font-medium text-fg-primary text-xs">{title}</div>
                <div className="text-fg-secondary text-xs">{desc}</div>
              </div>
            </div>
          ))}
        </div>
      ),
    },
  ];

  const handleNext = () => {
    if (step < steps.length - 1) {
      setStep(step + 1);
    } else {
      onComplete();
    }
  };

  const current = steps[step]!;

  return (
    <div className="min-h-dvh bg-surface-primary flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="bg-surface-secondary border border-border-default rounded-2xl p-8">
          <div className="flex gap-1.5 mb-8">
            {steps.map((_, i) => (
              <div key={i} className={`h-1 flex-1 rounded-full transition-colors ${i <= step ? 'bg-brand-500' : 'bg-surface-elevated'}`} />
            ))}
          </div>

          <h2 className="text-2xl font-bold text-fg-primary">{current.title}</h2>
          <p className="text-sm text-fg-secondary mt-1 mb-6">{current.subtitle}</p>

          {current.content}

          <div className="flex justify-between mt-8">
            {step > 0 ? (
              <button onClick={() => setStep(step - 1)} className="px-4 py-2 text-sm text-fg-secondary hover:text-fg-primary transition-colors">
                Back
              </button>
            ) : (
              <button onClick={onComplete} className="px-4 py-2 text-sm text-fg-tertiary hover:text-fg-secondary transition-colors">
                Skip
              </button>
            )}
            <div className="flex items-center gap-3">
              {step === LLM_STEP && !llmConfigured && (
                <button onClick={handleNext} className="px-4 py-2 text-sm text-fg-tertiary hover:text-fg-secondary transition-colors">
                  Skip for now
                </button>
              )}
              <button
                onClick={handleNext}
                className="px-6 py-2.5 bg-brand-600 hover:bg-brand-500 text-white text-sm rounded-xl transition-colors"
              >
                {step === steps.length - 1 ? 'Get Started' : 'Next'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
