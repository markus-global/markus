import { DockerScreenshotProvider, screenshotToBase64 } from './screenshot.js';
import { DesktopInput } from './input.js';
import { join } from 'node:path';

/**
 * Returns a set of AgentToolHandler-compatible objects that give an agent
 * GUI control over its sandbox container.
 */
export function createGUITools(containerId: string, screenshotDir: string, display = ':1') {
  const screenshot = new DockerScreenshotProvider(containerId, display);
  const input = new DesktopInput(containerId, display);

  return [
    {
      name: 'gui_screenshot',
      description: 'Capture a screenshot of the agent\'s desktop. Returns the base64-encoded PNG.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        const path = join(screenshotDir, `screenshot_${Date.now()}.png`);
        const result = await screenshot.capture(path);
        const b64 = screenshotToBase64(path);
        return JSON.stringify({
          width: result.width,
          height: result.height,
          timestamp: result.timestamp,
          base64_length: b64.length,
          base64_preview: b64.substring(0, 100) + '...',
        });
      },
    },
    {
      name: 'gui_click',
      description: 'Click at a position on the desktop. Provide x, y coordinates.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X coordinate' },
          y: { type: 'number', description: 'Y coordinate' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default: left)' },
        },
        required: ['x', 'y'],
      },
      execute: async (args: Record<string, unknown>) => {
        const x = args['x'] as number;
        const y = args['y'] as number;
        const button = args['button'] as string | undefined;
        const btn = button === 'right' ? 3 : button === 'middle' ? 2 : 1;
        await input.click(x, y, btn as 1 | 2 | 3);
        return JSON.stringify({ success: true, x, y, button: button ?? 'left' });
      },
    },
    {
      name: 'gui_double_click',
      description: 'Double-click at a position on the desktop.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X coordinate' },
          y: { type: 'number', description: 'Y coordinate' },
        },
        required: ['x', 'y'],
      },
      execute: async (args: Record<string, unknown>) => {
        await input.doubleClick(args['x'] as number, args['y'] as number);
        return JSON.stringify({ success: true });
      },
    },
    {
      name: 'gui_type',
      description: 'Type text on the keyboard.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to type' },
        },
        required: ['text'],
      },
      execute: async (args: Record<string, unknown>) => {
        await input.type(args['text'] as string);
        return JSON.stringify({ success: true, typed: (args['text'] as string).length });
      },
    },
    {
      name: 'gui_key_press',
      description: 'Press key combination, e.g. "ctrl+c", "Return", "alt+F4".',
      inputSchema: {
        type: 'object',
        properties: {
          keys: { type: 'string', description: 'Key combination, e.g. "ctrl+c"' },
        },
        required: ['keys'],
      },
      execute: async (args: Record<string, unknown>) => {
        const keys = (args['keys'] as string).split('+');
        await input.keyPress(...keys);
        return JSON.stringify({ success: true, keys });
      },
    },
    {
      name: 'gui_scroll',
      description: 'Scroll the mouse wheel at a position. Positive clicks = down, negative = up.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          clicks: { type: 'number', description: 'Number of scroll clicks (positive=down, negative=up)' },
        },
        required: ['x', 'y', 'clicks'],
      },
      execute: async (args: Record<string, unknown>) => {
        await input.scroll(args['x'] as number, args['y'] as number, args['clicks'] as number);
        return JSON.stringify({ success: true });
      },
    },
    {
      name: 'gui_get_window_title',
      description: 'Get the title of the currently active window.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        const title = await input.getActiveWindowTitle();
        return JSON.stringify({ title });
      },
    },
  ];
}
