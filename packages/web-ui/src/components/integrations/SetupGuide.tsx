/**
 * Setup guide — the "how do I get these credentials?" steps shown at the top of
 * an expanded integration card.
 *
 * Guidance is the one thing a raw manifest form cannot supply, and it is exactly
 * what turns "here are two empty boxes" into a task a user can finish. The steps
 * come from the locale files by convention (see `lib/platformI18n.ts`), so a
 * platform's guide is content, not code, and an untranslated platform simply
 * shows the generic hint plus its docs link.
 *
 * It is an accordion because a returning (already-configured) user does not want
 * the tutorial every time: it starts **open** for an unconfigured platform and
 * **closed** once credentials are stored.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { consoleUrlFor, guideHeading, guideSteps } from '../../lib/platformI18n.ts';
import type { PlatformStatus } from '../../lib/platformIntegrations.ts';

export interface SetupGuideProps {
  status: PlatformStatus;
  /** Credentials already stored → the guide starts collapsed. */
  configured: boolean;
}

export function SetupGuide({ status, configured }: SetupGuideProps) {
  const { t, i18n } = useTranslation(['settings', 'common']);
  const [open, setOpen] = useState(!configured);

  const steps = guideSteps(i18n, t, status.id);
  const consoleUrl = consoleUrlFor(status.id);
  const description = t(`settings:integrations.platforms.${status.id}.description`, { defaultValue: '' });

  return (
    <div
      className="bg-surface-secondary border border-border-default rounded-xl overflow-hidden"
      data-testid="integration-guide"
      data-open={open ? 'true' : 'false'}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="integration-guide-toggle"
        className="w-full flex items-center gap-2.5 px-4 py-3 text-left hover:bg-white/[0.02] transition-colors"
      >
        <span className="text-base leading-none" aria-hidden="true">🧭</span>
        <span className="flex-1 text-sm font-medium text-fg-primary">{guideHeading(t)}</span>
        <svg
          className={`w-4 h-4 text-fg-tertiary transition-transform ${open ? 'rotate-90' : ''}`}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 space-y-3 border-t border-border-default">
          {description && <p className="text-xs text-fg-tertiary">{description}</p>}

          {steps.length > 0 ? (
            <ol className="space-y-2.5" data-testid="integration-guide-steps">
              {steps.map((step, index) => (
                <li key={step.title} className="flex gap-3">
                  <span className="shrink-0 w-5 h-5 mt-0.5 rounded-full bg-brand-500/15 text-brand-600 text-[11px] font-semibold flex items-center justify-center">
                    {index + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-fg-primary">{step.title}</span>
                    {step.desc && <span className="block text-[11px] text-fg-tertiary mt-0.5">{step.desc}</span>}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-xs text-fg-tertiary">
              {t('settings:integrations.guide.fallback', {
                defaultValue: 'Fill in the credentials from the platform’s developer console below.',
              })}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            {consoleUrl && (
              <a
                href={consoleUrl}
                target="_blank"
                rel="noreferrer"
                data-testid="integration-guide-console"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors"
              >
                {t('settings:integrations.guide.openConsole', { defaultValue: 'Open developer console' })}
                <span aria-hidden="true">↗</span>
              </a>
            )}
            {status.docsUrl && (
              <a
                href={status.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-brand-600 hover:text-brand-700"
              >
                {t('settings:integrations.docs', { defaultValue: 'Setup docs' })}
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
