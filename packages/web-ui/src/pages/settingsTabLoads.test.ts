/**
 * A settings tab that renders state nobody loads opens BLANK and only fills in
 * after an unrelated action (pressing Save) happens to call the same loader.
 * That is what the 网络与访问 tab did: no `network` branch existed in the lazy
 * load, so the proxy panel was empty on first open.
 *
 * These assertions pin the loader contract per tab instead of the JSX, so
 * removing a loader (or adding a data-backed tab without one) fails here.
 */
import { describe, it, expect } from 'vitest';
import { settingsTabLoads, SETTINGS_TABS } from './Settings.tsx';

describe('settingsTabLoads', () => {
  it('loads network state for the 网络与访问 tab (regression: panel opened blank)', () => {
    expect(settingsTabLoads('network')).toContain('network');
  });

  it('loads network AND llm state for the 模型配置 tab', () => {
    // The providers tab shows the proxy/egress summary too, so it needs both.
    expect(settingsTabLoads('providers')).toEqual(
      expect.arrayContaining(['llm', 'network']),
    );
  });

  it('gives every data-backed tab a loader and every pure tab none', () => {
    const dataBacked = new Set(['providers', 'network', 'execution', 'browser', 'storage']);
    for (const tab of SETTINGS_TABS) {
      const loads = settingsTabLoads(tab.id);
      if (dataBacked.has(tab.id)) expect(loads.length).toBeGreaterThan(0);
      else expect(loads).toEqual([]);
    }
  });
});
