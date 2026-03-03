import { useState, useEffect, useCallback, useRef } from 'react';
import { api, type PromptTemplateInfo, type PromptVersionInfo, type EvaluationResultInfo, type ABTestInfo } from '../api.ts';

type Tab = 'editor' | 'versions' | 'evaluate' | 'ab-tests';

export function PromptStudioPage({ embedded }: { embedded?: boolean } = {}) {
  const [prompts, setPrompts] = useState<PromptTemplateInfo[]>([]);
  const [selected, setSelected] = useState<PromptTemplateInfo | null>(null);
  const [tab, setTab] = useState<Tab>('editor');
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [filterCategory, setFilterCategory] = useState('');

  const loadPrompts = useCallback(async () => {
    try {
      const { prompts: list } = await api.promptStudio.list(
        filterCategory || undefined,
        searchQuery || undefined,
      );
      setPrompts(list);
    } catch { /* ignore */ }
    setLoading(false);
  }, [filterCategory, searchQuery]);

  useEffect(() => { loadPrompts(); }, [loadPrompts]);

  const selectPrompt = async (p: PromptTemplateInfo) => {
    try {
      const { prompt } = await api.promptStudio.get(p.id);
      setSelected(prompt);
      setTab('editor');
    } catch { setSelected(p); }
  };

  const categories = [...new Set(prompts.map(p => p.category))].sort();

  return (
    <div className="flex h-full">
      {/* Sidebar - prompt list */}
      <div className="w-72 border-r border-gray-800 flex flex-col bg-gray-900/50 shrink-0">
        <div className="p-4 border-b border-gray-800 space-y-3">
          <div className="flex items-center justify-between">
            {!embedded && <h2 className="text-lg font-semibold text-gray-100">Prompt Studio</h2>}
            {embedded && <h3 className="text-sm font-semibold text-gray-300">Prompts</h3>}
            <button
              onClick={() => setShowCreate(true)}
              className="px-2.5 py-1 text-xs bg-indigo-600 hover:bg-indigo-500 rounded-md text-white transition-colors"
            >
              + New
            </button>
          </div>
          <input
            type="text"
            placeholder="Search prompts…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-md text-sm text-gray-200 placeholder-gray-500 focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
          />
          {categories.length > 0 && (
            <div className="flex gap-1 flex-wrap">
              <button onClick={() => setFilterCategory('')}
                className={`px-2 py-1 rounded text-[10px] font-medium border transition-colors ${!filterCategory ? 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30' : 'bg-gray-800 text-gray-500 border-gray-700 hover:border-gray-600'}`}>All</button>
              {categories.map(c => (
                <button key={c} onClick={() => setFilterCategory(c)}
                  className={`px-2 py-1 rounded text-[10px] font-medium border transition-colors capitalize ${filterCategory === c ? 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30' : 'bg-gray-800 text-gray-500 border-gray-700 hover:border-gray-600'}`}>{c}</button>
              ))}
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {loading ? (
            <div className="text-center text-gray-600 text-sm py-8">Loading…</div>
          ) : prompts.length === 0 ? (
            <div className="text-center text-gray-600 text-sm py-8">
              No prompts yet.<br />Create one to get started.
            </div>
          ) : prompts.map(p => (
            <button
              key={p.id}
              onClick={() => selectPrompt(p)}
              className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors ${
                selected?.id === p.id
                  ? 'bg-indigo-600/20 border border-indigo-500/40 text-indigo-200'
                  : 'hover:bg-gray-800 text-gray-300 border border-transparent'
              }`}
            >
              <div className="text-sm font-medium truncate">{p.name}</div>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[10px] px-1.5 py-0.5 bg-gray-700/50 rounded text-gray-400">{p.category}</span>
                <span className="text-[10px] text-gray-500">v{p.currentVersion}</span>
                <span className="text-[10px] text-gray-600">{p.versions?.length ?? 0} versions</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center text-gray-600">
            <div className="text-center space-y-3">
              <div className="text-4xl">✎</div>
              <div className="text-lg font-medium">Prompt Engineering Studio</div>
              <div className="text-sm max-w-md">
                Create, version, and A/B test your prompts. Select a prompt from the sidebar or create a new one.
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Tab bar */}
            <div className="border-b border-gray-800 px-6 flex items-center gap-1 bg-gray-900/30">
              {([
                { id: 'editor' as Tab, label: 'Editor', icon: '✎' },
                { id: 'versions' as Tab, label: 'Versions', icon: '⟳' },
                { id: 'evaluate' as Tab, label: 'Evaluate', icon: '▶' },
                { id: 'ab-tests' as Tab, label: 'A/B Tests', icon: '⚖' },
              ]).map(t => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`px-4 py-3 text-sm border-b-2 transition-colors ${
                    tab === t.id
                      ? 'border-indigo-500 text-indigo-300'
                      : 'border-transparent text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {t.icon} {t.label}
                </button>
              ))}
              <div className="flex-1" />
              <button
                onClick={async () => {
                  if (!confirm('Delete this prompt?')) return;
                  await api.promptStudio.delete(selected.id);
                  setSelected(null);
                  loadPrompts();
                }}
                className="text-xs text-red-400 hover:text-red-300 px-3 py-1"
              >
                Delete
              </button>
            </div>

            {/* Tab content */}
            <div className="flex-1 overflow-y-auto">
              {tab === 'editor' && (
                <EditorTab prompt={selected} onUpdate={p => { setSelected(p); loadPrompts(); }} />
              )}
              {tab === 'versions' && (
                <VersionsTab prompt={selected} onUpdate={p => { setSelected(p); loadPrompts(); }} />
              )}
              {tab === 'evaluate' && (
                <EvaluateTab prompt={selected} />
              )}
              {tab === 'ab-tests' && (
                <ABTestsTab prompt={selected} />
              )}
            </div>
          </>
        )}
      </div>

      {/* Create dialog */}
      {showCreate && (
        <CreatePromptDialog
          onClose={() => setShowCreate(false)}
          onCreate={p => { setSelected(p); loadPrompts(); setShowCreate(false); }}
        />
      )}
    </div>
  );
}

/* ── Editor Tab ─────────────────────────────────────────────────────── */

function EditorTab({ prompt, onUpdate }: { prompt: PromptTemplateInfo; onUpdate: (p: PromptTemplateInfo) => void }) {
  const currentVersion = prompt.versions?.find(v => v.version === prompt.currentVersion);
  const [content, setContent] = useState(currentVersion?.content ?? '');
  const [changelog, setChangelog] = useState('');
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState('');
  const [variables, setVariables] = useState<Record<string, string>>({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const cv = prompt.versions?.find(v => v.version === prompt.currentVersion);
    setContent(cv?.content ?? '');
    setChangelog('');
  }, [prompt.id, prompt.currentVersion]);

  const extractedVars = content.match(/\{\{(\w+)\}\}/g)?.map(m => m.slice(2, -2)) ?? [];
  const uniqueVars = [...new Set(extractedVars)];

  const hasChanges = content !== (currentVersion?.content ?? '');

  const handleSave = async () => {
    if (!hasChanges) return;
    setSaving(true);
    try {
      await api.promptStudio.addVersion(prompt.id, content, changelog || undefined);
      const { prompt: updated } = await api.promptStudio.get(prompt.id);
      onUpdate(updated);
      setChangelog('');
    } catch (err) {
      alert(`Save failed: ${err instanceof Error ? err.message : err}`);
    }
    setSaving(false);
  };

  const handlePreview = async () => {
    try {
      const { rendered } = await api.promptStudio.render(prompt.id, variables, prompt.currentVersion);
      setPreview(rendered);
    } catch (err) {
      setPreview(`Error: ${err instanceof Error ? err.message : err}`);
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xl font-semibold text-gray-100">{prompt.name}</h3>
          <p className="text-sm text-gray-500 mt-0.5">{prompt.description || 'No description'}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs px-2 py-1 bg-gray-800 rounded text-gray-400">v{prompt.currentVersion}</span>
          <span className="text-xs px-2 py-1 bg-gray-800 rounded text-gray-400">{prompt.category}</span>
        </div>
      </div>

      {/* Editor */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-gray-300">Prompt Content</label>
        <textarea
          ref={textareaRef}
          value={content}
          onChange={e => setContent(e.target.value)}
          className="w-full h-80 px-4 py-3 bg-gray-800/70 border border-gray-700 rounded-lg text-sm text-gray-200 font-mono resize-y focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
          placeholder="Write your prompt here. Use {{variable}} for template variables."
        />
        {uniqueVars.length > 0 && (
          <div className="text-xs text-gray-500">
            Variables detected: {uniqueVars.map(v => <code key={v} className="mx-1 px-1.5 py-0.5 bg-gray-700 rounded text-amber-300">{`{{${v}}}`}</code>)}
          </div>
        )}
      </div>

      {/* Variables input */}
      {uniqueVars.length > 0 && (
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-300">Variable Values (for preview)</label>
          <div className="grid grid-cols-2 gap-3">
            {uniqueVars.map(v => (
              <div key={v} className="flex items-center gap-2">
                <label className="text-xs text-gray-400 w-24 shrink-0 font-mono">{v}</label>
                <input
                  type="text"
                  value={variables[v] ?? ''}
                  onChange={e => setVariables({ ...variables, [v]: e.target.value })}
                  className="flex-1 px-2.5 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-gray-200 outline-none focus:ring-1 focus:ring-indigo-500"
                  placeholder={`Value for ${v}`}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={changelog}
          onChange={e => setChangelog(e.target.value)}
          placeholder="Changelog (optional)"
          className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-md text-sm text-gray-200 outline-none focus:ring-1 focus:ring-indigo-500 placeholder-gray-500"
        />
        <button
          onClick={handleSave}
          disabled={!hasChanges || saving}
          className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-md text-sm text-white font-medium transition-colors"
        >
          {saving ? 'Saving…' : 'Save New Version'}
        </button>
        {uniqueVars.length > 0 && (
          <button
            onClick={handlePreview}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-md text-sm text-gray-200 transition-colors"
          >
            Preview
          </button>
        )}
      </div>

      {/* Preview panel */}
      {preview && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-gray-300">Rendered Preview</label>
            <button onClick={() => setPreview('')} className="text-xs text-gray-500 hover:text-gray-300">Close</button>
          </div>
          <div className="p-4 bg-gray-800/50 border border-gray-700 rounded-lg text-sm text-gray-300 whitespace-pre-wrap font-mono">
            {preview}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Versions Tab ───────────────────────────────────────────────────── */

function VersionsTab({ prompt, onUpdate }: { prompt: PromptTemplateInfo; onUpdate: (p: PromptTemplateInfo) => void }) {
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null);
  const [diffBase, setDiffBase] = useState<number | null>(null);

  const versions = [...(prompt.versions ?? [])].sort((a, b) => b.version - a.version);

  return (
    <div className="p-6 max-w-5xl space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-100">Version History</h3>
        <span className="text-xs text-gray-500">{versions.length} versions</span>
      </div>

      <div className="space-y-2">
        {versions.map((v, idx) => {
          const isExpanded = expandedVersion === v.version;
          const isCurrent = v.version === prompt.currentVersion;
          const prevVersion = versions[idx + 1];

          return (
            <div key={v.id} className={`border rounded-lg transition-colors ${
              isCurrent ? 'border-indigo-500/40 bg-indigo-900/10' : 'border-gray-700/50 bg-gray-800/30'
            }`}>
              <button
                onClick={() => setExpandedVersion(isExpanded ? null : v.version)}
                className="w-full flex items-center gap-4 px-4 py-3 text-left"
              >
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                  isCurrent ? 'bg-indigo-600 text-white' : 'bg-gray-700 text-gray-400'
                }`}>
                  v{v.version}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-200">{v.changelog || `Version ${v.version}`}</span>
                    {isCurrent && <span className="text-[10px] px-1.5 py-0.5 bg-indigo-600/30 text-indigo-300 rounded">current</span>}
                  </div>
                  <div className="flex items-center gap-3 mt-0.5 text-[11px] text-gray-500">
                    <span>by {v.author}</span>
                    <span>{new Date(v.createdAt).toLocaleDateString()}</span>
                    {v.variables.length > 0 && <span>{v.variables.length} variables</span>}
                  </div>
                </div>
                <span className="text-gray-500 text-sm">{isExpanded ? '▴' : '▾'}</span>
              </button>

              {isExpanded && (
                <div className="px-4 pb-4 space-y-3 border-t border-gray-700/30">
                  <div className="mt-3">
                    <pre className="p-3 bg-gray-900/80 rounded-md text-xs text-gray-300 font-mono whitespace-pre-wrap overflow-auto max-h-64">
                      {v.content}
                    </pre>
                  </div>
                  {prevVersion && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setDiffBase(diffBase === prevVersion.version ? null : prevVersion.version)}
                        className="text-xs text-indigo-400 hover:text-indigo-300"
                      >
                        {diffBase === prevVersion.version ? 'Hide diff' : `Diff with v${prevVersion.version}`}
                      </button>
                    </div>
                  )}
                  {diffBase !== null && (
                    <SimpleDiff
                      oldText={versions.find(vv => vv.version === diffBase)?.content ?? ''}
                      newText={v.content}
                      oldLabel={`v${diffBase}`}
                      newLabel={`v${v.version}`}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Evaluate Tab ───────────────────────────────────────────────────── */

function EvaluateTab({ prompt }: { prompt: PromptTemplateInfo }) {
  const [version, setVersion] = useState(prompt.currentVersion);
  const [testInput, setTestInput] = useState('');
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [evaluations, setEvaluations] = useState<EvaluationResultInfo[]>([]);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<{ avgScore: number; avgLatencyMs: number; avgTokenCount: number; count: number } | null>(null);

  const currentVersionObj = prompt.versions?.find(v => v.version === version);
  const vars = currentVersionObj?.variables ?? [];

  useEffect(() => {
    loadEvals();
  }, [prompt.id, version]);

  const loadEvals = async () => {
    try {
      const [evalsRes, sumRes] = await Promise.all([
        api.promptStudio.getEvaluations(prompt.id, version),
        api.promptStudio.getEvaluationSummary(prompt.id, version),
      ]);
      setEvaluations(evalsRes.evaluations);
      setSummary(sumRes.summary);
    } catch { /* ignore */ }
  };

  const runEval = async () => {
    if (!testInput.trim()) return;
    setRunning(true);
    try {
      const { evaluation } = await api.promptStudio.evaluate(prompt.id, version, testInput, variables);
      setEvaluations(prev => [evaluation, ...prev]);
      loadEvals();
    } catch (err) {
      alert(`Evaluation failed: ${err instanceof Error ? err.message : err}`);
    }
    setRunning(false);
  };

  const scoreEval = async (evalId: string, score: number) => {
    try {
      await api.promptStudio.scoreEvaluation(evalId, score);
      loadEvals();
    } catch { /* ignore */ }
  };

  return (
    <div className="p-6 max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-100">Evaluate Prompt</h3>
        <select
          value={version}
          onChange={e => setVersion(parseInt(e.target.value, 10))}
          className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-md text-sm text-gray-300 outline-none"
        >
          {[...(prompt.versions ?? [])].sort((a, b) => b.version - a.version).map(v => (
            <option key={v.version} value={v.version}>v{v.version}{v.version === prompt.currentVersion ? ' (current)' : ''}</option>
          ))}
        </select>
      </div>

      {/* Summary */}
      {summary && summary.count > 0 && (
        <div className="grid grid-cols-4 gap-4">
          {[
            { label: 'Avg Score', value: summary.avgScore.toFixed(1), suffix: '/10', color: summary.avgScore >= 7 ? 'text-green-400' : summary.avgScore >= 4 ? 'text-amber-400' : 'text-red-400' },
            { label: 'Avg Latency', value: `${Math.round(summary.avgLatencyMs)}`, suffix: 'ms', color: 'text-blue-400' },
            { label: 'Avg Tokens', value: String(Math.round(summary.avgTokenCount)), suffix: '', color: 'text-purple-400' },
            { label: 'Total Evals', value: String(summary.count), suffix: '', color: 'text-gray-300' },
          ].map(m => (
            <div key={m.label} className="p-3 bg-gray-800/50 border border-gray-700/50 rounded-lg">
              <div className="text-[11px] text-gray-500 mb-1">{m.label}</div>
              <div className={`text-lg font-semibold ${m.color}`}>
                {m.value}<span className="text-xs text-gray-500 ml-0.5">{m.suffix}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Test input */}
      <div className="space-y-3">
        <label className="text-sm font-medium text-gray-300">Test Input</label>
        <textarea
          value={testInput}
          onChange={e => setTestInput(e.target.value)}
          className="w-full h-28 px-3 py-2.5 bg-gray-800/70 border border-gray-700 rounded-lg text-sm text-gray-200 font-mono resize-y outline-none focus:ring-1 focus:ring-indigo-500"
          placeholder="Enter test input to evaluate the prompt against…"
        />
        {vars.length > 0 && (
          <div className="grid grid-cols-2 gap-3">
            {vars.map(v => (
              <div key={v} className="flex items-center gap-2">
                <label className="text-xs text-gray-400 w-24 shrink-0 font-mono">{v}</label>
                <input
                  type="text"
                  value={variables[v] ?? ''}
                  onChange={e => setVariables({ ...variables, [v]: e.target.value })}
                  className="flex-1 px-2.5 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-gray-200 outline-none"
                />
              </div>
            ))}
          </div>
        )}
        <button
          onClick={runEval}
          disabled={running || !testInput.trim()}
          className="px-5 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-md text-sm text-white font-medium transition-colors"
        >
          {running ? 'Running…' : '▶ Run Evaluation'}
        </button>
      </div>

      {/* Results list */}
      {evaluations.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-sm font-medium text-gray-400">Evaluation Results</h4>
          {evaluations.map(ev => (
            <div key={ev.id} className="p-4 bg-gray-800/30 border border-gray-700/50 rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 text-xs text-gray-500">
                  <span>v{ev.version}</span>
                  <span>{ev.latencyMs}ms</span>
                  <span>{ev.tokenCount} tokens</span>
                  <span>{new Date(ev.evaluatedAt).toLocaleString()}</span>
                </div>
                <ScoreSelector score={ev.score} onChange={s => scoreEval(ev.id, s)} />
              </div>
              <div className="text-xs text-gray-400">
                <span className="font-medium text-gray-500">Input:</span> {ev.testInput}
              </div>
              <div className="p-3 bg-gray-900/60 rounded text-sm text-gray-300 whitespace-pre-wrap max-h-40 overflow-auto">
                {ev.output}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── A/B Tests Tab ──────────────────────────────────────────────────── */

function ABTestsTab({ prompt }: { prompt: PromptTemplateInfo }) {
  const [tests, setTests] = useState<ABTestInfo[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => { loadTests(); }, [prompt.id]);

  const loadTests = async () => {
    try {
      const { tests: list } = await api.promptStudio.listABTests(prompt.id);
      setTests(list);
    } catch { /* ignore */ }
  };

  const startTest = async (id: string) => {
    await api.promptStudio.startABTest(id);
    loadTests();
  };

  const completeTest = async (id: string) => {
    await api.promptStudio.completeABTest(id);
    loadTests();
  };

  const versions = [...(prompt.versions ?? [])].sort((a, b) => b.version - a.version);

  return (
    <div className="p-6 max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-100">A/B Tests</h3>
        <button
          onClick={() => setShowCreate(true)}
          className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 rounded-md text-white transition-colors"
        >
          + New A/B Test
        </button>
      </div>

      {tests.length === 0 ? (
        <div className="text-center py-12 text-gray-600">
          <div className="text-3xl mb-2">⚖</div>
          <div className="text-sm">No A/B tests yet. Create one to compare prompt versions.</div>
        </div>
      ) : tests.map(test => (
        <ABTestCard key={test.id} test={test} prompt={prompt} onStart={() => startTest(test.id)} onComplete={() => completeTest(test.id)} />
      ))}

      {showCreate && (
        <CreateABTestDialog
          prompt={prompt}
          versions={versions}
          onClose={() => setShowCreate(false)}
          onCreate={() => { loadTests(); setShowCreate(false); }}
        />
      )}
    </div>
  );
}

function ABTestCard({ test, prompt, onStart, onComplete }: {
  test: ABTestInfo; prompt: PromptTemplateInfo;
  onStart: () => void; onComplete: () => void;
}) {
  const [results, setResults] = useState<{ variantAAvg: number; variantBAvg: number; winner: string; confidence: number } | null>(null);

  useEffect(() => {
    if (test.status !== 'draft') {
      api.promptStudio.getABTestResults(test.id)
        .then(r => setResults({ variantAAvg: r.variantAAvg, variantBAvg: r.variantBAvg, winner: r.winner, confidence: r.confidence }))
        .catch(() => {});
    }
  }, [test.id, test.status]);

  const statusColors: Record<string, string> = {
    draft: 'bg-gray-600 text-gray-300',
    running: 'bg-green-600/20 text-green-400 border border-green-500/30',
    completed: 'bg-blue-600/20 text-blue-400 border border-blue-500/30',
  };

  return (
    <div className="p-4 bg-gray-800/30 border border-gray-700/50 rounded-lg space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-gray-200">{test.name}</div>
          <div className="text-xs text-gray-500 mt-0.5">
            v{test.variantA} vs v{test.variantB} · Split {Math.round(test.splitRatio * 100)}%/{Math.round((1 - test.splitRatio) * 100)}%
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] px-2 py-0.5 rounded ${statusColors[test.status] ?? 'bg-gray-700 text-gray-400'}`}>
            {test.status}
          </span>
          {test.status === 'draft' && (
            <button onClick={onStart} className="text-xs px-3 py-1 bg-green-600 hover:bg-green-500 rounded text-white">Start</button>
          )}
          {test.status === 'running' && (
            <button onClick={onComplete} className="text-xs px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white">Complete</button>
          )}
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 gap-3">
        <VariantMetric
          label={`Variant A (v${test.variantA})`}
          trials={test.metrics.variantATrials}
          avgScore={results?.variantAAvg ?? 0}
          isWinner={results?.winner === 'A'}
        />
        <VariantMetric
          label={`Variant B (v${test.variantB})`}
          trials={test.metrics.variantBTrials}
          avgScore={results?.variantBAvg ?? 0}
          isWinner={results?.winner === 'B'}
        />
      </div>

      {results && results.confidence > 0 && (
        <div className="text-xs text-gray-500">
          Confidence: {(results.confidence * 100).toFixed(1)}% ·
          Winner: <span className={results.winner === 'tie' ? 'text-gray-400' : 'text-green-400 font-medium'}>
            {results.winner === 'tie' ? 'Tie (no significant difference)' : `Variant ${results.winner}`}
          </span>
        </div>
      )}
    </div>
  );
}

function VariantMetric({ label, trials, avgScore, isWinner }: {
  label: string; trials: number; avgScore: number; isWinner: boolean;
}) {
  return (
    <div className={`p-3 rounded-lg border ${isWinner ? 'bg-green-900/10 border-green-500/30' : 'bg-gray-800/30 border-gray-700/30'}`}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-400">{label}</span>
        {isWinner && <span className="text-[10px] text-green-400">Winner</span>}
      </div>
      <div className="flex items-center gap-4">
        <div>
          <div className="text-lg font-semibold text-gray-200">{avgScore.toFixed(1)}</div>
          <div className="text-[10px] text-gray-500">avg score</div>
        </div>
        <div>
          <div className="text-lg font-semibold text-gray-300">{trials}</div>
          <div className="text-[10px] text-gray-500">trials</div>
        </div>
      </div>
    </div>
  );
}

/* ── Score Selector ─────────────────────────────────────────────────── */

function ScoreSelector({ score, onChange }: { score: number; onChange: (s: number) => void }) {
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: 10 }, (_, i) => i + 1).map(s => (
        <button
          key={s}
          onClick={() => onChange(s)}
          className={`w-5 h-5 rounded text-[10px] font-medium transition-colors ${
            s <= score
              ? s >= 7 ? 'bg-green-600/30 text-green-400' : s >= 4 ? 'bg-amber-600/30 text-amber-400' : 'bg-red-600/30 text-red-400'
              : 'bg-gray-800 text-gray-600 hover:bg-gray-700'
          }`}
        >
          {s}
        </button>
      ))}
    </div>
  );
}

/* ── Simple Diff ────────────────────────────────────────────────────── */

function SimpleDiff({ oldText, newText, oldLabel, newLabel }: {
  oldText: string; newText: string; oldLabel: string; newLabel: string;
}) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const maxLines = Math.max(oldLines.length, newLines.length);

  return (
    <div className="grid grid-cols-2 gap-2 text-xs font-mono">
      <div className="space-y-0">
        <div className="text-[10px] text-gray-500 font-sans mb-1">{oldLabel}</div>
        {Array.from({ length: maxLines }, (_, i) => {
          const line = oldLines[i] ?? '';
          const changed = line !== (newLines[i] ?? '');
          return (
            <div key={i} className={`px-2 py-0.5 ${changed ? 'bg-red-900/20 text-red-300' : 'text-gray-400'}`}>
              {line || '\u00A0'}
            </div>
          );
        })}
      </div>
      <div className="space-y-0">
        <div className="text-[10px] text-gray-500 font-sans mb-1">{newLabel}</div>
        {Array.from({ length: maxLines }, (_, i) => {
          const line = newLines[i] ?? '';
          const changed = line !== (oldLines[i] ?? '');
          return (
            <div key={i} className={`px-2 py-0.5 ${changed ? 'bg-green-900/20 text-green-300' : 'text-gray-400'}`}>
              {line || '\u00A0'}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Create Prompt Dialog ───────────────────────────────────────────── */

function CreatePromptDialog({ onClose, onCreate }: {
  onClose: () => void;
  onCreate: (p: PromptTemplateInfo) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('general');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    if (!name.trim() || !content.trim()) return;
    setSaving(true);
    try {
      const { prompt } = await api.promptStudio.create({
        name: name.trim(),
        description: description.trim(),
        category,
        content,
        tags: tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : undefined,
      });
      onCreate(prompt);
    } catch (err) {
      alert(`Create failed: ${err instanceof Error ? err.message : err}`);
    }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-lg p-6 space-y-4" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-gray-100">Create New Prompt</h3>

        <div className="space-y-3">
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Prompt name"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-md text-sm text-gray-200 outline-none focus:ring-1 focus:ring-indigo-500 placeholder-gray-500"
            autoFocus
          />
          <input
            type="text"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Description (optional)"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-md text-sm text-gray-200 outline-none focus:ring-1 focus:ring-indigo-500 placeholder-gray-500"
          />
          <div className="space-y-2">
            <label className="text-xs text-gray-400">Category</label>
            <div className="flex gap-1.5 flex-wrap">
              {['general', 'system', 'agent-role', 'task', 'chat', 'code', 'analysis', 'creative'].map(c => (
                <button key={c} onClick={() => setCategory(c)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors capitalize ${
                    category === c ? 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30' : 'bg-gray-800 text-gray-500 border-gray-700 hover:border-gray-600'
                  }`}>{c.replace('-', ' ')}</button>
              ))}
            </div>
          </div>
          <input
            type="text"
            value={tags}
            onChange={e => setTags(e.target.value)}
            placeholder="Tags (comma-separated)"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-md text-sm text-gray-200 outline-none placeholder-gray-500"
          />
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder="Prompt content… Use {{variable}} for template variables."
            className="w-full h-48 px-3 py-2.5 bg-gray-800/70 border border-gray-700 rounded-lg text-sm text-gray-200 font-mono resize-y outline-none focus:ring-1 focus:ring-indigo-500 placeholder-gray-500"
          />
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors">Cancel</button>
          <button
            onClick={handleCreate}
            disabled={!name.trim() || !content.trim() || saving}
            className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-md text-sm text-white font-medium transition-colors"
          >
            {saving ? 'Creating…' : 'Create Prompt'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Create A/B Test Dialog ─────────────────────────────────────────── */

function CreateABTestDialog({ prompt, versions, onClose, onCreate }: {
  prompt: PromptTemplateInfo;
  versions: PromptVersionInfo[];
  onClose: () => void;
  onCreate: () => void;
}) {
  const [name, setName] = useState('');
  const [variantA, setVariantA] = useState(versions[1]?.version ?? 1);
  const [variantB, setVariantB] = useState(versions[0]?.version ?? 1);
  const [splitRatio, setSplitRatio] = useState(50);
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.promptStudio.createABTest({
        name: name.trim(),
        promptId: prompt.id,
        variantA,
        variantB,
        splitRatio: splitRatio / 100,
      });
      onCreate();
    } catch (err) {
      alert(`Create failed: ${err instanceof Error ? err.message : err}`);
    }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-md p-6 space-y-4" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-gray-100">New A/B Test</h3>

        <div className="space-y-3">
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Test name"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-md text-sm text-gray-200 outline-none focus:ring-1 focus:ring-indigo-500 placeholder-gray-500"
            autoFocus
          />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Variant A</label>
              <select
                value={variantA}
                onChange={e => setVariantA(parseInt(e.target.value, 10))}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-md text-sm text-gray-300 outline-none"
              >
                {versions.map(v => <option key={v.version} value={v.version}>v{v.version}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Variant B</label>
              <select
                value={variantB}
                onChange={e => setVariantB(parseInt(e.target.value, 10))}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-md text-sm text-gray-300 outline-none"
              >
                {versions.map(v => <option key={v.version} value={v.version}>v{v.version}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Traffic Split: {splitRatio}% A / {100 - splitRatio}% B</label>
            <input
              type="range"
              min={10}
              max={90}
              value={splitRatio}
              onChange={e => setSplitRatio(parseInt(e.target.value, 10))}
              className="w-full accent-indigo-500"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors">Cancel</button>
          <button
            onClick={handleCreate}
            disabled={!name.trim() || saving || variantA === variantB}
            className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-md text-sm text-white font-medium transition-colors"
          >
            {saving ? 'Creating…' : 'Create Test'}
          </button>
        </div>
      </div>
    </div>
  );
}
