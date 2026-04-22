import { useState } from 'react';

export type BuilderMode = 'agent' | 'team' | 'skill';

/** Detect builder mode from agent role name or assigned building skills */
export function getBuilderMode(role?: string, skills?: string[]): BuilderMode | null {
  if (role) {
    const r = role.toLowerCase();
    if (r === 'agent father' || r === 'agent-father') return 'agent';
    if (r === 'team factory' || r === 'team-factory') return 'team';
    if (r === 'skill architect' || r === 'skill-architect') return 'skill';
  }
  if (skills) {
    if (skills.includes('agent-building')) return 'agent';
    if (skills.includes('team-building')) return 'team';
    if (skills.includes('skill-building')) return 'skill';
  }
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function toStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return (val as string[]).map(s => String(s).trim()).filter(Boolean);
  if (typeof val === 'string' && val) return val.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

function getArtifactFiles(artifact: Record<string, unknown>): Record<string, string> | null {
  if (artifact.files && typeof artifact.files === 'object' && !Array.isArray(artifact.files)) {
    return artifact.files as Record<string, string>;
  }
  return null;
}

// ─── Artifact Preview Components ──────────────────────────────────────────────

function Field({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div>
      <span className="text-[10px] text-fg-tertiary uppercase tracking-wider">{label}</span>
      <div className="text-xs text-fg-secondary mt-0.5">{value}</div>
    </div>
  );
}

function Badge({ label, value, color }: { label: string; value?: string; color: string }) {
  if (!value) return null;
  const colors: Record<string, string> = {
    purple: 'bg-brand-500/15 text-brand-500',
    cyan: 'bg-blue-500/15 text-blue-600',
    indigo: 'bg-brand-500/15 text-brand-500',
    gray: 'bg-gray-500/15 text-fg-secondary',
    emerald: 'bg-green-500/15 text-green-600',
  };
  return (
    <div>
      <span className="text-[10px] text-fg-tertiary uppercase tracking-wider">{label}</span>
      <div className={`mt-0.5 px-2 py-0.5 rounded-full text-[10px] font-medium ${colors[color] ?? colors.gray} capitalize inline-block`}>{value}</div>
    </div>
  );
}

function FilesPreview({ files }: { files: Record<string, string> }) {
  const [active, setActive] = useState(Object.keys(files)[0] ?? '');
  const names = Object.keys(files);
  if (names.length === 0) return null;
  return (
    <div>
      <span className="text-[10px] text-fg-tertiary uppercase tracking-wider">Files ({names.length})</span>
      <div className="mt-1 bg-surface-elevated/50 rounded-lg border border-border-default/30 overflow-hidden">
        <div className="flex gap-0.5 px-1.5 py-1 border-b border-border-default/30 overflow-x-auto">
          {names.map(fn => (
            <button key={fn} onClick={() => setActive(fn)}
              className={`px-2 py-0.5 text-[10px] rounded whitespace-nowrap transition-colors ${active === fn ? 'bg-brand-600/30 text-brand-500' : 'text-fg-tertiary hover:text-fg-secondary'}`}>
              {fn}
            </button>
          ))}
        </div>
        {active && files[active] != null && (
          <pre className="p-2 text-[10px] text-fg-secondary max-h-[120px] overflow-auto whitespace-pre-wrap font-mono">{files[active]}</pre>
        )}
      </div>
    </div>
  );
}

export function ArtifactPreview({ artifact, mode }: { artifact: Record<string, unknown>; mode: BuilderMode }) {
  const files = getArtifactFiles(artifact);
  const agentSection = artifact.agent as Record<string, unknown> | undefined;
  const teamSection = artifact.team as Record<string, unknown> | undefined;
  const deps = artifact.dependencies as Record<string, unknown> | undefined;
  const displayName = (artifact.displayName as string) ?? (artifact.name as string);

  if (mode === 'agent') {
    const roleName = agentSection?.roleName as string | undefined;
    const agentRole = agentSection?.agentRole as string | undefined;
    const llmProvider = agentSection?.llmProvider as string | undefined;
    const llmModel = agentSection?.llmModel as string | undefined;
    const envDeps = toStringArray(deps?.env);
    const skillDeps = toStringArray(deps?.skills);

    return (
      <div className="space-y-3 text-sm">
        <Field label="Name" value={displayName} />
        <Field label="Description" value={artifact.description as string} />
        <div className="flex flex-wrap gap-2">
          {roleName && <Badge label="Base Template" value={roleName} color="indigo" />}
          <Badge label="Agent Role" value={agentRole} color={agentRole === 'manager' ? 'purple' : 'cyan'} />
        </div>
        {toStringArray(artifact.tags).length > 0 && (
          <div className="flex flex-wrap gap-1">
            {toStringArray(artifact.tags).map(t => (
              <span key={t} className="px-1.5 py-0.5 text-[10px] bg-surface-elevated text-fg-tertiary rounded">{t}</span>
            ))}
          </div>
        )}
        {(llmProvider || llmModel) && (
          <div className="flex gap-2">
            {llmProvider && <Badge label="LLM Provider" value={llmProvider} color="gray" />}
            {llmModel && <Badge label="LLM Model" value={llmModel} color="gray" />}
          </div>
        )}
        {envDeps.length > 0 && (
          <div>
            <span className="text-[10px] text-fg-tertiary uppercase tracking-wider">Required Env</span>
            <div className="flex flex-wrap gap-1 mt-1">
              {envDeps.map(e => (
                <span key={e} className="px-1.5 py-0.5 text-[10px] bg-amber-500/10 text-amber-600 rounded font-mono">{e}</span>
              ))}
            </div>
          </div>
        )}
        {skillDeps.length > 0 && <Field label="Skills" value={skillDeps.join(', ')} />}
        {files && <FilesPreview files={files} />}
      </div>
    );
  }

  if (mode === 'team') {
    const teamMembers = teamSection?.members as Array<Record<string, unknown>> | undefined;
    const members = teamMembers ?? [];
    return (
      <div className="space-y-3 text-sm">
        <Field label="Name" value={displayName} />
        <Field label="Description" value={artifact.description as string} />
        <div className="flex flex-wrap gap-2">
          <Badge label="Category" value={artifact.category as string} color="indigo" />
        </div>
        {toStringArray(artifact.tags).length > 0 && (
          <div className="flex flex-wrap gap-1">
            {toStringArray(artifact.tags).map(t => (
              <span key={t} className="px-1.5 py-0.5 text-[10px] bg-surface-elevated text-fg-tertiary rounded">{t}</span>
            ))}
          </div>
        )}
        {files && <FilesPreview files={files} />}
        <div>
          <span className="text-[10px] text-fg-tertiary uppercase tracking-wider">Members ({members.length})</span>
          <div className="mt-1.5 space-y-1.5">
            {members.map((m, i) => (
              <div key={i} className="bg-surface-elevated/30 rounded-lg px-2 py-1.5 border border-border-default/20">
                <div className="flex items-center gap-2">
                  <span className={`w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold ${
                    m.role === 'manager' ? 'bg-brand-500/20 text-brand-500' : 'bg-blue-500/20 text-blue-600'
                  }`}>
                    {m.role === 'manager' ? '\u2605' : (i + 1)}
                  </span>
                  <span className="text-xs text-fg-secondary flex-1 truncate">{m.name as string}</span>
                  {typeof m.roleName === 'string' && m.roleName && <span className="text-[10px] text-brand-500/70 font-mono">{m.roleName}</span>}
                  <span className="text-[10px] text-fg-tertiary">x{String(m.count ?? 1)}</span>
                </div>
                {toStringArray(m.skills).length > 0 && (
                  <div className="mt-1 ml-7 flex flex-wrap gap-1">
                    {toStringArray(m.skills).map(s => (
                      <span key={s} className="px-1 py-0.5 text-[9px] bg-green-500/10 text-green-600 rounded font-mono">{s}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // skill
  return (
    <div className="space-y-3 text-sm">
      <Field label="Name" value={displayName} />
      <Field label="Description" value={artifact.description as string} />
      <div className="flex gap-2">
        <Badge label="Category" value={artifact.category as string} color="indigo" />
      </div>
      {files && <FilesPreview files={files} />}
      {toStringArray(artifact.tags).length > 0 && (
        <div className="flex flex-wrap gap-1">
          {toStringArray(artifact.tags).map(t => (
            <span key={t} className="px-1.5 py-0.5 text-[10px] bg-surface-elevated text-fg-tertiary rounded">{t}</span>
          ))}
        </div>
      )}
    </div>
  );
}

