/**
 * tabDefs — Shared tab definitions for the Team page.
 *
 * Extracted from Team.tsx so tabLabel/tabIcon/isProfileTab and the tab lists
 * can be imported without creating a circular dependency: AgentProfile /
 * TeamProfile export the definition tables, and neither imports this file.
 * Team.tsx is the only importer (plus any future tab-aware UI).
 */
import type { TFunction } from 'i18next';
import { TAB_DEF as AGENT_TAB_DEF } from './AgentProfile.tsx';
import { TABS as TEAM_TABS } from './TeamProfile.tsx';

export type MainTab = 'chat' | 'profile'
  | 'overview' | 'mind' | 'files' | 'tools' | 'memory' | 'deliverables'
  | 'announcements' | 'norms' | 'settings';

/**
 * Agent 的 tab 只有三个：聊天 / 概览 / 产出。
 *
 * 原先 mind / files / tools / memory 各自占一个 tab（共 7 个），把选择成本推给了
 * 用户。它们现在都是概览页里默认收起的折叠分组（见 AgentProfile 的 OverviewTab
 * 与 LEGACY_TAB_SECTION）——注意是「收进概览」而不是「堆进概览」：砍 tab 本身不
 * 减少内容，只把内容换到一个更长的页面上，所以详情必须默认收起且展开才挂载。
 */
export const AGENT_TABS: MainTab[] = ['chat', 'overview', 'deliverables'];
export const TEAM_TAB_SET: MainTab[] = ['chat', 'overview', 'announcements', 'norms', 'settings'];

export function tabLabel(tab: MainTab, t: TFunction): string {
  if (tab === 'chat') return t('page.chatTitle');
  const agentDef = AGENT_TAB_DEF.find(d => d.key === tab);
  if (agentDef) return t(`agent:tabs.${tab}`);
  const teamDef = TEAM_TABS.find(d => d.key === tab);
  if (teamDef) return t(teamDef.labelKey);
  return tab;
}

export function tabIcon(tab: MainTab): string {
  if (tab === 'chat') return '💬';
  const agentDef = AGENT_TAB_DEF.find(d => d.key === tab);
  if (agentDef) return agentDef.icon;
  const teamDef = TEAM_TABS.find(d => d.key === tab);
  if (teamDef) return teamDef.icon;
  return '';
}

export function isProfileTab(tab: MainTab): boolean {
  return tab !== 'chat';
}
