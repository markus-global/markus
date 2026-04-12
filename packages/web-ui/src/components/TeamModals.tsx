import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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

export function NewTeamModal({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, description: string) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');

  const submit = () => {
    setError('');
    if (!name.trim()) { setError(t('team.create_name_required')); return; }
    onCreate(name.trim(), description.trim());
  };

  return (
    <Modal onClose={onClose} title={t('team.create')} width="w-[420px]">
      <div className="space-y-4">
        <Field label={t('team.name') + ' *'}>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t('team.name_placeholder')}
            className="w-full px-3 py-2 bg-surface-base border border-border-default rounded-lg text-sm focus:border-brand-500 focus:outline-none"
            autoFocus
          />
        </Field>
        <Field label={t('team.description')}>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder={t('team.description_placeholder')}
            rows={3}
            className="w-full px-3 py-2 bg-surface-base border border-border-default rounded-lg text-sm focus:border-brand-500 focus:outline-none resize-none"
          />
        </Field>
        {error && <div className="text-xs text-red-500 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}
        <div className="flex justify-end gap-3 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated">{t('common.cancel')}</button>
          <button onClick={submit} className="px-4 py-2 text-sm bg-brand-700 hover:bg-brand-600 rounded-lg text-white">{t('team.create')}</button>
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
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [role, setRole] = useState('member');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [selectedTeam, setSelectedTeam] = useState(teamId ?? '');
  const [error, setError] = useState('');

  const submit = () => {
    setError('');
    if (!name.trim()) { setError(t('team.name_required')); return; }
    if (password && password !== confirmPassword) { setError(t('team.passwords_mismatch')); return; }
    onAdd(name.trim(), role, email || undefined, password || undefined, selectedTeam || undefined);
  };

  return (
    <Modal onClose={onClose} title={t('team.add_human')} width="w-[460px]">
      <div className="space-y-4">
        <Field label={t('member.name') + ' *'}>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t('member.name_placeholder')}
            className="w-full px-3 py-2 bg-surface-base border border-border-default rounded-lg text-sm focus:border-brand-500 focus:outline-none"
            autoFocus
          />
        </Field>
        <Field label={t('common.role')}>
          <select
            value={role}
            onChange={e => setRole(e.target.value)}
            className="w-full px-3 py-2 bg-surface-base border border-border-default rounded-lg text-sm focus:border-brand-500 focus:outline-none"
          >
            <option value="member">{t('role.member')}</option>
            <option value="reviewer">{t('role.reviewer')}</option>
            <option value="manager">{t('role.manager')}</option>
          </select>
        </Field>
        <Field label={t('member.email')}>
          <input
            value={email}
            onChange={e => setEmail(e.target.value)}
            type="email"
            placeholder={t('member.email_placeholder')}
            className="w-full px-3 py-2 bg-surface-base border border-border-default rounded-lg text-sm focus:border-brand-500 focus:outline-none"
          />
        </Field>
        {teams.length > 1 && (
          <Field label={t('common.team')}>
            <select
              value={selectedTeam}
              onChange={e => setSelectedTeam(e.target.value)}
              className="w-full px-3 py-2 bg-surface-base border border-border-default rounded-lg text-sm focus:border-brand-500 focus:outline-none"
            >
              <option value="">{t('common.none')}</option>
              {teams.map(team => (
                <option key={team.id} value={team.id}>{team.name}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label={t('auth.password')}>
          <input
            value={password}
            onChange={e => setPassword(e.target.value)}
            type="password"
            placeholder={t('member.password_placeholder')}
            className="w-full px-3 py-2 bg-surface-base border border-border-default rounded-lg text-sm focus:border-brand-500 focus:outline-none"
          />
        </Field>
        <Field label={t('auth.confirm_password')}>
          <input
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            type="password"
            placeholder={t('member.confirm_password_placeholder')}
            className="w-full px-3 py-2 bg-surface-base border border-border-default rounded-lg text-sm focus:border-brand-500 focus:outline-none"
          />
        </Field>
        {error && <div className="text-xs text-red-500 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}
        <div className="flex justify-end gap-3 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated">{t('common.cancel')}</button>
          <button onClick={submit} className="px-4 py-2 text-sm bg-green-700 hover:bg-green-600 rounded-lg text-white">{t('team.add_human')}</button>
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
  const { t } = useTranslation();
  return (
    <Modal onClose={onClose} title={t('team.invite_member')}>
      <div className="space-y-3">
        <div className="text-xs text-fg-tertiary">{t('modal.select_ungrouped_member')}</div>
        {ungrouped.length === 0 ? (
          <div className="text-center py-8 text-sm text-fg-tertiary">{t('modal.all_members_grouped')}</div>
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
                  <div className="text-xs text-fg-tertiary">{m.role} · {m.type === 'agent' ? t('common.agent') : t('common.human')}</div>
                </div>
                {m.status && (
                  <span className={`w-2 h-2 rounded-full ${m.status === 'idle' ? 'bg-green-400' : m.status === 'working' ? 'bg-blue-400' : 'bg-gray-600'}`} />
                )}
              </button>
            ))}
          </div>
        )}
        <div className="flex justify-end pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated">{t('common.close')}</button>
        </div>
      </div>
    </Modal>
  );
}

// ─── OpenClaw Import Panel ────────────────────────────────────────────────────

export function OpenClawImportModal({
  onClose, onConnected,
}: {
  onClose: () => void;
  onConnected: () => void;
}) {
  const { t } = useTranslation();
  const [agentName, setAgentName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    externalAgentId: string; markusAgentId?: string; token?: string; gatewayUrl?: string;
  } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const handleRegister = async () => {
    if (!agentName.trim()) { setError(t('agent.name_required')); return; }
    const extId = agentName.trim().toLowerCase().replace(/\s+/g, '-');
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/external-agents/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ externalAgentId: extId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('agent.registration_failed'));
      setResult(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleConnect = () => {
    onConnected();
    onClose();
  };

  return (
    <Modal onClose={onClose} title={t('modal.import_agent')} width="w-[480px]">
      {!result ? (
        <div className="space-y-4">
          <p className="text-sm text-fg-secondary">{t('modal.import_desc')}</p>
          <Field label={t('agent.name') + ' *'}>
            <input
              value={agentName}
              onChange={e => setAgentName(e.target.value)}
              placeholder={t('agent.name_placeholder')}
              className="w-full px-3 py-2 bg-surface-base border border-border-default rounded-lg text-sm focus:border-brand-500 focus:outline-none"
              autoFocus
            />
          </Field>
          {error && <div className="text-xs text-red-500 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}
          <div className="flex justify-end gap-3 pt-2">
            <button onClick={onClose} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated">{t('common.cancel')}</button>
            <button onClick={handleRegister} disabled={loading} className="px-4 py-2 text-sm bg-brand-700 hover:bg-brand-600 rounded-lg text-white disabled:opacity-50">
              {loading ? t('modal.connecting') : t('modal.register')}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="text-center py-4">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-500/20 flex items-center justify-center">
              <span className="text-3xl">✓</span>
            </div>
            <div className="font-semibold text-lg">{t('modal.connection_success')}</div>
          </div>

          <div className="space-y-3">
            <Field label="Agent ID">
              <div className="flex gap-2">
                <code className="flex-1 px-3 py-2 bg-surface-base border border-border-default rounded-lg text-sm font-mono">{result.externalAgentId}</code>
                <button onClick={() => copyToClipboard(result.externalAgentId)} className="px-3 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated">
                  {copied === result.externalAgentId ? '✓' : t('common.copy')}
                </button>
              </div>
            </Field>
            <Field label="Access Token">
              <div className="flex gap-2">
                <code className="flex-1 px-3 py-2 bg-surface-base border border-border-default rounded-lg text-sm font-mono overflow-x-auto">{result.token}</code>
                <button onClick={() => copyToClipboard(result.token || '')} className="px-3 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated">
                  {copied === result.token ? '✓' : t('common.copy')}
                </button>
              </div>
            </Field>
            <Field label="Gateway URL">
              <div className="flex gap-2">
                <code className="flex-1 px-3 py-2 bg-surface-base border border-border-default rounded-lg text-sm font-mono overflow-x-auto">{result.gatewayUrl}</code>
                <button onClick={() => copyToClipboard(result.gatewayUrl || '')} className="px-3 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated">
                  {copied === result.gatewayUrl ? '✓' : t('common.copy')}
                </button>
              </div>
            </Field>
          </div>

          <div className="text-xs text-fg-tertiary bg-surface-base border border-border-default rounded-lg px-3 py-2">
            {t('modal.token_warning')}
          </div>

          <Field label={t('agent.name') + ' *'}>
            <input
              value={agentName}
              onChange={e => setAgentName(e.target.value)}
              placeholder={t('agent.name_placeholder')}
              className="w-full px-3 py-2 bg-surface-base border border-border-default rounded-lg text-sm focus:border-brand-500 focus:outline-none"
              autoFocus />
          </Field>
          {error && <div className="text-xs text-red-500 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}
          <div className="flex justify-end gap-3 pt-2">
            <button onClick={onClose} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated">{t('common.cancel')}</button>
            <button onClick={handleRegister} disabled={loading} className="px-4 py-2 text-sm bg-brand-700 hover:bg-brand-600 rounded-lg text-white disabled:opacity-50">
              {loading ? t('modal.connecting') : t('modal.import')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}