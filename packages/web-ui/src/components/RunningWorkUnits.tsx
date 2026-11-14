/**
 * C8-E —「在跑」的唯一权威来源：`work_units`。
 *
 * 这个组件存在的理由是一个真实事故（2026-11-14）：Owner 看到 agent 「还在干活」，
 * 但「运行与注意力」页面一个进行中的 session 都看不到。原因：页面在自己派生
 * 「进行中」，而 `agent_activities` 里积了一批 `ended_at` 永远为 NULL 的僵尸回合，
 * 内存注册表又在重启后清零 —— 两套口径都不对。
 *
 * 权威对象只有 `work_units.status='running'`（+ claimed_by / lease_until）。
 * 本组件**只读它**：不读 activity、不读 mailbox、不读内存注册表。
 * 内部 session（requirement_* / channel_dm:* / session:*）也会显示 —— 那正是
 * 「我在干活但页面是空的」要修的部分。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, type AgentWorkUnitRow } from '../api.ts';
import { useTranslation } from 'react-i18next';

const REFRESH_MS = 15000;

export function RunningWorkUnits({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const [units, setUnits] = useState<AgentWorkUnitRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.agents.workUnits(agentId, 'running');
      setUnits(res.units);
      setFailed(false);
    } catch {
      // 读不到就说读不到，不要拿旧值冒充当前状态。
      setFailed(true);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);

  if (failed) {
    return <div className="text-xs text-fg-tertiary">{t('agent:profilePage.overview.runningUnavailable')}</div>;
  }
  if (!units) return null;

  return (
    <div className="text-xs text-fg-secondary space-y-1">
      <div className="font-medium">
        {t('agent:profilePage.overview.runningTitle')}
        {' '}
        <span className="tabular-nums">{units.length}</span>
      </div>
      {units.length === 0 ? (
        <div className="text-fg-tertiary">{t('agent:profilePage.overview.runningNone')}</div>
      ) : (
        <ul className="space-y-0.5">
          {units.map((u) => (
            <li key={u.ref} className="flex items-center gap-2">
              <span className="truncate max-w-[16rem]" title={u.ref}>{u.ref}</span>
              {u.internal && (
                <span className="rounded bg-brand-500/15 px-1 text-[10px] text-brand-300">
                  {t('agent:profilePage.overview.runningInternal')}
                </span>
              )}
              {u.claimedBy && <span className="text-fg-tertiary">@{u.claimedBy.slice(0, 10)}</span>}
              {u.budget !== null && (
                <span className="text-fg-tertiary tabular-nums">{u.used}/{u.budget}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
