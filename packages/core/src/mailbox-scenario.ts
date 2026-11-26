/**
 * DR6 — which TURN SHAPE a mailbox signal produces.
 *
 * Why this file exists: this mapping used to be eight hand-written
 * `scenario: '...'` literals scattered through the dispatch switch in
 * `agent.ts#processMailboxItemCore`, one per `case`. But "a `review_request`
 * produces a review turn" is a fact about the SIGNAL TYPE, not about the caller
 * that happened to dispatch it — so eight copies is eight writers of one fact,
 * and the first one to drift is silent.
 *
 * The failure this prevents is not cosmetic: `scenario` selects the capability
 * pack, i.e. the agent's tool set. A wrong literal ships the wrong tools with no
 * error and no red test. There is a recorded instance of exactly that class:
 * a background completion dispatched as `heartbeat` produced the reflex pack,
 * which has no `file_write`/`file_edit`/`shell_execute`, so the task could not
 * be continued — only announced.
 *
 * Scope, measured rather than assumed (2026-11-15): there are 21 `scenario:`
 * literals in agent.ts. Eight of them are this dispatch table; the other
 * thirteen are genuine path facts (`_executeTaskInternal` IS a task execution,
 * `handleHeartbeat` IS a heartbeat) and are deliberately NOT routed through here
 * — a path that knows its own shape is not a duplicated mapping.
 *
 * Types absent from the table keep the caller's existing default. That is
 * intentional: this file is authoritative for the eight it knows, and invents
 * nothing for the rest.
 */
import type { MailboxItemType } from '@markus/shared';
import type { AgentScenario } from './agent.js';

/**
 * Signal type -> turn shape.
 *
 * Every entry must be justified by the dispatch case that consumes it; an entry
 * with no `case` is exactly the kind of declaration this refactor exists to stop.
 * `mailbox-scenario.test.ts` pins the table against the dispatch source so the two
 * cannot drift.
 */
export const MAILBOX_TYPE_SCENARIO: Partial<Record<MailboxItemType, AgentScenario>> = {
  // A human message IS a chat turn — the shape follows from the signal, not from
  // whichever entry point happened to enqueue it. Stated here so `sendMessage`
  // does not have to invent a default (it used to leave `scenario` undefined and
  // let `handleMessage` guess `'chat'` for *any* type, which made a forgotten
  // scenario indistinguishable from a human message).
  human_chat: 'chat',
  // Agent-to-agent traffic is a conversational turn, whichever envelope carries it
  // (`a2a_message` and a `mention` are the same shape — both arrive as `a2a`).
  a2a_message: 'a2a',
  mention: 'a2a',
  // Governance signals get their own packs so they can carry the matching tool set.
  requirement_update: 'requirement_action',
  requirement_comment: 'comment_response',
  task_comment: 'comment_response',
  workflow_update: 'workflow_action',
  review_request: 'review',
  // Dream runs must never be dispatched as a chat turn: the reflex pack is what
  // keeps a consolidation from wandering off into the conversation.
  memory_consolidation: 'memory_consolidation',
};

/**
 * The turn shape for a signal type, or `undefined` when the type is not part of
 * this mapping (the caller then states its own path fact).
 *
 * Overloaded so that a **literal** type in the table yields a definite
 * `AgentScenario` — inside a `switch (item.sourceType) { case 'task_comment': … }`
 * TypeScript narrows the type to the literal, so `mailboxScenario(item.sourceType)`
 * is total there and no `?? default` is needed. Only a genuinely unknown string
 * gets `| undefined`, which forces the caller to decide rather than inherit a
 * human-chat-shaped default.
 */
export function mailboxScenario<K extends keyof typeof MAILBOX_TYPE_SCENARIO>(type: K): AgentScenario;
export function mailboxScenario(type: string | undefined): AgentScenario | undefined;
export function mailboxScenario(type: string | undefined): AgentScenario | undefined {
  if (!type) return undefined;
  return MAILBOX_TYPE_SCENARIO[type as MailboxItemType];
}
