import { useState, useCallback, useRef, useEffect } from 'react';
import { api } from '../api.ts';
import { MarkdownMessage } from '../components/MarkdownMessage.tsx';

type BuilderTab = 'agent' | 'team' | 'skill';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  artifact?: Record<string, unknown> | null;
}

const TAB_CONFIG: Array<{ key: BuilderTab; label: string; icon: string; desc: string; greeting: string }> = [
  {
    key: 'agent',
    label: 'Agent Father',
    icon: '✦',
    desc: 'AI agent architect',
    greeting: "I'm **Agent Father** — your AI agent architect. Tell me what kind of agent you need, and I'll design it for you.\n\nFor example:\n- *\"A senior full-stack developer who specializes in React and Node.js\"*\n- *\"A DevOps engineer for CI/CD pipeline management\"*\n- *\"A code reviewer who enforces best practices\"*\n\nWhat agent would you like to create?",
  },
  {
    key: 'team',
    label: 'Team Factory',
    icon: '◈',
    desc: 'AI team composer',
    greeting: "I'm **Team Factory** — your AI team composition expert. Describe the team you need, and I'll design the optimal lineup.\n\nFor example:\n- *\"A web development team with a PM, two developers, and a QA engineer\"*\n- *\"A content team for a tech blog with editor, writers, and SEO specialist\"*\n- *\"A data engineering squad\"*\n\nWhat team would you like to build?",
  },
  {
    key: 'skill',
    label: 'Skill Architect',
    icon: '⬡',
    desc: 'AI skill designer',
    greeting: "I'm **Skill Architect** — your AI skill designer. Tell me what capability you want to create, and I'll design the skill manifest.\n\nFor example:\n- *\"A skill that analyzes Git repos and generates changelogs\"*\n- *\"A web scraping skill that extracts structured data from URLs\"*\n- *\"A database migration tool with rollback support\"*\n\nWhat skill would you like to create?",
  },
];

// ─── Chat-Based Creator Agent ────────────────────────────────────────────────

