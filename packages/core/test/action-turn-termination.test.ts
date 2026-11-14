/**
 * Regression fence for the "action turn can never end" bug (2026-11-14).
 *
 * Root cause was NOT the mandatory-action wording: `end_turn` was missing from
 * `REQ_ACTION_TOOLS`, so a turn that legitimately decided "nothing needs to
 * change" could never satisfy the requirement or the reminder interceptor —
 * the only lawful exit was closed. Every attempt to stop got pushed back, which
 * is why sessions ran 33 and 166 rounds with finishReason=tool_use on every
 * call (evidence: ~/.markus/llm-logs/2026-11-14.jsonl).
 *
 * The fix is one concept: make `end_turn` a legal action and say what it is for.
 * The musts stay — an event still has to reach a disposition, just not
 * necessarily a *mutation*.
 *
 * Source-text assertions on purpose: the artifact under test is the prompt text
 * and the membership of the action-tool set.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = (file: string) => readFileSync(resolve(here, '../src', file), 'utf8');

describe('an action turn has a lawful way to end', () => {
  const agent = src('agent.ts');
  const engine = src('context-engine.ts');

  it('end_turn is a legal action (not only a mutation tool)', () => {
    const reqActionTools = agent.match(/REQ_ACTION_TOOLS = \[([^\]]+)\]/)?.[1] ?? '';
    expect(reqActionTools).toContain("'end_turn'");
    expect(reqActionTools).toContain("'requirement_comment'");
  });

  it('the reminder names end_turn as an exit without inventing a count limit', () => {
    expect(agent).toContain('nothing needs to change, call `end_turn` instead');
    expect(agent).toContain('records the decision');
    // "exactly one thing" was wrong: an event can legitimately need several
    // actions (create tasks + update status + comment). The constraint is on the
    // *disposition* (act or explicitly end), not on the number of tool calls.
    expect(agent).not.toContain('exactly one thing');
  });

  it('the requirement prompt lists "nothing needs to change" as a valid outcome', () => {
    expect(engine).toContain('**Nothing needs to change**: call `end_turn`');
  });

  it('the obligation itself is NOT weakened — a disposition is still required', () => {
    // The musts must survive: this bug was a missing exit, not a missing duty.
    expect(engine).toContain('MUST call at least one action tool');
    expect(agent).toContain('WITHOUT taking any action');
  });

  it('every scenario whose prompt names end_turn actually offers it in its allow-list', () => {
    // The allow-list is authoritative: agent.ts filters the LLM tool schema by it,
    // so a tool named in the prompt but missing here is an unsatisfiable must.
    const packs = src('capability-packs.ts');
    for (const name of [
      'COMMENT_RESPONSE_ALLOWED_TOOLS',
      'REQUIREMENT_ACTION_ALLOWED_TOOLS',
      'WORKFLOW_ACTION_ALLOWED_TOOLS',
    ]) {
      const block = packs.slice(packs.indexOf(`export const ${name}`));
      const body = block.slice(0, block.indexOf('];'));
      expect(body, `${name} must offer end_turn`).toContain("'end_turn'");
    }
  });
});
