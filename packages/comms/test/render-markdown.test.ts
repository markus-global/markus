/**
 * Markdown → platform dialect rendering.
 *
 * These pin the two defects that made formatting invisible in the field:
 *   1. a platform speaking another dialect prints the markup literally
 *      (`**bold**` shown as characters) — so every dialect gets a real mapping;
 *   2. raw prose must be **escaped**, or an agent's `<...>`/`&` becomes markup
 *      (Slack links/mentions, Telegram entities) — so escaping is asserted, not
 *      assumed.
 */
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../src/render/markdown.js';

describe('renderMarkdown — html (Telegram)', () => {
  it('maps bold/italic/strike/code to Telegram HTML', () => {
    expect(renderMarkdown('**b** and *i* and ~~s~~ and `c`', 'html')).toBe(
      '<b>b</b> and <i>i</i> and <s>s</s> and <code>c</code>',
    );
  });

  it('escapes prose so it cannot be read as markup', () => {
    expect(renderMarkdown('a < b & c > d', 'html')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('renders links as anchors and escapes the href', () => {
    expect(renderMarkdown('[docs](https://x.com/a?b=1&c=2)', 'html')).toBe(
      '<a href="https://x.com/a?b=1&amp;c=2">docs</a>',
    );
  });

  it('renders headings bold, quotes prefixed, bullets as dots', () => {
    const out = renderMarkdown('# Title\n> note\n- one\n- two', 'html');
    expect(out).toBe('<b>Title</b>\n❯ note\n• one\n• two');
  });

  it('keeps a fenced code block verbatim inside <pre>', () => {
    expect(renderMarkdown('```\n**not bold**\n```', 'html')).toBe('<pre>**not bold**</pre>');
  });

  it('does not italicise underscores inside a word', () => {
    expect(renderMarkdown('the file_name_here value', 'html')).toBe('the file_name_here value');
  });

  it('renders an unterminated fence rather than dropping the body', () => {
    expect(renderMarkdown('```\nstill code', 'html')).toBe('<pre>still code</pre>');
  });
});

describe('renderMarkdown — mrkdwn (Slack)', () => {
  it('converts markdown bold to Slack bold (*) and keeps italic (_)', () => {
    expect(renderMarkdown('**b** _i_', 'mrkdwn')).toBe('*b* _i_');
  });

  it('does not re-read Slack bold as markdown italic (single pass)', () => {
    // A two-pass bold-then-italic implementation turns *b* into _b_ here.
    expect(renderMarkdown('**b**', 'mrkdwn')).toBe('*b*');
  });

  it('converts links to the Slack <url|label> form', () => {
    expect(renderMarkdown('[docs](https://x.com)', 'mrkdwn')).toBe('<https://x.com|docs>');
  });

  it('escapes < > & so an agent cannot inject a mention/link', () => {
    expect(renderMarkdown('hi <@U123> & <https://evil>', 'mrkdwn')).toBe(
      'hi &lt;@U123&gt; &amp; &lt;https://evil&gt;',
    );
  });
});

describe('renderMarkdown — whatsapp', () => {
  it('maps bold to * and italic to _', () => {
    expect(renderMarkdown('**b** *i*', 'whatsapp')).toBe('*b* _i_');
  });

  it('degrades a link to label + url (WhatsApp has no inline links)', () => {
    expect(renderMarkdown('[docs](https://x.com)', 'whatsapp')).toBe('docs (https://x.com)');
  });
});

describe('renderMarkdown — native (Discord) and edge cases', () => {
  it('passes native markdown through untouched', () => {
    const md = '**b** `c`\n- item';
    expect(renderMarkdown(md, 'native')).toBe(md);
  });

  it('returns empty input unchanged', () => {
    expect(renderMarkdown('', 'html')).toBe('');
  });

  it('leaves plain prose without markers untouched', () => {
    expect(renderMarkdown('just a sentence.', 'html')).toBe('just a sentence.');
  });
});
