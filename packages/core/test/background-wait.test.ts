/**
 * `background_wait` — the result of a background command BELONGS to the turn
 * that launched it.
 *
 * Defect background: every completion re-entered as a fresh attention cycle
 * (full context re-injection, scenario re-decided, ~53k tokens / 0 tools /
 * HEARTBEAT_OK measured per redundant callback). The fix lets the launching
 * turn await the result in-band; consuming it suppresses the separate
 * completion turn in BOTH orderings (wait-before-exit resolves the registry
 * entry; exit-before-wait marks the result consumed for the queued item).
 *
 * These tests run REAL processes — no fixture can lie about exit timing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  createBackgroundExecTool,
  createBackgroundWaitTool,
  createProcessTool,
  wasBackgroundResultConsumed,
} from '../src/tools/process-manager.js';
import { pendingCallbackRegistry } from '../src/pending-callback.js';

const exec = createBackgroundExecTool();
const wait = createBackgroundWaitTool();
const proc = createProcessTool();

const tracked: string[] = [];
/** Simulate what the agent does at launch: register lineage in the durable store. */
function register(id: string): void {
  pendingCallbackRegistry.register({
    id, agentId: 'agt_wait_test', originSessionId: 'sess_w', type: 'background_exec',
    originScenario: 'task_execution', registeredAt: Date.now(), timeoutMs: 600_000,
  });
  tracked.push(id);
}

async function launch(command: string, timeoutSeconds = 30): Promise<string> {
  const r = JSON.parse(await exec.execute({ command, timeout_seconds: timeoutSeconds }));
  expect(r.status).toBe('running');
  return r.sessionId as string;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

afterEach(async () => {
  for (const id of tracked) pendingCallbackRegistry.resolve(id);
  tracked.length = 0;
  const list = JSON.parse(await proc.execute({ action: 'list' }));
  for (const s of list.sessions ?? []) {
    if (s.running) await proc.execute({ action: 'kill', sessionId: s.id });
  }
  await sleep(150);
  await proc.execute({ action: 'clear' });
});

describe('background_wait — in-turn result delivery', () => {
  it('returns a finished result as a normal tool result and consumes it (exit-before-wait)', async () => {
    const id = await launch('echo hello');
    register(id);
    await sleep(200); // let it exit first — the bus already fired
    const r = JSON.parse(await wait.execute({ session_ids: [id], timeout_ms: 5000 }));
    expect(r.status).toBe('success');
    expect(r.results[0].status).toBe('completed');
    expect(r.results[0].exitCode).toBe(0);
    expect(r.results[0].stdout).toContain('hello');
    // Consumed: the queued completion item will be skipped at processing time.
    expect(wasBackgroundResultConsumed(id)).toBe(true);
    expect(pendingCallbackRegistry.get(id)).toBeUndefined();
  });

  it('awaits a still-running process and closes the pending question (wait-before-exit)', async () => {
    const id = await launch('sleep 0.3; echo done');
    register(id);
    const r = JSON.parse(await wait.execute({ session_ids: [id], timeout_ms: 5000 }));
    expect(r.results[0].status).toBe('completed');
    expect(r.results[0].stdout).toContain('done');
    expect(wasBackgroundResultConsumed(id)).toBe(true);
    // Registry resolved → the completion bus finds no lineage → no delivery.
    expect(pendingCallbackRegistry.get(id)).toBeUndefined();
  });

  it('timeout keeps the notification: running sessions stay registered and unconsumed', async () => {
    const id = await launch('sleep 5');
    register(id);
    const r = JSON.parse(await wait.execute({ session_ids: [id], timeout_ms: 150 }));
    expect(r.results[0].status).toBe('running');
    expect(r.hint).toBeDefined();
    expect(wasBackgroundResultConsumed(id)).toBe(false);
    expect(pendingCallbackRegistry.get(id)).toBeDefined();
  });

  it('process poll/log on a FINISHED session consumes it (no duplicate turn)', async () => {
    const idPoll = await launch('sleep 0.2; echo p');
    const idLog = await launch('sleep 0.2; echo l');
    register(idPoll);
    register(idLog);
    await sleep(500);
    const p = JSON.parse(await proc.execute({ action: 'poll', sessionId: idPoll }));
    expect(p.running).toBe(false);
    expect(wasBackgroundResultConsumed(idPoll)).toBe(true);
    expect(pendingCallbackRegistry.get(idPoll)).toBeUndefined();
    const l = JSON.parse(await proc.execute({ action: 'log', sessionId: idLog }));
    expect(l.stdout).toContain('l');
    expect(wasBackgroundResultConsumed(idLog)).toBe(true);
  });

  it('process clear cannot erase the consumption evidence', async () => {
    const id = await launch('echo bye');
    await wait.execute({ session_ids: [id], timeout_ms: 5000 });
    await proc.execute({ action: 'clear' });
    // A queued callback item may still be waiting — dedupe must outlive the session entry.
    expect(wasBackgroundResultConsumed(id)).toBe(true);
  });

  it('waits for multiple sessions under one shared deadline', async () => {
    const a = await launch('sleep 0.2; echo A');
    const b = await launch('sleep 0.2; echo B');
    const r = JSON.parse(await wait.execute({ session_ids: [a, b], timeout_ms: 5000 }));
    expect(r.results.map((x: { status: string }) => x.status)).toEqual(['completed', 'completed']);
    expect(wasBackgroundResultConsumed(a)).toBe(true);
    expect(wasBackgroundResultConsumed(b)).toBe(true);
  });

  it('unknown id → not_found; invalid args → error; duplicate ids are deduped', async () => {
    const nf = JSON.parse(await wait.execute({ session_ids: ['bg_nope'], timeout_ms: 100 }));
    expect(nf.results[0].status).toBe('not_found');
    expect(JSON.parse(await wait.execute({ session_ids: [] })).status).toBe('error');
    expect(JSON.parse(await wait.execute({ session_ids: 'x' })).status).toBe('error');
    const id = await launch('echo dup');
    const r = JSON.parse(await wait.execute({ session_ids: [id, id], timeout_ms: 5000 }));
    expect(r.results).toHaveLength(1);
  });
});
