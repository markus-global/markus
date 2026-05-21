/**
 * Inspection tools: take_screenshot, take_snapshot, evaluate_script,
 * get_console_message, list_console_messages, lighthouse_audit
 */

import type { PageManager } from '../page-manager.js';
import { ensureDebugger } from '../debugger-helper.js';

async function cdp(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// Console message storage per tab
const consoleMessages = new Map<number, Array<{ id: number; level: string; text: string; url?: string; timestamp: number }>>();
let nextMsgId = 1;

export function setupConsoleListener(): void {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (method === 'Runtime.consoleAPICalled' && source.tabId) {
      const p = params as { type: string; args?: Array<{ value?: unknown; description?: string }>; timestamp?: number };
      const text = (p.args ?? []).map(a => a.description ?? String(a.value ?? '')).join(' ');
      let messages = consoleMessages.get(source.tabId);
      if (!messages) {
        messages = [];
        consoleMessages.set(source.tabId, messages);
      }
      messages.push({
        id: nextMsgId++,
        level: p.type ?? 'log',
        text,
        timestamp: p.timestamp ?? Date.now(),
      });
      // Keep last 200 messages per tab
      if (messages.length > 200) messages.splice(0, messages.length - 200);
    }
  });
}

export function registerInspectionTools(
  register: (name: string, handler: (params: Record<string, unknown>) => Promise<string>) => void,
  pm: PageManager,
): void {

  register('take_screenshot', async (params) => {
    const tabId = pm.resolveTabId(params);
    await ensureDebugger(pm, tabId);

    const format = (params.format as string) || 'png';
    const quality = params.quality as number | undefined;
    const fullPage = params.fullPage === true;

    const cdpParams: Record<string, unknown> = {
      format: format === 'jpg' ? 'jpeg' : format,
    };
    if (quality !== undefined) cdpParams.quality = quality;
    if (fullPage) cdpParams.captureBeyondViewport = true;

    const result = await cdp(tabId, 'Page.captureScreenshot', cdpParams) as { data?: string };
    if (!result?.data) throw new Error('Screenshot failed');

    return `data:image/${format};base64,${result.data}`;
  });

  register('take_snapshot', async (params) => {
    const tabId = pm.resolveTabId(params);
    await ensureDebugger(pm, tabId);

    // Get accessibility tree
    const result = await cdp(tabId, 'Accessibility.getFullAXTree') as {
      nodes?: Array<{
        nodeId: string;
        role?: { value?: string };
        name?: { value?: string };
        properties?: Array<{ name: string; value: { value?: unknown } }>;
        childIds?: string[];
        backendDOMNodeId?: number;
      }>;
    };

    if (!result?.nodes || result.nodes.length === 0) {
      return 'Empty accessibility tree';
    }

    const lines: string[] = [];
    const nodeMap = new Map(result.nodes.map(n => [n.nodeId, n]));
    let uidCounter = 1;

    function walk(nodeId: string, depth: number): void {
      const node = nodeMap.get(nodeId);
      if (!node) return;

      const role = node.role?.value ?? '';
      const name = node.name?.value ?? '';

      // Skip generic/none roles and unnamed nodes at root level
      if (role === 'none' || role === 'generic') {
        for (const childId of node.childIds ?? []) {
          walk(childId, depth);
        }
        return;
      }

      if (role || name) {
        const uid = `e${uidCounter++}`;
        const indent = '  '.repeat(depth);
        const nameStr = name ? ` "${name}"` : '';
        lines.push(`${indent}[${uid}] ${role}${nameStr}`);

        for (const childId of node.childIds ?? []) {
          walk(childId, depth + 1);
        }
      }
    }

    // Start from root
    if (result.nodes.length > 0) {
      walk(result.nodes[0].nodeId, 0);
    }

    return lines.length > 0 ? lines.join('\n') : 'Empty accessibility tree';
  });

  register('evaluate_script', async (params) => {
    const expression = params.expression as string;
    if (!expression) throw new Error('expression is required');
    const tabId = pm.resolveTabId(params);
    await ensureDebugger(pm, tabId);

    const result = await cdp(tabId, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }) as {
      result?: { value?: unknown; description?: string };
      exceptionDetails?: {
        text?: string;
        exception?: { description?: string; value?: unknown };
      };
    };

    if (result?.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description
        ?? String(result.exceptionDetails.exception?.value ?? '')
        ?? result.exceptionDetails.text
        ?? 'Unknown error';
      throw new Error(`Script error: ${detail}`);
    }

    const value = result?.result?.value;
    if (value === undefined) return result?.result?.description ?? 'undefined';
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  });

  register('get_console_message', async (params) => {
    const msgId = params.msgid as number ?? params.id as number;
    if (msgId === undefined) throw new Error('msgid is required');
    const tabId = pm.resolveTabId(params);

    const messages = consoleMessages.get(tabId) ?? [];
    const msg = messages.find(m => m.id === msgId);
    if (!msg) return `Console message ${msgId} not found`;

    return `[${msg.level}] ${msg.text}`;
  });

  register('list_console_messages', async (params) => {
    const tabId = pm.resolveTabId(params);
    const messages = consoleMessages.get(tabId) ?? [];

    if (messages.length === 0) return 'No console messages';

    return messages.map(m => `${m.id}: [${m.level}] ${m.text}`).join('\n');
  });

  register('lighthouse_audit', async (params) => {
    const tabId = pm.resolveTabId(params);
    const categories = (params.categories as string[]) ?? ['accessibility', 'best-practices', 'seo'];

    // Lighthouse is not available via chrome.debugger — provide a basic a11y audit instead
    await ensureDebugger(pm, tabId);

    const result = await cdp(tabId, 'Accessibility.getFullAXTree') as {
      nodes?: Array<{ role?: { value?: string }; name?: { value?: string } }>;
    };

    const nodes = result?.nodes ?? [];
    const issues: string[] = [];

    // Basic accessibility checks
    let imagesWithoutAlt = 0;
    let buttonsWithoutLabel = 0;
    let linksWithoutText = 0;

    for (const node of nodes) {
      const role = node.role?.value;
      const name = node.name?.value;
      if (role === 'img' && !name) imagesWithoutAlt++;
      if (role === 'button' && !name) buttonsWithoutLabel++;
      if (role === 'link' && !name) linksWithoutText++;
    }

    if (imagesWithoutAlt > 0) issues.push(`${imagesWithoutAlt} image(s) without alt text`);
    if (buttonsWithoutLabel > 0) issues.push(`${buttonsWithoutLabel} button(s) without labels`);
    if (linksWithoutText > 0) issues.push(`${linksWithoutText} link(s) without text`);

    const report = [
      `Accessibility Audit (${nodes.length} nodes analyzed)`,
      `Categories: ${categories.join(', ')}`,
      '',
      issues.length > 0 ? `Issues found:\n${issues.map(i => `  - ${i}`).join('\n')}` : 'No issues found',
    ];

    return report.join('\n');
  });
}
