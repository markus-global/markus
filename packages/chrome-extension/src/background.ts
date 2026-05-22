/**
 * Chrome Extension Service Worker — main entry point.
 *
 * Connects to Markus browser bridge via WebSocket and registers
 * all tool handlers that mirror chrome-devtools-mcp's API.
 */

import { BridgeClient } from './protocol.js';
import { PageManager } from './page-manager.js';
import { registerNavigationTools } from './tools/navigation.js';
import { registerInputTools } from './tools/input.js';
import { registerInspectionTools, setupConsoleListener } from './tools/inspection.js';
import { registerNetworkTools, setupNetworkListener } from './tools/network.js';

const pm = new PageManager();
const client = new BridgeClient();

// Register all tool handlers
registerNavigationTools((name, handler) => client.registerHandler(name, handler), pm);
registerInputTools((name, handler) => client.registerHandler(name, handler), pm);
registerInspectionTools((name, handler) => client.registerHandler(name, handler), pm);
registerNetworkTools((name, handler) => client.registerHandler(name, handler), pm);

// Set up CDP event listeners
setupConsoleListener();
setupNetworkListener();

// Clean up page state when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  const pageId = pm.peekPageId(tabId);
  pm.removeByTabId(tabId);
  client.send({ event: 'tab_closed', data: { tabId, pageId } });
});

// Handle debugger detach events
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    pm.setDebuggerAttached(source.tabId, false);
  }
});

// Auto-dismiss beforeunload dialogs so agent navigation isn't blocked.
// Regular dialogs (alert/confirm/prompt) are left for the agent to handle
// via handle_dialog, but a notification event is sent.
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== 'Page.javascriptDialogOpening' || !source.tabId) return;
  const p = params as { type?: string; message?: string; url?: string };

  if (p.type === 'beforeunload') {
    chrome.debugger.sendCommand(source, 'Page.handleJavaScriptDialog', { accept: true })
      .catch(() => { /* tab may have closed */ });
    console.log(`[Markus] Auto-dismissed beforeunload dialog on tab ${source.tabId}`);
    return;
  }

  const pageId = pm.peekPageId(source.tabId);
  client.send({
    event: 'dialog_opened',
    data: { tabId: source.tabId, pageId, type: p.type, message: p.message },
  });
});

// Handle popup status queries
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'getStatus') {
    sendResponse({
      connected: client.connected,
      pageCount: pm.getAllPages().length,
      bridgeUrl: 'ws://127.0.0.1:9333',
    });
    return true;
  }
});

// Restore PM state from chrome.storage.session (survives service worker restarts),
// then connect to bridge.
pm.restore().then((restored) => {
  if (restored) {
    console.log('[Markus] Reconnecting with restored page state');
  }
  client.connect();
  console.log('[Markus] Browser automation extension initialized');
});
