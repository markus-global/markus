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

export const AGENT_TABS: MainTab[] = ['chat', 'overview', 'files', 'tools', 'memory', 'deliverables'];
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
