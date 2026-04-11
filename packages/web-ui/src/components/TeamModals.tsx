import { useEffect, useState } from 'react';
import { api, type TeamInfo, type TeamMemberInfo } from '../api.ts';

// ─── UI Primitives ────────────────────────────────────────────────────────────

export function Modal({ children, onClose, title, width = 'w-[440px]' }: { children: React.ReactNode; onClose: () => void; title: string; width?: string }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className={`bg-surface-secondary border border-border-default rounded-xl p-6 ${width} shadow-2xl max-h-[90vh] overflow-y-auto`} onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-semibold mb-5">{title}</h3>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-fg-secondary mb-1.5 font-medium">{label}</label>
      {children}
    </div>
  );
}

// ─── NewTeamModal ─────────────────────────────────────────────────────────────

export function NewTeamModal({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, description?: string) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  return (
    <Modal onClose={onClose} title="Create a New Team">
      <div className="space-y-4">
        <Field label="Team Name">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Engineering, Marketing, Support" className="input" autoFocus
            onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onCreate(name.trim(), description.trim() || undefined); }}
          />
        </Field>
        <Field label="Description (optional)">
          <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="What does this team work on?" className="input" rows={2} />
        </Field>
        <div className="text-xs text-fg-tertiary">
          You can add human and AI members to this team after creating it.
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated">Cancel</button>
          <button onClick={() => name.trim() && onCreate(name.trim(), description.trim() || undefined)} disabled={!name.trim()} className="px-4 py-2 text-sm bg-brand-600 hover:bg-brand-500 disabled:opacity-40 rounded-lg text-white">
            Create Team
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── AddHumanModal ────────────────────────────────────────────────────────────

export function AddHumanModal({
  teamId, teams, onClose, onAdd,
}: {
  teamId?: string;
  teams: TeamInfo[];
  onClose: () => void;
  onAdd: (name: string, role: string, email: string | undefined, password: string | undefined, teamId: string | undefined) => void;
}) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('member');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [selectedTeam, setSelectedTeam] = useState(teamId ?? '');
  const [error, setError] = useState('');

  const submit = () => {
    setError('');
    if (!name.trim()) { setError('Name is required'); return; }
    if (password && password !== confirmPassword) { setError('Passwords do not match'); return; }
    onAdd(name.trim(), role, email || undefined, password || undefined, selectedTeam || undefined);
  };

  return (
    <Modal onClose={onClose} title="Add Human Team Member" width="w-[460px]">
      <div className="space-y-4">
        <Field label="Name *">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Full name" className="input" autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Role">
            <select value={role} onChange={e => setRole(e.target.value)} className="input">
              <option value="owner">Owner</option>
              <option value="admin">Admin</option>
              <option value="member">Member</option>
              <option value="guest">Guest</option>
            </select>
          </Field>
          <Field label="Assign to Team">
            <select value={selectedTeam} onChange={e => setSelectedTeam(e.target.value)} className="input">
              <option value="">No team</option>
              {teams.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Email">
          <input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="Optional (required for login)" className="input" />
        </Field>
        <div className="border-t border-border-default pt-3">
          <div className="text-xs text-fg-tertiary mb-3">Set a password to allow this person to log in.</div>
          <Field label="Password">
            <input value={password} onChange={e => setPassword(e.target.value)} type="password" placeholder="Leave blank for no login access" className="input" />
          </Field>
          {password && (
            <div className="mt-3">
              <Field label="Confirm Password">
                <input value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} type="password" placeholder="Repeat password" className="input" />
              </Field>
            </div>
          )}
        </div>
        {error && <div className="text-xs text-red-500 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}
        <div className="flex justify-end gap-3 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated">Cancel</button>
          <button onClick={submit} className="px-4 py-2 text-sm bg-green-700 hover:bg-green-600 rounded-lg text-white">Add Member</button>
        </div>
      </div>
    </Modal>
  );
}

// ─── AddExistingModal ─────────────────────────────────────────────────────────

