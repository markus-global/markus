import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { ModelSelect, type ModelOption } from './ModelSelect';

interface Props {
  configuredProviders: Array<{ name: string; displayName?: string; model: string; models?: Array<{ id: string; name: string }> }>;
}

interface Row {
  id: string;
  name: string;
  teamId?: string;
  /** Current per-agent default, "provider/model" or null when following global. */
  override: string | null;
  llmConfig: { modelMode?: string; primary: string; defaultModel?: string };
}

interface TeamRef {
  id: string;
  name: string;
}

interface Group {
  key: string;
  label: string;
  rows: Row[];
}

/**
 * "Agent default model" management section for the Settings > Model page.
 * Lets the user bind each agent to a specific provider+model (that agent's
 * per-agent default) or reset it to follow the global default. Mirrors the
 * JSON shape that the chat composer "Apply to current agent" writes, so both
 * entry points stay consistent. Agents are grouped by team (same grouping as
 * the Team chat roster) so related agents stay together visually.
 */
export function PerAgentModelSection({ configuredProviders }: Props) {
  const { t } = useTranslation('settings');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [teams, setTeams] = useState<TeamRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const providerKey = useMemo(
    () => configuredProviders.map(p => `${p.name}:${p.models?.length ?? 0}`).sort().join(','),
    [configuredProviders],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const [{ agents }, teamData] = await Promise.all([
        api.agents.list(),
        api.teams.list(),
      ]);
      const teamRefs = teamData.teams.map(tm => ({ id: tm.id, name: tm.name }));
      setTeams(teamRefs);
      const data = await Promise.all(
        agents.map(async a => {
          try {
            const detail = await api.agents.get(a.id);
            const lc = detail.config?.llmConfig;
            return {
              id: a.id,
              name: a.name || a.id,
              teamId: a.teamId,
              override:
                lc?.modelMode === 'custom' && lc.primary && lc.defaultModel
                  ? `${lc.primary}/${lc.defaultModel}`
                  : null,
              llmConfig: { modelMode: lc?.modelMode, primary: lc?.primary ?? '', defaultModel: lc?.defaultModel },
            } as Row;
          } catch {
            return { id: a.id, name: a.name || a.id, teamId: a.teamId, override: null, llmConfig: { modelMode: 'default', primary: '', defaultModel: undefined } } as Row;
          }
        }),
      );
      setRows(agents.length ? data : null);
    } catch (e) {
      setError(String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerKey]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load, providerKey]);

  const modelOptions: ModelOption[] = useMemo(() => {
    const opts: ModelOption[] = [];
    for (const p of configuredProviders) {
      for (const m of p.models ?? []) {
        opts.push({ provider: p.name, providerLabel: p.displayName ?? p.name, modelId: m.id, modelName: m.name ?? m.id });
      }
    }
    return opts;
  }, [configuredProviders]);

  const setOverride = async (agentId: string, value: string | null) => {
    setSavingId(agentId);
    setError(null);
    try {
      if (value) {
        const [provider, model] = [value.slice(0, value.lastIndexOf('/')), value.slice(value.lastIndexOf('/') + 1)];
        await api.agents.updateConfig(agentId, {
          llmConfig: { modelMode: 'custom', primary: provider, defaultModel: model },
        });
      } else {
        await api.agents.updateConfig(agentId, {
          llmConfig: { modelMode: 'default', primary: '', defaultModel: undefined },
        });
      }
      setRows(prev => prev?.map(r => (r.id === agentId ? { ...r, override: value } : r)) ?? prev);
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingId(null);
    }
  };

  // Group rows by team (teams follow the teams list order; agents without a
  // team go into an "Ungrouped" bucket FIRST so loose agents stay visible,
  // before falling back to any team ids missing from the teams list).
  const groups: Group[] = useMemo(() => {
    if (!rows) return [];
    const byTeam = new Map<string, Row[]>();
    const ungrouped: Row[] = [];
    for (const r of rows) {
      if (r.teamId) {
        const arr = byTeam.get(r.teamId) ?? [];
        arr.push(r);
        byTeam.set(r.teamId, arr);
      } else {
        ungrouped.push(r);
      }
    }
    const out: Group[] = [];
    if (ungrouped.length) out.push({ key: 'ungrouped', label: t('perAgentModel.ungrouped', { defaultValue: 'Ungrouped' }), rows: ungrouped });
    for (const tm of teams) {
      const teamRows = byTeam.get(tm.id);
      if (teamRows?.length) out.push({ key: `team:${tm.id}`, label: tm.name, rows: teamRows });
    }
    // Any teams that exist in agent.teamId but weren't in the teams list.
    for (const [teamId, teamRows] of byTeam) {
      if (!teams.some(tm => tm.id === teamId)) {
        out.push({ key: `team:${teamId}`, label: teamId, rows: teamRows });
      }
    }
    return out;
  }, [rows, teams, t]);

  if (rows === null && !error) {
    return (
      <div className="bg-surface-elevated rounded-xl p-5 text-sm text-fg-tertiary">
        {t('common:loading', { defaultValue: 'Loading…' })}
      </div>
    );
  }

  return (
    <div className="bg-surface-elevated rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">{t('perAgentModel.title', { defaultValue: 'Per-agent default model' })}</div>
          <div className="text-xs text-fg-tertiary mt-0.5">
            {t('perAgentModel.desc', {
              defaultValue: 'Bind a specific provider+model to an agent, or leave it following the global default. This is what the composer "Apply to current agent" writes.',
            })}
          </div>
        </div>
      </div>

      {error && <div className="text-xs text-red-500">{error}</div>}

      {(!rows || rows.length === 0) && !error && (
        <div className="text-xs text-fg-tertiary">{t('perAgentModel.noAgents', { defaultValue: 'No agents available.' })}</div>
      )}

      {rows && rows.length > 0 && (
        <div className="space-y-5">
          {groups.map(g => (
            <div key={g.key}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-tertiary truncate">{g.label}</span>
                <span className="text-[10px] text-fg-tertiary/70 tabular-nums shrink-0">{g.rows.length}</span>
              </div>
              <div className="space-y-2">
                {g.rows.map(r => (
                  <div key={r.id} className="flex items-center justify-between gap-3 text-sm">
                    <div className="flex-1 truncate">
                      <span className="font-medium">{r.name}</span>
                      <span className="text-xs text-fg-tertiary ml-2 truncate">{r.id}</span>
                    </div>
                    <div className="flex items-center gap-2 w-[320px]">
                      {r.override ? (
                        <>
                          <ModelSelect
                            value={r.override}
                            options={modelOptions}
                            placeholder={t('perAgentModel.followGlobal', { defaultValue: 'Follow global' })}
                            onChange={v => void setOverride(r.id, v || null)}
                          />
                          <button
                            type="button"
                            disabled={savingId === r.id}
                            onClick={() => void setOverride(r.id, null)}
                            className="shrink-0 px-2.5 py-1.5 text-xs border border-border-default rounded-lg hover:bg-surface-base disabled:opacity-40 transition-colors"
                          >
                            {t('perAgentModel.reset', { defaultValue: 'Reset' })}
                          </button>
                        </>
                      ) : (
                        <ModelSelect
                          value=""
                          options={modelOptions}
                          placeholder={t('perAgentModel.followGlobal', { defaultValue: 'Follow global' })}
                          onChange={v => void setOverride(r.id, v || null)}
                        />
                      )}
                      {savingId === r.id && (
                        <span className="shrink-0 text-[10px] text-fg-tertiary">{t('common:loading', { defaultValue: '…' })}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}