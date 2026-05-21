/**
 * Shared debugger attachment helper.
 * Handles state desynchronization caused by service worker restarts:
 * the PM's in-memory `debuggerAttached` set may have been cleared while
 * Chrome's actual debugger connections persist.
 */

import type { PageManager } from './page-manager.js';

export async function ensureDebugger(pm: PageManager, tabId: number): Promise<void> {
  if (pm.isDebuggerAttached(tabId)) return;

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already attached') || msg.includes('Another debugger')) {
      // Chrome says attached but PM disagrees → stale PM state after SW restart.
      // Re-sync: mark attached and enable domains (they may also be stale).
      pm.setDebuggerAttached(tabId, true);
      try {
        await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
        await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
      } catch { /* domains may already be enabled */ }
      return;
    }
    throw err;
  }

  pm.setDebuggerAttached(tabId, true);
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
}
