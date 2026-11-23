/**
 * C10-C — autonomy axis: ONE predicate, ONE consumer, witnessed.
 *
 * Rebuild of the #462 axis that #464 physically deleted (plan §0.1 fact 2).
 * Design SSOT: docs/design/c10-c-trust-boundary-2026-11-23.md §1, §4.
 *
 * Three load-bearing assertions:
 *   1. truth table — only 'observe' blocks; undefined/dirty values fail OPEN to
 *      the old behavior (a new field must not stall existing agents); a ceiling
 *      can only TIGHTEN, never lift an 'observe' agent.
 *   2. single consumer — exactly one call site of maySelfInitiate( in
 *      packages/*\/src (the forever-loop patrol admission in core/agent.ts).
 *      Seeding a second call site turns this file red on purpose.
 *   3. witness — the declaration registry names the predicate as the reader;
 *      deleting the consumer while keeping the declaration is the fossil case
 *      declarations-witness.test.ts exists for.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maySelfInitiate } from '../src/types/agent.js';
import { DECLARATIONS } from '../src/declarations.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

/** All backend+frontend source files under packages/*\/src (no tests, no dist). */
function collectSrcFiles(): string[] {
  const out: string[] = [];
  const packagesDir = join(REPO_ROOT, 'packages');
  for (const pkg of readdirSync(packagesDir)) {
    const srcDir = join(packagesDir, pkg, 'src');
    let st;
    try { st = statSync(srcDir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        const full = join(dir, entry);
        const s = statSync(full);
        if (s.isDirectory()) walk(full);
        else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
      }
    };
    walk(srcDir);
  }
  return out;
}

describe('maySelfInitiate — truth table (fail-open by design, ceiling only tightens)', () => {
  it("'observe' blocks self-initiation", () => {
    expect(maySelfInitiate('observe')).toBe(false);
  });

  it("'act' allows self-initiation", () => {
    expect(maySelfInitiate('act')).toBe(true);
  });

  it('undefined / dirty historical values fail OPEN to act (no silent stall)', () => {
    expect(maySelfInitiate(undefined)).toBe(true);
    expect(maySelfInitiate('')).toBe(true);
    expect(maySelfInitiate('some-legacy-dirty-value')).toBe(true);
  });

  it("ceiling 'observe' caps an 'act' agent (verified=false trust cap)", () => {
    expect(maySelfInitiate('act', 'observe')).toBe(false);
    expect(maySelfInitiate(undefined, 'observe')).toBe(false);
  });

  it('ceiling can only TIGHTEN — it never lifts an observe agent', () => {
    expect(maySelfInitiate('observe', 'act')).toBe(false);
    expect(maySelfInitiate('observe', undefined)).toBe(false);
  });

  it("no ceiling / ceiling 'act' leaves the axis unchanged", () => {
    expect(maySelfInitiate('act', undefined)).toBe(true);
    expect(maySelfInitiate('act', 'act')).toBe(true);
  });
});

describe('single consumer guard (seed a second call site → red)', () => {
  it('exactly ONE call site of maySelfInitiate( in packages/*/src, in core/agent.ts', () => {
    const definitionFile = join(REPO_ROOT, 'packages/shared/src/types/agent.ts');
    const callSites: Array<{ file: string; count: number }> = [];
    for (const file of collectSrcFiles()) {
      if (file === definitionFile) continue; // the definition itself is not a consumer
      const text = readFileSync(file, 'utf8');
      const matches = text.match(/\bmaySelfInitiate\s*\(/g);
      if (matches && matches.length > 0) {
        callSites.push({ file: relative(REPO_ROOT, file), count: matches.length });
      }
    }
    const total = callSites.reduce((n, c) => n + c.count, 0);
    expect(total).toBe(1);
    expect(callSites).toHaveLength(1);
    expect(callSites[0]!.file).toBe(join('packages', 'core', 'src', 'agent.ts'));
    expect(callSites[0]!.count).toBe(1);
  });
});

describe('declaration witness (the axis is registered, not a fossil)', () => {
  it("DECLARATIONS['agent.autonomyLevel'] names maySelfInitiate as its reader", () => {
    const entry = (DECLARATIONS as Record<string, { kind: string; witness: { type: string; at: string } }>)['agent.autonomyLevel'];
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('param');
    expect(entry!.witness.type).toBe('reader');
    expect(entry!.witness.at).toBe('maySelfInitiate');
  });
});