import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DECLARATIONS, declarationDebt, type Declaration } from '../src/declarations.js';

/**
 * Witness enforcement for the declaration registry.
 *
 * Four rules, each mapping to a real failure we have had:
 *   1. a declaration with no witness at all  → nobody can say what consumes it;
 *   2. a witness that cannot be found in the source → the "consumer" was deleted
 *      and the declaration stayed (the fossil case);
 *   3. `onExceed: 'act'` with no trigger/writer → we claim to act but nothing acts
 *      (the 111%-banner case);
 *   4. an unwitnessed entry without a reason or with an expired `removeBy`
 *      → debt parked forever, which is how a registry rots into documentation.
 */

const REPO_ROOT = resolve(__dirname, '../../..');
const SCAN_ROOTS = ['packages', 'scripts'];

function collectSource(): string {
  const chunks: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git' || entry === 'dist-electron') {
        continue;
      }
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|mjs|js)$/.test(entry)) {
        try {
          chunks.push(readFileSync(full, 'utf8'));
        } catch {
          /* unreadable file: skip, it cannot witness anything */
        }
      }
    }
  };
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root));
  return chunks.join('\n');
}

const SOURCE = collectSource();
const ENTRIES = Object.entries(DECLARATIONS) as Array<[string, Declaration]>;

describe('declaration witness registry', () => {
  it('the registry itself is non-empty (an empty registry proves nothing)', () => {
    expect(ENTRIES.length).toBeGreaterThan(0);
  });

  it('rule 1: every declaration carries a witness', () => {
    for (const [key, d] of ENTRIES) {
      expect(d.witness, `${key} has no witness`).toBeDefined();
      expect(['trigger', 'writer', 'reader', 'none']).toContain(d.witness.type);
    }
  });

  it('rule 2: a witnessed declaration points at code that actually exists', () => {
    for (const [key, d] of ENTRIES) {
      if (d.witness.type === 'none') continue; // debt: the consumer is the thing that is missing
      expect(
        SOURCE.includes(d.witness.at),
        `${key}: witness "${d.witness.at}" not found anywhere in packages/ or scripts/ — ` +
          'the consumer was probably deleted while the declaration stayed',
      ).toBe(true);
    }
  });

  it("rule 3: 'act' limits are witnessed by something that acts", () => {
    for (const [key, d] of ENTRIES) {
      if (d.kind !== 'limit' || d.onExceed !== 'act') continue;
      expect(
        ['trigger', 'writer'],
        `${key} claims onExceed:'act' but its witness is "${d.witness.type}" — nothing acts`,
      ).toContain(d.witness.type);
    }
  });

  it('rule 4: unwitnessed debt must be explained and dated', () => {
    const now = Date.now();
    for (const [key, d] of ENTRIES) {
      if (d.witness.type !== 'none') continue;
      expect(d.reason, `${key} has no witness and no reason`).toBeTruthy();
      expect((d.reason ?? '').length, `${key}: reason too short to be useful`).toBeGreaterThan(20);
      expect(d.removeBy, `${key} has no witness and no removeBy date`).toBeTruthy();
      const deadline = Date.parse(d.removeBy as string);
      expect(Number.isNaN(deadline), `${key}: removeBy is not a date`).toBe(false);
      expect(deadline, `${key}: removeBy ${d.removeBy} is in the past — pay the debt or re-justify`).toBeGreaterThan(now);
    }
  });

  it('declarationDebt() reports exactly the unwitnessed entries', () => {
    const debt = declarationDebt();
    expect(debt.length).toBe(ENTRIES.filter(([, d]) => d.witness.type === 'none').length);
    expect(debt.every((d) => d.reason.length > 0 && d.removeBy.length > 0)).toBe(true);
  });
});
