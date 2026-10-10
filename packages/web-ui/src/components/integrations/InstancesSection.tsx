/**
 * Settings → Integrations — the **instance list** (slice G5).
 *
 * The page used to be a platform list, because a platform could only hold one
 * bot. It is now a list of bot instances: every platform's bots are shown under
 * that platform, and a platform with no bot yet still gets an "Add bot" entry so
 * the first one can be created.
 *
 * ── Still zero UI code per platform ────────────────────────────────────────
 * Nothing here names a platform. A platform is a group header derived from the
 * manifest catalog the API returns; its instances are rendered by
 * `InstanceCard`, which derives everything from the manifest too. Adding a
 * platform remains a backend registry entry — the regression guard in
 * `test/instancesSection.test.tsx` renders a platform the front-end has never
 * heard of and fails if anyone reintroduces a per-platform branch.
 *
 * `loadInstances`, `loadPlatforms` and `client` are seams so the section can be
 * rendered in tests without the singleton `api`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api.ts';
import type { PlatformExtras, PlatformStatus } from '../../lib/platformIntegrations.ts';
import { platformLabel } from '../../lib/platformI18n.ts';
import {
  draftInstance,
  groupByPlatform,
  visiblePlatformIds,
  type InstanceStatus,
} from '../../lib/instanceIntegrations.ts';
import { type AgentOption } from './AgentSelect.tsx';
import { InstanceCard, defaultInstanceClient, type InstanceClient } from './InstanceCard.tsx';
import { PlatformIcon } from './PlatformIcon.tsx';

export interface InstancesSectionProps {
  /** Platform catalog (drives the groups). Defaults to GET /settings/integrations. */
  loadPlatforms?: () => Promise<PlatformStatus[]>;
  /** Bot instances. Defaults to GET /settings/integrations/instances. */
  loadInstances?: () => Promise<InstanceStatus[]>;
  /** Override the operations (tests). Defaults to the real API. */
  client?: InstanceClient;
  /** Override the extras registry (tests). Defaults to the built-in one. */
  extras?: Record<string, PlatformExtras>;
  /** Override the agent list for agent pickers. Defaults to the cached API. */
  loadAgents?: () => Promise<AgentOption[]>;
  defaultExpanded?: boolean;
}

async function defaultLoadInstances(): Promise<InstanceStatus[]> {
  const res = await api.settings.listInstances();
  return res.instances ?? [];
}

async function defaultLoadPlatforms(): Promise<PlatformStatus[]> {
  const res = await api.settings.listIntegrations();
  return res.platforms ?? [];
}

export function InstancesSection({
  loadPlatforms = defaultLoadPlatforms,
  loadInstances = defaultLoadInstances,
  client = defaultInstanceClient,
  extras,
  loadAgents,
  defaultExpanded = false,
}: InstancesSectionProps) {
  const { t } = useTranslation(['settings', 'common']);
  const [instances, setInstances] = useState<InstanceStatus[]>([]);
  const [platforms, setPlatforms] = useState<PlatformStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // "Add bot" opens a **draft card** rather than a name prompt: the user meets
  // the setup steps first, and the first complete save creates the row. Until
  // that happens nothing exists server-side, which is why an abandoned draft
  // costs nothing and leaves no half-configured bot behind.
  const [adding, setAdding] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [nextInstances, nextPlatforms] = await Promise.all([loadInstances(), loadPlatforms()]);
    setInstances(nextInstances);
    setPlatforms(nextPlatforms);
    setError(null);
  }, [loadInstances, loadPlatforms]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [nextInstances, nextPlatforms] = await Promise.all([loadInstances(), loadPlatforms()]);
        if (cancelled) return;
        setInstances(nextInstances);
        setPlatforms(nextPlatforms);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [loadInstances, loadPlatforms]);

  const groups = useMemo(() => groupByPlatform(instances), [instances]);
  const platformLabelOf = useCallback(
    (platform: string) => {
      // The translated display name, not the raw manifest label: the group header
      // is the one place a Chinese user sees "飞书 / Lark". Falling back to the
      // manifest string is what keeps an untranslated platform rendering.
      const found = platforms.find((p) => p.id === platform);
      return found ? platformLabel(t, found) : platform;
    },
    [platforms, t],
  );
  const platformIds = useMemo(
    () => visiblePlatformIds(platforms, instances),
    [platforms, instances],
  );

  const startAdd = useCallback((platform: string) => {
    setAdding(platform);
  }, []);

  if (loading) {
    return (
      <div data-testid="integrations-loading" className="flex items-center justify-center py-16">
        <div className="w-5 h-5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
        <span className="ml-2 text-sm text-fg-tertiary">{t('common:loading', { defaultValue: 'Loading…' })}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="integrations-error" className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-sm text-red-600">
        {t('settings:integrations.loadFailed', { defaultValue: 'Failed to load integrations' })}: {error}
      </div>
    );
  }

  return (
    <div data-testid="instances-section" className="space-y-4">
      <p className="text-xs text-fg-tertiary">
        {t('settings:instances.subtitle', {
          defaultValue:
            'Each bot is an instance: its own credentials, its own agent, its own chats. A platform can host several.',
        })}
      </p>

      {platformIds.map((platform) => {
        const group = groups.find((g) => g.platform === platform);
        const list = group?.instances ?? [];
        return (
          <div key={platform} data-testid={`platform-group-${platform}`} className="space-y-2">
            <div className="flex items-center gap-2">
              <PlatformIcon id={platform} />
              <span className="text-xs font-semibold text-fg-secondary uppercase tracking-wider">
                {platformLabelOf(platform)}
              </span>
              {list.length > 0 && (
                <span className="text-[11px] text-fg-tertiary" data-testid={`platform-bot-count-${platform}`}>
                  {t('settings:instances.botCount', { defaultValue: '{{count}} bot(s)', count: list.length })}
                </span>
              )}
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => startAdd(platform)}
                data-testid={`add-bot-${platform}`}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-brand-600 border border-brand-500/30 rounded-lg hover:bg-brand-500/10 transition-colors"
              >
                + {t('settings:instances.addBot.label', { defaultValue: 'Add bot' })}
              </button>
            </div>

            {adding === platform && (
              <InstanceCard
                instance={draftInstance(
                  platforms.find((p) => p.id === platform) ?? {
                    id: platform,
                    label: platformLabelOf(platform),
                    capabilities: { inbound: false, outbound: false, threads: false },
                    fields: [],
                    defaultEnabled: false,
                    enabled: false,
                    connected: false,
                    hasConfig: false,
                    values: {},
                    secrets: {},
                  },
                )}
                client={client}
                extras={extras}
                loadAgents={loadAgents}
                onChanged={reload}
                onCreated={() => setAdding(null)}
                defaultExpanded
              />
            )}

            {list.map((instance) => (
              <InstanceCard
                key={instance.id}
                instance={instance}
                client={client}
                extras={extras}
                loadAgents={loadAgents}
                onChanged={reload}
                defaultExpanded={defaultExpanded}
              />
            ))}

            {list.length === 0 && adding !== platform && (
              <p className="text-[11px] text-fg-tertiary pl-7" data-testid={`platform-empty-${platform}`}>
                {t('settings:instances.noBots', { defaultValue: 'No bots yet.' })}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
