/**
 * "Who is thinking?" after posting a task/requirement comment.
 *
 * The renderer used to answer this itself: match each @mention against the
 * agent list **by display name**, then also add the task's assignee and its
 * creator. Mentions travel as agent **ids**, so the name lookup never matched;
 * the result was that the agent the human actually @-mentioned never appeared,
 * while the task creator was shown as "thinking…" — a confidently wrong
 * statement, which is worse than showing nothing.
 *
 * The only authority is the server: `postTaskComment` / `postRequirementComment`
 * report the agents they actually enqueued a notification for, and the renderer
 * displays exactly that list. Never re-derive it locally.
 */

export interface AgentIdentity {
  id: string;
  name: string;
  avatarUrl?: string;
}

/** Map the server's `notifiedAgentIds` to displayable agents (unknown ids dropped). */
export function agentsFromIds(
  ids: string[] | undefined,
  agents: AgentIdentity[],
): AgentIdentity[] {
  if (!ids || ids.length === 0) return [];
  const byId = new Map(agents.map(a => [a.id, a]));
  const out: AgentIdentity[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const a = byId.get(id);
    if (a) out.push({ id: a.id, name: a.name, avatarUrl: a.avatarUrl });
  }
  return out;
}
