import { useState, useEffect, useCallback } from 'react';
import { api, type AgentInfo } from '../api.ts';
import { navBus } from '../navBus.ts';

const BUILDERS = [
  {
    roleId: 'agent-father',
    roleName: 'Agent Father',
    icon: '✦',
    color: 'from-indigo-500 to-purple-600',
    borderColor: 'border-indigo-500/30 hover:border-indigo-400/50',
    bgColor: 'bg-indigo-500/10',
    desc: 'AI Agent Architect',
    detail: 'Design and create powerful AI agents through natural conversation. Describe the agent you need and Agent Father will configure it with the right role, skills, tools, and system prompt.',
    examples: [
      'A senior full-stack developer who specializes in React and Node.js',
      'A DevOps engineer for CI/CD pipeline management',
      'A code reviewer who enforces best practices',
    ],
  },
  {
    roleId: 'team-factory',
    roleName: 'Team Factory',
    icon: '◈',
    color: 'from-cyan-500 to-blue-600',
    borderColor: 'border-cyan-500/30 hover:border-cyan-400/50',
    bgColor: 'bg-cyan-500/10',
    desc: 'AI Team Composer',
    detail: 'Compose optimal agent teams for any project. Describe your goal and Team Factory will design the lineup with the right mix of managers, developers, reviewers, and specialists.',
    examples: [
      'A web development team with PM, developers, and QA',
      'A content team for a tech blog',
      'A data engineering squad',
    ],
  },
  {
    roleId: 'skill-architect',
    roleName: 'Skill Architect',
    icon: '⬡',
    color: 'from-emerald-500 to-teal-600',
    borderColor: 'border-emerald-500/30 hover:border-emerald-400/50',
    bgColor: 'bg-emerald-500/10',
    desc: 'AI Skill Designer',
    detail: 'Create new agent skills and tool definitions. Describe the capability you want and Skill Architect will design the complete skill manifest with tools, schemas, and permissions.',
    examples: [
      'A skill that analyzes Git repos and generates changelogs',
      'A web scraping skill for extracting structured data',
      'A database migration tool with rollback support',
    ],
  },
];

interface BuilderArtifact {
  type: string;
  name: string;
  meta: Record<string, unknown>;
  path: string;
  updatedAt: string;
}

