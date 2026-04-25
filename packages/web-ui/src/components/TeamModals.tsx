import { useEffect, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
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
  const { t } = useTranslation(['team', 'common']);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  return (
    <Modal onClose={onClose} title={t('team:modals.createTeam.title')}>
      <div className="space-y-4">
        <Field label={t('team:modals.createTeam.teamName')}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder={t('team:modals.createTeam.teamNamePlaceholder')} className="input" autoFocus
            onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onCreate(name.trim(), description.trim() || undefined); }}
          />
        </Field>
        <Field label={t('team:modals.createTeam.description')}>
          <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder={t('team:modals.createTeam.descriptionPlaceholder')} className="input" rows={2} />
        </Field>
        <div className="text-xs text-fg-tertiary">
          {t('team:modals.createTeam.hint')}
        </div>
        <div className="text-xs text-fg-tertiary bg-brand-500/5 border border-brand-500/20 rounded-lg px-3 py-2">
          <Trans
            i18nKey="modals.createTeam.tipTrans"
            ns="team"
            components={{
              0: <span className="text-brand-400 font-medium" />,
              1: <span className="text-brand-400" />,
            }}
          />
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated">{t('common:cancel')}</button>
          <button onClick={() => name.trim() && onCreate(name.trim(), description.trim() || undefined)} disabled={!name.trim()} className="px-4 py-2 text-sm bg-brand-600 hover:bg-brand-500 disabled:opacity-40 rounded-lg text-white">
            {t('team:modals.createTeam.createTeam')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── AddHumanModal ────────────────────────────────────────────────────────────

export function AddHumanModal({
  onClose, onAdd,
}: {
  onClose: () => void;
  onAdd: (name: string, role: string, email: string | undefined, password: string | undefined) => void;
}) {
  const { t } = useTranslation(['team', 'common']);
  const [name, setName] = useState('');
  const [role, setRole] = useState('member');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');

  const submit = () => {
    setError('');
    if (!name.trim()) { setError(t('team:modals.addHuman.nameRequired')); return; }
    if (password && !email.trim()) { setError(t('team:modals.addHuman.emailRequired')); return; }
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError(t('team:modals.addHuman.invalidEmail')); return; }
    if (password && password.length < 6) { setError(t('team:modals.addHuman.passwordMinLength')); return; }
    if (password && password !== confirmPassword) { setError(t('team:modals.addHuman.passwordsMismatch')); return; }
    onAdd(name.trim(), role, email.trim() || undefined, password || undefined);
  };

  return (
    <Modal onClose={onClose} title={t('team:modals.addHuman.title')} width="w-[460px]">
      <div className="space-y-4">
        <Field label={t('team:modals.addHuman.name')}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder={t('team:modals.addHuman.namePlaceholder')} className="input" autoFocus />
        </Field>
        <Field label={t('team:modals.addHuman.role')}>
          <select value={role} onChange={e => setRole(e.target.value)} className="input">
            <option value="owner">{t('common:role.owner')}</option>
            <option value="admin">{t('common:role.admin')}</option>
            <option value="member">{t('common:role.member')}</option>
            <option value="guest">{t('common:role.guest')}</option>
          </select>
        </Field>
        <Field label={t('team:modals.addHuman.email')}>
          <input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder={t('team:modals.addHuman.emailPlaceholder')} className="input" />
        </Field>
        <div className="border-t border-border-default pt-3">
          <div className="text-xs text-fg-tertiary mb-3">{t('team:modals.addHuman.passwordSection')}</div>
          <Field label={t('team:modals.addHuman.password')}>
            <input value={password} onChange={e => setPassword(e.target.value)} type="password" placeholder={t('team:modals.addHuman.passwordPlaceholder')} className="input" />
          </Field>
          {password && (
            <div className="mt-3">
              <Field label={t('team:modals.addHuman.confirmPassword')}>
                <input value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} type="password" placeholder={t('team:modals.addHuman.confirmPasswordPlaceholder')} className="input" />
              </Field>
            </div>
          )}
        </div>
        {error && <div className="text-xs text-red-500 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}
        <div className="flex justify-end gap-3 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated">{t('common:cancel')}</button>
          <button onClick={submit} className="px-4 py-2 text-sm bg-green-700 hover:bg-green-600 rounded-lg text-white">{t('team:modals.addHuman.addMember')}</button>
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
  const { t } = useTranslation(['team', 'common']);
  return (
    <Modal onClose={onClose} title={t('team:modals.addExisting.title')}>
      <div className="space-y-3">
        <div className="text-xs text-fg-tertiary">{t('team:modals.addExisting.hint')}</div>
        {ungrouped.length === 0 ? (
          <div className="text-center py-8 text-sm text-fg-tertiary">{t('team:modals.addExisting.allInTeam')}</div>
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
                  <div className="text-xs text-fg-tertiary">{m.role} · {m.type === 'agent' ? t('team:modals.addExisting.typeAgent') : t('team:modals.addExisting.typeHuman')}</div>
                </div>
                {m.status && (
                  <span className={`w-2 h-2 rounded-full ${m.status === 'idle' ? 'bg-green-400' : m.status === 'working' ? 'bg-blue-400' : 'bg-gray-600'}`} />
                )}
              </button>
            ))}
          </div>
        )}
        <div className="flex justify-end pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated">{t('common:close')}</button>
        </div>
      </div>
    </Modal>
  );
}

