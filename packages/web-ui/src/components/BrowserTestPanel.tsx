import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../api.ts';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface TestStep {
  name: string;
  group: string;
  passed: boolean;
  durationMs: number;
  error?: string;
  detail?: string;
}

interface QuickResult {
  connected: boolean;
  steps: TestStep[];
  totalDurationMs: number;
  passed: number;
  failed: number;
  summary: string;
}

interface ChaosOp {
  type: 'op';
  agent: string;
  op: string;
  target: string;
  passed: boolean;
  durationMs: number;
  error?: string;
  detail?: string;
  timestamp: number;
}

interface ChaosStatsEv {
  type: 'stats';
  elapsed: number;
  totalOps: number;
  passed: number;
  failed: number;
  opsPerSec: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const AGENT_COLORS: Record<string, string> = {
  'Agent-1': 'text-blue-400',
  'Agent-2': 'text-green-400',
  'Agent-3': 'text-amber-400',
  'Agent-4': 'text-purple-400',
  'Agent-5': 'text-pink-400',
};

const AGENT_BG: Record<string, string> = {
  'Agent-1': 'bg-blue-500/10',
  'Agent-2': 'bg-green-500/10',
  'Agent-3': 'bg-amber-500/10',
  'Agent-4': 'bg-purple-500/10',
  'Agent-5': 'bg-pink-500/10',
};

// ─── Component ─────────────────────────────────────────────────────────────────

export function BrowserTestPanel({ extensionConnected }: { extensionConnected: boolean }) {
  const [mode, setMode] = useState<'quick' | 'chaos'>('quick');
  const [running, setRunning] = useState(false);

  // Quick state
  const [quickResult, setQuickResult] = useState<QuickResult | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Chaos state
  const [chaosOps, setChaosOps] = useState<ChaosOp[]>([]);
  const [chaosStats, setChaosStats] = useState<ChaosStatsEv | null>(null);
  const [chaosDuration, setChaosDuration] = useState(2);
  const [chaosAgents, setChaosAgents] = useState(3);
  const [showFailuresOnly, setShowFailuresOnly] = useState(false);
  const [chaosDone, setChaosDone] = useState<{ totalOps: number; passed: number; failed: number; elapsed: number } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Auto-scroll log
  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [chaosOps.length, autoScroll]);

