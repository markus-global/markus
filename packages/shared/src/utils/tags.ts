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
 * value (storage read) and where a domain value becomes a payload (storage
 * write). Downstream code keeps assuming `string[]`, so the invariant has one
 * implementation instead of an `Array.isArray` guard at every call site.
 *
 * Coercion — not rejection — is deliberate: the only information a bad payload
 * carries is *which* tags the writer meant, and all three encodings say so
 * unambiguously. Dropping them would lose data; refusing them would turn a
 * cosmetic input mistake into a failed write.
 */

/**
 * Validate a `tags` argument **as it arrives** (MCP tool args, HTTP body) and
 * reject the wrong shape with a message the caller can act on.
 *
 * ## Why coercion at the write layer was not enough
 *
 * `toStringArray` decides what a *stored* payload means; it must stay tolerant,
 * because rows already in the database cannot be sent back. But tolerance at the
 * write end is the wrong lesson for a live caller: it turns "you filled the
 * field wrong" into silent data, and the agent never learns. The create path had
 * no check at all — every boundary did `as string[]`:
 *
 *   tool args  → `args['tags'] as string[]`          (the MCP schema is a
 *                description for the model, NOT a validator)
 *   HTTP body  → `body['tags'] as string[]`
 *   storage    → `toJSON.stringify(anything)`
 *
 * Three boundaries, zero enforcement → `"a,b"` and `{"item":[…]}` rows.
 *
 * ## The contract this enforces
 *
 * Accept an array of strings (or absence). Refuse everything else, and say
 * exactly how to re-send. The refusal is **synchronous**: the caller is still in
 * its own turn, so the correction happens immediately instead of costing a
 * follow-up round trip through a notification.
 */
export type TagsInputCheck =
  | { ok: true; tags: string[] | undefined }
  | { ok: false; error: string };

export function checkTagsInput(value: unknown, field = 'tags'): TagsInputCheck {
  if (value === undefined || value === null) return { ok: true, tags: undefined };

  if (Array.isArray(value)) {
    const bad = value.findIndex(item => typeof item !== 'string');
    if (bad === -1) {
      const tags = (value as string[]).map(tag => tag.trim()).filter(Boolean);
      return { ok: true, tags };
    }
    return {
      ok: false,
      error:
        `Invalid \`${field}\`: every item must be a string, but item #${bad} is ${describe(value[bad])}. ` +
        `Nothing was written. Re-send as an array of strings, e.g. ${JSON.stringify(['tag-a', 'tag-b'])}.`,
    };
  }

  // A string is the most common mistake: the caller sent one comma-joined value.
  const hint = typeof value === 'string'
    ? ` You sent the string ${JSON.stringify(value)} — split it into separate items.`
    : '';
  return {
    ok: false,
    error:
      `Invalid \`${field}\`: expected an array of strings, got ${describe(value)}.${hint} ` +
      `Nothing was written. Re-send as an array, e.g. ${JSON.stringify(['tag-a', 'tag-b'])}.`,
  };
}

/** What the caller actually sent, short enough to quote back in an error. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array (length ${value.length})`;
  if (typeof value === 'object') return `an object ${JSON.stringify(value).slice(0, 60)}`;
  if (typeof value === 'string') return `a string ${JSON.stringify(value.slice(0, 60))}`;
  return `a ${typeof value} (${String(value)})`;
}

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