function CreatorAgent({ mode, greeting }: { mode: BuilderTab; greeting: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'assistant', content: greeting },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [creating, setCreating] = useState(false);
  const [flash, setFlash] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Latest artifact from the conversation
  const latestArtifact = [...messages].reverse().find(m => m.artifact)?.artifact ?? null;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [mode]);

  const msg = (m: string) => { setFlash(m); setTimeout(() => setFlash(''), 5000); };

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    const userMsg: ChatMessage = { role: 'user', content: text };
    const updated = [...messages, userMsg];
    setMessages(updated);
    setSending(true);

    try {
      const apiMessages = updated
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: m.content }))
        .slice(1); // skip the greeting (generated client-side)

      const resp = await api.builder.chat(mode, apiMessages);
      setMessages(prev => [...prev, { role: 'assistant', content: resp.reply, artifact: resp.artifact }]);
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${String(err)}. Please try again.` }]);
    } finally {
      setSending(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [input, sending, messages, mode]);

  const handleCreate = useCallback(async () => {
    if (!latestArtifact || creating) return;
    setCreating(true);
    try {
      await api.builder.create(mode, latestArtifact);
      const labels = { agent: 'Agent template', team: 'Team template', skill: 'Skill' };
      msg(`${labels[mode]} created successfully!`);
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Done! The ${labels[mode].toLowerCase()} **${(latestArtifact.name as string) ?? ''}** has been created and saved. You can find it in the marketplace. Would you like to create another one?`,
      }]);
    } catch (err) {
      msg(`Creation failed: ${String(err)}`);
    } finally {
      setCreating(false);
    }
  }, [latestArtifact, creating, mode]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex h-full">
      {/* Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {flash && (
          <div className="mx-4 mt-2 px-3 py-1.5 bg-emerald-900/50 text-emerald-300 text-xs rounded-lg border border-emerald-700/30">{flash}</div>
        )}

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-xl px-4 py-3 ${
                m.role === 'user'
                  ? 'bg-indigo-600/20 border border-indigo-500/20 text-gray-200'
                  : 'bg-gray-800/60 border border-gray-700/30 text-gray-300'
              }`}>
                <MarkdownMessage content={m.content} className="text-sm leading-relaxed" />
              </div>
            </div>
          ))}
          {sending && (
            <div className="flex justify-start">
              <div className="bg-gray-800/60 border border-gray-700/30 rounded-xl px-4 py-3">
                <span className="text-sm text-gray-500 animate-pulse">Thinking...</span>
              </div>
            </div>
          )}
        </div>

        {/* Input */}
        <div className="border-t border-gray-800 px-4 py-3">
          <div className="flex gap-2 items-end">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Describe what you need..."
              rows={2}
              className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 focus:border-indigo-500 outline-none resize-none"
              disabled={sending}
            />
            <button
              onClick={() => void send()}
              disabled={sending || !input.trim()}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg disabled:opacity-50 shrink-0 h-fit"
            >
              Send
            </button>
          </div>
          <div className="text-[10px] text-gray-600 mt-1.5">Press Enter to send, Shift+Enter for new line</div>
        </div>
      </div>

      {/* Artifact Sidebar */}
      <div className="w-80 border-l border-gray-800 flex flex-col bg-gray-950 shrink-0">
        <div className="px-4 py-3 border-b border-gray-800">
          <h3 className="text-sm font-semibold text-gray-300">
            {mode === 'agent' ? 'Agent Config' : mode === 'team' ? 'Team Config' : 'Skill Manifest'}
          </h3>
          <p className="text-[10px] text-gray-600 mt-0.5">Generated configuration appears here</p>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {latestArtifact ? (
            <ArtifactPreview artifact={latestArtifact} mode={mode} />
          ) : (
            <div className="text-center text-gray-600 text-xs py-12">
              <div className="text-3xl mb-3 opacity-20">
                {mode === 'agent' ? '✦' : mode === 'team' ? '◈' : '⬡'}
              </div>
              <div>Start the conversation and the AI will generate<br />a configuration for you.</div>
            </div>
          )}
        </div>

        {latestArtifact && (
          <div className="p-4 border-t border-gray-800 space-y-2">
            <button
              onClick={() => void handleCreate()}
              disabled={creating}
              className="w-full px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-lg disabled:opacity-50"
            >
              {creating ? 'Creating...' : `Create ${mode === 'agent' ? 'Agent' : mode === 'team' ? 'Team' : 'Skill'}`}
            </button>
            <button
              onClick={() => {
                const blob = new Blob([JSON.stringify(latestArtifact, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${(latestArtifact.name as string) ?? mode}.json`;
                a.click();
                URL.revokeObjectURL(url);
              }}
              className="w-full px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm rounded-lg border border-gray-700"
            >
              Export JSON
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Artifact Preview ────────────────────────────────────────────────────────

function ArtifactPreview({ artifact, mode }: { artifact: Record<string, unknown>; mode: BuilderTab }) {
  if (mode === 'agent') {
    return (
      <div className="space-y-3 text-sm">
        <Field label="Name" value={artifact.name as string} />
        <Field label="Description" value={artifact.description as string} />
        <div className="flex gap-2">
          <Badge label="Role" value={artifact.agentRole as string} color={artifact.agentRole === 'manager' ? 'purple' : 'cyan'} />
          <Badge label="Category" value={artifact.category as string} color="indigo" />
        </div>
        {artifact.systemPrompt && (
          <div>
            <span className="text-[10px] text-gray-500 uppercase tracking-wider">System Prompt</span>
            <pre className="mt-1 text-xs text-gray-400 bg-gray-800/50 rounded-lg p-2 whitespace-pre-wrap max-h-[150px] overflow-y-auto">{artifact.systemPrompt as string}</pre>
          </div>
        )}
        {Array.isArray(artifact.toolWhitelist) && (artifact.toolWhitelist as string[]).length > 0 && (
          <div>
            <span className="text-[10px] text-gray-500 uppercase tracking-wider">Tools</span>
            <div className="flex flex-wrap gap-1 mt-1">
              {(artifact.toolWhitelist as string[]).map(t => (
                <span key={t} className="px-1.5 py-0.5 text-[10px] bg-indigo-500/10 text-indigo-400 rounded font-mono">{t}</span>
              ))}
            </div>
          </div>
        )}
        {artifact.skills && (
          <Field label="Skills" value={artifact.skills as string} />
        )}
        {artifact.temperature !== undefined && (
          <Field label="Temperature" value={String(artifact.temperature)} />
        )}
      </div>
    );
  }

  if (mode === 'team') {
    const members = Array.isArray(artifact.members) ? artifact.members as Array<Record<string, unknown>> : [];
    return (
      <div className="space-y-3 text-sm">
        <Field label="Name" value={artifact.name as string} />
        <Field label="Description" value={artifact.description as string} />
        <Badge label="Category" value={artifact.category as string} color="indigo" />
        <div>
          <span className="text-[10px] text-gray-500 uppercase tracking-wider">Members ({members.length})</span>
          <div className="mt-1.5 space-y-1.5">
            {members.map((m, i) => (
              <div key={i} className="flex items-center gap-2 bg-gray-800/30 rounded-lg px-2 py-1.5 border border-gray-700/20">
                <span className={`w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold ${
                  m.role === 'manager' ? 'bg-purple-500/20 text-purple-400' : 'bg-cyan-500/20 text-cyan-400'
                }`}>
                  {m.role === 'manager' ? '★' : (i + 1)}
                </span>
                <span className="text-xs text-gray-300 flex-1 truncate">{m.name as string}</span>
                <span className="text-[10px] text-gray-500">×{String(m.count ?? 1)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // skill
  const tools = Array.isArray(artifact.tools) ? artifact.tools as Array<Record<string, unknown>> : [];
  return (
    <div className="space-y-3 text-sm">
      <Field label="Name" value={artifact.name as string} />
      <Field label="Description" value={artifact.description as string} />
      <div className="flex gap-2">
        <Badge label="Category" value={artifact.category as string} color="indigo" />
        {artifact.version && <Badge label="Version" value={artifact.version as string} color="gray" />}
      </div>
      {tools.length > 0 && (
        <div>
          <span className="text-[10px] text-gray-500 uppercase tracking-wider">Tools ({tools.length})</span>
          <div className="mt-1.5 space-y-1">
            {tools.map((t, i) => (
              <div key={i} className="bg-gray-800/30 rounded-lg px-2 py-1.5 border border-gray-700/20">
                <div className="text-xs text-indigo-400 font-medium">{t.name as string}</div>
                {t.description && <div className="text-[10px] text-gray-500 mt-0.5">{t.description as string}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
      {Array.isArray(artifact.requiredPermissions) && (artifact.requiredPermissions as string[]).length > 0 && (
        <div>
          <span className="text-[10px] text-gray-500 uppercase tracking-wider">Permissions</span>
          <div className="flex flex-wrap gap-1 mt-1">
            {(artifact.requiredPermissions as string[]).map(p => (
              <span key={p} className="px-1.5 py-0.5 text-[10px] bg-amber-500/10 text-amber-400 rounded">{p}</span>
            ))}
          </div>
        </div>
      )}
      {Array.isArray(artifact.tags) && (artifact.tags as string[]).length > 0 && (
        <div className="flex flex-wrap gap-1">
          {(artifact.tags as string[]).map(t => (
            <span key={t} className="px-1.5 py-0.5 text-[10px] bg-gray-800 text-gray-500 rounded">{t}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div>
      <span className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</span>
      <div className="text-xs text-gray-300 mt-0.5">{value}</div>
    </div>
  );
}

function Badge({ label, value, color }: { label: string; value?: string; color: string }) {
  if (!value) return null;
  const colors: Record<string, string> = {
    purple: 'bg-purple-500/15 text-purple-400',
    cyan: 'bg-cyan-500/15 text-cyan-400',
    indigo: 'bg-indigo-500/15 text-indigo-400',
    gray: 'bg-gray-500/15 text-gray-400',
    emerald: 'bg-emerald-500/15 text-emerald-400',
  };
  return (
    <div>
      <span className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</span>
      <div className={`mt-0.5 px-2 py-0.5 rounded-full text-[10px] font-medium ${colors[color] ?? colors.gray} capitalize inline-block`}>{value}</div>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────────

export function AgentBuilder({ initialTab }: { initialTab?: BuilderTab } = {}) {
  const [tab, setTab] = useState<BuilderTab>(initialTab ?? 'agent');

  useEffect(() => {
    const applyNavTab = () => {
      const t = localStorage.getItem('markus_nav_tab');
      if (t && ['agent', 'team', 'skill'].includes(t)) {
        setTab(t as BuilderTab);
        localStorage.removeItem('markus_nav_tab');
      }
    };
    applyNavTab();
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ page: string }>).detail;
      if (detail.page === 'builder') applyNavTab();
    };
    window.addEventListener('markus:navigate', handler);
    return () => window.removeEventListener('markus:navigate', handler);
  }, []);

  const currentTab = TAB_CONFIG.find(t => t.key === tab)!;

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Header with tabs */}
      <div className="flex items-center gap-4 px-5 h-14 border-b border-gray-800 bg-gray-900 shrink-0">
        <h2 className="text-lg font-semibold mr-2">Builder</h2>
        <div className="flex gap-1.5">
          {TAB_CONFIG.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-2 ${
                tab === t.key
                  ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/30'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800 border border-transparent'
              }`}
            >
              <span className="text-sm">{t.icon}</span>
              <div className="text-left">
                <div>{t.label}</div>
                <div className="text-[9px] opacity-60">{t.desc}</div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Creator Agent */}
      <CreatorAgent key={tab} mode={tab} greeting={currentTab.greeting} />
    </div>
  );
}
