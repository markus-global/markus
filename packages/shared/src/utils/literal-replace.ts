/**
 * Literal string replacement — the replacement text is never interpreted.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Every agent-facing edit path (file_edit, apply_patch) used to call
 * `content.replace(search, replacement)` directly. That is WRONG when the
 * replacement is agent-authored text, because String.prototype.replace treats
 * dollar-sign sequences inside the replacement string as *substitution
 * patterns*:
 *
 *   - `$&`  the matched text itself
 *   - ``$` ``  everything BEFORE the match  → the whole prefix gets appended (duplicated)
 *   - `$'`  everything AFTER  the match  → the whole suffix gets appended (duplicated)
 *   - `$1` … numbered capture groups
 *   - `$$`  an escaped literal dollar sign
 *
 * Because `String.prototype.replaceAll` uses the exact same replacement-string
 * grammar, the same corruption happens when *all* occurrences are meant to be
 * replaced (e.g. workflow template placeholders — see workflow-template.ts).
 *
 * So when an agent's (or a user's) new_string happened to contain one of those
 * sequences — shell snippets, regex examples, Makefile or template fragments in
 * docs — the tool/rendered prompt silently duplicated or expanded the
 * surrounding text while still reporting "success". Observed symptom: a
 * document grew by hundreds of lines and ended up containing two copies of its
 * own header.
 *
 * Passing a *function* as the replacement disables pattern interpretation
 * entirely: the returned string is inserted verbatim.
 *
 * ── HARD RULE ────────────────────────────────────────────────────────────────
 * When inserting Agent- or user-authored text into existing text, NEVER use the
 * string-form replacer (`String.prototype.replace` / `replaceAll` with a string
 * replacement argument). Call `replaceLiteral` / `replaceAllLiteral` instead, so
 * there is exactly one implementation to trust and one place to audit.
 *
 * This module lives in `@markus/shared` (not `@markus/core`) because workflow
 * templates are rendered inside the shared package and the dependency direction
 * is core → shared; shared must never import core. `@markus/core`'s
 * `src/tools/literal-replace.ts` re-exports these functions so tool code keeps a
 * single, stable import path.
 *
 * Regression coverage: packages/core/test/file-edit-replace-template.test.ts,
 * packages/shared/src/utils/literal-replace.test.ts.
 */

/**
 * Replace the FIRST occurrence of `search` with `replacement`, verbatim.
 *
 * Mirrors `String.prototype.replace`'s single-occurrence semantics but never
 * interprets `$`-sequences in `replacement`. `search` is always treated as a
 * literal string, never as a regular expression.
 */
export function replaceLiteral(content: string, search: string, replacement: string): string {
  return content.replace(search, () => replacement);
}

/**
 * Replace EVERY occurrence of `search` with `replacement`, verbatim.
 *
 * Mirrors `String.prototype.replaceAll`'s all-occurrence semantics but never
 * interprets `$`-sequences in `replacement` (`$&`, ``$` ``, `$'`, `$1`, `$$` are
 * inserted literally). `search` is treated as a literal string.
 *
 * Implemented with `split`/`join` deliberately: passing a *function* to
 * `replaceAll` would not help here (its function form receives the match and can
 * still be abused), and `split`/`join` keeps the "never interpret" guarantee in
 * one obvious expression.
 *
 * Guard: an empty `search` would make `split('')` break the string into single
 * characters and `join` would splice a copy of `replacement` between every
 * character — i.e. an unbounded expansion. `String.prototype.replaceAll` rejects
 * an empty pattern for that same reason, so we return `content` unchanged.
 */
export function replaceAllLiteral(content: string, search: string, replacement: string): string {
  if (search === '') return content;
  return content.split(search).join(replacement);
}
