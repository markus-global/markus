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
 *   - the matched text itself
 *   - everything BEFORE the match  → the whole prefix gets appended (duplicated)
 *   - everything AFTER  the match  → the whole suffix gets appended (duplicated)
 *   - numbered capture groups
 *   - an escaped literal dollar sign
 *
 * So when an agent's new_string happened to contain one of those sequences —
 * shell snippets, regex examples, Makefile or template fragments in docs —
 * the tool silently duplicated or expanded the surrounding file while still
 * reporting "success". Observed symptom: a document grew by hundreds of lines
 * and ended up containing two copies of its own header.
 *
 * Passing a *function* as the replacement disables pattern interpretation
 * entirely: the returned string is inserted verbatim.
 *
 * Do NOT inline `replace(search, replacement)` in tool code. Call this instead,
 * so there is exactly one implementation to trust and one place to audit.
 *
 * Regression coverage: test/file-edit-replace-template.test.ts
 */
export function replaceLiteral(content: string, search: string, replacement: string): string {
  return content.replace(search, () => replacement);
}
