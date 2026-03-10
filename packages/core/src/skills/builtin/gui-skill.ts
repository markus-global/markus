import type { AgentToolHandler } from '../../agent.js';
import type { SkillManifest, SkillInstance } from '../types.js';
import { createLogger } from '@markus/shared';

const log = createLogger('gui-skill');

const manifest: SkillManifest = {
  name: 'gui',
  version: '0.1.0',
  description: 'GUI automation for desktop applications: screenshot, mouse control, keyboard input',
  author: 'markus',
  category: 'development',
  tags: ['gui', 'desktop', 'automation', 'vnc', 'screenshot', 'input'],
  tools: [
    {
      name: 'gui_screenshot',
      description: 'Capture a screenshot of the agent\'s desktop. Returns the base64-encoded PNG.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
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
    },
    {
      name: 'gui_get_window_title',
      description: 'Get the title of the currently active window.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  ],
};

export async function createGUISkill(containerId?: string, screenshotDir?: string, vncConfig?: { host: string; port: number; password?: string }): Promise<SkillInstance> {
  let guiTools: AgentToolHandler[] = [];
  let cleanup: (() => Promise<void>) | undefined;

  if (vncConfig) {
    try {
      const { createRealGUITools } = await import('@markus/gui');
      const result = await createRealGUITools({
        vnc: vncConfig,
        screenshot: {
          dir: screenshotDir ?? '/tmp/markus-screenshots',
          format: 'png',
          quality: 90,
        },
      });
      guiTools = result.tools as AgentToolHandler[];
      cleanup = result.cleanup;
      log.info('Real GUI tools initialized via VNC', { host: vncConfig.host, port: vncConfig.port });
    } catch (err) {
      log.warn('Failed to create real GUI tools, falling back to stubs', { error: String(err) });
      guiTools = createStubTools();
    }
  } else {
    guiTools = createStubTools();
  }

  return {
    manifest,
    tools: guiTools,
  };
}

function createStubTools(): AgentToolHandler[] {
  return manifest.tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    execute: async (args: Record<string, unknown>) => {
      if (tool.name === 'gui_screenshot') {
        return JSON.stringify({
          error: 'GUI tools require containerId and screenshotDir parameters to be provided when creating the skill.',
          tool: tool.name,
          required_params: ['containerId', 'screenshotDir'],
          note: 'In a real environment, this would return a base64-encoded screenshot',
        });
      }
      
      return JSON.stringify({
        success: true,
        tool: tool.name,
        message: `GUI tool ${tool.name} would execute with args: ${JSON.stringify(args)}`,
        note: 'Real GUI tools require @markus/gui package and proper container setup',
        required_params: ['containerId', 'screenshotDir'],
      });
    },
  }));
}