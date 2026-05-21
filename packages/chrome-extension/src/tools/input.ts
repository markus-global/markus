/**
 * Input tools: click, fill, fill_form, type_text, press_key, hover, drag, handle_dialog, upload_file
 *
 * These use chrome.debugger CDP commands for input simulation.
 * Element targeting uses the "uid" from accessibility tree snapshots.
 */

import type { PageManager } from '../page-manager.js';
import { ensureDebugger } from '../debugger-helper.js';

async function cdp(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

/**
 * Resolve a snapshot uid to DOM coordinates via JS evaluation.
 * The uid corresponds to an aria-snapshot element with a data-uid attribute
 * or a node from the accessibility tree.
 */
async function resolveUidToCoords(tabId: number, uid: string): Promise<{ x: number; y: number }> {
  const script = `
    (function() {
      // Try data-uid attribute first
      let el = document.querySelector('[data-uid="${uid}"]');
      if (!el) {
        // Try aria-label or other attributes
        const all = document.querySelectorAll('*');
        for (const e of all) {
          if (e.getAttribute('data-snapshot-uid') === '${uid}') { el = e; break; }
        }
      }
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()
  `;
  const result = await cdp(tabId, 'Runtime.evaluate', {
    expression: script, returnByValue: true,
  }) as { result?: { value?: { x: number; y: number } | null } };

  if (!result?.result?.value) {
    throw new Error(`Element with uid "${uid}" not found on page`);
  }
  return result.result.value;
}

async function dispatchClick(tabId: number, x: number, y: number): Promise<void> {
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1,
  });
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
  });
}

