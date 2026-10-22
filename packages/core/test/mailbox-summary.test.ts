import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { summarizeForMailbox, isLossySummary, mergeCountOf, bumpMergeCount, displayLabelOf } from '../src/mailbox-summary.js';

/**
 * Regression suite for the 2026-10-22 incident: a 383-char owner message was
 * represented to a downstream reader by its 100-char prefix, which ended
 * exactly on a `"""` fence and therefore read as a complete — and empty —
 * message. The agent answered a question it had never read.
 */

// The 100-char `payload.summary` that was actually published for the incident
// (read back from mailbox_items). The first assertion pins our fixture to it, so
// this suite cannot drift away from the real payload.
const INCIDENT_LEGACY_SUMMARY = [
  '[terminal-selection]',
  'Terminal: Terminal (term_mvjl59p5_0_u1o03)',
  'Cwd: /Users/liuqian/mycode/markus',
  '""',
].join('\n');

// The exact body from mailbox_items.payload.content of the incident. Built by
// prefixing the REAL published summary (below) so the fixture cannot drift from
// what the platform actually sent.
const INCIDENT_CONTENT = [INCIDENT_LEGACY_SUMMARY + '"', 'git status', 'On branch main'].concat([
  "Your branch is up to date with 'origin/main'.",
  '',
  'nothing to commit, working tree clean',
  'liuqian@Mac ~/m/markus (main)> ls scripts/quick-release.sh',
  'scripts/quick-release.sh*',
  'liuqian@Mac ~/m/markus (main)> ls RELEASELOG.md',
  'RELEASELOG.md',
  '"""',
  '',
  '已经合并了。创建一个新的rc版本吧。',
]).join('\n');

describe('summarizeForMailbox — truncation must be self-evident', () => {
  it('reproduces the incident: the old 100-char prefix was silently incomplete', () => {
    const legacy = INCIDENT_CONTENT.slice(0, 100);
    // Fixture check — the published summary is a prefix of the real message and
    // ends on the OPENING fence.
    expect(INCIDENT_CONTENT.startsWith(INCIDENT_LEGACY_SUMMARY)).toBe(true);
    expect(INCIDENT_LEGACY_SUMMARY.trimEnd().endsWith('""')).toBe(true);
    expect(legacy.length).toBe(100);
    // It ends INSIDE the opening fence (`""`), so it reads as a finished chip
    // with an empty body: the worst possible thing to hand a reader as "the
    // message". Measured on the real payload: 100 chars, last line `""`.
    expect(legacy).toBe(INCIDENT_LEGACY_SUMMARY);
    expect(legacy.endsWith('""')).toBe(true);
    expect(legacy.endsWith('"""')).toBe(false);
    expect(INCIDENT_CONTENT.length).toBeGreaterThan(legacy.length);
  });

  it('never publishes a bare prefix: a lossy excerpt carries the omitted count', () => {
    const summary = summarizeForMailbox(INCIDENT_CONTENT);
    expect(isLossySummary(summary)).toBe(true);
    expect(summary).toMatch(/…\[\+\d+ chars omitted\]$/);
    // The reader can no longer mistake it for the finished message.
    expect(summary).not.toBe(INCIDENT_CONTENT.slice(0, 100));
    // One line only — a multi-line payload cannot masquerade as "the message".
    expect(summary.includes('\n')).toBe(false);
  });

  it('keeps the head readable and preserves the count of what was dropped', () => {
    const summary = summarizeForMailbox(INCIDENT_CONTENT, 60);
    const omitted = Number(/…\[\+(\d+) chars omitted\]$/.exec(summary)![1]);
    const single = INCIDENT_CONTENT.replace(/\s+/g, ' ').trim();
    expect(summary.startsWith(single.slice(0, 60).trimEnd())).toBe(true);
    expect(omitted).toBe(single.length - single.slice(0, 60).trimEnd().length);
  });

  it('leaves short messages byte-identical (no marker pollution)', () => {
    const short = 'push，提交PR。commit内容和PR都应该用英文';
    expect(summarizeForMailbox(short)).toBe(short);
    expect(isLossySummary(summarizeForMailbox(short))).toBe(false);
  });

  it('leaves a message exactly at the limit unchanged', () => {
    const atLimit = 'a'.repeat(100);
    expect(summarizeForMailbox(atLimit)).toBe(atLimit);
    expect(isLossySummary(summarizeForMailbox(atLimit))).toBe(false);
  });

  it('collapses multi-line content but does not mark it lossy when nothing was cut', () => {
    const multi = '第一行\n第二行\n\n第三行';
    const summary = summarizeForMailbox(multi);
    expect(summary).toBe('第一行 第二行 第三行');
    expect(isLossySummary(summary)).toBe(false);
  });

  it('is never in a third state: identical-or-marked, for every input', () => {
    const cases = [
      '',
      '  ',
      'short',
      'a'.repeat(99),
      'a'.repeat(100),
      'a'.repeat(101),
      INCIDENT_CONTENT,
      '\n\n\n',
      'x\n'.repeat(80),
    ];
    for (const input of cases) {
      const summary = summarizeForMailbox(input);
      const single = input.replace(/\s+/g, ' ').trim();
      const identical = summary === single;
      expect(identical || isLossySummary(summary)).toBe(true);
      if (!identical) expect(isLossySummary(summary)).toBe(true);
    }
  });
});

describe('merge count — structure lives in metadata, never in the display string', () => {
  it('counts folded items from metadata', () => {
    const item = { sourceType: 'a2a_message', payload: { content: 'a' }, metadata: { mergeCount: 3 } };
    expect(mergeCountOf(item)).toBe(3);
    expect(displayLabelOf(item)).toContain('(+3)');
  });

  it('still recovers the count from rows persisted before metadata.mergeCount existed', () => {
    // No migration: legacy rows carry the fold count as a `(+N)` suffix. Reading
    // it as a fallback keeps stored data usable; writing it that way is banned.
    const legacy = { sourceType: 'a2a_message', payload: { content: 'Msg', summary: 'Msg (+2)' } };
    expect(mergeCountOf(legacy)).toBe(2);
  });

  it('prefers metadata over a stale legacy suffix', () => {
    const item = { sourceType: 'a2a_message', payload: { content: 'Msg', summary: 'Msg (+1)' }, metadata: { mergeCount: 5 } };
    expect(mergeCountOf(item)).toBe(5);
  });

  it('bumpMergeCount writes metadata and leaves the display string untouched', () => {
    const item: { sourceType: string; payload: { content: string; summary: string }; metadata?: { mergeCount?: number } } = {
      sourceType: 'a2a_message',
      payload: { content: 'Msg', summary: 'Msg' },
    };
    bumpMergeCount(item);
    bumpMergeCount(item);
    expect(item.metadata?.mergeCount).toBe(2);
    expect(item.payload.summary).toBe('Msg');
  });
});

describe('no source file may rebuild a silent prefix copy', () => {
  /**
   * The bug was expressible because four call sites wrote
   * `summary: userMessage.slice(0, 100)` by hand. A single writer
   * (`summarizeForMailbox`) removes the shape; this guard catches a future
   * fifth copy that would bring the silent truncation back.
   */
  it('core/src contains no hand-rolled `summary: <msg>.slice(0, N)`', () => {
    const root = new URL('../src', import.meta.url).pathname;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith('.ts')) continue;
        const text = readFileSync(full, 'utf8');
        const re = /summary:\s*\w+\.slice\(\s*0\s*,\s*\d+\s*\)/g;
        for (const m of text.match(re) ?? []) offenders.push(`${full}: ${m}`);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
