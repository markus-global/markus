/**
 * CDP tool backend for the Electron embedded browser.
 *
 * Implements the same tool names as chrome-devtools-mcp / markus-browser-mcp
 * so AgentManager + BrowserSessionManager can route unchanged.
 *
 * Duck-typed to match `@markus/core` EmbeddedBrowserHost (desktop does not
 * depend on core directly; the host is injected onto AgentManager at runtime).
 */
import {
  captureEmbeddedBrowser,
  createEmbeddedBrowser,
  debuggerSendEmbeddedBrowser,
  destroyEmbeddedBrowser,
  embeddedBrowserAction,
  executeInEmbeddedBrowser,
  getEmbeddedBrowserState,
  listEmbeddedBrowserPages,
  navigateEmbeddedBrowser,
  resolveEmbeddedBrowserId,
  saveEmbeddedBrowserScreenshot,
  selectEmbeddedBrowserPage,
} from './embedded-browser.js';

export interface EmbeddedBrowserToolResult {
  content: string;
  error?: string;
}

export interface EmbeddedBrowserHost {
  available(): boolean;
  callTool(name: string, args: Record<string, unknown>): Promise<EmbeddedBrowserToolResult>;
}

function formatPageList(): string {
  const pages = listEmbeddedBrowserPages();
  if (pages.length === 0) return 'No open pages';
  return pages
    .map(p => `${p.pageId}: ${p.url}${p.selected ? ' [selected]' : ''}`)
    .join('\n');
}

function resolvePageArgs(args: Record<string, unknown>): string {
  const pageId = (args.pageId ?? args._pageId) as number | undefined;
  const id = resolveEmbeddedBrowserId(pageId);
  if (!id) {
    throw new Error(pageId !== undefined ? `Page ${pageId} not found` : 'No embedded browser page selected');
  }
  return id;
}

async function cdp(id: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
  const res = await debuggerSendEmbeddedBrowser(id, method, params);
  if (!res.ok) throw new Error(res.error || `CDP ${method} failed`);
  return res.result;
}

async function resolveUidToCoords(id: string, uid: string): Promise<{ x: number; y: number }> {
  const script = `
    (function() {
      let el = document.querySelector('[data-uid="${uid}"]');
      if (!el) {
        for (const e of document.querySelectorAll('[data-snapshot-uid]')) {
          if (e.getAttribute('data-snapshot-uid') === '${uid}') { el = e; break; }
        }
      }
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()
  `;
  const res = await executeInEmbeddedBrowser(id, script);
  if (!res.ok || !res.result || typeof res.result !== 'object') {
    throw new Error(`Element with uid "${uid}" not found on page`);
  }
  const coords = res.result as { x: number; y: number };
  return coords;
}

async function dispatchClick(id: string, x: number, y: number): Promise<void> {
  await cdp(id, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1,
  });
  await cdp(id, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
  });
}

async function waitForLoad(id: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = getEmbeddedBrowserState(id);
    if (state.ok) {
      const ready = await executeInEmbeddedBrowser(id, 'document.readyState');
      if (ready.ok && ready.result === 'complete') return;
    }
    await new Promise(r => setTimeout(r, 150));
  }
}

