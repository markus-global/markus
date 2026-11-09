/**
 * Settings → Network & Access tab is *reachable* (T9 regression guard, renamed).
 *
 * The remote-access wizard shipped a `RemoteAccessSection` and mounted it behind a
 * settings tab, but the settings *navigation* had lost the matching entrytwice, so
 * the panel was dead code — no sidebar entry and `#settings/remote` resolved
 * elsewhere. The component-level tests all passed because they render
 * `<RemoteAccessSection />` directly and never touch the routing/nav seam.
 *
 * The page now owns all three network concerns — bind scope, outbound proxy and
 * remote access — under a single `network` tab. This file pins that seam: it goes
 * red for the right reason if anyone drops the entry from the tab list, drops it
 * from a nav group (the rendered `SETTINGS_TAB_GROUPS` drives the sidebar), or
 * shadows it with a legacy alias.
 */
import { describe, it, expect } from 'vitest';
import {
  SETTINGS_TABS,
  SETTINGS_TAB_GROUPS,
  resolveSettingsTab,
} from '../src/pages/Settings.tsx';

/** The ids that actually render in the sidebar = union of all group members. */
const navGroupTabs = SETTINGS_TAB_GROUPS.flatMap(g => g.tabs);

describe('Settings → Network & Access reachability', () => {
  it('declares a `network` tab entry', () => {
    expect(SETTINGS_TABS.some(t => t.id === 'network')).toBe(true);
  });

  it('the `network` tab is placed in a rendered nav group', () => {
    // A tab missing from every group renders nowhere, even though it is "declared".
    expect(navGroupTabs).toContain('network');
  });

  it('every rendered nav group member is a declared tab (no dangling ids)', () => {
    const declared = new Set(SETTINGS_TABS.map(t => t.id));
    for (const id of navGroupTabs) {
      expect(declared.has(id)).toBe(true);
    }
  });

  it('keeps the old `#settings/remote` link working by resolving to `network`', () => {
    expect(resolveSettingsTab('#settings/network')).toBe('network');
    expect(resolveSettingsTab('#settings/remote')).toBe('network');
  });

  it('is admin-gated (bind address and tunnel controls are not member surface)', () => {
    const tab = SETTINGS_TABS.find(t => t.id === 'network');
    expect(tab?.adminOnly).toBe(true);
  });
});