  const toggleGroup = useCallback((group: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group); else next.add(group);
      return next;
    });
  }, []);

  // ── Quick Test ──────────────────────────────────────────────────────────────

  const runQuick = useCallback(async () => {
    setRunning(true);
    setQuickResult(null);
    try {
      const r = await api.settings.testConcurrentBrowserQuick();
      setQuickResult(r);
      const groups = new Set(r.steps.map((s) => s.group));
      setExpandedGroups(groups);
    } catch (err) {
      setQuickResult({
        connected: false, steps: [], totalDurationMs: 0, passed: 0, failed: 0,
        summary: err instanceof Error ? err.message : String(err),
      });
    }
    setRunning(false);
  }, []);

  // ── Chaos Test ──────────────────────────────────────────────────────────────

  const runChaos = useCallback(async () => {
    setRunning(true);
    setChaosOps([]);
    setChaosStats(null);
    setChaosDone(null);
    setAutoScroll(true);
    try {
      await api.settings.testConcurrentBrowserChaos(
        { durationSec: chaosDuration * 60, agents: chaosAgents },
        (ev) => {
          if (ev.type === 'op') {
            setChaosOps((prev) => {
              const next = [...prev, ev as unknown as ChaosOp];
              if (next.length > 2000) return next.slice(-1500);
              return next;
            });
          } else if (ev.type === 'stats') {
            setChaosStats(ev as unknown as ChaosStatsEv);
          } else if (ev.type === 'done') {
            setChaosDone(ev as unknown as { totalOps: number; passed: number; failed: number; elapsed: number });
          }
        },
      );
    } catch (err) {
      console.error('Chaos test error:', err);
    }
    setRunning(false);
  }, [chaosDuration, chaosAgents]);

  const stopChaos = useCallback(async () => {
    try { await api.settings.stopConcurrentBrowserTest(); } catch { /* ignore */ }
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────────

  const groups = quickResult
    ? [...new Set(quickResult.steps.map((s) => s.group))]
    : [];

  const filteredOps = showFailuresOnly ? chaosOps.filter((o) => !o.passed) : chaosOps;
  const totalDurationSec = chaosDuration * 60;
  const elapsedSec = chaosStats ? Math.round(chaosStats.elapsed / 1000) : 0;
  const progressPct = totalDurationSec > 0 ? Math.min(100, Math.round((elapsedSec / totalDurationSec) * 100)) : 0;

  return (
    <div className="mt-6 rounded-xl border-2 border-dashed border-purple-500/30 bg-purple-500/5 p-5">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-purple-500/20 text-purple-400 rounded">DEV</span>
        <div>
          <div className="text-sm font-semibold text-fg-primary">Browser Integration Test Suite</div>
          <div className="text-xs text-fg-tertiary">Concurrent multi-agent browser test with correctness verification</div>
        </div>
      </div>

      {!extensionConnected && (
        <div className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-400">
          Chrome extension not connected. Connect the extension first to run tests.
        </div>
      )}

      {/* Mode tabs */}
      <div className="flex gap-1 mb-4 bg-surface-primary rounded-lg p-1">
        <button
          onClick={() => setMode('quick')}
          className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${mode === 'quick' ? 'bg-purple-500/20 text-purple-400' : 'text-fg-tertiary hover:text-fg-secondary'}`}
        >
          Quick Test (~15s)
        </button>
        <button
          onClick={() => setMode('chaos')}
          className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${mode === 'chaos' ? 'bg-purple-500/20 text-purple-400' : 'text-fg-tertiary hover:text-fg-secondary'}`}
        >
          Chaos Test
        </button>
      </div>

      {/* ═══════ Quick Test ═══════ */}
      {mode === 'quick' && (
        <div>
          <div className="flex items-center gap-3 mb-4">
            <button
              onClick={runQuick}
              disabled={running || !extensionConnected}
              className="px-4 py-1.5 text-xs font-medium bg-purple-500 text-white rounded-lg hover:bg-purple-600 transition-colors disabled:opacity-40"
            >
              {running ? (
                <span className="flex items-center gap-2">
                  <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="28 56" /></svg>
                  Running...
                </span>
              ) : 'Run Quick Test'}
            </button>
            {quickResult && (
              <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${quickResult.failed === 0 ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                {quickResult.summary} | {(quickResult.totalDurationMs / 1000).toFixed(1)}s
              </span>
            )}
          </div>

          {quickResult && groups.map((group) => {
            const groupSteps = quickResult.steps.filter((s) => s.group === group);
            const groupPassed = groupSteps.filter((s) => s.passed).length;
            const expanded = expandedGroups.has(group);
            return (
              <div key={group} className="mb-2">
                <button
                  onClick={() => toggleGroup(group)}
                  className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-surface-elevated hover:bg-surface-primary transition-colors text-left"
                >
                  <span className="text-xs font-medium text-fg-primary flex items-center gap-2">
                    <svg className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                    {group}
                  </span>
                  <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${groupPassed === groupSteps.length ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                    {groupPassed}/{groupSteps.length}
                  </span>
                </button>
                {expanded && (
                  <div className="mt-1 ml-5 space-y-0.5">
                    {groupSteps.map((step, i) => (
                      <div key={i} className={`flex items-start gap-2 px-3 py-1.5 rounded text-xs ${step.passed ? '' : 'bg-red-500/5'}`}>
                        {step.passed
                          ? <svg className="w-3.5 h-3.5 text-green-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                          : <svg className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                        }
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between">
                            <span className="text-fg-primary">{step.name}</span>
                            <span className="text-fg-tertiary ml-2 shrink-0">{step.durationMs}ms</span>
                          </div>
                          {step.error && <div className="text-red-400 mt-0.5 break-all">{step.error}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ═══════ Chaos Test ═══════ */}
      {mode === 'chaos' && (
        <div>
          {/* Controls */}
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <div className="flex items-center gap-2">
              <label className="text-xs text-fg-tertiary">Duration:</label>
              <input
                type="number" min={1} max={10} value={chaosDuration}
                onChange={(e) => setChaosDuration(Math.max(1, Math.min(10, Number(e.target.value))))}
                disabled={running}
                className="w-14 px-2 py-1 text-xs border border-border-default rounded bg-surface-primary text-fg-primary text-center"
              />
              <span className="text-xs text-fg-tertiary">min</span>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-fg-tertiary">Agents:</label>
              <input
                type="number" min={2} max={5} value={chaosAgents}
                onChange={(e) => setChaosAgents(Math.max(2, Math.min(5, Number(e.target.value))))}
                disabled={running}
                className="w-14 px-2 py-1 text-xs border border-border-default rounded bg-surface-primary text-fg-primary text-center"
              />
            </div>
            {!running ? (
              <button
                onClick={runChaos}
                disabled={!extensionConnected}
                className="px-4 py-1.5 text-xs font-medium bg-purple-500 text-white rounded-lg hover:bg-purple-600 transition-colors disabled:opacity-40"
              >
                Start Chaos
              </button>
            ) : (
              <button
                onClick={stopChaos}
                className="px-4 py-1.5 text-xs font-medium bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
              >
                Stop
              </button>
            )}
          </div>

          {/* Stats bar */}
          {(chaosStats || chaosDone) && (
            <div className="mb-3 space-y-2">
              <div className="flex items-center gap-4 text-xs">
                <span className="text-fg-secondary font-medium">
                  {(chaosStats?.totalOps ?? chaosDone?.totalOps ?? 0)} ops
                </span>
                <span className="text-green-400">{chaosStats?.passed ?? chaosDone?.passed ?? 0} passed</span>
                <span className={`${(chaosStats?.failed ?? chaosDone?.failed ?? 0) > 0 ? 'text-red-400' : 'text-fg-tertiary'}`}>
                  {chaosStats?.failed ?? chaosDone?.failed ?? 0} failed
                </span>
                {chaosStats && <span className="text-fg-tertiary">{chaosStats.opsPerSec} ops/s</span>}
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 rounded-full bg-surface-primary overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${chaosDone ? (chaosDone.failed > 0 ? 'bg-amber-500' : 'bg-green-500') : 'bg-purple-500'}`}
                    style={{ width: `${chaosDone ? 100 : progressPct}%` }}
                  />
                </div>
                <span className="text-[10px] text-fg-tertiary w-20 text-right">
                  {formatTime(elapsedSec)} / {formatTime(totalDurationSec)}
                </span>
              </div>
              {chaosDone && (
                <div className={`text-xs font-medium ${chaosDone.failed === 0 ? 'text-green-400' : 'text-amber-400'}`}>
                  Complete: {chaosDone.passed}/{chaosDone.totalOps} passed in {(chaosDone.elapsed / 1000).toFixed(1)}s
                </div>
              )}
            </div>
          )}

          {/* Filter toggle */}
          {chaosOps.length > 0 && (
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] text-fg-tertiary uppercase tracking-wider">
                Live Log ({filteredOps.length}{showFailuresOnly ? ' failures' : ' ops'})
              </span>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showFailuresOnly}
                  onChange={(e) => setShowFailuresOnly(e.target.checked)}
                  className="w-3 h-3 rounded"
                />
                <span className="text-[10px] text-fg-tertiary">Failures only</span>
              </label>
            </div>
          )}

          {/* Log */}
          {chaosOps.length > 0 && (
            <div
              ref={logRef}
              className="h-72 overflow-y-auto rounded-lg bg-surface-primary border border-border-default font-mono text-[11px] leading-relaxed"
              onScroll={(e) => {
                const el = e.currentTarget;
                const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                setAutoScroll(atBottom);
              }}
            >
              {filteredOps.map((op, i) => (
                <ChaosLogEntry key={i} op={op} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function ChaosLogEntry({ op }: { op: ChaosOp }) {
  const [expanded, setExpanded] = useState(false);
  const time = new Date(op.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const agentColor = AGENT_COLORS[op.agent] ?? 'text-fg-secondary';
  const agentBg = AGENT_BG[op.agent] ?? '';

  return (
    <div
      className={`px-2 py-0.5 border-b border-border-default/50 hover:bg-surface-elevated/50 cursor-pointer ${!op.passed ? 'bg-red-500/5' : ''}`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-center gap-2">
        <span className="text-fg-tertiary w-16 shrink-0">{time}</span>
        <span className={`w-16 shrink-0 font-medium ${agentColor} ${agentBg} px-1 rounded text-center`}>
          {op.agent}
        </span>
        <span className="w-28 shrink-0 text-fg-secondary truncate">{op.op}</span>
        <span className="flex-1 text-fg-tertiary truncate">{op.target}</span>
        <span className={`w-10 text-right shrink-0 ${op.passed ? 'text-green-400' : 'text-red-400'}`}>
          {op.passed ? 'PASS' : 'FAIL'}
        </span>
        <span className="w-14 text-right text-fg-tertiary shrink-0">{op.durationMs}ms</span>
      </div>
      {!op.passed && op.error && (
        <div className="ml-[8.5rem] text-red-400/80 text-[10px] truncate">
          {op.error}
        </div>
      )}
      {expanded && op.detail && (
        <div className="ml-[8.5rem] mt-1 mb-1 text-fg-tertiary text-[10px] whitespace-pre-wrap break-all bg-surface-primary p-1.5 rounded">
          {op.detail}
        </div>
      )}
    </div>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}
