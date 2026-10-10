/**
 * Agent picker for `type: 'agent'` manifest fields.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A platform field that binds an agent used to render as a plain text box whose
 * placeholder was `agt_…` — i.e. we asked the user to paste an opaque id they
 * have no way of knowing. The value *is* an agent id, but the human-facing
 * choice is "which agent", so the control must list the org's agents by name
 * and let the user type to filter.
 *
 * ── Why it is not special-cased by field key ────────────────────────────────
 * `FieldInput` picks this component from the manifest's **field type**, never
 * from the field being called `agentId`. Any platform that declares an agent
 * binding therefore gets the right control for free — the "zero UI code per
 * platform" invariant holds.
 *
 * ── One request, N cards ────────────────────────────────────────────────────
 * `loadAgentOptions` memoises a single in-flight promise at module scope, so six
 * platform cards mount without firing six identical `GET /agents` calls. The
 * cache is dropped on failure so a transient error can be retried.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api.ts';
import { FilterableSelect } from '../FilterableSelect.tsx';

export interface AgentOption {
  id: string;
  name: string;
  /** Shown as the row hint so two same-named agents in different teams differ. */
  role?: string;
}

async function fetchAgentOptions(): Promise<AgentOption[]> {
  const { agents } = await api.agents.list();
  return agents.map((a) => ({ id: a.id, name: a.name, role: a.role }));
}

let inflight: Promise<AgentOption[]> | null = null;

/** Cached agent list. The default loader for every `<AgentSelect>`. */
export function loadAgentOptions(): Promise<AgentOption[]> {
  if (!inflight) {
    inflight = fetchAgentOptions().catch((err) => {
      inflight = null; // a failed load must not poison the cache
      throw err;
    });
  }
  return inflight;
}

/** Test seam: forget the cached list (used by the unit tests). */
export function resetAgentOptionsCache(): void {
  inflight = null;
}

/**
 * Resolve the agent list once per card. Errors are swallowed into an empty list
 * on purpose: a picker that cannot load must still render (as a disabled
 * "no agents" control), never blank out the whole settings form.
 */
export function useAgentOptions(
  loader: () => Promise<AgentOption[]> = loadAgentOptions,
  enabled = true,
): AgentOption[] {
  const [agents, setAgents] = useState<AgentOption[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    loader()
      .then((list) => { if (alive) setAgents(list); })
      .catch(() => { if (alive) setAgents([]); });
    return () => { alive = false; };
  }, [loader, enabled]);
  return agents;
}

export interface AgentSelectProps {
  value: unknown;
  options: AgentOption[];
  onChange: (key: string, value: unknown) => void;
  /** Manifest key this control edits. */
  fieldKey: string;
  ariaLabel?: string;
}

export function AgentSelect({ value, options, onChange, fieldKey, ariaLabel }: AgentSelectProps) {
  const { t } = useTranslation(['settings']);
  return (
    <FilterableSelect
      value={typeof value === 'string' ? value : ''}
      options={options.map((a) => ({ value: a.id, label: a.name, hint: a.role }))}
      onChange={(next) => onChange(fieldKey, next)}
      // The empty row is what makes "unbound" selectable — clearing a binding
      // must be as easy as setting one.
      placeholder={t('settings:integrations.agentSelect.none', { defaultValue: 'Not bound' })}
      filterPlaceholder={t('settings:integrations.agentSelect.search', { defaultValue: 'Search agents…' })}
      emptyText={t('settings:integrations.agentSelect.empty', { defaultValue: 'No matching agent' })}
      ariaLabel={ariaLabel ?? t('settings:integrations.agentSelect.none', { defaultValue: 'Not bound' })}
      className="w-full"
    />
  );
}