async function handleTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'new_page':
    case 'open_page': {
      const url = (args.url as string) || 'about:blank';
      const timeout = (args.timeout as number) || 15000;
      const browserId = `agent_page_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const created = await createEmbeddedBrowser(browserId, url);
      if (!created.ok || created.pageId === undefined) {
        throw new Error(created.error || 'Failed to create embedded page');
      }
      selectEmbeddedBrowserPage(created.pageId);
      if (url !== 'about:blank') {
        await waitForLoad(browserId, timeout);
      }
      return formatPageList();
    }

    case 'close_page': {
      const pageId = args.pageId as number;
      if (pageId === undefined) throw new Error('pageId is required');
      const id = resolveEmbeddedBrowserId(pageId);
      if (!id) throw new Error(`Page ${pageId} not found`);
      await destroyEmbeddedBrowser(id);
      return formatPageList();
    }

    case 'list_pages':
      return formatPageList();

    case 'select_page': {
      const pageId = args.pageId as number;
      if (pageId === undefined) throw new Error('pageId is required');
      const res = selectEmbeddedBrowserPage(pageId);
      if (!res.ok) throw new Error(res.error || `Page ${pageId} not found`);
      return formatPageList();
    }

    case 'navigate_page': {
      const id = resolvePageArgs(args);
      const action = args.action as string | undefined;
      const url = args.url as string | undefined;
      const timeout = (args.timeout as number) || 15000;
      if (action === 'back' || action === 'forward' || action === 'reload') {
        const res = embeddedBrowserAction(id, action);
        if (!res.ok) throw new Error(res.error || `Action ${action} failed`);
      } else if (url) {
        const res = navigateEmbeddedBrowser(id, url);
        if (!res.ok) throw new Error(res.error || 'Navigate failed');
        await waitForLoad(id, timeout);
      } else {
        throw new Error('url or action is required');
      }
      const state = getEmbeddedBrowserState(id);
      return `Navigated to ${state.url || url || action}`;
    }

    case 'wait_for': {
      const id = resolvePageArgs(args);
      const text = args.text as string;
      if (!text) throw new Error('text is required');
      const timeout = (args.timeout as number) || 30000;
      const start = Date.now();
      const escaped = JSON.stringify(text);
      while (Date.now() - start < timeout) {
        const res = await executeInEmbeddedBrowser(
          id,
          `document.body && document.body.innerText && document.body.innerText.includes(${escaped})`,
        );
        if (res.ok && res.result === true) return `Found text: ${text}`;
        await new Promise(r => setTimeout(r, 200));
      }
      throw new Error(`Timeout waiting for text: ${text}`);
    }

    case 'click': {
      const id = resolvePageArgs(args);
      const uid = args.uid as string;
      if (!uid) throw new Error('uid is required');
      const { x, y } = await resolveUidToCoords(id, uid);
      await dispatchClick(id, x, y);
      return `Clicked element ${uid} at (${Math.round(x)}, ${Math.round(y)})`;
    }

    case 'fill': {
      const id = resolvePageArgs(args);
      const uid = args.uid as string;
      const value = args.value as string;
      if (!uid) throw new Error('uid is required');
      if (value === undefined) throw new Error('value is required');
      const { x, y } = await resolveUidToCoords(id, uid);
      await dispatchClick(id, x, y);
      await cdp(id, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
      await cdp(id, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
      await cdp(id, 'Input.insertText', { text: value });
      return `Filled element ${uid} with "${value}"`;
    }

    case 'fill_form': {
      const id = resolvePageArgs(args);
      const fields = args.fields as Array<{ uid: string; value: string }>;
      if (!fields || !Array.isArray(fields)) throw new Error('fields array is required');
      const results: string[] = [];
      for (const field of fields) {
        const { x, y } = await resolveUidToCoords(id, field.uid);
        await dispatchClick(id, x, y);
        await cdp(id, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
        await cdp(id, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
        await cdp(id, 'Input.insertText', { text: field.value });
        results.push(`${field.uid}: "${field.value}"`);
      }
      return `Filled ${results.length} fields:\n${results.join('\n')}`;
    }

    case 'type_text': {
      const id = resolvePageArgs(args);
      const text = args.text as string;
      if (!text) throw new Error('text is required');
      await cdp(id, 'Input.insertText', { text });
      return `Typed "${text}"`;
    }

    case 'press_key': {
      const id = resolvePageArgs(args);
      const key = args.key as string;
      if (!key) throw new Error('key is required');
      const parts = key.split('+');
      let modifiers = 0;
      for (const part of parts.slice(0, -1)) {
        const lower = part.toLowerCase().trim();
        if (lower === 'control' || lower === 'ctrl') modifiers |= 2;
        else if (lower === 'alt') modifiers |= 1;
        else if (lower === 'shift') modifiers |= 8;
        else if (lower === 'meta' || lower === 'command' || lower === 'cmd') modifiers |= 4;
      }
      const mainKey = parts[parts.length - 1]!.trim();
      await cdp(id, 'Input.dispatchKeyEvent', { type: 'keyDown', key: mainKey, modifiers });
      await cdp(id, 'Input.dispatchKeyEvent', { type: 'keyUp', key: mainKey, modifiers });
      return `Pressed key: ${key}`;
    }

    case 'hover': {
      const id = resolvePageArgs(args);
      const uid = args.uid as string;
      if (!uid) throw new Error('uid is required');
      const { x, y } = await resolveUidToCoords(id, uid);
      await cdp(id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      return `Hovered over element ${uid} at (${Math.round(x)}, ${Math.round(y)})`;
    }

    case 'drag': {
      const id = resolvePageArgs(args);
      const fromUid = (args.from_uid as string) ?? (args.fromUid as string);
      const toUid = (args.to_uid as string) ?? (args.toUid as string);
      if (!fromUid || !toUid) throw new Error('from_uid and to_uid are required');
      const from = await resolveUidToCoords(id, fromUid);
      const to = await resolveUidToCoords(id, toUid);
      await cdp(id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
      await cdp(id, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left' });
      for (let i = 1; i <= 5; i++) {
        const x = from.x + (to.x - from.x) * (i / 5);
        const y = from.y + (to.y - from.y) * (i / 5);
        await cdp(id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      }
      await cdp(id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left' });
      return `Dragged from ${fromUid} to ${toUid}`;
    }

    case 'handle_dialog': {
      const id = resolvePageArgs(args);
      const accept = args.accept !== false;
      const promptText = args.promptText as string | undefined;
      await cdp(id, 'Page.handleJavaScriptDialog', {
        accept,
        ...(promptText !== undefined ? { promptText } : {}),
      });
      return `Dialog ${accept ? 'accepted' : 'dismissed'}`;
    }

    case 'upload_file':
      throw new Error('upload_file is not supported in the embedded browser backend');

    case 'take_screenshot': {
      const id = resolvePageArgs(args);
      const format = ((args.format as string) || 'png').toLowerCase();
      if (format === 'png' || !args.fullPage) {
        const shot = await captureEmbeddedBrowser(id);
        if (!shot.ok || !shot.path) throw new Error(shot.error || 'Screenshot failed');
        return shot.path;
      }
      const cdpParams: Record<string, unknown> = {
        format: format === 'jpg' || format === 'jpeg' ? 'jpeg' : 'png',
      };
      if (typeof args.quality === 'number') cdpParams.quality = args.quality;
      if (args.fullPage === true) cdpParams.captureBeyondViewport = true;
      const result = await cdp(id, 'Page.captureScreenshot', cdpParams) as { data?: string };
      if (!result?.data) throw new Error('Screenshot failed');
      const mime = cdpParams.format === 'jpeg' ? 'jpeg' : 'png';
      const buf = Buffer.from(result.data, 'base64');
      if (buf.length === 0) throw new Error('Screenshot came back empty: page has not painted yet. Retry in a moment.');
      return saveEmbeddedBrowserScreenshot(buf, mime);
    }

    case 'take_snapshot': {
      const id = resolvePageArgs(args);
      const script = `(() => {
        document.querySelectorAll('[data-uid]').forEach(el => el.removeAttribute('data-uid'));
        const selectors = 'a, button, input, textarea, select, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [contenteditable="true"]';
        const els = [...document.querySelectorAll(selectors)].filter(el => {
          const r = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        });
        const lines = [];
        els.forEach((el, i) => {
          const uid = 'e' + (i + 1);
          el.setAttribute('data-uid', uid);
          const role = el.tagName.toLowerCase();
          const name = (el.getAttribute('aria-label')
            || el.getAttribute('placeholder')
            || el.getAttribute('title')
            || (el instanceof HTMLInputElement ? el.value : '')
            || (el.textContent || '')).trim().replace(/\\s+/g, ' ').slice(0, 80);
          lines.push('[' + uid + '] ' + role + (name ? ' "' + name + '"' : ''));
        });
        return lines.length ? lines.join('\\n') : 'Empty accessibility tree';
      })()`;
      const res = await executeInEmbeddedBrowser(id, script);
      if (!res.ok) throw new Error(res.error || 'Snapshot failed');
      return String(res.result ?? 'Empty accessibility tree');
    }

    case 'evaluate_script': {
      const id = resolvePageArgs(args);
      const expression = args.expression as string;
      if (!expression) throw new Error('expression is required');
      const result = await cdp(id, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      }) as {
        result?: { value?: unknown; description?: string };
        exceptionDetails?: { text?: string; exception?: { description?: string; value?: unknown } };
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
    }

    case 'get_console_message':
    case 'list_console_messages':
      return 'Console message capture is limited in the embedded browser backend.';

    case 'lighthouse_audit':
      return 'Lighthouse audits are not available in the embedded browser backend.';

    case 'list_network_requests':
    case 'get_network_request':
      return 'Network request inspection is not available in the embedded browser backend.';

    case 'emulate': {
      const id = resolvePageArgs(args);
      const width = args.width as number | undefined;
      const height = args.height as number | undefined;
      if (width && height) {
        await cdp(id, 'Emulation.setDeviceMetricsOverride', {
          width, height,
          deviceScaleFactor: (args.deviceScaleFactor as number) || 1,
          mobile: args.mobile === true,
        });
      }
      if (typeof args.userAgent === 'string') {
        await cdp(id, 'Emulation.setUserAgentOverride', { userAgent: args.userAgent });
      }
      return 'Emulation applied';
    }

    case 'resize_page': {
      const id = resolvePageArgs(args);
      const width = args.width as number;
      const height = args.height as number;
      if (!width || !height) throw new Error('width and height are required');
      await cdp(id, 'Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false,
      });
      return `Resized to ${width}x${height}`;
    }

    default:
      throw new Error(`Unsupported embedded browser tool: ${name}`);
  }
}

export function createEmbeddedBrowserHost(): EmbeddedBrowserHost {
  return {
    // Available as soon as desktop wires the host — pages may be created lazily.
    available: () => true,
    callTool: async (name, args): Promise<EmbeddedBrowserToolResult> => {
      try {
        const content = await handleTool(name, args);
        return { content };
      } catch (err) {
        return { content: '', error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
