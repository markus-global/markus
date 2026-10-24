/**
 * The tool block is a PREFIX of the request in every provider (it is a top-level
 * field serialized before the messages), so anything that changes it — even a
 * pure reorder — invalidates the cache for the system prompt AND the whole
 * history. These tests pin the two properties that matter:
 *   1. Eviction is preserved (which tools exist is the selector's call).
 *   2. Surviving tools keep their previous relative order, so the already-cached
 *      part of the block stays byte-identical.
 */

import { describe, it, expect } from 'vitest';
import { stabilizeToolOrder } from '../src/tool-order.js';
import type { LLMTool } from '@markus/shared';

const tool = (name: string): LLMTool => ({ name, description: `${name} tool`, parameters: {} }) as LLMTool;
const names = (arr: LLMTool[]) => arr.map((t) => t.name);

describe('stabilizeToolOrder', () => {
  it('appends a newly discovered tool and leaves the existing order untouched', () => {
    const current = [tool('a'), tool('b'), tool('c')];
    // The selector would have re-ranked: the new tool lands in the middle.
    const rebuilt = [tool('c'), tool('d'), tool('a'), tool('b')];

    const out = stabilizeToolOrder(current, rebuilt);

    // a,b,c keep the order the model already saw; d goes last.
    expect(names(out)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('preserves eviction — a tool the selector dropped stays dropped', () => {
    const current = [tool('a'), tool('b'), tool('c')];
    const rebuilt = [tool('c'), tool('a')];

    expect(names(stabilizeToolOrder(current, rebuilt))).toEqual(['a', 'c']);
  });

  it('is a no-op when nothing changed (byte-identical block)', () => {
    const current = [tool('a'), tool('b')];
    expect(names(stabilizeToolOrder(current, [tool('a'), tool('b')]))).toEqual(['a', 'b']);
  });

  it('returns the rebuilt list when the previous array was empty', () => {
    expect(names(stabilizeToolOrder([], [tool('a'), tool('b')]))).toEqual(['a', 'b']);
  });

  it('never duplicates a tool that is both kept and "new"', () => {
    const current = [tool('a')];
    const rebuilt = [tool('a'), tool('b'), tool('a')];

    const out = stabilizeToolOrder(current, rebuilt);
    expect(names(out)).toEqual(['a', 'b']);
    expect(new Set(names(out)).size).toBe(out.length);
  });
});
