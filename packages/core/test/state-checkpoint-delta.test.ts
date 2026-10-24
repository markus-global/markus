/**
 * The state checkpoint must carry the CHANGE, not a fresh copy of everything.
 *
 * Measured before this fix (real sessions in ~/.markus/agents/*\/sessions):
 *   task_tsk_…_r1        565 msgs · 1,902k chars · 82 checkpoints = 1,417k (74%)
 *   sess_1789818195130   616 msgs · 1,186k chars · 108 checkpoints =   836k (70%)
 *   channel_dm:a2a:…     726 msgs · 1,251k chars · 21 checkpoints =   837k (67%)
 *
 * One changed attention-state line re-wrote every section of the state, so the
 * same fact existed in dozens of copies — the exact shape that makes a long run
 * expensive while telling the agent nothing new.
 *
 * A delta is lossless: each section body is always COMPLETE, so the newest
 * occurrence of a section is authoritative and older ones add nothing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextEngine } from '../src/context-engine.js';
import { MemoryStore } from '../src/memory/store.js';
import type { LLMMessage } from '@markus/shared';

let dir: string;
let memory: MemoryStore;
let engine: ContextEngine;

const MARK_A = 'SECTION-A-BODY';
const MARK_B = 'SECTION-B-BODY';

const state = (a: string, b: string) => `## Section A\n${a}\n## Section B\n${b}`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'markus-ckpt-'));
  memory = new MemoryStore(dir);
  engine = new ContextEngine();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function pack(sessionId: string, volatileState: string): Promise<void> {
  const history: LLMMessage[] = [{ role: 'user', content: 'do the thing' }];
  await engine.prepareMessages({
    systemPrompt: 'sys',
    sessionMessages: history,
    memory,
    sessionId,
    modelContextWindow: 1_000_000,
    modelMaxOutput: 32_000,
    volatileState,
  });
}

function checkpoints(sessionId: string): string[] {
  return memory
    .getRecentMessages(sessionId, 500)
    .filter((m) => typeof m.content === 'string' && m.content.startsWith('[SYSTEM] [State checkpoint]'))
    .map((m) => String(m.content));
}

describe('state checkpoint is a delta, not a snapshot', () => {
  it('the first delivery still carries the whole state (nothing to diff against)', async () => {
    const session = memory.createSession('agt_ckpt');
    await pack(session.id, state(`${MARK_A} ${'a'.repeat(4000)}`, `${MARK_B} ${'b'.repeat(4000)}`));

    const cks = checkpoints(session.id);
    expect(cks).toHaveLength(1);
    expect(cks[0]).toContain(MARK_A);
    expect(cks[0]).toContain(MARK_B);
  });

  it('a change in ONE section appends only that section', async () => {
    const session = memory.createSession('agt_ckpt');
    const bodyA = `${MARK_A} ${'a'.repeat(4000)}`;

    await pack(session.id, state(bodyA, `${MARK_B} ${'b'.repeat(4000)}`));
    // Only Section B changes.
    await pack(session.id, state(bodyA, `${MARK_B}-v2 ${'b'.repeat(4000)}`));

    const cks = checkpoints(session.id);
    expect(cks).toHaveLength(2);

    const delta = cks[1]!;
    expect(delta).toContain(MARK_B);       // the change is there
    expect(delta).not.toContain(MARK_A);   // the unchanged 4KB section is NOT repeated
  });

  it('the delta is an order of magnitude smaller than a full snapshot', async () => {
    const session = memory.createSession('agt_ckpt');
    const bodyA = `${MARK_A} ${'a'.repeat(4000)}`;

    await pack(session.id, state(bodyA, `${MARK_B} ${'b'.repeat(4000)}`));
    await pack(session.id, state(bodyA, `${MARK_B}-v2 ${'b'.repeat(4000)}`));

    const [full, delta] = checkpoints(session.id);
    expect(delta!.length).toBeLessThan(full!.length * 0.6);
  });

  it('writes no checkpoint at all when nothing changed', async () => {
    const session = memory.createSession('agt_ckpt');
    const vol = state(`${MARK_A} ${'a'.repeat(2000)}`, `${MARK_B} ${'b'.repeat(2000)}`);

    await pack(session.id, vol);
    await pack(session.id, vol);

    expect(checkpoints(session.id)).toHaveLength(1);
  });

  it('a new section appearing is delivered on its own (no silent drop)', async () => {
    const session = memory.createSession('agt_ckpt');
    const bodyA = `${MARK_A} ${'a'.repeat(2000)}`;
    const bodyB = `${MARK_B} ${'b'.repeat(2000)}`;

    await pack(session.id, state(bodyA, bodyB));
    await pack(session.id, `${state(bodyA, bodyB)}\n## Section C\nSECTION-C-BODY ${'c'.repeat(2000)}`);

    const cks = checkpoints(session.id);
    expect(cks).toHaveLength(2);
    expect(cks[1]).toContain('SECTION-C-BODY');
    expect(cks[1]).not.toContain(MARK_A);
    expect(cks[1]).not.toContain(MARK_B);
  });
});
