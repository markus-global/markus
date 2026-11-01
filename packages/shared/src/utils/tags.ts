/**
 * Turn "whatever is stored in a tag column" into a `string[]`.
 *
 * ## Why this file exists
 *
 * Columns like `requirements.tags` are declared `TEXT NOT NULL DEFAULT '[]'`:
 * the contract is *a JSON-encoded string array*. Every consumer then reads
 * `req.tags` as `string[]` — `.join(', ')`, `.map(tag => …)`. That is the right
 * assumption to make, because it is the type in `Requirement.tags`.
 *
 * The problem is that `JSON.parse(v) as string[]` **cannot fail**. It happily
 * returns whatever the payload happens to be, so a row written by a sloppier
 * writer reaches the renderer as a `string` or an object, and the blind cast
 * hides that fact until the first `.join()`.
 *
 * Three encodings were found in a real database (2026-11, all 387 rows scanned):
 *
 *   `["a","b"]`              ← the contract
 *   `"a,b"`                  ← a writer that stringified a comma-joined string
 *   `{"item":["a","b"]}`     ← a writer that stringified an object wrapper
 *
 * The blast radius is not a cosmetic glitch: `('a,b').join` throws a TypeError
 * during render, React 18 unmounts the whole tree (no boundary above it), and
 * the user gets a blank page — from one row of tag data.
 *
 * ## The rule this enforces
 *
 * The shape is decided **once**, where a stored payload becomes a typed domain
 * value (storage read). Downstream code keeps assuming `string[]`, so the
 * invariant has one implementation instead of an `Array.isArray` guard at every
 * call site.
 *
 * Coercion — not rejection — is deliberate here: the only information a bad
 * payload carries is *which* tags the writer meant, and all three encodings say
 * so unambiguously. Dropping them would lose data.
 *
 * ## Compatibility (old users, no manual step)
 *
 * This runs on **read**. Existing databases keep their bytes untouched: an old
 * row reads correctly whether or not anything has rewritten it, and a row that
 * is re-saved through the normal write path comes back in the canonical
 * encoding. Nothing bulk-rewrites user data.
 */

/** Recover the tag list from `["a","b"]`, `"a,b"`, `{"item":["a","b"]}`, or raw text. */
export function toStringArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];

  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (trimmed) out.push(trimmed);
      } else if (typeof item === 'number' || typeof item === 'boolean') {
        // A list of ids/labels sometimes arrives as numbers; they are still tags.
        out.push(String(item));
      }
    }
    return out;
  }

  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return [];
    // A JSON-looking payload is decoded first, so `"a,b"` (a quoted JSON string)
    // and `{"item":[…]}` recover their original list rather than becoming
    // one tag holding the whole payload.
    if (raw.startsWith('[') || raw.startsWith('{') || raw.startsWith('"')) {
      try {
        return toStringArray(JSON.parse(raw) as unknown);
      } catch {
        /* not valid JSON — fall through and treat it as plain text */
      }
    }
    return raw
      .split(',')
      .map(tag => tag.trim())
      .filter(Boolean);
  }

  if (typeof value === 'object') {
    // An object wrapper (`{"item":[…]}`) has exactly one array inside it; when
    // there is no such array the payload carries no tag list at all.
    const arrays = Object.values(value as Record<string, unknown>).filter(Array.isArray);
    return arrays.length === 1 ? toStringArray(arrays[0]) : [];
  }

  return [];
}
