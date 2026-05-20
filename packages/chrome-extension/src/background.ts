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
  pm.removeByTabId(tabId);
  client.send({ event: 'tab_closed', data: { tabId } });
});

// Handle debugger detach events
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    pm.setDebuggerAttached(source.tabId, false);
  }
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

// Connect to bridge
client.connect();

console.log('[Markus] Browser automation extension initialized');
