/**
 * Text sanitization utilities for safe LLM API consumption.
 *
 * Shell commands, web fetches, and file reads can produce output containing
 * binary data, ANSI escapes, control characters, and lone surrogates.
 * These break JSON serialization for some LLM providers (notably DeepSeek)
 * which reject malformed `\x` / `\u` escape sequences in request bodies.
 */

import type { LLMMessage, LLMContentPart } from './types/llm.js';

const ANSI_CSI = /\x1b\[[0-9;]*[a-zA-Z]/g;
const ANSI_OSC = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const ANSI_OTHER = /\x1b[^[\]].?/g;
const C0_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const C1_CONTROL = /[\x80-\x9f]/g;
const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g;
const LONE_LOW_SURROGATE = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Strip characters that cause JSON parse failures or LLM API rejections.
 * Keeps \t (0x09), \n (0x0a), \r (0x0d). Replaces lone surrogates with U+FFFD.
 */
export function sanitizeForLLM(text: string): string {
  return text
    .replace(ANSI_CSI, '')
    .replace(ANSI_OSC, '')
    .replace(ANSI_OTHER, '')
    .replace(C0_CONTROL, '')
    .replace(C1_CONTROL, '')
    .replace(LONE_HIGH_SURROGATE, '\uFFFD')
    .replace(LONE_LOW_SURROGATE, '\uFFFD');
}

/**
 * Sanitize ALL text content in an LLMMessage array before it reaches a
 * provider's JSON serialization.  This is the single choke-point that
 * prevents ANSI escapes, control characters, and lone surrogates from
 * causing API 400 errors (notably DeepSeek's "unexpected end of hex escape").
 *
 * Returns a shallow copy — original messages are not mutated.
 */
export function sanitizeLLMMessages(messages: LLMMessage[]): LLMMessage[] {
  return messages.map(m => {
    const cleaned: LLMMessage = { ...m };

    if (typeof cleaned.content === 'string') {
      cleaned.content = sanitizeForLLM(cleaned.content);
    } else if (Array.isArray(cleaned.content)) {
      cleaned.content = cleaned.content.map((part: LLMContentPart) =>
        part.type === 'text'
          ? { type: 'text' as const, text: sanitizeForLLM(part.text) }
          : part,
      );
    }

    if (cleaned.reasoningContent) {
      cleaned.reasoningContent = sanitizeForLLM(cleaned.reasoningContent);
    }

    return cleaned;
  });
}

/**
 * Like `String.prototype.slice` but avoids splitting UTF-16 surrogate pairs.
 * If the slice boundary falls inside a surrogate pair, the lone half is dropped.
 */
export function safeSlice(text: string, start: number, end?: number): string {
  let result = text.slice(start, end);
  if (result.length === 0) return result;

  const first = result.charCodeAt(0);
  if (first >= 0xDC00 && first <= 0xDFFF) {
    result = result.slice(1);
  }

  if (result.length === 0) return result;

  const last = result.charCodeAt(result.length - 1);
  if (last >= 0xD800 && last <= 0xDBFF) {
    result = result.slice(0, -1);
  }

  return result;
}
