/**
 * Regression guard for the 2026-11-09 incident: one screenshot reached the
 * provider as a 338,836-character JSON string (~35k prompt tokens, re-sent
 * every turn) and the vision model got no usable image.
 *
 * The fixtures are the real serialized shape, not an invented one.
 */
import { describe, it, expect } from 'vitest';
import { rehydrateContentParts, normalizeHistoryContent } from '../src/llm/message-content.js';

const serialize = (parts: unknown[]) => JSON.stringify(parts);

describe('rehydrateContentParts — structure must not be inferred from payload', () => {
  it('parses a serialized parts array that carries an image back into parts', () => {
    const content = serialize([
      { type: 'text', text: '1. 这设计很丑。2. 没有“立即生效”按钮？' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ]);
    const parts = rehydrateContentParts(content);
    expect(parts).not.toBeNull();
    expect(parts!.map(p => p.type)).toEqual(['text', 'image_url']);
  });

  it('leaves ordinary text alone, even when it is JSON', () => {
    expect(rehydrateContentParts('修复设置页：{ "a": 1 }')).toBeNull();
    // A JSON array WITHOUT an image is prose the user actually typed.
    expect(rehydrateContentParts('[{"type":"text","text":"hello"}]')).toBeNull();
    expect(rehydrateContentParts('')).toBeNull();
    expect(rehydrateContentParts(undefined)).toBeNull();
  });

  it('rejects malformed / non-part arrays instead of guessing', () => {
    expect(rehydrateContentParts('[1,2,3]')).toBeNull();
    expect(rehydrateContentParts('[{"no_type":true}]')).toBeNull();
    expect(rehydrateContentParts('[{"type":"image_url",')).toBeNull();
  });
});

describe('normalizeHistoryContent', () => {
  it('repairs only the messages that need it and keeps array identity otherwise', () => {
    const messages = [
      { role: 'user', content: 'plain text' },
      {
        role: 'user',
        content: serialize([
          { type: 'text', text: '看图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        ]),
      },
      { role: 'assistant', content: 'ok' },
    ];
    const out = normalizeHistoryContent(messages);
    expect(out).not.toBe(messages);
    expect(Array.isArray(out[1]!.content)).toBe(true);
    expect(out[0]).toBe(messages[0]);

    const clean = [{ role: 'user', content: 'plain text' }];
    // No repair ⇒ same array, no allocation churn on the packing hot path.
    expect(normalizeHistoryContent(clean)).toBe(clean);
  });
});
