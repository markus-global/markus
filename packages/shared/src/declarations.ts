/**
 * Declaration → Witness registry.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The platform is full of *declarations*: a budget constant, a policy flag, a
 * guard field, a config property, a table. Each one is supposed to be consumed
 * by real code — a trigger, a writer, a reader, a UI. When that consumer
 * disappears and the declaration does not, nothing breaks: it compiles, the
 * tests stay green, and the only symptom is an alarm that can never turn off,
 * or a flag that describes a producer that no longer exists.
 *
 * Three real examples this registry was created for (see
 * `docs/design/c8-residual-mechanisms-2026-11-15.md`):
 *   - a 15 000-char budget with zero action consumers, announced by a banner
 *     that claims auto-archiving is happening (it is not);
 *   - a `triageStaleDrop` policy for a mailbox type whose producer was
 *     switched off, kept alive only by a test that wanted a non-empty list;
 *   - a deferred-persist call gated *behind* the event it is supposed to
 *     record, so the table can never remember the first run.
 *
 * RULE: a declaration either names a witness, or says in writing why it has
 * none and when it dies. `declarations-witness.test.ts` enforces four things:
 *   1. every entry has a witness;
 *   2. `witness.at` must be findable in the source tree (no phantom consumers);
 *   3. a `limit` that claims `onExceed: 'act'` must be witnessed by a trigger
 *      or a writer — "we act on it" requires something that acts;
 *   4. an unwitnessed entry needs `reason` AND a future `removeBy` — debt may be
 *      declared, never parked forever.
 *
 * This is deliberately a *plain data table* rather than a framework. The point
 * is that adding a budget/policy/guard without registering it fails a test.
 */

export type DeclarationKind = 'limit' | 'policy' | 'guard' | 'object' | 'param';

/** Who consumes the declaration. `none` is a debt, not a category. */
export type WitnessType = 'trigger' | 'writer' | 'reader' | 'none';

export interface DeclarationWitness {
  type: WitnessType;
  /**
   * A symbol or file:marker that must exist in the source tree. The test greps
   * for this string; keep it a real identifier (function/class/const name) or a
   * `path/to/file.ts` path, never a comment fragment.
   */
  at: string;
}

export interface Declaration {
  kind: DeclarationKind;
  /** Where the declaration itself lives, `path:SYMBOL`. Documentation only. */
  declaredAt: string;
  witness: DeclarationWitness;
  /** Only meaningful for `kind === 'limit'`: what happens when it is exceeded. */
  onExceed?: 'act' | 'report';
  /** Required when `witness.type === 'none'`: why it is allowed to have none. */
  reason?: string;
  /** Required when `witness.type === 'none'`: ISO date by which it must die. */
  removeBy?: string;
  /** Free-form note for the next reader. Keep it to one line. */
  note?: string;
}

/**
 * The registry. Adding a budget/policy/guard anywhere in the platform without
 * adding it here (or vice versa: leaving an entry after deleting the consumer)
 * is what the test is for.
 */
