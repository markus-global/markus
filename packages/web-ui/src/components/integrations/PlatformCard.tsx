/**
 * Presentational pieces shared by the integration cards.
 *
 * ── What this file is now, and why ──────────────────────────────────────────
 *
 * It used to export `PlatformCard`: a complete card with its own expandable
 * header, an "Enable integration" block, a "Save & test" button and a
 * disconnect button. Every one of those was a *lifecycle* concern, and the
 * product surface (a bot instance) had to re-host all of them — so the page
 * ended up with two cards that disagreed: a platform-level one nobody rendered,
 * and an instance-level one that wrapped it.
 *
 * The lifecycle now lives in one place (`InstanceCard`). What remains here is
 * what a card is genuinely made of:
 *
 *   • `FieldInput`     — one manifest field → one control;
 *   • `PlatformFields` — a manifest's fields → a column of controls;
 *   • `StatusBadge`    — the connection state of a bot;
 *   • `Msg`            — an inline result line.
 *
 * Nothing here knows what a platform is called, and nothing here saves.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConnectionState } from '../../lib/instanceIntegrations.ts';
import { fieldText } from '../../lib/platformI18n.ts';
import type { PlatformField, PlatformStatus } from '../../lib/platformIntegrations.ts';
import { Switch } from '../Switch.tsx';
import { AgentSelect, type AgentOption } from './AgentSelect.tsx';

// ─── Connection badge ────────────────────────────────────────────────────────

/**
 * The badge answers "is this bot working?" from **two** facts, not one:
 * whether it is configured, and whether the two-way handshake ever passed.
 *
 * The old badge was `enabled && connected`, where `connected` only meant "our
 * process holds a live client" — a bot with a wrong token, or one that can
 * receive but has no send scope, showed green. Colour therefore has to encode
 * the stronger claim, and the weaker states get their own words rather than
 * being collapsed into "Disconnected".
 */
const BADGE_STYLE: Record<ConnectionState, string> = {
  verified: 'bg-green-500/10 text-green-600 border-green-500/30',
  unverified: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  off: 'bg-gray-500/10 text-fg-tertiary border-border-default',
  unconfigured: 'bg-gray-500/10 text-fg-tertiary border-border-default',
};

const BADGE_DOT: Record<ConnectionState, string> = {
  verified: 'bg-green-500',
  unverified: 'bg-amber-400',
  off: 'bg-gray-400',
  unconfigured: 'bg-gray-400',
};

const BADGE_KEY: Record<ConnectionState, string> = {
  verified: 'settings:integrations.status.verified',
  unverified: 'settings:integrations.status.unverified',
  off: 'settings:integrations.status.off',
  unconfigured: 'settings:integrations.status.unconfigured',
};

const BADGE_FALLBACK: Record<ConnectionState, string> = {
  verified: 'Connected',
  unverified: 'Not verified',
  off: 'Off',
  unconfigured: 'Not configured',
};

export function StatusBadge({ state }: { state: ConnectionState }) {
  const { t } = useTranslation(['settings']);
  return (
    <span
      data-testid="integration-status"
      data-state={state}
      data-connected={state === 'verified' ? 'true' : 'false'}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${BADGE_STYLE[state]}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${BADGE_DOT[state]}`} />
      {t(BADGE_KEY[state], { defaultValue: BADGE_FALLBACK[state] })}
    </span>
  );
}

/** Inline result line (a save outcome, a failure reason). */
export function Msg({ type, text }: { type: 'ok' | 'err'; text: string }) {
  return (
    <div
      data-testid={type === 'ok' ? 'integration-msg-ok' : 'integration-msg-err'}
      className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${
        type === 'ok'
          ? 'bg-green-500/10 text-green-600 border border-green-500/30'
          : 'bg-red-500/10 text-red-600 border border-red-500/30'
      }`}
    >
      {text}
    </div>
  );
}

// ─── Fields ──────────────────────────────────────────────────────────────────