const TYPE_STYLES: Record<string, { icon: string; color: string; bg: string }> = {
  agent: { icon: '✦', color: 'text-indigo-400', bg: 'bg-indigo-500/10' },
  team: { icon: '◈', color: 'text-cyan-400', bg: 'bg-cyan-500/10' },
  skill: { icon: '⬡', color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
};

export function AgentBuilder() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [artifacts, setArtifacts] = useState<BuilderArtifact[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterType, setFilterType] = useState<string>('all');
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  const loadArtifacts = useCallback(() => {
    setLoading(true);
    api.builder.artifacts.list()
      .then(d => setArtifacts(d.artifacts))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    api.agents.list().then(d => setAgents(d.agents)).catch(() => {});
    loadArtifacts();
  }, [loadArtifacts]);

  const navigateToBuilder = (_roleId: string, roleName: string) => {
    const builderAgent = agents.find(a => a.role === roleName || a.name === roleName);
    if (builderAgent) {
      navBus.navigate('chat', { agentId: builderAgent.id });
    } else {
      navBus.navigate('chat');
    }
  };

  const handleInstall = async (art: BuilderArtifact) => {
    const key = `${art.type}/${art.name}`;
    setActionInProgress(key);
    try {
      await api.builder.artifacts.install(art.type, art.name);
      loadArtifacts();
    } catch (err) {
      console.error('Install failed:', err);
    } finally {
      setActionInProgress(null);
    }
  };

  const handleDelete = async (art: BuilderArtifact) => {
    if (!confirm(`Delete "${(art.meta.name as string) || art.name}"? This cannot be undone.`)) return;
    const key = `${art.type}/${art.name}`;
    setActionInProgress(key);
    try {
      await api.builder.artifacts.delete(art.type, art.name);
      setArtifacts(prev => prev.filter(a => !(a.type === art.type && a.name === art.name)));
    } catch (err) {
      console.error('Delete failed:', err);
    } finally {
      setActionInProgress(null);
    }
  };

  const filtered = filterType === 'all' ? artifacts : artifacts.filter(a => a.type === filterType);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-10">
        {/* Builder cards */}
        <div className="mb-10">
          <h1 className="text-2xl font-bold text-gray-100">Builder</h1>
          <p className="text-sm text-gray-500 mt-2">
            Create agents, teams, and skills through AI-powered conversations.
            Choose a builder to get started.
          </p>
        </div>

        <div className="grid gap-5">
          {BUILDERS.map(b => (
            <button
              key={b.roleId}
              onClick={() => navigateToBuilder(b.roleId, b.roleName)}
              className={`group text-left w-full rounded-xl border ${b.borderColor} bg-gray-900/60 p-6 transition-all hover:bg-gray-900/80 hover:shadow-lg`}
            >
              <div className="flex items-start gap-5">
                <div className={`w-14 h-14 rounded-xl ${b.bgColor} flex items-center justify-center text-2xl shrink-0`}>
                  {b.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1.5">
                    <h3 className={`text-lg font-semibold bg-gradient-to-r ${b.color} bg-clip-text text-transparent`}>
                      {b.roleName}
                    </h3>
                    <span className="text-[10px] text-gray-600 font-medium uppercase tracking-wider">{b.desc}</span>
                    {agents.find(a => a.role === b.roleName || a.name === b.roleName) && (
                      <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" title="Agent online" />
                    )}
                  </div>
                  <p className="text-sm text-gray-400 leading-relaxed">{b.detail}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {b.examples.map((ex, i) => (
                      <span key={i} className="text-[11px] text-gray-600 bg-gray-800/60 rounded-full px-3 py-1 border border-gray-800">
                        &ldquo;{ex}&rdquo;
                      </span>
                    ))}
                  </div>
                </div>
                <svg className="w-5 h-5 text-gray-700 group-hover:text-gray-400 transition-colors shrink-0 mt-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </div>
            </button>
          ))}
        </div>

        {agents.length > 0 && !agents.some(a => BUILDERS.some(b => a.role === b.roleName || a.name === b.roleName)) && (
          <div className="mt-8 p-4 rounded-lg border border-amber-800/30 bg-amber-900/10 text-amber-400 text-xs">
            Builder agents have not been created yet. They will be automatically seeded on next server restart.
          </div>
        )}

        {/* Artifact management section */}
        <div className="mt-14 mb-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-200">My Creations</h2>
              <p className="text-xs text-gray-500 mt-1">Saved builder artifacts — install to deploy, or share to Markus Hub.</p>
            </div>
            <button
              onClick={loadArtifacts}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors px-3 py-1.5 rounded-lg border border-gray-800 hover:border-gray-700"
            >
              Refresh
            </button>
          </div>

          <div className="flex gap-2 mt-4">
            {['all', 'agent', 'team', 'skill'].map(t => (
              <button
                key={t}
                onClick={() => setFilterType(t)}
                className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                  filterType === t
                    ? 'border-gray-600 bg-gray-800 text-gray-200'
                    : 'border-gray-800 text-gray-500 hover:text-gray-400 hover:border-gray-700'
                }`}
              >
                {t === 'all' ? 'All' : t.charAt(0).toUpperCase() + t.slice(1) + 's'}
              </button>
            ))}
          </div>
        </div>

        {loading && artifacts.length === 0 ? (
          <div className="text-center text-gray-600 py-12 text-sm">Loading artifacts...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-gray-600 text-sm">No artifacts found.</div>
            <div className="text-gray-700 text-xs mt-1">Use a builder above to create agents, teams, or skills.</div>
          </div>
        ) : (
          <div className="grid gap-3">
            {filtered.map(art => {
              const style = TYPE_STYLES[art.type] ?? TYPE_STYLES.agent!;
              const displayName = (art.meta.name as string) || art.name;
              const description = (art.meta.description as string) || '';
              const key = `${art.type}/${art.name}`;
              const busy = actionInProgress === key;

              return (
                <div
                  key={key}
                  className="group rounded-lg border border-gray-800 bg-gray-900/60 p-4 hover:border-gray-700 transition-all"
                >
                  <div className="flex items-start gap-3">
                    <div className={`w-9 h-9 rounded-lg ${style.bg} flex items-center justify-center text-lg shrink-0`}>
                      {style.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-sm font-medium text-gray-200 truncate">{displayName}</span>
                        <span className={`text-[10px] font-medium uppercase tracking-wider ${style.color}`}>{art.type}</span>
                      </div>
                      {description && <p className="text-xs text-gray-500 line-clamp-2">{description}</p>}
                      <div className="flex items-center gap-3 mt-2 text-[10px] text-gray-600">
                        <span title={art.path}>{art.path}</span>
                        <span>{new Date(art.updatedAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => handleInstall(art)}
                        disabled={busy}
                        className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50"
                      >
                        {busy ? '...' : 'Install'}
                      </button>
                      <button
                        onClick={() => handleDelete(art)}
                        disabled={busy}
                        className="text-xs px-2 py-1.5 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-900/20 transition-colors disabled:opacity-50"
                        title="Delete"
                      >
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
