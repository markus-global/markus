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

import { Icon } from '../Icon.tsx';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConnectionState } from '../../lib/instanceIntegrations.ts';
import { fieldText } from '../../lib/platformI18n.ts';
import type { PlatformField, PlatformStatus } from '../../lib/platformIntegrations.ts';
import { Switch } from '../Switch.tsx';
import { AgentSelect, type AgentOption } from './AgentSelect.tsx';
import { HINT, INPUT, ROW, ROW_CONTROL, ROW_LABEL, ROW_START, chipClass } from './ui.ts';

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

/**
 * One setting as a **row**: label on the left, control on the right, on one
 * line (it wraps when the viewport is too narrow for both). Every field in the
 * card is this shape — see `ui.ts` for why the scale and the row live there.
 */
function FieldRow({
  label,
  control,
  help,
  htmlFor,
  start = false,
}: {
  label: ReactNode;
  control: ReactNode;
  help?: ReactNode;
  htmlFor?: string;
  /** Control is taller than one line (a chip cluster) → align to the top. */
  start?: boolean;
}) {
  return (
    <div>
      <div className={start ? ROW_START : ROW}>
        {htmlFor ? (
          <label htmlFor={htmlFor} className={ROW_LABEL}>
            {label}
          </label>
        ) : (
          <span className={ROW_LABEL}>{label}</span>
        )}
        <div className={ROW_CONTROL}>{control}</div>
      </div>
      {help ? <p className={`${HINT} mt-1.5`}>{help}</p> : null}
    </div>
  );
}

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

  // The label text with its required marker, rendered inside the row.
  const labelNode = (
    <>
      {labelText}
      {field.required && <span className="text-red-500 ml-0.5">*</span>}
    </>
  );

  const helpNode: ReactNode =
    field.secret && hasStored
      ? t('settings:integrations.secretStored')
      : helpText || undefined;

  if (field.type === 'boolean') {
    const on = value === true;
    return (
      <FieldRow
        label={labelText}
        help={helpText}
        control={
          <Switch
            checked={on}
            onChange={(next) => onChange(field.key, next)}
            label={labelText}
            size="md"
            testId={`integration-field-${field.key}`}
          />
        }
      />
    );
  }

  if (field.type === 'agent') {
    return (
      <FieldRow
        label={labelNode}
        help={helpNode}
        control={
          <div className="w-full" data-testid={`integration-field-${field.key}`}>
            <AgentSelect
              value={value}
              options={agentOptions}
              onChange={onChange}
              fieldKey={field.key}
              ariaLabel={labelText}
            />
          </div>
        }
      />
    );
  }

  if (field.type === 'select' && field.multiple) {
    const selected = Array.isArray(value) ? (value as unknown[]).map(String) : [];
    return (
      <FieldRow
        start
        label={labelNode}
        help={helpNode}
        control={
          <div
            className="flex flex-wrap justify-end gap-1.5"
            data-testid={`integration-field-${field.key}`}
          >
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
                  className={chipClass(active)}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        }
      />
    );
  }

  if (field.type === 'select') {
    return (
      <FieldRow
        label={labelNode}
        help={helpNode}
        htmlFor={inputId}
        control={
          <select
            id={inputId}
            data-testid={`integration-field-${field.key}`}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(field.key, e.target.value)}
            className={INPUT}
          >
            {(field.options ?? []).map((opt) => {
              const optLabel = options.find((o) => o.value === opt.value)?.label ?? opt.label;
              return (
                <option key={opt.value} value={opt.value}>
                  {optLabel}
                </option>
              );
            })}
          </select>
        }
      />
    );
  }

  const isSecret = field.type === 'password';
  const isNumber = field.type === 'number';
  return (
    <FieldRow
      label={labelNode}
      help={helpNode}
      htmlFor={inputId}
      control={
        <div className="relative w-full">
          <input
            id={inputId}
            data-testid={`integration-field-${field.key}`}
            type={isNumber ? 'number' : isSecret && !reveal ? 'password' : 'text'}
            value={value === undefined || value === null ? '' : String(value)}
            placeholder={isSecret && hasStored ? t('settings:integrations.secretStoredPlaceholder') : placeholderText}
            onChange={(e) => onChange(field.key, e.target.value)}
            className={`${INPUT}${isSecret ? ' font-mono pr-10' : ''}`}
          />
          {isSecret && (
            <button
              type="button"
              aria-label={reveal ? t('settings:integrations.hide', { defaultValue: 'Hide' }) : t('settings:integrations.show', { defaultValue: 'Show' })}
              onClick={() => setReveal((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-fg-tertiary hover:text-fg-secondary transition-colors"
            >
              {reveal ? <Icon name="eye-off" size={14} /> : <Icon name="eye" size={14} />}
            </button>
          )}
        </div>
      }
    />
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