/** One manifest field → one input widget. Pure presentation. */
export function FieldInput({
  field,
  value,
  hasStored,
  onChange,
  platformId = '',
  agentOptions = [],
}: {
  field: PlatformField;
  value: unknown;
  hasStored: boolean;
  onChange: (key: string, value: unknown) => void;
  /** Enables the per-platform i18n convention; the manifest label is the fallback. */
  platformId?: string;
  /** Choices for a `type: 'agent'` field. */
  agentOptions?: AgentOption[];
}) {
  const { t } = useTranslation(['settings']);
  const inputId = `integration-field-${field.key}`;
  const [reveal, setReveal] = useState(false);

  // Translated presentation (falls back to the manifest's own English strings).
  const text = useMemo(
    () =>
      platformId
        ? fieldText(t, platformId, field)
        : { label: field.label, help: field.help, placeholder: field.placeholder, options: field.options },
    [t, platformId, field],
  );
  const labelText = text.label;
  const helpText = text.help;
  const placeholderText = text.placeholder;
  const options = text.options ?? field.options ?? [];

  const label = (
    <label htmlFor={inputId} className="block text-xs font-medium text-fg-secondary mb-1.5">
      {labelText}
      {field.required && <span className="text-red-500 ml-0.5">*</span>}
    </label>
  );

  const help = (helpText || (field.secret && hasStored)) && (
    <p className="text-[11px] text-fg-tertiary mt-1">
      {field.secret && hasStored ? t('settings:integrations.secretStored') : helpText}
    </p>
  );

  if (field.type === 'boolean') {
    const on = value === true;
    return (
      <div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-fg-primary">{labelText}</div>
            {helpText && <div className="text-xs text-fg-tertiary mt-0.5">{helpText}</div>}
          </div>
          <Switch
            checked={on}
            onChange={(next) => onChange(field.key, next)}
            label={labelText}
            size="md"
            testId={`integration-field-${field.key}`}
          />
        </div>
      </div>
    );
  }

  if (field.type === 'agent') {
    return (
      <div>
        {label}
        <div data-testid={`integration-field-${field.key}`}>
          <AgentSelect
            value={value}
            options={agentOptions}
            onChange={onChange}
            fieldKey={field.key}
            ariaLabel={labelText}
          />
        </div>
        {help}
      </div>
    );
  }

  if (field.type === 'select' && field.multiple) {
    const selected = Array.isArray(value) ? (value as unknown[]).map(String) : [];
    return (
      <div>
        {label}
        <div className="flex flex-wrap gap-2" data-testid={`integration-field-${field.key}`}>
          {options.map((opt) => {
            const active = selected.includes(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                aria-pressed={active}
                data-option={opt.value}
                onClick={() =>
                  onChange(
                    field.key,
                    active ? selected.filter((v) => v !== opt.value) : [...selected, opt.value],
                  )
                }
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                  active
                    ? 'bg-brand-500/10 border-brand-500/30 text-brand-600'
                    : 'bg-surface-primary border-border-default text-fg-tertiary hover:border-fg-tertiary'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        {help}
      </div>
    );
  }

  if (field.type === 'select') {
    return (
      <div>
        {label}
        <select
          id={inputId}
          data-testid={`integration-field-${field.key}`}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(field.key, e.target.value)}
          className="w-full px-3 py-2 text-sm bg-surface-primary border border-border-default rounded-lg text-fg-primary focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 transition-colors"
        >
          {(field.options ?? []).map((opt) => {
            const label = options.find((o) => o.value === opt.value)?.label ?? opt.label;
            return (
              <option key={opt.value} value={opt.value}>
                {label}
              </option>
            );
          })}
        </select>
        {help}
      </div>
    );
  }

  const isSecret = field.type === 'password';
  const isNumber = field.type === 'number';
  return (
    <div>
      {label}
      <div className="relative">
        <input
          id={inputId}
          data-testid={`integration-field-${field.key}`}
          type={isNumber ? 'number' : isSecret && !reveal ? 'password' : 'text'}
          value={value === undefined || value === null ? '' : String(value)}
          placeholder={isSecret && hasStored ? t('settings:integrations.secretStoredPlaceholder') : placeholderText}
          onChange={(e) => onChange(field.key, e.target.value)}
          className={`w-full px-3 py-2 text-sm bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 transition-colors${isSecret ? ' font-mono pr-10' : ''}`}
        />
        {isSecret && (
          <button
            type="button"
            aria-label={reveal ? t('settings:integrations.hide', { defaultValue: 'Hide' }) : t('settings:integrations.show', { defaultValue: 'Show' })}
            onClick={() => setReveal((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-fg-tertiary hover:text-fg-secondary transition-colors"
          >
            {reveal ? '🙈' : '👁'}
          </button>
        )}
      </div>
      {help}
    </div>
  );
}

/** A whole manifest's fields, in manifest order. */
export function PlatformFields({
  status,
  draft,
  fields = status.fields,
  onChange,
  agentOptions = [],
}: {
  status: PlatformStatus;
  draft: Record<string, unknown>;
  /** Subset of `status.fields` to render; defaults to all of them. */
  fields?: PlatformField[];
  onChange: (key: string, value: unknown) => void;
  agentOptions?: AgentOption[];
}) {
  return (
    <>
      {fields.map((field) => (
        <FieldInput
          key={field.key}
          field={field}
          platformId={status.id}
          value={draft[field.key]}
          hasStored={status.secrets[field.key]?.hasValue === true}
          agentOptions={agentOptions}
          onChange={onChange}
        />
      ))}
    </>
  );
}