export function AddExistingModal({
  teamId, ungrouped, onClose, onAdd,
}: {
  teamId: string;
  ungrouped: TeamMemberInfo[];
  onClose: () => void;
  onAdd: (memberId: string, memberType: 'human' | 'agent') => void;
}) {
  return (
    <Modal onClose={onClose} title="Add Existing Member to Team">
      <div className="space-y-3">
        <div className="text-xs text-fg-tertiary">Select an ungrouped member to add to this team.</div>
        {ungrouped.length === 0 ? (
          <div className="text-center py-8 text-sm text-fg-tertiary">All members are already in a team.</div>
        ) : (
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {ungrouped.map(m => (
              <button
                key={m.id}
                onClick={() => onAdd(m.id, m.type)}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-border-default hover:border-brand-500 hover:bg-brand-500/10 text-left transition-all"
              >
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold text-white ${m.type === 'agent' ? 'bg-brand-600' : 'bg-green-600'}`}>
                  {m.name.charAt(0)}
                </div>
                <div className="flex-1">
                  <div className="font-medium text-sm">{m.name}</div>
                  <div className="text-xs text-fg-tertiary">{m.role} · {m.type === 'agent' ? 'AI' : 'Human'}</div>
                </div>
                {m.status && (
                  <span className={`w-2 h-2 rounded-full ${m.status === 'idle' ? 'bg-green-400' : m.status === 'working' ? 'bg-blue-400' : 'bg-gray-600'}`} />
                )}
              </button>
            ))}
          </div>
        )}
        <div className="flex justify-end pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated">Close</button>
        </div>
      </div>
    </Modal>
  );
}

// ─── OpenClaw Import Panel ────────────────────────────────────────────────────

export function OpenClawImportModal({ onClose, onConnected }: { onClose: () => void; onConnected: () => void }) {
  const [agentName, setAgentName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    externalAgentId: string; markusAgentId?: string; token?: string; gatewayUrl?: string;
  } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const handleRegister = async () => {
    if (!agentName.trim()) { setError('Agent name is required'); return; }
    const extId = agentName.trim().toLowerCase().replace(/\s+/g, '-');
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/external-agents/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ externalAgentId: extId, agentName: agentName.trim(), orgId: 'default', capabilities: ['general'] }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      setResult({
        externalAgentId: extId,
        markusAgentId: data.registration?.markusAgentId,
        token: data.token,
        gatewayUrl: data.gatewayUrl,
      });
    } catch (e) {
      setError(String(e));
    }
    setLoading(false);
  };

  const doCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <Modal onClose={onClose} title="Import OpenClaw Agent" width="w-[560px]">
      {result ? (() => {
        const gwUrl = result.gatewayUrl ?? `${window.location.origin}/api/gateway`;
        const connectionPrompt = `Connect to the Markus AI platform as an external agent.

Gateway URL: ${gwUrl}
Agent ID: ${result.externalAgentId}
${result.token ? `Bearer Token: ${result.token}` : ''}

Step 1: Read the integration handbook at GET ${gwUrl}/manual (set header Authorization: Bearer <token above>). It describes the full Markus concept model, API endpoints, and collaboration patterns.
Step 2: Start a sync loop — call POST ${gwUrl}/sync every 30 seconds with your status. The response includes assigned tasks, inbox messages, team context (colleagues), and project context (requirements).
Step 3: Accept and execute tasks, report progress, and communicate with teammates via the sync message system.`;

        return (
          <>
            <div className="text-center py-6">
              <div className="text-3xl mb-3 text-green-600">✓</div>
              <div className="text-base text-green-600 font-medium mb-1">Agent registered</div>
              <div className="text-sm text-fg-secondary mt-1"><strong>{agentName}</strong></div>
            </div>

            <div className="bg-brand-500/10 border border-brand-500/30 rounded-xl p-4">
              <div className="text-xs text-fg-secondary mb-3">
                Copy this prompt and paste it into your OpenClaw agent, Cursor, or any AI assistant.
              </div>
              <button onClick={() => doCopy(connectionPrompt, 'prompt')}
                className={`w-full py-2.5 text-sm font-medium rounded-lg transition-colors ${copied === 'prompt' ? 'bg-green-600 text-white' : 'bg-brand-700 hover:bg-brand-600 text-white'}`}
              >{copied === 'prompt' ? 'Copied!' : 'Copy Connection Prompt'}</button>
            </div>

            <div className="flex justify-end pt-5">
              <button onClick={() => { onConnected(); }} className="px-5 py-2 text-sm bg-surface-elevated hover:bg-surface-overlay rounded-lg text-fg-secondary border border-border-default">Done</button>
            </div>
          </>
        );
      })() : (
        <>
          <div className="text-xs text-fg-secondary mb-4">
            Register an OpenClaw agent to join your Markus organization. After registration, you'll get a ready-to-use connection config.
          </div>
          <div className="space-y-4">
            <Field label="Agent Name *">
              <input className="input" placeholder="e.g. Alice" value={agentName} onChange={e => setAgentName(e.target.value)} autoFocus />
            </Field>
            {error && <div className="text-xs text-red-500 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}
            <div className="flex justify-end gap-3 pt-2">
              <button onClick={onClose} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated">Cancel</button>
              <button onClick={handleRegister} disabled={loading} className="px-4 py-2 text-sm bg-brand-700 hover:bg-brand-600 rounded-lg text-white disabled:opacity-50">
                {loading ? 'Connecting...' : 'Import Agent'}
              </button>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
