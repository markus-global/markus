/**
 * 组织身份（C10-D）—— 声明组织地址前缀的唯一 UI 入口。
 *
 * 为什么必须有这个页面：邮箱地址的格式是 `<local>.<org>@markus.global`，中间那段
 * `<org>` 必须是本组织**已声明**的合法 slug（C10-A 的防抢注门）。而 `declareOrgSlug`
 * 在此之前只有 storage 方法，没有任何 HTTP/UI 入口 —— 真实用户永远走不到"声明"这一步，
 * 于是地址永远绑不上。这个页面就是那个缺失的入口。
 *
 * 三条产品规则（都由后端裁决，前端只负责如实呈现）：
 *  1. 只有 owner 能改（slug 是全局唯一的地址段，不能让成员改走别人的名字）。
 *  2. 已签发地址的组织**锁定** —— 改 slug 会让已经发出去的地址变成悬空引用。
 *  3. 校验失败要给出 hint 与错误码，不能只说"保存失败"。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuthUser } from '../api';

interface OrgIdentityState {
  orgId: string;
  orgSlug: string | null;
  hubOrgId: string | null;
  issuedAddresses: number;
  locked: boolean;
}

interface SlugError {
  code: string;
  hint?: string;
}

export function OrgIdentitySection({ authUser }: { authUser?: AuthUser }) {
  const { t } = useTranslation('settings');
  const orgId = authUser?.orgId;
  const isOwner = authUser?.role === 'owner';

  const [state, setState] = useState<OrgIdentityState | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SlugError | null>(null);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/orgs/${orgId}/slug`, { credentials: 'include' });
      if (res.ok) {
        const data = (await res.json()) as OrgIdentityState;
        setState(data);
        setDraft(data.orgSlug ?? '');
      }
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!orgId) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/orgs/${orgId}/slug`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: draft.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as SlugError & { orgSlug?: string };
      if (!res.ok) {
        setError({ code: body.code ?? 'ERROR', hint: body.hint });
        return;
      }
      setSaved(true);
      await load();
    } catch (err) {
      setError({ code: 'NETWORK', hint: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const locked = state?.locked ?? false;
  const slug = state?.orgSlug ?? '';
  const preview = slug ? `${t('orgIdentity.previewLocal')}.${slug}@markus.global` : null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">{t('orgIdentity.title')}</h2>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">{t('orgIdentity.desc')}</p>
      </div>

      {loading && <p className="text-sm text-[var(--text-tertiary)]">{t('common:loading')}</p>}

      {!loading && state && (
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-wide text-[var(--text-tertiary)]">
                {t('orgIdentity.current')}
              </p>
              <p className="mt-1 font-mono text-sm text-[var(--text-primary)]">
                {slug || t('orgIdentity.unset')}
              </p>
            </div>
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${
                state.hubOrgId
                  ? 'bg-emerald-500/10 text-emerald-600'
                  : 'bg-amber-500/10 text-amber-600'
              }`}
            >
              {state.hubOrgId ? t('orgIdentity.hosted') : t('orgIdentity.localOnly')}
            </span>
          </div>

          {preview && (
            <p className="text-sm text-[var(--text-secondary)]">
              {t('orgIdentity.preview')}: <span className="font-mono">{preview}</span>
            </p>
          )}

          {locked ? (
            <p className="rounded-md bg-[var(--bg-tertiary)] p-3 text-sm text-[var(--text-secondary)]">
              {t('orgIdentity.locked', { count: state.issuedAddresses })}
            </p>
          ) : isOwner ? (
            <div className="space-y-3">
              <label className="block text-sm text-[var(--text-secondary)]" htmlFor="org-slug-input">
                {t('orgIdentity.inputLabel')}
              </label>
              <div className="flex gap-2">
                <input
                  id="org-slug-input"
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setSaved(false);
                    setError(null);
                  }}
                  placeholder={t('orgIdentity.placeholder')}
                  spellCheck={false}
                  className="flex-1 rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-2 font-mono text-sm text-[var(--text-primary)]"
                />
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={busy || !draft.trim() || draft.trim() === slug}
                  className="rounded-md bg-[var(--accent-primary)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {busy ? t('orgIdentity.saving') : t('orgIdentity.save')}
                </button>
              </div>
              <p className="text-xs text-[var(--text-tertiary)]">{t('orgIdentity.rule')}</p>
            </div>
          ) : (
            <p className="text-sm text-[var(--text-secondary)]">{t('orgIdentity.ownerOnly')}</p>
          )}

          {saved && <p className="text-sm text-emerald-600">{t('orgIdentity.saved')}</p>}

          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm">
              <p className="font-medium text-red-600">{t(`orgIdentity.err.${error.code}`, error.code)}</p>
              {error.hint && <p className="mt-1 font-mono text-xs text-red-500/80">{error.hint}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