export const DECLARATIONS = {
  // ── Memory budgets ──────────────────────────────────────────────────────
  'memory.curatedSoftBudget': {
    kind: 'limit',
    declaredAt: 'packages/shared/src/limits.ts:MEMORY_MD_CURATED_MAX_CHARS',
    // SETTLED (2026-11-15, DR5): this is the CURATED REGION's soft size and it is
    // report-only BY DESIGN — it never was an injection ceiling, and treating it as
    // one is what produced the "111% injected" alarm on a turn carrying 6691 chars.
    // Its reader is `getMemoryHealth()`, which reports it as `curatedPercent`. The
    // injection ceiling is a separate declaration (memory.injectedKnowledgeCap).
    witness: { type: 'reader', at: 'getMemoryHealth' },
    onExceed: 'report',
    note: 'Region size on disk, report-only. The injection budget is memory.injectedKnowledgeCap.',
  },
  'memory.curatedHardBudget': {
    kind: 'limit',
    declaredAt: 'packages/shared/src/limits.ts:MEMORY_MD_CURATED_HARD_MAX_CHARS',
    witness: { type: 'writer', at: 'writeKnowledgeMd' },
    onExceed: 'act',
    note: 'Write is refused above this. The refusal IS the action.',
  },
  'memory.observationBudget': {
    kind: 'limit',
    declaredAt: 'packages/shared/src/limits.ts:MEMORY_OBSERVATIONS_MAX_CHARS',
    witness: { type: 'trigger', at: 'shouldRunDreamCycle' },
    onExceed: 'act',
    note: 'dream is the action consumer; this one is real.',
  },
  'memory.dreamTriggerPercent': {
    kind: 'policy',
    declaredAt: 'packages/shared/src/limits.ts:MEMORY_DREAM_TRIGGER_PERCENT',
    witness: { type: 'trigger', at: 'shouldRunDreamCycle' },
    note: 'Compares observationPercent only. Do not reuse it for curated region pressure.',
  },
  'memory.injectedKnowledgeCap': {
    kind: 'limit',
    declaredAt: 'packages/shared/src/limits.ts:SYSTEM_KNOWLEDGE_CHARS',
    witness: { type: 'writer', at: 'prepareKnowledgeForPrompt' },
    onExceed: 'act',
    note: 'The injector truncates to this; it is the real injection ceiling (not 15000).',
  },

  // ── Mailbox ─────────────────────────────────────────────────────────────
  'mailbox.queuedTtl': {
    kind: 'limit',
    declaredAt: 'packages/shared/src/limits.ts:MAILBOX_QUEUED_TTL_MS',
    witness: { type: 'trigger', at: 'purgeStaleItems' },
    onExceed: 'act',
  },
  'mailbox.triageStaleInfoTtl': {
    kind: 'limit',
    declaredAt: 'packages/shared/src/limits.ts:TRIAGE_STALE_INFO_TTL_MS',
    witness: { type: 'trigger', at: 'purgeStaleItems' },
    onExceed: 'act',
  },
  'mailbox.heartbeatTriageStaleDrop': {
    kind: 'policy',
    declaredAt: 'packages/shared/src/types/mailbox.ts:MAILBOX_TYPE_REGISTRY.heartbeat',
    // SETTLED (2026-11-15, H7): no longer a fossil, because producibility became a
    // COLUMN of the same table. `triageStaleDropTypes(mode)` derives the droppable
    // set per channel, so a type the active channel cannot produce is never
    // droppable there. The type is deliberately KEPT: legacy rows already in the
    // mailbox must stay readable, so retiring the type would strand live data.
    witness: { type: 'reader', at: 'triageStaleDropTypes' },
    note: 'heartbeat is producedBy: [legacy] only; clock-mode triage never sees it. Rows already on disk remain readable by design.',
  },

  // ── Wakeups / triggers ──────────────────────────────────────────────────
  'trigger.eventSource': {
    kind: 'param',
    declaredAt: 'packages/core/src/trigger.ts:TriggerEvent',
    // SETTLED (2026-11-15, H4). The original reason said "no producer emits
    // TriggerEvent" -- that was already stale when checked: mailbox.ts emits
    // mailbox:new-item from six enqueue paths and agent.ts subscribes to it. The
    // real gap was the OTHER end: dispatch matched, logged, and emitted
    // trigger:matched onto a bus with no production listener, so a declared wait was
    // satisfied on paper while the agent carried on. wakeForTriggerMatch() is now the
    // consumer that actually delivers the turn.
    witness: { type: 'trigger', at: 'wakeForTriggerMatch' },
    note: 'Producer: mailbox:new-item. Consumer: wakeForTriggerMatch(). Sweep still covers timeout only.',
  },
  'agent.scenarioIsDeclared': {
    kind: 'param',
    declaredAt: 'packages/core/src/agent.ts:scenario',
    // SETTLED (2026-11-15, DR6). Measured before changing: 21 scenario literals, not
    // the 34 the design doc claimed. Eight of them were a duplicated mapping between
    // signal type and turn shape and now live in mailbox-scenario.ts. The other
    // thirteen are genuine PATH facts (dreamConsolidateMemory IS a consolidation,
    // handleHeartbeat IS a heartbeat) and are meant to stay inline -- a path that
    // knows its own shape is not a second writer.
    witness: { type: 'reader', at: 'mailboxScenario' },
    note: 'Signal-driven shapes come from MAILBOX_TYPE_SCENARIO; path facts stay inline by design.',
  },
} as const satisfies Record<string, Declaration>;

export type DeclarationKey = keyof typeof DECLARATIONS;

/** Entries that admit they have no consumer. Kept as a helper for reporting. */
export function declarationDebt(): Array<{ key: DeclarationKey; reason: string; removeBy: string }> {
  return (Object.entries(DECLARATIONS) as Array<[DeclarationKey, Declaration]>)
    .filter(([, d]) => d.witness.type === 'none')
    .map(([key, d]) => ({ key, reason: d.reason ?? '', removeBy: d.removeBy ?? '' }));
}
