import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hubApi } from '../api.ts';
import { useNativeBrowserOverlay } from '../hooks/useNativeBrowserOverlay.ts';
import {
  MAX_FEEDBACK_IMAGES,
  MAX_FEEDBACK_IMAGE_BYTES,
  acceptFeedbackFiles,
  formatBytes,
  validateFeedbackDraft,
  type RejectReason,
} from '../lib/feedbackAttachments.ts';

interface Props {
  /** 联系方式默认值：登录邮箱（没有则为空）。 */
  defaultContact: string;
  onClose: () => void;
}

interface Shot {
  id: string;
  file: File;
  previewUrl: string;
}

function rejectMessage(t: (key: string, opts?: Record<string, unknown>) => string, reason: RejectReason): string {
  if (reason === 'not_image') return t('feedback.rejectNotImage');
  if (reason === 'too_large') return t('feedback.rejectTooLarge', { size: formatBytes(MAX_FEEDBACK_IMAGE_BYTES) });
  return t('feedback.rejectTooMany', { max: MAX_FEEDBACK_IMAGES });
}

/**
 * 问题反馈弹窗：标题（必填）+ 详细内容 + 最多 5 张截图 + 联系方式。
 *
 * 截图先经 `hubApi.uploadImage()` 上传到 Hub（R2 `uploads/`），
 * 再把 URL 数组交给 `hubApi.feedback.create()`——Hub 只存快照。
 * 未登录 Hub 时图片上传不可用（上传接口需要鉴权），只允许纯文字反馈。
 */
