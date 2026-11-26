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
import i18n from '../i18n/index.ts';

const REFRESH_MS = 15000;

/**
 * `work_units.ref` → 人话。
 *
 * 用户看不懂 `delegation:session:cs_abc:r127#sub_1794…_aj4ylb`，而这串 id 唯一
 * 对开发者有用。所以列表显标签与轮次，原文只放在 `title` 里（hover 才看得到）。
 *
 * 纯函数、可单测：同一个 ref 在列表与 tooltip 里不会给出两种说法。
 */
export interface WorkUnitLabel {
  /** 主标签：做了什么类型的事 */
  label: string;
  /** 次信息：第几轮 / 哪个子任务（没有就是 undefined） */
  detail?: string;
}

export function describeWorkUnitRef(ref: string): WorkUnitLabel {
  const round = /:r(\d+)/.exec(ref)?.[1];
  const roundText = round ? i18n.t('work:task.executionRound', { n: round }) : undefined;
  if (ref.startsWith('delegation:')) {
    const isSub = ref.includes('#sub_');
    return {
      label: isSub
        ? i18n.t('agent:profilePage.overview.workUnit.subDelegation')
        : i18n.t('agent:profilePage.overview.workUnit.delegation'),
      detail: roundText,
    };
  }
  if (ref.startsWith('task:')) {
    return { label: i18n.t('agent:profilePage.overview.workUnit.task'), detail: roundText };
  }
  if (ref.startsWith('requirement:')) {
    return { label: i18n.t('agent:profilePage.overview.workUnit.requirement'), detail: roundText };
  }
  if (ref.startsWith('channel')) {
    return { label: i18n.t('agent:profilePage.overview.workUnit.channel'), detail: roundText };
  }
  if (ref.startsWith('session:')) {
    return { label: i18n.t('agent:profilePage.overview.runningInternal'), detail: roundText };
  }
  // 未知形状：不编造标签，如实说是哪个字头。
  const head = ref.split(':')[0] ?? ref;
  return { label: head || i18n.t('agent:profilePage.overview.workUnit.unknown'), detail: roundText };
}

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
          {units.map((u) => {
            const { label, detail } = describeWorkUnitRef(u.ref);
            // 轮次与 used/budget 是内部记账：`0/75` 看起来像「进度 0%」，实际只是
            // 「这一轮还没调过工具」。两者对用户都不可执行，所以走 hover，不占视觉位置。
            const tip = [
              u.ref,
              detail,
              u.budget !== null && u.budget > 0 ? `${u.used}/${u.budget}` : undefined,
            ].filter(Boolean).join(' · ');
            return (
              <li key={u.ref} className="flex items-center gap-2" title={tip}>
                <span className="truncate">{label}</span>
                {u.internal && (
                  <span className="rounded bg-brand-500/15 px-1 text-[10px] text-brand-300">
                    {t('agent:profilePage.overview.runningInternal')}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