export function registerInputTools(
  register: (name: string, handler: (params: Record<string, unknown>) => Promise<string>) => void,
  pm: PageManager,
): void {

  register('click', async (params) => {
    const uid = params.uid as string;
    if (!uid) throw new Error('uid is required');
    const tabId = pm.resolveTabId(params);
    await ensureDebugger(pm, tabId);

    const { x, y } = await resolveUidToCoords(tabId, uid);
    await dispatchClick(tabId, x, y);
    return `Clicked element ${uid} at (${Math.round(x)}, ${Math.round(y)})`;
  });

  register('fill', async (params) => {
    const uid = params.uid as string;
    const value = params.value as string;
    if (!uid) throw new Error('uid is required');
    if (value === undefined) throw new Error('value is required');
    const tabId = pm.resolveTabId(params);
    await ensureDebugger(pm, tabId);

    const { x, y } = await resolveUidToCoords(tabId, uid);
    await dispatchClick(tabId, x, y);
    // Select all then replace
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 }); // Ctrl+A
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
    await cdp(tabId, 'Input.insertText', { text: value });
    return `Filled element ${uid} with "${value}"`;
  });

  register('fill_form', async (params) => {
    const fields = params.fields as Array<{ uid: string; value: string }>;
    if (!fields || !Array.isArray(fields)) throw new Error('fields array is required');
    const tabId = pm.resolveTabId(params);
    await ensureDebugger(pm, tabId);

    const results: string[] = [];
    for (const field of fields) {
      const { x, y } = await resolveUidToCoords(tabId, field.uid);
      await dispatchClick(tabId, x, y);
      await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
      await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
      await cdp(tabId, 'Input.insertText', { text: field.value });
      results.push(`${field.uid}: "${field.value}"`);
    }
    return `Filled ${results.length} fields:\n${results.join('\n')}`;
  });

  register('type_text', async (params) => {
    const text = params.text as string;
    if (!text) throw new Error('text is required');
    const tabId = pm.resolveTabId(params);
    await ensureDebugger(pm, tabId);

    await cdp(tabId, 'Input.insertText', { text });
    return `Typed "${text}"`;
  });

  register('press_key', async (params) => {
    const key = params.key as string;
    if (!key) throw new Error('key is required');
    const tabId = pm.resolveTabId(params);
    await ensureDebugger(pm, tabId);

    const parts = key.split('+');
    let modifiers = 0;
    const modifierKeys: string[] = [];
    for (const part of parts.slice(0, -1)) {
      const lower = part.toLowerCase().trim();
      if (lower === 'control' || lower === 'ctrl') { modifiers |= 2; modifierKeys.push(lower); }
      else if (lower === 'alt') { modifiers |= 1; modifierKeys.push(lower); }
      else if (lower === 'shift') { modifiers |= 8; modifierKeys.push(lower); }
      else if (lower === 'meta' || lower === 'command' || lower === 'cmd') { modifiers |= 4; modifierKeys.push(lower); }
    }
    const mainKey = parts[parts.length - 1].trim();

    await cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: mainKey, modifiers,
    });
    await cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: mainKey, modifiers,
    });
    return `Pressed key: ${key}`;
  });

  register('hover', async (params) => {
    const uid = params.uid as string;
    if (!uid) throw new Error('uid is required');
    const tabId = pm.resolveTabId(params);
    await ensureDebugger(pm, tabId);

    const { x, y } = await resolveUidToCoords(tabId, uid);
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y,
    });
    return `Hovered over element ${uid} at (${Math.round(x)}, ${Math.round(y)})`;
  });

  register('drag', async (params) => {
    const fromUid = params.from_uid as string ?? params.fromUid as string;
    const toUid = params.to_uid as string ?? params.toUid as string;
    if (!fromUid || !toUid) throw new Error('from_uid and to_uid are required');
    const tabId = pm.resolveTabId(params);
    await ensureDebugger(pm, tabId);

    const from = await resolveUidToCoords(tabId, fromUid);
    const to = await resolveUidToCoords(tabId, toUid);

    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left' });
    // Intermediate move steps for smooth drag
    const steps = 5;
    for (let i = 1; i <= steps; i++) {
      const x = from.x + (to.x - from.x) * (i / steps);
      const y = from.y + (to.y - from.y) * (i / steps);
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    }
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left' });

    return `Dragged from ${fromUid} to ${toUid}`;
  });

  register('handle_dialog', async (params) => {
    const accept = params.accept !== false;
    const promptText = params.promptText as string | undefined;
    const tabId = pm.resolveTabId(params);
    await ensureDebugger(pm, tabId);

    await cdp(tabId, 'Page.handleJavaScriptDialog', {
      accept,
      ...(promptText !== undefined ? { promptText } : {}),
    });
    return `Dialog ${accept ? 'accepted' : 'dismissed'}`;
  });

  register('upload_file', async (params) => {
    const uid = params.uid as string;
    const filePath = params.filePath as string ?? params.file_path as string;
    if (!uid || !filePath) throw new Error('uid and filePath are required');
    const tabId = pm.resolveTabId(params);
    await ensureDebugger(pm, tabId);

    // Resolve uid to DOM node
    const script = `
      (function() {
        let el = document.querySelector('[data-uid="${uid}"]');
        if (!el) {
          const all = document.querySelectorAll('input[type="file"]');
          for (const e of all) {
            if (e.getAttribute('data-snapshot-uid') === '${uid}') { el = e; break; }
          }
        }
        return el ? true : false;
      })()
    `;
    const found = await cdp(tabId, 'Runtime.evaluate', {
      expression: script, returnByValue: true,
    }) as { result?: { value?: boolean } };

    if (!found?.result?.value) {
      throw new Error(`File input with uid "${uid}" not found`);
    }

    // Use DOM.setFileInputFiles via the node
    const docResult = await cdp(tabId, 'DOM.getDocument') as { root?: { nodeId?: number } };
    const nodeResult = await cdp(tabId, 'DOM.querySelector', {
      nodeId: docResult?.root?.nodeId,
      selector: `[data-uid="${uid}"]`,
    }) as { nodeId?: number };

    if (nodeResult?.nodeId) {
      await cdp(tabId, 'DOM.setFileInputFiles', {
        files: [filePath],
        nodeId: nodeResult.nodeId,
      });
      return `Uploaded file "${filePath}" to element ${uid}`;
    }

    throw new Error(`Could not set file on element ${uid}`);
  });
}
