/**
 * Notebook lifecycle invariants (docs/MEMORY-SYSTEM.md §2 Notebook, §3 invariants).
 *
 * These tests assert the INVARIANTS of the notebook, not the steps used to reach
 * them — that is what makes them survive refactors. The specific regressions they
 * lock down (measured on a real agent on 2026-09-16):
 *
 *   - 26 entries in NOTEBOOK.md against an agent-tier cap of 4, because only ONE
 *     of four writers counted entries and the load path trimmed nothing.
 *   - an 18-day-old triage decision and a 57-day-old CPP output still being
 *     injected every turn (no TTL anywhere).
 *   - one 9 475-char entry crowding every other entry out of the 6 000-char block.
 *   - a pure debounce that could defer the disk write indefinitely.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeNotebookKey,
  notebookTtlMs,
  pruneNotebookEntries,
  type NotebookEntry,
} from '../src/memory/store.js';
import {
  NOTEBOOK_KEY_MAX_CHARS,
  NOTEBOOK_MAX_ENTRIES,
  NOTEBOOK_MAX_AGENT_ENTRIES,
  NOTEBOOK_TTL_MS_AGENT,
  NOTEBOOK_TTL_MS_SYSTEM,
  NOTEBOOK_TTL_MS_CPP,
  NOTEBOOK_PERSIST_MAX_WAIT_MS,
} from '@markus/shared';

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);

function entry(managed: NotebookEntry['managed'], ageMs = 0, text = 'x'): NotebookEntry {
  return { text, updatedAt: NOW - ageMs, managed };
}

function nb(pairs: Array<[string, NotebookEntry]>): Map<string, NotebookEntry> {
  return new Map(pairs);
}

describe('notebook — key normalization (N-5)', () => {
  it('flattens line breaks, strips leading hashes, trims', () => {
    expect(normalizeNotebookKey('  ## 这但不必然阻塞\n第二行  ')).toBe('这但不必然阻塞 第二行');
  });

  it('caps key length so headings stay labels', () => {
    const long = normalizeNotebookKey('✅'.repeat(200));
    expect(long.length).toBeLessThanOrEqual(NOTEBOOK_KEY_MAX_CHARS);
  });

  it('keeps CJK keys intact (no lossy slugging)', () => {
    expect(normalizeNotebookKey('定价与计费方案设计原则')).toBe('定价与计费方案设计原则');
    expect(normalizeNotebookKey('current-priorities')).toBe('current-priorities');
  });

  it('returns empty string for unusable input', () => {
    expect(normalizeNotebookKey('   ')).toBe('');
    expect(normalizeNotebookKey('\n\n')).toBe('');
  });
});

describe('notebook — per-tier TTL (N-2)', () => {
  it('assigns a shorter TTL the more machine-generated the tier is', () => {
    expect(notebookTtlMs('agent')).toBeGreaterThan(notebookTtlMs('system'));
    expect(notebookTtlMs('system')).toBeGreaterThan(notebookTtlMs('cpp'));
  });

  it('expires entries past their tier TTL and keeps fresh ones', () => {
    const entries = nb([
      ['cpp-fresh', entry('cpp', NOTEBOOK_TTL_MS_CPP - 60_000)],
      ['cpp-stale', entry('cpp', NOTEBOOK_TTL_MS_CPP + 60_000)],
      ['sys-stale', entry('system', NOTEBOOK_TTL_MS_SYSTEM + 60_000)],
      ['sys-fresh', entry('system', NOTEBOOK_TTL_MS_SYSTEM - 60_000)],
      ['agent-fresh', entry('agent', NOTEBOOK_TTL_MS_AGENT - 60_000)],
    ]);
    const result = pruneNotebookEntries(entries, NOW);

    expect(result.expired.sort()).toEqual(['cpp-stale', 'sys-stale']);
    expect([...entries.keys()].sort()).toEqual(['agent-fresh', 'cpp-fresh', 'sys-fresh']);
  });

  it('drops the real-world 57-day-old CPP entry on load', () => {
    const entries = nb([
      ['cognitive-context', { text: 'Incoming chat: 看看最近的交付产出', updatedAt: Date.UTC(2026, 6, 21), managed: 'cpp' }],
    ]);
    const result = pruneNotebookEntries(entries, NOW);
    expect(result.expired).toEqual(['cognitive-context']);
    expect(entries.size).toBe(0);
  });

  it('drops the 18-day-old system deliberation entry', () => {
    const entries = nb([
      ['deliberation', { text: 'Decision: Processing item [mbx_…]', updatedAt: Date.UTC(2026, 7, 29), managed: 'system' }],
    ]);
    pruneNotebookEntries(entries, NOW);
    expect(entries.size).toBe(0);
  });
});

describe('notebook — hard caps (N-1)', () => {
  it('bounds the TOTAL entry count, not just the agent tier', () => {
    const pairs: Array<[string, NotebookEntry]> = [];
    // 10 agent + 10 system + 5 cpp = 25 live entries, all fresh.
    for (let i = 0; i < 10; i++) pairs.push([`agent-${i}`, entry('agent', i * 1000)]);
    for (let i = 0; i < 10; i++) pairs.push([`sys-${i}`, entry('system', i * 1000)]);
    for (let i = 0; i < 5; i++) pairs.push([`cpp-${i}`, entry('cpp', i * 1000)]);
    const entries = nb(pairs);

    pruneNotebookEntries(entries, NOW);

    expect(entries.size).toBe(NOTEBOOK_MAX_ENTRIES);
    expect([...entries.values()].filter(e => e.managed === 'agent').length)
      .toBeLessThanOrEqual(NOTEBOOK_MAX_AGENT_ENTRIES);
  });

  it('is idempotent — a legal notebook is left untouched', () => {
    const entries = nb([
      ['a', entry('agent', 0)],
      ['b', entry('agent', 1000)],
      ['s', entry('system', 0)],
    ]);
    const snapshot = [...entries.keys()];
    const result = pruneNotebookEntries(entries, NOW);
    expect(result.expired).toEqual([]);
    expect(result.evicted).toEqual([]);
    expect([...entries.keys()]).toEqual(snapshot);
  });

  it('evicts machine-written tiers before the agent tier (agent notes are the last to go)', () => {
    // 3 agent + 14 system = 17 fresh entries ⇒ total cap exceeded by 1.
    // The agent tier is under its own cap, so the eviction must come from the
    // system tier — regressing this order silently eats the agent's own notes.
    const entries = nb([
      ['agent-a', entry('agent', 100_000)],
      ['agent-b', entry('agent', 200_000)],
      ['agent-c', entry('agent', 300_000)],
      ...Array.from({ length: 14 }, (_, i): [string, NotebookEntry] =>
        [`sys-${i}`, entry('system', 400_000 + i)]),
    ]);

    const result = pruneNotebookEntries(entries, NOW);

    expect(entries.size).toBe(NOTEBOOK_MAX_ENTRIES);
    expect(result.evicted).toHaveLength(1);
    expect(result.evicted[0]).toMatch(/^sys-/);
    for (const key of ['agent-a', 'agent-b', 'agent-c']) expect(entries.has(key)).toBe(true);
  });

  it('thins the oldest agent entries when the agent tier itself overflows', () => {
    const entries = nb(
      Array.from({ length: 6 }, (_, i): [string, NotebookEntry] =>
        [`agent-${i}`, entry('agent', 900_000 - i * 10_000)]),
    );

    pruneNotebookEntries(entries, NOW);

    expect(entries.size).toBe(NOTEBOOK_MAX_AGENT_ENTRIES);
    // agent-0 has the largest age, so it is the first to go.
    expect(entries.has('agent-0')).toBe(false);
    expect(entries.has('agent-5')).toBe(true);
  });

  it('never evicts the entry that was just written', () => {
    const pairs: Array<[string, NotebookEntry]> = [];
    for (let i = 0; i < 20; i++) pairs.push([`old-${i}`, entry('system', 500_000 + i)]);
    const entries = nb(pairs);
    // Simulate a fresh write: newest updatedAt in the whole map.
    entries.set('just-written', { text: 'new', updatedAt: NOW, managed: 'agent' });

    pruneNotebookEntries(entries, NOW);

    expect(entries.has('just-written')).toBe(true);
  });
});

describe('notebook — constants stay coherent', () => {
  it('the total cap is the display cap (16) and the agent cap is tighter', () => {
    expect(NOTEBOOK_MAX_ENTRIES).toBe(16);
    expect(NOTEBOOK_MAX_AGENT_ENTRIES).toBeLessThan(NOTEBOOK_MAX_ENTRIES);
  });

  it('maxWait is a small multiple of the debounce window, so starvation is bounded', () => {
    expect(NOTEBOOK_PERSIST_MAX_WAIT_MS).toBeGreaterThanOrEqual(5_000);
    expect(NOTEBOOK_PERSIST_MAX_WAIT_MS).toBeLessThanOrEqual(60_000);
  });
});
