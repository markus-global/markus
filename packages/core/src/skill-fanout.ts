/**
 * Skill update mailbox fanout — LEARNING-LOOP §6
 */

export interface FanoutCandidate {
  agentId: string;
  roleSkills: string[];
  roleTags: string[];
}

export function matchAgentsForSkillFanout(
  skillTags: string[],
  candidates: FanoutCandidate[],
): string[] {
  const tags = new Set(skillTags.map((t) => t.toLowerCase()));
  if (tags.size === 0) return candidates.map((c) => c.agentId);
  return candidates
    .filter((c) => {
      const hay = [...c.roleSkills, ...c.roleTags].map((x) => x.toLowerCase());
      return hay.some((h) => tags.has(h) || [...tags].some((t) => h.includes(t)));
    })
    .map((c) => c.agentId);
}

/** Cap to 1 notification per agent per day (merge multiples). */
export function applyFanoutDailyCap(
  agentIds: string[],
  alreadyNotifiedToday: Set<string>,
): string[] {
  return agentIds.filter((id) => !alreadyNotifiedToday.has(id));
}
