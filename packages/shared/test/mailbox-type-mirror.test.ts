/**
 * Contract test across the build boundary: the browser mirror must equal the registry.
 *
 * `packages/web-ui` cannot import `@markus/shared` at runtime (node-flavoured shared
 * code does not belong in the browser bundle), so the UI keeps a plain-data
 * projection in `packages/web-ui/src/lib/mailboxTypeMeta.ts`. Hand-maintained
 * duplicates are how the previous map drifted: `workflow_update` and
 * `callback_result` were missing, so those types rendered without an icon and
 * dropped out of every category filter, silently.
 *
 * This test makes that failure mode impossible to reach production: the registry
 * stays the single writer, and any divergence turns CI red instead of the UI
 * quietly losing a type.
 */

import { describe, it, expect } from 'vitest';
import { MAILBOX_TYPE_REGISTRY, MAILBOX_CATEGORIES } from '../src/types/mailbox.js';
import { MAILBOX_TYPE_STRUCTURE, MAILBOX_CATEGORY_TYPES } from '../../web-ui/src/lib/mailboxTypeMeta.js';

describe('web-ui mailbox type mirror', () => {
  it('covers exactly the same type set as the registry', () => {
    expect(Object.keys(MAILBOX_TYPE_STRUCTURE).sort())
      .toEqual(Object.keys(MAILBOX_TYPE_REGISTRY).sort());
  });

  it('mirrors icon and category for every type', () => {
    const drift = Object.entries(MAILBOX_TYPE_REGISTRY)
      .map(([type, descriptor]) => {
        const mirror = MAILBOX_TYPE_STRUCTURE[type];
        if (!mirror) return `${type}: missing from the browser mirror`;
        const problems: string[] = [];
        if (mirror.icon !== descriptor.icon) {
          problems.push(`icon ${mirror.icon} != ${descriptor.icon}`);
        }
        if (mirror.category !== descriptor.category) {
          problems.push(`category ${mirror.category} != ${descriptor.category}`);
        }
        return problems.length ? `${type}: ${problems.join(', ')}` : null;
      })
      .filter((v): v is string => v !== null);

    // Failing here means someone edited one side only. Fix the data, not the test.
    expect(drift).toEqual([]);
  });

  it('derives category buckets identical to MAILBOX_CATEGORIES', () => {
    for (const [category, entry] of Object.entries(MAILBOX_CATEGORIES)) {
      expect([...MAILBOX_CATEGORY_TYPES[category as keyof typeof MAILBOX_CATEGORY_TYPES]].sort())
        .toEqual([...entry.types].sort());
    }
  });
});
