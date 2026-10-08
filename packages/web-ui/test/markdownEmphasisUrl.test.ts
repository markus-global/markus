import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type ReactMarkdown from 'react-markdown';

import { autolinkBareUrls, transformOutsideCode } from '../src/components/markdown-utils.ts';

/**
 * Incident 2026-10-08 — end-to-end regression for a bolded bare URL.
 *
 * Reported from the live UI: a message containing
 * `**https://github.com/markus-global/markus/pull/363**` rendered with the
 * asterisks visible, and clicking the link navigated to a URL that included them.
 *
 * Root cause lived in `autolinkBareUrls` (see the unit tests in
 * `markdown-utils.test.ts`): the pre-rewrite that protects bare URLs from GFM's
 * over-eager autolink decided where a URL ends with a character denylist that had
 * no notion of markdown emphasis, so it swallowed the closing `**` into both the
 * link text and the href.
 *
 * The unit tests pin the rewrite itself. This file pins the OUTCOME through the
 * real pipeline (react-markdown + remark-gfm, exactly like MarkdownMessage), so a
 * future change in the preprocessing order or a plugin swap cannot silently
 * reintroduce the symptom while the unit tests stay green.
 */

let _ReactMarkdown: typeof ReactMarkdown | null = null;

/** Run `md` through the same preprocess step MarkdownMessage applies last. */
function preprocessLikeMarkdownMessage(md: string): string {
  return transformOutsideCode(md, autolinkBareUrls);
}

/** Render the real pipeline and return the HTML. */
async function renderLikeMarkdownMessage(md: string): Promise<string> {
  const [{ default: Markdown }, { default: remarkGfm }] = await Promise.all([
    import('react-markdown'),
    import('remark-gfm'),
  ]);
  _ReactMarkdown = Markdown;
  return renderToStaticMarkup(
    h(_ReactMarkdown as never, {
      remarkPlugins: [remarkGfm] as never,
      children: preprocessLikeMarkdownMessage(md),
    }),
  );
}

const URL = 'https://github.com/markus-global/markus/pull/363';

describe('bolded bare URL renders as a bold link (2026-10-08 incident)', () => {
  it('produces a <strong> wrapping an <a> whose href has no asterisks', async () => {
    const html = await renderLikeMarkdownMessage(`**${URL}**`);

    expect(html).toContain(`<strong><a href="${URL}">${URL}</a></strong>`);
    expect(html).not.toContain('363**');
    expect(html).not.toContain('**');
  });

  it('keeps working when the bolded link is inside a sentence', async () => {
    const html = await renderLikeMarkdownMessage(`见 **${URL}** 这条 PR`);

    expect(html).toContain(`<strong><a href="${URL}">${URL}</a></strong>`);
    expect(html).toContain('这条 PR');
  });

  it('still leaves plain (unbolded) bare URLs as autolinks', async () => {
    const html = await renderLikeMarkdownMessage(`见 ${URL} 这条`);

    expect(html).toContain(`<a href="${URL}">${URL}</a>`);
  });

  it('does not damage a URL that merely ends with an underscore', async () => {
    const html = await renderLikeMarkdownMessage('https://example.com/foo_');

    expect(html).toContain('href="https://example.com/foo_"');
  });
});
