/**
 * Regression: the "thinking…" row after posting a comment must name the agents
 * the SERVER woke — not a locally guessed set.
 *
 * The bug this guards: mentions arrive as agent IDs, but the old renderer
 * matched them against agent **names**, so the lookup always missed and the
 * guess fell back to the task creator. The human mentioned agent B and saw
 * agent A ("created this task") under "thinking…".
 */
import { describe, it, expect } from 'vitest';
import { agentsFromIds } from './commentThinking.ts';

const AGENTS = [
  { id: 'agt_creator', name: 'Creator' },
  { id: 'agt_mentioned', name: 'Mentioned', avatarUrl: '/a.png' },
];

describe('agentsFromIds', () => {
  it('renders exactly the agents the server woke', () => {
    expect(agentsFromIds(['agt_mentioned'], AGENTS)).toEqual([
      { id: 'agt_mentioned', name: 'Mentioned', avatarUrl: '/a.png' },
    ]);
  });

  it('never invents an entry for an unknown id', () => {
    expect(agentsFromIds(['agt_ghost'], AGENTS)).toEqual([]);
  });

  it('deduplicates and preserves server order', () => {
    expect(agentsFromIds(['agt_creator', 'agt_creator', 'agt_mentioned'], AGENTS).map(a => a.id))
      .toEqual(['agt_creator', 'agt_mentioned']);
  });

  it('shows nothing when the server woke nobody (unlike the old creator guess)', () => {
    expect(agentsFromIds(undefined, AGENTS)).toEqual([]);
    expect(agentsFromIds([], AGENTS)).toEqual([]);
  });
});
