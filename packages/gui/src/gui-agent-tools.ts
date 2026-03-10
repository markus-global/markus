import { createLogger } from '@markus/shared';
import { VNCClient } from './vnc-client.js';
import { ScreenshotProvider } from './screenshot.js';
import { DesktopInput } from './input.js';
import { ElementDetector } from './element-detector.js';
import { VisualAutomation, type AutomationStep } from './visual-automation.js';
import type { GUIConfig, Position, MouseButton } from './types.js';

const log = createLogger('gui-tools');

interface AgentToolHandler {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<string>;
}

/**
 * Create real GUI automation tools backed by a VNC connection.
 * Falls back to stub tools if VNC connection fails.
 */
export async function createRealGUITools(config: GUIConfig): Promise<{
  tools: AgentToolHandler[];
  cleanup: () => Promise<void>;
}> {
  const vncClient = new VNCClient();

  try {
    await vncClient.connect(config.vnc);
  } catch (err) {
    log.warn('Failed to connect VNC, returning stub tools', { error: String(err) });
    return { tools: createStubGUITools(), cleanup: async () => {} };
  }

  const screenshot = new ScreenshotProvider(vncClient, {
    screenshotDir: config.screenshot.dir,
    format: config.screenshot.format,
    quality: config.screenshot.quality,
  });
  const input = new DesktopInput(vncClient);

  const tools: AgentToolHandler[] = [
    {
      name: 'gui_screenshot',
      description: 'Capture a screenshot of the desktop. Returns the file path of the saved image.',
      inputSchema: {
        type: 'object',
        properties: {
          region: {
            type: 'object',
            description: 'Optional region to capture { x, y, width, height }',
            properties: {
              x: { type: 'number' }, y: { type: 'number' },
              width: { type: 'number' }, height: { type: 'number' },
            },
          },
        },
      },
      async execute(args) {
        const region = args['region'] as { x: number; y: number; width: number; height: number } | undefined;
        const result = await screenshot.capture(region);
        return JSON.stringify({ success: true, path: result.path, width: result.width, height: result.height });
      },
    },
    {
      name: 'gui_click',
      description: 'Click at a specific position on the screen.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X coordinate' },
          y: { type: 'number', description: 'Y coordinate' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default: left)' },
        },
        required: ['x', 'y'],
      },
      async execute(args) {
        const x = args['x'] as number;
        const y = args['y'] as number;
        const button = (args['button'] as MouseButton) ?? 'left';
        await input.mouseClick(x, y, button);
        return JSON.stringify({ success: true, action: 'click', x, y, button });
      },
    },
    {
      name: 'gui_double_click',
      description: 'Double-click at a specific position on the screen.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X coordinate' },
          y: { type: 'number', description: 'Y coordinate' },
        },
        required: ['x', 'y'],
      },
      async execute(args) {
        await input.mouseDoubleClick(args['x'] as number, args['y'] as number);
        return JSON.stringify({ success: true, action: 'double_click' });
      },
    },
    {
      name: 'gui_type',
      description: 'Type text at the current cursor position. Use gui_click first to focus an input field.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to type' },
        },
        required: ['text'],
      },
      async execute(args) {
        const text = args['text'] as string;
        await input.typeText(text);
        return JSON.stringify({ success: true, action: 'type', length: text.length });
      },
    },
    {
      name: 'gui_key_press',
      description: 'Press a keyboard key. Supports special keys like Enter, Tab, Escape, F1-F12, and key combinations like ["Control_L", "c"].',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key name (e.g. "Enter", "Tab", "a")' },
          combination: {
            type: 'array',
            items: { type: 'string' },
            description: 'Key combination as array (e.g. ["Control_L", "c"] for Ctrl+C)',
          },
        },
      },
      async execute(args) {
        const combination = args['combination'] as string[] | undefined;
        if (combination && combination.length > 0) {
          await input.keyCombination(combination);
          return JSON.stringify({ success: true, action: 'key_combination', keys: combination });
        }
        const key = args['key'] as string;
        if (!key) return JSON.stringify({ success: false, error: 'Provide key or combination' });
        await input.keyPress(key);
        return JSON.stringify({ success: true, action: 'key_press', key });
      },
    },
    {
      name: 'gui_scroll',
      description: 'Scroll up or down at a position on the screen.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X coordinate' },
          y: { type: 'number', description: 'Y coordinate' },
          direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
          amount: { type: 'number', description: 'Number of scroll steps (default: 3)' },
        },
        required: ['x', 'y', 'direction'],
      },
      async execute(args) {
        const direction = args['direction'] as 'up' | 'down';
        await input.scroll(args['x'] as number, args['y'] as number, direction, (args['amount'] as number) ?? 3);
        return JSON.stringify({ success: true, action: 'scroll', direction });
      },
    },
    {
      name: 'gui_get_screen_info',
      description: 'Get the screen resolution and VNC connection status.',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        const size = vncClient.getScreenSize();
        return JSON.stringify({ success: true, connected: vncClient.isConnected(), width: size.width, height: size.height });
      },
    },
  ];

  // Add element detection and high-level automation tools when detection config is provided
  if (config.detection) {
    const detector = new ElementDetector(config.detection);
    const automation = new VisualAutomation(vncClient, screenshot, input, config.detection);

    tools.push(
      {
        name: 'gui_analyze_screen',
        description: 'Analyze the current screen and detect all GUI elements (buttons, inputs, text, links, etc.). Takes a screenshot first, then runs element detection.',
        inputSchema: { type: 'object', properties: {} },
        async execute() {
          const base64 = await screenshot.captureBase64();
          const elements = await detector.detectElements(base64);
          return JSON.stringify({ success: true, elementCount: elements.length, elements: elements.slice(0, 50) });
        },
      },
      {
        name: 'gui_find_element',
        description: 'Find a specific GUI element by text content or type. Returns the element with its screen coordinates.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text to search for in element labels/text' },
            type: { type: 'string', enum: ['button', 'input', 'text', 'link', 'image', 'checkbox', 'dropdown'], description: 'Element type filter' },
          },
        },
        async execute(args) {
          const base64 = await screenshot.captureBase64();
          const query = { text: args['text'] as string | undefined, type: args['type'] as any };
          const element = await detector.findElement(base64, query);
          if (!element) return JSON.stringify({ success: false, message: 'Element not found' });
          return JSON.stringify({ success: true, element });
        },
      },
      {
        name: 'gui_extract_text',
        description: 'Extract text from the screen or a specific region using OCR.',
        inputSchema: {
          type: 'object',
          properties: {
            region: {
              type: 'object',
              description: 'Optional region { x, y, width, height }',
              properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
            },
          },
        },
        async execute(args) {
          const base64 = await screenshot.captureBase64();
          const region = args['region'] as { x: number; y: number; width: number; height: number } | undefined;
          const text = await detector.extractText(base64, region);
          return JSON.stringify({ success: true, text });
        },
      },
      {
        name: 'gui_click_element',
        description: 'Find a GUI element by text or type and click on it. Takes a screenshot, finds the element, then clicks its center.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text to search for in the element' },
            type: { type: 'string', enum: ['button', 'input', 'text', 'link', 'checkbox', 'dropdown'], description: 'Element type filter' },
          },
        },
        async execute(args) {
          const result = await automation.clickElement({
            text: args['text'] as string | undefined,
            type: args['type'] as any,
          });
          return JSON.stringify(result);
        },
      },
      {
        name: 'gui_type_to_element',
        description: 'Find an input element by text/label, click on it to focus, then type text into it.',
        inputSchema: {
          type: 'object',
          properties: {
            element_text: { type: 'string', description: 'Text/label of the input field to find' },
            text: { type: 'string', description: 'Text to type into the field' },
          },
          required: ['text'],
        },
        async execute(args) {
          const query = { text: args['element_text'] as string | undefined, type: 'input' as const };
          const result = await automation.typeToElement(query, args['text'] as string);
          return JSON.stringify(result);
        },
      },
      {
        name: 'gui_wait_for_element',
        description: 'Wait until a GUI element appears on screen. Polls the screen periodically until the element is found or timeout.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text to search for' },
            type: { type: 'string', description: 'Element type' },
            timeout: { type: 'number', description: 'Timeout in milliseconds (default: 10000)' },
          },
        },
        async execute(args) {
          const element = await automation.waitForElement(
            { text: args['text'] as string | undefined, type: args['type'] as any },
            (args['timeout'] as number) ?? 10000,
          );
          if (!element) return JSON.stringify({ success: false, message: 'Element not found within timeout' });
          return JSON.stringify({ success: true, element });
        },
      },
      {
        name: 'gui_automate_task',
        description: 'Execute a multi-step GUI automation workflow. Each step can click, type, press keys, wait for elements, scroll, or take screenshots.',
        inputSchema: {
          type: 'object',
          properties: {
            steps: {
              type: 'array',
              description: 'Array of automation steps',
              items: {
                type: 'object',
                properties: {
                  action: { type: 'string', enum: ['click', 'type', 'key', 'wait', 'screenshot', 'scroll'] },
                  target: { type: 'object', properties: { text: { type: 'string' }, type: { type: 'string' } } },
                  position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
                  text: { type: 'string' },
                  key: { type: 'string' },
                  keys: { type: 'array', items: { type: 'string' } },
                  timeout: { type: 'number' },
                  direction: { type: 'string', enum: ['up', 'down'] },
                  amount: { type: 'number' },
                },
                required: ['action'],
              },
            },
          },
          required: ['steps'],
        },
        async execute(args) {
          const steps = args['steps'] as AutomationStep[];
          const results = await automation.executeWorkflow(steps);
          const allSuccess = results.every(r => r.success);
          return JSON.stringify({ success: allSuccess, steps: results });
        },
      },
    );
  }

  const cleanup = async () => {
    await vncClient.disconnect();
  };

  return { tools, cleanup };
}

function createStubGUITools(): AgentToolHandler[] {
  const stubAction = async (args: Record<string, unknown>): Promise<string> =>
    JSON.stringify({ success: false, stub: true, message: 'GUI automation not available (no VNC connection)', args });

  return [
    { name: 'gui_screenshot', description: 'Capture screenshot (VNC unavailable)', inputSchema: { type: 'object', properties: {} }, execute: stubAction },
    { name: 'gui_click', description: 'Click (VNC unavailable)', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] }, execute: stubAction },
    { name: 'gui_double_click', description: 'Double click (VNC unavailable)', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] }, execute: stubAction },
    { name: 'gui_type', description: 'Type text (VNC unavailable)', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, execute: stubAction },
    { name: 'gui_key_press', description: 'Key press (VNC unavailable)', inputSchema: { type: 'object', properties: { key: { type: 'string' } } }, execute: stubAction },
    { name: 'gui_scroll', description: 'Scroll (VNC unavailable)', inputSchema: { type: 'object', properties: { direction: { type: 'string' } }, required: ['direction'] }, execute: stubAction },
    { name: 'gui_get_screen_info', description: 'Screen info (VNC unavailable)', inputSchema: { type: 'object', properties: {} }, execute: stubAction },
  ];
}
