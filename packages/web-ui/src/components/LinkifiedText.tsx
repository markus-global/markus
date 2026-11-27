/**
 * Render plain text with its bare http(s) URLs as REAL links that always leave
 * the app (system browser), never the in-app right panel.
 *
 * ── Why this exists (and why not MarkdownMessage) ────────────────────────────
 * Error / notice text used to be printed into a `<p>` / `<span>` as-is, so the
 * billing link inside "余额不足，请充值或升级计划：https://…" was dead text — the
 * user could see where to go and could not click it. Sending those strings
 * through `MarkdownMessage` instead would have made them clickable but opened
 * them in the right-panel browser (`useMarkdownComponents` → `openRightPanel`
 * for external http(s) hrefs), which is the wrong destination for an action the
 * user must complete in their own browser (top-up / upgrade, with their session
 * and their payment method).
 *
 * So: notices get their own renderer, with one fixed contract — a link found in
 * a notice always opens externally. The "where does a bare URL end" rule is NOT
 * duplicated here: it comes from `splitBareUrls` (same regex as the markdown
 * autolink path), so the two renderers can never disagree about the same
 * sentence.
 */
import { Fragment } from 'react';
import { splitBareUrls } from './markdown-utils.ts';
import { openExternal } from '../hooks/useElectron.ts';

export function LinkifiedText({
  text,
  linkClassName = 'text-brand-500 hover:underline break-all',
}: {
  text: string;
  /** Override anchor styling; the caller owns the surrounding typography. */
  linkClassName?: string;
}) {
  const parts = splitBareUrls(text);
  // Fast path: nothing to link — return the original string so callers keep a
  // single text node (and existing tests/screen readers see exactly the text).
  if (parts.length <= 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) => (
        part.kind === 'link' ? (
          <a
            key={i}
            href={part.value}
            target="_blank"
            rel="noopener noreferrer"
            className={linkClassName}
            // Electron would otherwise hand http(s) navigation to the embedding
            // WebContentsView; the bridge is the only path to the system browser.
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); openExternal(part.value); }}
          >
            {part.value}
          </a>
        ) : (
          <Fragment key={i}>{part.value}</Fragment>
        )
      ))}
    </>
  );
}
