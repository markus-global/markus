/**
 * Shared startup contract for agent tests.
 *
 * `start()` is a lifecycle reset AND a wake: it enqueues the `[RESTARTED]`
 * system event, because coming up is semantically the same as a rest window
 * ending (Owner, 2026-11-16). So the agent has real work the moment it is up.
 *
 * Two consequences every suite must handle the same way — hence one helper
 * rather than a bespoke wait per test:
 *
 *  1. Asserting `idle` at the instant `start()` resolves tests a snapshot of a
 *     race, not the contract. The contract is that the agent SETTLES to idle
 *     once that startup turn ends.
 *  2. The startup turn consumes LLM calls. A test whose subject is a LATER turn
 *     must let startup settle and then clear its recorder, or every
 *     "the Nth call" index is shifted by one.
 *
 * Never swallows a failure: if the agent does not settle, the caller's own
 * assertion goes red.
 */
export async function startSettled(
  agent: { start(): Promise<unknown>; getState(): { status: string } },
): Promise<void> {
  await agent.start();
  const deadline = Date.now() + 8000;
  while (agent.getState().status !== 'idle' && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 20));
  }
}
