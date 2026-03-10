import type { AgentToolHandler } from '../../agent.js';
import type { SkillManifest, SkillInstance } from '../types.js';
import { createLogger } from '@markus/shared';

const log = createLogger('advanced-gui-skill');

const manifest: SkillManifest = {
  name: 'advanced-gui',
  version: '0.2.0',
  description: 'Advanced GUI automation with visual element recognition and OmniParser integration',
  author: 'markus',
  category: 'development',
  tags: ['gui', 'desktop', 'automation', 'vnc', 'screenshot', 'input', 'visual', 'omniparser', 'ai'],
  tools: [
    // 基础GUI工具
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
    // 视觉自动化工具
    {
      name: 'gui_analyze_screen',
      description: 'Analyze the current screen to detect GUI elements using OmniParser.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'gui_find_element',
      description: 'Find a GUI element on screen by text, type, or attributes.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to search for (optional)' },
          type: { type: 'string', description: 'Element type: button, input, text, link, etc. (optional)' },
          label: { type: 'string', description: 'Element label (optional)' },
          min_confidence: { type: 'number', description: 'Minimum confidence score (0-1, default: 0.7)' },
        },
        required: [],
      },
    },
    {
      name: 'gui_click_element',
      description: 'Find and click a GUI element by text, type, or attributes.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to search for (optional)' },
          type: { type: 'string', description: 'Element type: button, input, text, link, etc. (optional)' },
          label: { type: 'string', description: 'Element label (optional)' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default: left)' },
          min_confidence: { type: 'number', description: 'Minimum confidence score (0-1, default: 0.7)' },
        },
        required: [],
      },
    },
    {
      name: 'gui_type_to_element',
      description: 'Find an input element and type text into it.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to type' },
          label: { type: 'string', description: 'Element label to find (optional)' },
          placeholder: { type: 'string', description: 'Placeholder text to find (optional)' },
          min_confidence: { type: 'number', description: 'Minimum confidence score (0-1, default: 0.7)' },
        },
        required: ['text'],
      },
    },
    {
      name: 'gui_automate_task',
      description: 'Automate a multi-step GUI task using visual automation.',
      inputSchema: {
        type: 'object',
        properties: {
          task_description: { type: 'string', description: 'Description of the task to automate' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                action: { type: 'string', enum: ['click', 'type', 'wait', 'key_press'], description: 'Action to perform' },
                target: { type: 'string', description: 'Target element or text' },
                value: { type: 'string', description: 'Value to type or key combination' },
                delay_ms: { type: 'number', description: 'Delay before next step (milliseconds)' },
              },
              required: ['action'],
            },
            description: 'List of steps to execute',
          },
        },
        required: ['task_description', 'steps'],
      },
    },
  ],
};

export async function createAdvancedGUISkill(
  containerId?: string,
  screenshotDir?: string,
  options?: { debug?: boolean; vncConfig?: { host: string; port: number; password?: string }; detectionConfig?: { engine: 'omniparser' | 'tesseract'; apiUrl?: string; confidence: number; timeout: number } }
): Promise<SkillInstance> {
  let guiTools: AgentToolHandler[] = [];

  if (options?.vncConfig) {
    try {
      const { createRealGUITools } = await import('@markus/gui');
      const result = await createRealGUITools({
        vnc: options.vncConfig,
        screenshot: {
          dir: screenshotDir ?? '/tmp/markus-screenshots',
          format: 'png',
          quality: 90,
        },
        detection: options.detectionConfig,
      });
      guiTools = result.tools as AgentToolHandler[];
      log.info('Advanced GUI tools initialized with VNC + detection');
    } catch (err) {
      log.warn('Failed to create advanced GUI tools, falling back to stubs', { error: String(err) });
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
      
      // 对于高级工具，提供更详细的说明
      if (tool.name.startsWith('gui_analyze') || tool.name.startsWith('gui_find') || 
          tool.name.startsWith('gui_click_element') || tool.name.startsWith('gui_type_to_element') ||
          tool.name.startsWith('gui_automate')) {
        return JSON.stringify({
          success: true,
          tool: tool.name,
          message: `Advanced GUI tool ${tool.name} would execute with args: ${JSON.stringify(args)}`,
          note: 'Real advanced GUI tools require @markus/gui package with OmniParser integration and proper container setup',
          required_params: ['containerId', 'screenshotDir'],
          capabilities: [
            'Visual element recognition using OmniParser',
            'GUI element detection and analysis',
            'Automated task execution',
            'Intelligent element interaction',
          ],
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