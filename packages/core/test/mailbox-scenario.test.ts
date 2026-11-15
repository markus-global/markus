import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAILBOX_TYPE_SCENARIO, mailboxScenario } from '../src/mailbox-scenario.js';

/**
 * DR6 — the signal-type -> turn-shape mapping must have exactly one writer.
 *
 * `scenario` selects the capability pack, i.e. the agent's tool set. A wrong
 * literal ships the wrong tools with no error: the recorded instance of this
 * class is a background completion dispatched as `heartbeat`, which produced the
 * reflex pack (no file_write / file_edit / shell_execute) so the task could only
 * be announced, never continued.
 *
 * These tests pin BOTH directions:
 *   - every table entry describes a real dispatch case (no declaration without a consumer);
 *   - every dispatch case that used to hold a literal is served by the table
 *     (no consumer whose fact lives somewhere else).
 */

const AGENT_SRC = readFileSync(join(import.meta.dirname, '../src/agent.ts'), 'utf-8');

describe('DR6 — mailbox signal type -> turn shape', () => {
  it('answers only from the table, and invents nothing for unknown types', () => {
    expect(mailboxScenario('review_request')).toBe('review');
    expect(mailboxScenario('a2a_message')).toBe('a2a');
    // A type the table does not know keeps the caller's default; returning a
    // guessed value here is what would silently ship a wrong tool set.
    expect(mailboxScenario('task_status_update')).toBeUndefined();
    expect(mailboxScenario(undefined)).toBeUndefined();
    expect(mailboxScenario('')).toBeUndefined();
  });

  it('every entry names a type that really is dispatched in agent.ts', () => {
    // A table entry with no `case` is the fossil this refactor exists to prevent:
    // it reads as live policy to every future reader while no such item can arrive.
    for (const type of Object.keys(MAILBOX_TYPE_SCENARIO)) {
      expect(
        AGENT_SRC.includes(`case '${type}'`) || AGENT_SRC.includes(`'${type}'`),
        `table declares "${type}" but agent.ts never dispatches it`,
      ).toBe(true);
    }
  });

  it('the eight dispatch sites read the table instead of holding literals', () => {
    // The duplication that existed: eight hand-written `scenario: '...'` literals
    // in `processMailboxItemCore`'s switch, one per case. They now go through
    // `mailboxScenario(item.sourceType)`.
    //
    // Deliberately NOT asserted as "no scenario literal anywhere in agent.ts":
    // thirteen other literals are genuine PATH facts (`dreamConsolidateMemory` IS
    // a consolidation, `handleHeartbeat` IS a heartbeat). A path that knows its own
    // shape is not a duplicated mapping, and banning them outright would pressure
    // someone to route them through the table for no reason.
    const dispatchReads = AGENT_SRC.match(/mailboxScenario\(item\.sourceType\)/g) ?? [];
    expect(dispatchReads.length).toBe(8);
  });

  it('the mapping is total over the types that produce an LLM turn', () => {
    // The four turn-producing governance signals must each resolve, otherwise a
    // dispatch falls back to the caller default and the agent silently gets the
    // conversational pack instead of its governance pack.
    for (const type of ['requirement_update', 'requirement_comment', 'task_comment', 'workflow_update'] as const) {
      expect(mailboxScenario(type), `${type} lost its turn shape`).toBeTruthy();
    }
  });
});