// ─── OpenClaw Import Panel ────────────────────────────────────────────────────

export function OpenClawImportModal({ onClose, onConnected }: { onClose: () => void; onConnected: () => void }) {
  const { t } = useTranslation(['team', 'common']);
  const [agentName, setAgentName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    externalAgentId: string; markusAgentId?: string; token?: string; gatewayUrl?: string;
  } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const handleRegister = async () => {
    if (!agentName.trim()) { setError(t('team:modals.openClaw.agentNameRequired')); return; }
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
    <Modal onClose={onClose} title={t('team:modals.openClaw.title')} width="w-[560px]">
      {result ? (() => {
        const gwUrl = result.gatewayUrl ?? `${window.location.origin}/api/gateway`;
        const tokenSection = result.token ? t('team:modals.openClaw.bearerTokenLine', { token: result.token }) : '';
        const connectionPrompt = t('team:modals.openClaw.connectionPromptBody', {
          gwUrl,
          externalAgentId: result.externalAgentId,
          tokenSection,
        });

        return (
          <>
            <div className="text-center py-6">
              <div className="text-3xl mb-3 text-green-600">✓</div>
              <div className="text-base text-green-600 font-medium mb-1">{t('team:modals.openClaw.agentRegistered')}</div>
              <div className="text-sm text-fg-secondary mt-1"><strong>{agentName}</strong></div>
            </div>

            <div className="bg-brand-500/10 border border-brand-500/30 rounded-xl p-4">
              <div className="text-xs text-fg-secondary mb-3">
                {t('team:modals.openClaw.copyInstruction')}
              </div>
              <button onClick={() => doCopy(connectionPrompt, 'prompt')}
                className={`w-full py-2.5 text-sm font-medium rounded-lg transition-colors ${copied === 'prompt' ? 'bg-green-600 text-white' : 'bg-brand-700 hover:bg-brand-600 text-white'}`}
              >{copied === 'prompt' ? t('common:copied') : t('team:modals.openClaw.copyPrompt')}</button>
            </div>

            <div className="flex justify-end pt-5">
              <button onClick={() => { onConnected(); }} className="px-5 py-2 text-sm bg-surface-elevated hover:bg-surface-overlay rounded-lg text-fg-secondary border border-border-default">{t('team:modals.openClaw.done')}</button>
            </div>
          </>
        );
      })() : (
        <>
          <div className="text-xs text-fg-secondary mb-4">
            {t('team:modals.openClaw.description')}
          </div>
          <div className="space-y-4">
            <Field label={t('team:modals.openClaw.agentName')}>
              <input className="input" placeholder={t('team:modals.openClaw.agentNamePlaceholder')} value={agentName} onChange={e => setAgentName(e.target.value)} autoFocus />
            </Field>
            {error && <div className="text-xs text-red-500 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}
            <div className="flex justify-end gap-3 pt-2">
              <button onClick={onClose} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated">{t('common:cancel')}</button>
              <button onClick={handleRegister} disabled={loading} className="px-4 py-2 text-sm bg-brand-700 hover:bg-brand-600 rounded-lg text-white disabled:opacity-50">
                {loading ? t('team:modals.openClaw.connecting') : t('team:modals.openClaw.importAgent')}
              </button>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
