/**
 * In-process MCP-compatible tool provider that forwards tool calls
 * to the Chrome extension via the WebSocket bridge.
 *
 * When the extension is connected, this replaces chrome-devtools-mcp entirely,
 * avoiding the "Allow debugging?" dialog and npx startup overhead.
 *
 * The tool list mirrors chrome-devtools-mcp's tools so that BrowserSessionManager
 * and agents work identically regardless of which backend is used.
 */

import { createLogger } from '@markus/shared';
import type { MarkusBrowserBridge } from './markus-browser-bridge.js';
import type { MCPToolDescriptor } from './mcp-client.js';
import type { AgentToolHandler } from '../agent.js';

const log = createLogger('browser-mcp');

/**
 * Tool descriptors matching chrome-devtools-mcp's tool interface.
 * These are registered when the extension is connected.
 */
const TOOL_DESCRIPTORS: MCPToolDescriptor[] = [
  // Navigation tools
  {
    name: 'new_page',
    description: 'Create a new browser page/tab and optionally navigate to a URL',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL to navigate to (default: about:blank)' }, background: { type: 'boolean', description: 'Open in background' }, timeout: { type: 'number', description: 'Timeout in ms (default: 60000)' } } },
  },
  {
    name: 'open_page',
    description: 'Open a new browser page/tab and navigate to a URL',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL to navigate to' }, background: { type: 'boolean', description: 'Open in background' }, timeout: { type: 'number', description: 'Timeout in ms (default: 60000)' } } },
  },
  {
    name: 'close_page',
    description: 'Close a browser page/tab',
    inputSchema: { type: 'object', properties: { pageId: { type: 'number', description: 'Page ID to close' } }, required: ['pageId'] },
  },
  {
    name: 'list_pages',
    description: 'List all open browser pages/tabs',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'select_page',
    description: 'Select a browser page/tab as the active one',
    inputSchema: { type: 'object', properties: { pageId: { type: 'number', description: 'Page ID to select' } }, required: ['pageId'] },
  },
  {
    name: 'navigate_page',
    description: 'Navigate the selected page to a URL or go back/forward/reload',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL to navigate to' }, action: { type: 'string', enum: ['back', 'forward', 'reload'] }, timeout: { type: 'number', description: 'Timeout in ms' } } },
  },
  {
    name: 'wait_for',
    description: 'Wait for text to appear on the selected page',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text to wait for' }, timeout: { type: 'number', description: 'Timeout in ms (default: 30000)' } }, required: ['text'] },
  },
  // Input tools
  {
    name: 'click',
    description: 'Click an element identified by its accessibility snapshot uid',
    inputSchema: { type: 'object', properties: { uid: { type: 'string', description: 'Element uid from snapshot' } }, required: ['uid'] },
  },
  {
    name: 'fill',
    description: 'Fill an input element with text (replaces existing content)',
    inputSchema: { type: 'object', properties: { uid: { type: 'string', description: 'Element uid from snapshot' }, value: { type: 'string', description: 'Text to fill' } }, required: ['uid', 'value'] },
  },
  {
    name: 'fill_form',
    description: 'Fill multiple form fields at once',
    inputSchema: { type: 'object', properties: { fields: { type: 'array', items: { type: 'object', properties: { uid: { type: 'string' }, value: { type: 'string' } }, required: ['uid', 'value'] } } }, required: ['fields'] },
  },
  {
    name: 'type_text',
    description: 'Type text into the currently focused element',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text to type' } }, required: ['text'] },
  },
  {
    name: 'press_key',
    description: 'Press a keyboard key or key combination (e.g. Enter, Ctrl+A)',
    inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'Key or combination (e.g. Enter, Ctrl+A)' } }, required: ['key'] },
  },
  {
    name: 'hover',
    description: 'Hover over an element identified by its accessibility snapshot uid',
    inputSchema: { type: 'object', properties: { uid: { type: 'string', description: 'Element uid from snapshot' } }, required: ['uid'] },
  },
  {
    name: 'drag',
    description: 'Drag from one element to another',
    inputSchema: { type: 'object', properties: { from_uid: { type: 'string' }, to_uid: { type: 'string' } }, required: ['from_uid', 'to_uid'] },
  },
  {
    name: 'handle_dialog',
    description: 'Accept or dismiss a JavaScript dialog (alert, confirm, prompt)',
    inputSchema: { type: 'object', properties: { accept: { type: 'boolean', description: 'Accept (true) or dismiss (false)' }, promptText: { type: 'string', description: 'Text for prompt dialog' } } },
  },
  {
    name: 'upload_file',
    description: 'Upload a file to a file input element',
    inputSchema: { type: 'object', properties: { uid: { type: 'string', description: 'File input element uid' }, filePath: { type: 'string', description: 'Path to file to upload' } }, required: ['uid', 'filePath'] },
  },
  // Inspection tools
  {
    name: 'take_screenshot',
    description: 'Take a screenshot of the selected page',
    inputSchema: { type: 'object', properties: { format: { type: 'string', description: 'Image format (png or jpg)' }, quality: { type: 'number', description: 'Quality 0-100 for jpg' }, fullPage: { type: 'boolean', description: 'Capture full page' } } },
  },
  {
    name: 'take_snapshot',
    description: 'Take an accessibility tree snapshot of the selected page',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'evaluate_script',
    description: 'Evaluate JavaScript in the selected page',
    inputSchema: { type: 'object', properties: { expression: { type: 'string', description: 'JavaScript expression to evaluate' } }, required: ['expression'] },
  },
  {
    name: 'get_console_message',
    description: 'Get a specific console message by ID',
    inputSchema: { type: 'object', properties: { msgid: { type: 'number', description: 'Message ID' } }, required: ['msgid'] },
  },
  {
    name: 'list_console_messages',
    description: 'List all console messages from the selected page',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lighthouse_audit',
    description: 'Run an accessibility audit on the selected page',
    inputSchema: { type: 'object', properties: { categories: { type: 'array', items: { type: 'string' } } } },
  },
  // Network tools
  {
    name: 'list_network_requests',
    description: 'List captured network requests from the selected page',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_network_request',
    description: 'Get details of a specific network request',
    inputSchema: { type: 'object', properties: { reqid: { type: 'string', description: 'Request ID' } }, required: ['reqid'] },
  },
  // Emulation tools
  {
    name: 'emulate',
    description: 'Set device emulation (viewport, user agent, geolocation, color scheme)',
    inputSchema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' }, deviceScaleFactor: { type: 'number' }, mobile: { type: 'boolean' }, userAgent: { type: 'string' }, geolocation: { type: 'object', properties: { latitude: { type: 'number' }, longitude: { type: 'number' } } }, colorScheme: { type: 'string' } } },
  },
  {
    name: 'resize_page',
    description: 'Resize the browser window',
    inputSchema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } }, required: ['width', 'height'] },
  },
];

/**
 * Creates tool handlers that forward calls through the browser bridge.
 * These handlers have the same interface as MCPClientManager's tool handlers,
 * so they can be used with BrowserSessionManager.wrapToolHandlers().
 */
export function createBridgeToolHandlers(
  bridge: MarkusBrowserBridge,
  serverName: string,
): AgentToolHandler[] {
  return TOOL_DESCRIPTORS.map((tool) => ({
    name: `${serverName}__${tool.name}`,
    description: `[MCP:${serverName}] ${tool.description}`,
    inputSchema: tool.inputSchema,
    execute: async (args: Record<string, unknown>) => {
      const result = await bridge.callTool(tool.name, args);
      if (result.error) {
        return `Error: ${result.error}`;
      }
      return result.content;
    },
  }));
}

/**
 * Get the static tool descriptors (useful for lazy registration when
 * the extension is connected but we don't need to spawn chrome-devtools-mcp).
 */
export function getBridgeToolDescriptors(): MCPToolDescriptor[] {
  return TOOL_DESCRIPTORS;
}