export function FeedbackModal({ defaultContact, onClose }: Props) {
  const { t } = useTranslation('common');
  useNativeBrowserOverlay(true);

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [contact, setContact] = useState(defaultContact);
  const [shots, setShots] = useState<Shot[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const shotsRef = useRef<Shot[]>([]);
  shotsRef.current = shots;

  const hubReady = hubApi.isAuthenticated();

  // Object URLs must be revoked by the component that created them.
  useEffect(() => () => {
    for (const shot of shotsRef.current) URL.revokeObjectURL(shot.previewUrl);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const addFiles = useCallback((files: FileList | File[] | null) => {
    if (!files) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    const { accepted, rejected } = acceptFeedbackFiles(list, shotsRef.current.length);
    if (rejected.length) {
      setWarnings(rejected.map(r => `${r.name}：${rejectMessage(t, r.reason)}`));
    } else {
      setWarnings([]);
    }
    if (accepted.length) {
      setShots(prev => [
        ...prev,
        ...accepted.map(file => ({ id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`, file, previewUrl: URL.createObjectURL(file) })),
      ]);
    }
  }, [t]);

  const removeShot = (id: string) => {
    setShots(prev => {
      const target = prev.find(s => s.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter(s => s.id !== id);
    });
    setWarnings([]);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (validateFeedbackDraft({ title })) { setError(t('feedback.titleRequired')); return; }

    setBusy(true);
    try {
      const urls: string[] = [];
      for (const shot of shots) {
        const uploaded = await hubApi.uploadImage(shot.file);
        if (!uploaded?.url) throw new Error('upload_failed');
        urls.push(uploaded.url);
      }

      await hubApi.feedback.create({
        title: title.trim(),
        content: content.trim() || undefined,
        contact: contact.trim() || undefined,
        images: urls.length ? urls : undefined,
        appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : undefined,
        platform: typeof navigator !== 'undefined' ? navigator.platform : undefined,
        locale: typeof navigator !== 'undefined' ? navigator.language : undefined,
      });
      setDone(true);
    } catch (err) {
      const status = (err as { status?: number }).status;
      const message = err instanceof Error ? err.message : String(err);
      if (status === 404) setError(t('feedback.hubUnsupported'));
      else if (message === 'upload_failed') setError(t('feedback.uploadFailed'));
      else setError(t('feedback.submitFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[10000] p-4" onClick={() => { if (!busy) onClose(); }}>
      <div
        className="bg-surface-secondary border border-border-default rounded-xl w-[540px] max-w-full max-h-[calc(100vh-2rem)] overflow-y-auto shadow-2xl"
        onClick={e => e.stopPropagation()}
        onDragOver={e => { e.preventDefault(); if (hubReady) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => {
          e.preventDefault();
          setDragging(false);
          if (hubReady) addFiles(e.dataTransfer.files);
        }}
      >
        {done ? (
          <div className="p-6 text-center">
            <div className="text-3xl mb-3">✅</div>
            <h3 className="text-base font-semibold text-fg-primary mb-2">{t('feedback.successTitle')}</h3>
            <p className="text-sm text-fg-tertiary mb-5">{t('feedback.successDesc')}</p>
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm bg-brand-600 hover:bg-brand-500 text-white rounded-lg">
              {t('feedback.successClose')}
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="p-6">
            <h3 className="text-base font-semibold text-fg-primary">{t('feedback.modalTitle')}</h3>
            <p className="text-xs text-fg-tertiary mt-1 mb-4">{t('feedback.modalSubtitle')}</p>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-fg-tertiary font-medium mb-1">
                  {t('feedback.fieldTitle')} <span className="text-red-400">*</span>
                </label>
                <input
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  maxLength={120}
                  autoFocus
                  placeholder={t('feedback.titlePlaceholder')}
                  className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm text-fg-primary focus:border-brand-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-xs text-fg-tertiary font-medium mb-1">{t('feedback.fieldContent')}</label>
                <textarea
                  value={content}
                  onChange={e => setContent(e.target.value)}
                  maxLength={4000}
                  rows={5}
                  placeholder={t('feedback.contentPlaceholder')}
                  onPaste={e => {
                    if (!hubReady) return;
                    const files = Array.from(e.clipboardData?.files ?? []);
                    if (files.length) { e.preventDefault(); addFiles(files); }
                  }}
                  className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm text-fg-primary focus:border-brand-500 outline-none resize-y"
                />
              </div>

              <div>
                <label className="block text-xs text-fg-tertiary font-medium mb-1">
                  {t('feedback.fieldImages', { max: MAX_FEEDBACK_IMAGES })}
                </label>
                {hubReady ? (
                  <div className={`rounded-lg border border-dashed p-3 transition-colors ${dragging ? 'border-brand-500 bg-brand-500/5' : 'border-border-default'}`}>
                    <div className="flex flex-wrap gap-2">
                      {shots.map(shot => (
                        <div key={shot.id} className="relative group">
                          <img src={shot.previewUrl} alt={shot.file.name} className="w-20 h-16 object-cover rounded-md border border-border-default" />
                          <button
                            type="button"
                            onClick={() => removeShot(shot.id)}
                            title={t('remove')}
                            className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-black/70 text-white text-[11px] leading-none opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      {shots.length < MAX_FEEDBACK_IMAGES && (
                        <button
                          type="button"
                          onClick={() => inputRef.current?.click()}
                          className="w-20 h-16 rounded-md border border-dashed border-border-default text-fg-muted hover:text-fg-secondary hover:border-brand-500 transition-colors text-lg"
                        >
                          +
                        </button>
                      )}
                    </div>
                    <p className="text-[10px] text-fg-muted mt-2">{t('feedback.dropHint')}</p>
                    <input
                      ref={inputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      multiple
                      className="hidden"
                      onChange={e => { addFiles(e.target.files); e.target.value = ''; }}
                    />
                  </div>
                ) : (
                  <p className="text-[11px] text-amber-500/90 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
                    {t('feedback.loginForImages')}
                  </p>
                )}
                {warnings.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5">
                    {warnings.map((w, i) => <li key={i} className="text-[11px] text-red-400">{w}</li>)}
                  </ul>
                )}
              </div>

              <div>
                <label className="block text-xs text-fg-tertiary font-medium mb-1">{t('feedback.fieldContact')}</label>
                <input
                  value={contact}
                  onChange={e => setContact(e.target.value)}
                  placeholder={t('feedback.contactPlaceholder')}
                  className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm text-fg-primary focus:border-brand-500 outline-none"
                />
              </div>

              {error && (
                <div className="text-xs text-red-500 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>
              )}
            </div>

            <div className="flex justify-end gap-3 mt-5">
              <button type="button" onClick={onClose} disabled={busy} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated disabled:opacity-50">
                {t('cancel')}
              </button>
              <button type="submit" disabled={busy} className="px-4 py-2 text-sm bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white rounded-lg">
                {busy ? t('feedback.submitting') : t('feedback.submit')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
