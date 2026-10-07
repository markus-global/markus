/**
 * H21 — residue repair for the retired whole-file compressor.
 *
 * The old `compressLongTermMemory()` scanned the WHOLE knowledge file, so a `## ` heading
 * inside a stored observation / conversation fragment was mistaken for a curated section:
 * its body was COPIED into `knowledge-archive.md` and replaced IN PLACE by a pointer stub
 * (`_[archived → …]_`). H13 stopped the bleeding; H20 wrote the first one-time repair — but
 * it only walked the observation/fragment ENTRY pools, so the same stub left in the
 * **curated region** (the part that is injected into every prompt) was never healed: an
 * agent's live knowledge showed an empty section with a pointer line where its content
 * used to be. Measured on the live org: 65 such curated stubs across 25 agents.
 *
 * This module is the single, pure implementation of the repair. It is deliberately
 * deterministic and conservative:
 *   • a stub is healed from the archived body **only when exactly ONE archived section
 *     carries the owning heading's name**;
 *   • a duplicate name (ambiguity) or a missing name ⇒ the stub is left untouched and
 *     REPORTED. The repair never guesses which body belonged there;
 *   • the archive copy is kept (copy-back, not move), so the operation can never lose
 *     data and is trivially reversible;
 *   • it is idempotent: with no stubs left it is a no-op.
 *
 * Pure by design (no fs, no logger) so the rules can be tested directly.
 */

/** The exact pointer line the retired compressor left behind. */
export const ARCHIVE_STUB_SENTINEL = '_[archived →';

export function isArchiveStub(line: string): boolean {
  return /^\s*_\[archived →/.test(line);
}

/** name → archived bodies. Length > 1 means the name is ambiguous. */
export function indexArchiveBodies(archiveText: string): Map<string, string[]> {
  const bodies = new Map<string, string[]>();
  if (!archiveText) return bodies;
  // A section starts at a `## ` line at the beginning of a line.
  for (const part of archiveText.split(/\n(?=## )/)) {
    const m = part.match(/^## (.+)\n?/);
    if (!m) continue;
    const name = (m[1] ?? '').trim();
    if (!name || name === '_observations' || name === '_session_fragments') continue;
    const body = part.slice(m[0].length).trim();
    if (!body) continue;
    const arr = bodies.get(name);
    if (arr) arr.push(body);
    else bodies.set(name, [body]);
  }
  return bodies;
}

export interface StubHealResult {
  /** Number of stub lines replaced by their archived body. */
  repaired: number;
  /** Stubs whose owning name matched MORE THAN ONE archived section — left untouched. */
  ambiguous: Array<{ name: string; candidates: number }>;
  /** Stubs whose owning name matched no archived section — left untouched. */
  notFound: string[];
}

function emptyResult(): StubHealResult {
  return { repaired: 0, ambiguous: [], notFound: [] };
}

/**
 * The heading that OWNS a stub is the nearest non-blank line above it, skipping
 * serialization meta comments (`<!-- … -->`) and other stubs. That lookback is what makes
 * an entry stub work at all: the writer emits `### <id>` / `<!-- type: … -->` / body, so a
 * stub inside a body has the meta comment — not the heading — directly above it.
 */
function nearestHeadingName(lines: string[], i: number): string | null {
  for (let j = i - 1; j >= 0; j--) {
    const s = (lines[j] ?? '').trim();
    if (!s) continue;
    if (s.startsWith('<!--')) continue;
    if (isArchiveStub(s)) continue;
    return s.replace(/^#+\s*/, '').trim();
  }
  return null;
}

/**
 * Heal every stub in `text`. Works for the curated region, for one entry's content, or for
 * one fragment's content — the rule is purely line-local. Returns the (possibly rewritten)
 * text plus a structured result so callers can report what could NOT be resolved.
 */
export function healStubLines(
  text: string,
  bodies: Map<string, string[]>,
): { text: string; result: StubHealResult } {
  const result = emptyResult();
  if (!text || bodies.size === 0 || !text.includes(ARCHIVE_STUB_SENTINEL)) {
    return { text, result };
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!isArchiveStub(lines[i] ?? '')) continue;
    const name = nearestHeadingName(lines, i);
    if (!name) {
      result.notFound.push('(no heading above stub)');
      continue;
    }
    const candidates = bodies.get(name);
    if (!candidates || candidates.length === 0) {
      result.notFound.push(name);
      continue;
    }
    if (candidates.length > 1) {
      result.ambiguous.push({ name, candidates: candidates.length });
      continue;
    }
    lines[i] = candidates[0] as string;
    result.repaired += 1;
  }
  return { text: lines.join('\n'), result };
}

/** Merge a per-blob result into aggregate accumulators (deduped, stable order). */
export function accumulateResidue(
  into: { ambiguous: Map<string, number>; notFound: Set<string> },
  from: StubHealResult,
): void {
  for (const a of from.ambiguous) {
    into.ambiguous.set(a.name, Math.max(into.ambiguous.get(a.name) ?? 0, a.candidates));
  }
  for (const n of from.notFound) into.notFound.add(n);
}
