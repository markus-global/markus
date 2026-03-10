import { createLogger } from '@markus/shared';
import type { VNCClient } from './vnc-client.js';
import { ScreenshotProvider } from './screenshot.js';
import { DesktopInput } from './input.js';
import { ElementDetector, type ElementDetectorConfig } from './element-detector.js';
import type { GUIElement, ElementQuery, ScreenRegion, GUIConfig } from './types.js';

const log = createLogger('visual-automation');

export interface AutomationStep {
  action: 'click' | 'type' | 'key' | 'wait' | 'screenshot' | 'scroll';
  target?: ElementQuery;
  position?: { x: number; y: number };
  text?: string;
  key?: string;
  keys?: string[];
  timeout?: number;
  direction?: 'up' | 'down';
  amount?: number;
}

/**
 * High-level visual automation that combines screenshot + element detection + input.
 * Provides smart actions like "click the Submit button" or "type into the search field".
 */
export class VisualAutomation {
  private vncClient: VNCClient;
  private screenshot: ScreenshotProvider;
  private input: DesktopInput;
  private detector: ElementDetector;

  constructor(
    vncClient: VNCClient,
    screenshot: ScreenshotProvider,
    input: DesktopInput,
    detectorConfig: ElementDetectorConfig,
  ) {
    this.vncClient = vncClient;
    this.screenshot = screenshot;
    this.input = input;
    this.detector = new ElementDetector(detectorConfig);
  }

  /**
   * Click on an element found by query (text, type, or position).
   */
  async clickElement(query: ElementQuery): Promise<{ success: boolean; element?: GUIElement; error?: string }> {
    const base64 = await this.screenshot.captureBase64();
    const element = await this.detector.findElement(base64, query);

    if (!element) {
      return { success: false, error: `Element not found: ${JSON.stringify(query)}` };
    }

    const cx = element.bounds.x + element.bounds.width / 2;
    const cy = element.bounds.y + element.bounds.height / 2;
    await this.input.mouseClick(cx, cy);

    log.debug('Clicked element', { query, element: element.text ?? element.label, x: cx, y: cy });
    return { success: true, element };
  }

  /**
   * Type text into an element found by query. Clicks the element first to focus it.
   */
  async typeToElement(query: ElementQuery, text: string): Promise<{ success: boolean; element?: GUIElement; error?: string }> {
    const clickResult = await this.clickElement(query);
    if (!clickResult.success) return clickResult;

    await new Promise(r => setTimeout(r, 100));
    await this.input.typeText(text);

    log.debug('Typed to element', { query, textLength: text.length });
    return { success: true, element: clickResult.element };
  }

  /**
   * Wait until an element matching the query appears on screen.
   */
  async waitForElement(query: ElementQuery, timeoutMs: number = 10000): Promise<GUIElement | null> {
    const start = Date.now();
    const pollInterval = 500;

    while (Date.now() - start < timeoutMs) {
      const base64 = await this.screenshot.captureBase64();
      const element = await this.detector.findElement(base64, query);
      if (element) {
        log.debug('Element found after waiting', { query, elapsedMs: Date.now() - start });
        return element;
      }
      await new Promise(r => setTimeout(r, pollInterval));
    }

    log.debug('Element not found within timeout', { query, timeoutMs });
    return null;
  }

  /**
   * Execute a sequence of automation steps.
   */
  async executeWorkflow(steps: AutomationStep[]): Promise<Array<{ step: number; success: boolean; error?: string }>> {
    const results: Array<{ step: number; success: boolean; error?: string }> = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      try {
        switch (step.action) {
          case 'click':
            if (step.target) {
              const r = await this.clickElement(step.target);
              results.push({ step: i, success: r.success, error: r.error });
            } else if (step.position) {
              await this.input.mouseClick(step.position.x, step.position.y);
              results.push({ step: i, success: true });
            } else {
              results.push({ step: i, success: false, error: 'Click needs target or position' });
            }
            break;

          case 'type':
            if (step.target && step.text) {
              const r = await this.typeToElement(step.target, step.text);
              results.push({ step: i, success: r.success, error: r.error });
            } else if (step.text) {
              await this.input.typeText(step.text);
              results.push({ step: i, success: true });
            } else {
              results.push({ step: i, success: false, error: 'Type needs text' });
            }
            break;

          case 'key':
            if (step.keys) {
              await this.input.keyCombination(step.keys);
            } else if (step.key) {
              await this.input.keyPress(step.key);
            }
            results.push({ step: i, success: true });
            break;

          case 'wait':
            if (step.target) {
              const el = await this.waitForElement(step.target, step.timeout ?? 10000);
              results.push({ step: i, success: el !== null, error: el ? undefined : 'Timeout waiting for element' });
            } else {
              await new Promise(r => setTimeout(r, step.timeout ?? 1000));
              results.push({ step: i, success: true });
            }
            break;

          case 'screenshot':
            await this.screenshot.capture();
            results.push({ step: i, success: true });
            break;

          case 'scroll':
            const dir = step.direction ?? 'down';
            const pos = step.position ?? { x: 960, y: 540 };
            await this.input.scroll(pos.x, pos.y, dir, step.amount ?? 3);
            results.push({ step: i, success: true });
            break;

          default:
            results.push({ step: i, success: false, error: `Unknown action: ${step.action}` });
        }

        // Small delay between steps
        await new Promise(r => setTimeout(r, 100));
      } catch (err) {
        results.push({ step: i, success: false, error: String(err) });
      }
    }

    return results;
  }

  /**
   * Get the element detector for direct use.
   */
  getDetector(): ElementDetector {
    return this.detector;
  }
}
