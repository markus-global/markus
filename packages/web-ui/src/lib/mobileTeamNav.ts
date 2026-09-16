/**
 * Mobile Team navigation rules, kept pure so they are testable without a DOM
 * (this package has no jsdom).
 *
 * The Team tab on mobile is a three-layer machine driven by the URL hash:
 *   L1 roster  #team
 *   L2 detail  #team/t/<teamId>
 *   L3 chat    #team/d
 *
 * Two behaviours used to be decided inline in `Team.tsx` and were wrong:
 *
 * 1. The L3 back button restored *whatever page you came from*
 *    (`mobileBackHashRef`). Entering an agent from Notifications or Home made
 *    Back return there, so tapping "Team" again re-opened the same agent and
 *    Back escaped again — you could never reach L1/L2. Back from a conversation
 *    must always land on its parent layer.
 * 2. The parent was assumed to exist. Pointing Back at a deleted team
 *    reproduces the blank-L2 failure, so the team must be verified against the
 *    loaded team list before being used as a destination.
 */

/** The `group:<teamId>` channel key used for team channels (they have no group_chats row). */
export function teamChannelKey(teamId: string): string {
  return `group:${teamId}`;
}

export interface MobileChatBackInput {
  chatMode: string;
  /** Owning team of the agent being chatted with (`chatMode === 'direct'`). */
  agentTeamId?: string | null;
  /** Owning team of the channel (`chatMode === 'channel'`). */
  channelTeamId?: string | null;
  /** Teams currently loaded — the only teams that can render an L2. */
  knownTeamIds: Iterable<string>;
}

/**
 * Resolve the hash the L3 back button should navigate to.
 *
 * Returns the parent layer only:
 *  - `#team/t/<teamId>` when the conversation belongs to a team that is
 *    currently loaded (L2),
 *  - otherwise `#team` (L1 roster), which is always safe.
 *
 * Deliberately never returns a non-Team page: escaping to wherever the user came
 * from is what made Back feel random, and re-entering Team then looped.
 */
export function resolveMobileChatBackHash(input: MobileChatBackInput): string {
  const { chatMode, agentTeamId, channelTeamId, knownTeamIds } = input;

  const candidateTeamId = chatMode === 'direct'
    ? agentTeamId
    : chatMode === 'channel'
      ? channelTeamId
      : null;

  if (candidateTeamId) {
    const known = knownTeamIds instanceof Set
      ? knownTeamIds.has(candidateTeamId)
      : Array.from(knownTeamIds).includes(candidateTeamId);
    // Only aim at an L2 we can actually draw — a stale team id must fall back
    // to L1 rather than the blank "team missing" frame.
    if (known) return `team/t/${candidateTeamId}`;
  }

  return 'team';
}
