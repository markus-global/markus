import { useState, useCallback, useEffect, useRef } from 'react';
import { api } from '../api.ts';

export type BuilderMode = 'agent' | 'team' | 'skill';

/** Detect builder mode from agent role name */
export function getBuilderMode(role?: string): BuilderMode | null {
  if (!role) return null;
  const r = role.toLowerCase();
  if (r === 'agent father' || r === 'agent-father') return 'agent';
  if (r === 'team factory' || r === 'team-factory') return 'team';
  if (r === 'skill architect' || r === 'skill-architect') return 'skill';
  return null;
}

/** Extract the latest JSON artifact from a set of message texts */
export function extractArtifact(messages: Array<{ sender: string; text: string }>): Record<string, unknown> | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.sender !== 'agent') continue;
    const match = m.text.match(/```json\s*\n([\s\S]*?)\n```/);
    if (match?.[1]) {
      try { return JSON.parse(match[1]); } catch { /* ignore */ }
    }
  }
  return null;
}

// ─── Artifact Preview Components ──────────────────────────────────────────────

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

export function ArtifactPreview({ artifact, mode }: { artifact: Record<string, unknown>; mode: BuilderMode }) {
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
                <span className="text-[10px] text-gray-500">x{String(m.count ?? 1)}</span>
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

// ─── Artifact Sidebar Panel (for Chat page) ──────────────────────────────────

export function BuilderArtifactPanel({ mode, messages }: {
  mode: BuilderMode;
  messages: Array<{ sender: string; text: string }>;
}) {
  const [creating, setCreating] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [flash, setFlash] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [editJson, setEditJson] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [editedArtifact, setEditedArtifact] = useState<Record<string, unknown> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const rawArtifact = extractArtifact(messages);
  const artifact = editedArtifact ?? rawArtifact;

  // Sync edit JSON when raw artifact changes and user hasn't manually edited
  const prevRawRef = useRef<string | null>(null);
  useEffect(() => {
    const rawStr = rawArtifact ? JSON.stringify(rawArtifact) : null;
    if (rawStr !== prevRawRef.current) {
      prevRawRef.current = rawStr;
      if (!editedArtifact && rawArtifact) {
        setEditJson(JSON.stringify(rawArtifact, null, 2));
      }
    }
  }, [rawArtifact, editedArtifact]);

  const showFlash = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(''), 5000);
  };

  const handleEditToggle = () => {
    if (!editMode && artifact) {
      setEditJson(JSON.stringify(artifact, null, 2));
      setJsonError('');
    }
    setEditMode(!editMode);
  };

  const handleJsonChange = (value: string) => {
    setEditJson(value);
    try {
      const parsed = JSON.parse(value);
      setEditedArtifact(parsed);
      setJsonError('');
    } catch {
      setJsonError('Invalid JSON');
    }
  };

  const handleReset = () => {
    setEditedArtifact(null);
    if (rawArtifact) {
      setEditJson(JSON.stringify(rawArtifact, null, 2));
    }
    setJsonError('');
  };

  const handleCreate = useCallback(async () => {
    if (!artifact || creating) return;
    setCreating(true);
    try {
      await api.builder.create(mode, artifact);
      const labels = { agent: 'Agent', team: 'Team', skill: 'Skill' };
      showFlash(`${labels[mode]} "${(artifact.name as string) ?? ''}" created successfully!`);
    } catch (err) {
      showFlash(`Creation failed: ${String(err)}`);
    } finally {
      setCreating(false);
    }
  }, [artifact, creating, mode]);

  const handleShare = useCallback(async () => {
    if (!artifact || sharing) return;
    setSharing(true);
    try {
      if (mode === 'agent') {
        const name = (artifact.name as string) ?? 'Unnamed Agent';
        const roleId = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        await api.marketplace.shareTemplate({
          name,
          description: (artifact.description as string) ?? '',
          roleId,
          agentRole: (artifact.agentRole as string) ?? 'worker',
          category: (artifact.category as string) ?? 'general',
          authorName: 'Builder',
          skills: typeof artifact.skills === 'string'
            ? (artifact.skills as string).split(',').map(s => s.trim()).filter(Boolean)
            : [],
          tags: typeof artifact.tags === 'string'
            ? (artifact.tags as string).split(',').map(s => s.trim()).filter(Boolean)
            : Array.isArray(artifact.tags) ? artifact.tags as string[] : [],
          config: {
            systemPrompt: artifact.systemPrompt,
            llmProvider: artifact.llmProvider,
            llmModel: artifact.llmModel,
            temperature: artifact.temperature,
            toolWhitelist: artifact.toolWhitelist,
            requiredEnv: artifact.requiredEnv,
          },
          publish: true,
        });
      } else if (mode === 'team') {
        const name = (artifact.name as string) ?? 'Unnamed Team';
        const roleId = `team-${name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}`;
        await api.marketplace.shareTemplate({
          name,
          description: (artifact.description as string) ?? '',
          roleId,
          agentRole: 'manager',
          category: (artifact.category as string) ?? 'general',
          authorName: 'Builder',
          tags: typeof artifact.tags === 'string'
            ? (artifact.tags as string).split(',').map(s => s.trim()).filter(Boolean)
            : Array.isArray(artifact.tags) ? artifact.tags as string[] : [],
          config: {
            type: 'team',
            members: artifact.members,
          },
          publish: true,
        });
      } else {
        // skill
        await api.marketplace.publishSkill({
          name: (artifact.name as string) ?? 'unnamed-skill',
          description: (artifact.description as string) ?? '',
          authorName: (artifact.author as string) ?? 'Builder',
          category: (artifact.category as string) ?? 'custom',
          tags: Array.isArray(artifact.tags) ? artifact.tags as string[] : [],
          tools: Array.isArray(artifact.tools) ? (artifact.tools as Array<{ name: string; description: string }>) : [],
          requiredPermissions: Array.isArray(artifact.requiredPermissions) ? artifact.requiredPermissions as string[] : [],
          requiredEnv: Array.isArray(artifact.requiredEnv) ? artifact.requiredEnv as string[] : [],
          publish: true,
        });
      }
      const labels = { agent: 'Agent template', team: 'Team template', skill: 'Skill' };
      showFlash(`${labels[mode]} shared to Templates!`);
    } catch (err) {
      showFlash(`Share failed: ${String(err)}`);
    } finally {
      setSharing(false);
    }
  }, [artifact, sharing, mode]);

  const modeLabels = { agent: 'Agent Config', team: 'Team Config', skill: 'Skill Manifest' };
  const modeIcons = { agent: '\u2726', team: '\u25C8', skill: '\u2B21' };
  const createLabels = { agent: 'Agent', team: 'Team', skill: 'Skill' };

  return (
    <div className="w-80 border-l border-gray-800 flex flex-col bg-gray-950 shrink-0">
      {/* Header with edit toggle */}
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-300">{modeLabels[mode]}</h3>
          <p className="text-[10px] text-gray-600 mt-0.5">
            {editMode ? 'Edit JSON directly' : 'Generated configuration'}
          </p>
        </div>
        {artifact && (
          <div className="flex items-center gap-1">
            {editMode && editedArtifact && (
              <button
                onClick={handleReset}
                className="px-2 py-1 text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
                title="Reset to AI-generated version"
              >
                Reset
              </button>
            )}
            <button
              onClick={handleEditToggle}
              className={`px-2.5 py-1 text-[10px] font-medium rounded-md transition-colors ${
                editMode
                  ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
                  : 'text-gray-500 hover:text-gray-300 border border-gray-700 hover:border-gray-600'
              }`}
            >
              {editMode ? 'Preview' : 'Edit'}
            </button>
          </div>
        )}
      </div>

      {flash && (
        <div className={`mx-3 mt-2 px-3 py-1.5 text-xs rounded-lg border ${
          flash.includes('failed') || flash.includes('Failed')
            ? 'bg-red-900/50 text-red-300 border-red-700/30'
            : 'bg-emerald-900/50 text-emerald-300 border-emerald-700/30'
        }`}>{flash}</div>
      )}

      {/* Content area */}
      <div className="flex-1 overflow-y-auto p-4">
        {artifact ? (
          editMode ? (
            <div className="h-full flex flex-col">
              <textarea
                ref={textareaRef}
                value={editJson}
                onChange={e => handleJsonChange(e.target.value)}
                spellCheck={false}
                className="flex-1 min-h-[300px] w-full bg-gray-900 border border-gray-700 rounded-lg p-3 text-xs text-gray-300 font-mono leading-relaxed resize-none focus:border-indigo-500 focus:outline-none"
              />
              {jsonError && (
                <div className="mt-2 text-[10px] text-red-400">{jsonError}</div>
              )}
            </div>
          ) : (
            <ArtifactPreview artifact={artifact} mode={mode} />
          )
        ) : (
          <div className="text-center text-gray-600 text-xs py-12">
            <div className="text-3xl mb-3 opacity-20">{modeIcons[mode]}</div>
            <div>Start the conversation and the AI will generate<br />a configuration for you.</div>
          </div>
        )}
      </div>

      {/* Action buttons */}
      {artifact && (
        <div className="p-4 border-t border-gray-800 space-y-2">
          <button
            onClick={() => void handleCreate()}
            disabled={creating || !!jsonError}
            className="w-full px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
          >
            {creating ? 'Creating...' : `Create ${createLabels[mode]}`}
          </button>
          <button
            onClick={() => void handleShare()}
            disabled={sharing || !!jsonError}
            className="w-full px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm rounded-lg border border-gray-700 disabled:opacity-50 transition-colors"
          >
            {sharing ? 'Sharing...' : 'Share to Templates'}
          </button>
          <button
            onClick={() => {
              const blob = new Blob([JSON.stringify(artifact, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${(artifact.name as string) ?? mode}.json`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            className="w-full px-4 py-1.5 text-gray-500 hover:text-gray-400 text-xs transition-colors"
          >
            Export JSON
          </button>
        </div>
      )}
    </div>
  );
}
