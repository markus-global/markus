export { VNCClient } from './vnc-client.js';
export { ScreenshotProvider } from './screenshot.js';
export { DesktopInput } from './input.js';
export { ElementDetector, type ElementDetectorConfig } from './element-detector.js';
export { VisualAutomation, type AutomationStep } from './visual-automation.js';
export { createRealGUITools } from './gui-agent-tools.js';
export type {
  VNCConfig,
  ScreenRegion,
  ScreenshotResult,
  Position,
  MouseButton,
  GUIElement,
  ElementQuery,
  GUIConfig,
} from './types.js';

export interface GUIAutomationController {
  getScreenInfo(): Promise<{ success: boolean; data?: any; message: string }>;
  captureScreenshot(): Promise<{ success: boolean; data?: any; message: string }>;
  analyzeScreen(): Promise<{ success: boolean; data?: any; message: string }>;
  executeCommand(command: any): Promise<{ success: boolean; data?: any; message: string }>;
}

export interface GUIAutomationOptions {
  containerId: string;
  display: string;
  debug: boolean;
}

/**
 * Legacy stub controller (kept for backward compatibility).
 * New code should use createRealGUITools() instead.
 */
export function createGUIAutomationController(options: GUIAutomationOptions): GUIAutomationController {
  return {
    async getScreenInfo() {
      return { success: true, data: { width: 1920, height: 1080 }, message: 'Screen info retrieved (stub)' };
    },
    async captureScreenshot() {
      return { success: true, data: { screenshotPath: `/tmp/screenshot-${Date.now()}.png`, width: 1920, height: 1080 }, message: 'Screenshot captured (stub)' };
    },
    async analyzeScreen() {
      return { success: true, data: { elements: [], metadata: { stub: true } }, message: 'Screen analyzed (stub)' };
    },
    async executeCommand(command: any) {
      return { success: true, data: command, message: 'Command executed (stub)' };
    },
  };
}

/**
 * Legacy stub tools (kept for backward compatibility).
 * New code should use createRealGUITools() instead.
 */
export function createGUITools(containerId: string, screenshotDir: string): any[] {
  return [
    {
      name: 'gui-stub',
      description: 'GUI automation tool stub',
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string', description: 'GUI action' } },
        required: ['action'],
      },
      async execute(params: Record<string, unknown>): Promise<string> {
        return JSON.stringify({ success: true, message: `GUI operation "${params.action}" executed (stub)`, data: params });
      },
    },
  ];
}
