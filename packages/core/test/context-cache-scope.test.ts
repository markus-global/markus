/**
 * Cache-scope layout invariants — PROMPT-ENGINEERING §2.0.
 *
 * The universal block (scope U) must be BYTE-IDENTICAL for every agent in the
 * installation, because it is the single shared prefix-cache entry. Before this
 * change ROLE.md (agent-private) was emitted as the first bytes of the system
 * prompt, so the shared prefix forked at byte ~11. Measured on
 * ~/.markus/llm-logs/2026-09-16.jsonl (30 agents / 901 calls): cross-agent
 * prefix overlap was 2–3 characters out of 30k+ — i.e. ≈ 0 %.
 *
 * These tests fail against the old ordering.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContextEngine } from '../src/context-engine.js';
import { MemoryStore } from '../src/memory/store.js';
import type { RoleTemplate } from '@markus/shared';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-cache-scope-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function role(id: string, persona: string): RoleTemplate {
  return {
    id,
    name: `Role ${id}`,
    description: `Role ${id} description`,
    category: 'engineering',
    systemPrompt: persona,
    defaultSkills: [],
    heartbeatChecklist: '- Check inbox',
    defaultPolicies: [],
    builtIn: false,
  } as RoleTemplate;
}

async function build(
  roleT: RoleTemplate,
  availableSkills: Array<{ name: string; description: string; category: string }> = [],
) {
  const memory = new MemoryStore(tempDir);
  const engine = new ContextEngine({ memorySearchTopK: 3 });
  return engine.buildSystemPrompt({
    agentId: `agt_${roleT.id}`,
    agentName: roleT.name,
    role: roleT,
    memory,
    availableSkills,
  });
}

describe('cache-scope layout: the universal block is agent-invariant', () => {
  it('two different agents produce a byte-identical scope-U (first) segment', async () => {
    const a = await build(role('a', 'You are agent A, the growth marketer.'));
    const b = await build(role('b', 'You are agent B, the backend engineer.'));

    // segments[0] is the universal tier — it must not contain ANY agent bytes.
    expect(a.segments.length).toBeGreaterThan(1);
    expect(a.segments[0]!.content).toBe(b.segments[0]!.content);
    expect(a.segments[0]!.content.length).toBeGreaterThan(1000);
  });

  it('agent persona is NOT in the universal segment, and is emitted after it', async () => {
    const MARKER = 'PERSONA_MARKER_UNIQUE_XYZ';
    const r = await build(role('a', MARKER));

    expect(r.segments[0]!.content).not.toContain(MARKER);
    // …but it still reaches the model, just in the agent-scoped tier.
    expect(r.text).toContain(MARKER);

    const universalIdx = r.text.indexOf('## Tool Usage Rules');
    const personaIdx = r.text.indexOf(MARKER);
    expect(universalIdx).toBeGreaterThanOrEqual(0);
    expect(personaIdx).toBeGreaterThan(universalIdx);
  });

  it('agent policies are also agent-scoped (not in the universal segment)', async () => {
    const withPolicy = { ...role('a', 'x'), defaultPolicies: [
      { name: 'POLICY_MARKER_ABC', description: 'd', rules: ['rule one'] },
    ] } as RoleTemplate;
    const r = await build(withPolicy);

    expect(r.segments[0]!.content).not.toContain('POLICY_MARKER_ABC');
    expect(r.text).toContain('POLICY_MARKER_ABC');
  });

  it('a browser-skill difference does NOT fork the universal block', async () => {
    // The old code branched on `hasBrowserSkill` INSIDE the universal section,
    // making the install-wide shared prefix depend on one agent's skill set.
    const withSkill = await build(role('a', 'x'), [
      { name: 'chrome-devtools', description: 'browser automation', category: 'tools' },
    ]);
    const withoutSkill = await build(role('a', 'x'), []);

    expect(withSkill.segments[0]!.content).toBe(withoutSkill.segments[0]!.content);
  });

  it('two agents with different personas share a long common prefix (>60% of segment 0)', async () => {
    const a = await build(role('a', 'You are agent A.'.repeat(50)));
    const b = await build(role('b', 'You are agent B.'.repeat(50)));

    const x = a.segments[0]!.content;
    const y = b.segments[0]!.content;
    let i = 0;
    while (i < Math.min(x.length, y.length) && x[i] === y[i]) i++;
    expect(i).toBe(Math.min(x.length, y.length));
  });
});
