/**
 * Embedded browser for the desktop right-panel preview.
 *
 * Uses Electron WebContentsView with a persistent session partition so logins
 * survive across app restarts. The React UI reports the panel's screen rect
 * via IPC; we sync the native view bounds to that rect.
 *
 * Agent control: webContents.debugger speaks CDP — the same protocol used by
 * chrome-devtools-mcp / the Chrome extension bridge.
 */
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebContentsView, session, type BrowserWindow } from 'electron';
import { getMainWindow } from './window.js';

const PARTITION = 'persist:markus-embedded-browser';

/**
 * Accept http(s), file://, about:blank, and bare filesystem paths so the
 * address bar / agent tools can open local files (e.g. /Users/.../logo.png).
 */
export function normalizeEmbeddedBrowserUrl(raw: string): string {
  const next = raw.trim();
  if (!next) return next;
  if (next === 'about:blank') return next;

  if (/^[a-z][a-z0-9+.-]*:/i.test(next)) {
    if (/^file:/i.test(next)) {
      try { return new URL(next).href; } catch { /* repair below */ }
      const rest = next.replace(/^file:/i, '').replace(/\\/g, '/');
      const path = rest.replace(/^\/\/(localhost)?/i, '') || rest;
      const abs = path.startsWith('/') || /^[a-zA-Z]:\//.test(path)
        ? (path.startsWith('/') && /^\/[a-zA-Z]:\//.test(path) ? path.slice(1) : path)
        : `/${path}`;
      try { return pathToFileURL(abs).href; } catch { return next; }
    }
    return next;
  }

  // Absolute local paths
  if (next.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(next) || next.startsWith('\\\\')) {
    try { return pathToFileURL(next).href; } catch { return next; }
  }

  return `https://${next}`;
}

/** If url is a local file:// directory, return its filesystem path; else null. */
export function localDirectoryPathFromUrl(url: string): string | null {
  if (!url || !/^file:/i.test(url)) return null;
  try {
    const p = fileURLToPath(url);
    if (existsSync(p) && statSync(p).isDirectory()) return p;
  } catch { /* ignore */ }
  return null;
}

/** Working viewport while the native view is hidden (agent CDP / layout). */
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

interface BrowserSlot {
  id: string;
  pageId: number;
  view: WebContentsView;
  /** Whether the view is painted on screen (not whether the page has a size). */
  visible: boolean;
  /** Defer first load until a non-zero working viewport exists. */
  pendingUrl?: string;
  /** True while webContents is loading a document. */
  isLoading: boolean;
  /** Last load failure message (cleared on next successful start). */
  loadError?: string;
  /**
   * When set, navigation targeted a local directory. Chromium cannot render
   * folders — UI should show a friendly prompt and hide the native view.
   */
  directoryPath?: string;
  /** file:// URL corresponding to directoryPath (for the address bar). */
  directoryUrl?: string;
  /** True after agent CDP Emulation.setDeviceMetricsOverride; cleared when UI size changes. */
  hasDeviceMetricsOverride?: boolean;
  lastUiX?: number;
  lastUiY?: number;
  lastUiWidth?: number;
  lastUiHeight?: number;
  /** True after we've aligned CSS viewport to the painted host at least once. */
  layoutAligned?: boolean;
}

type ViewWithVisibility = WebContentsView & {
  setVisible?: (visible: boolean) => void;
};

/** Hide/show painting without destroying the page viewport (no 0×0 shrink). */
function setSlotPainted(slot: BrowserSlot, painted: boolean): void {
  slot.visible = painted;
  const view = slot.view as ViewWithVisibility;
  if (typeof view.setVisible === 'function') {
    try { view.setVisible(painted); } catch { /* ignore */ }
    return;
  }
  // Fallback for older Electron: park off-screen but keep width/height.
  const w = Math.max(slot.lastUiWidth ?? DEFAULT_VIEWPORT.width, 2);
  const h = Math.max(slot.lastUiHeight ?? DEFAULT_VIEWPORT.height, 2);
  try {
    if (painted) {
      view.setBounds({
        x: slot.lastUiX ?? 0,
        y: slot.lastUiY ?? 0,
        width: w,
        height: h,
      });
    } else {
      view.setBounds({ x: -10000, y: -10000, width: w, height: h });
    }
  } catch { /* ignore */ }
}

function ensureWorkingViewport(slot: BrowserSlot): void {
  const b = slot.view.getBounds();
  if (b.width >= 2 && b.height >= 2) return;
  const w = slot.lastUiWidth ?? DEFAULT_VIEWPORT.width;
  const h = slot.lastUiHeight ?? DEFAULT_VIEWPORT.height;
  slot.view.setBounds({
    x: slot.lastUiX ?? 0,
    y: slot.lastUiY ?? 0,
    width: w,
    height: h,
  });
  if (slot.lastUiWidth === undefined) slot.lastUiWidth = w;
  if (slot.lastUiHeight === undefined) slot.lastUiHeight = h;
}

function flushPendingUrl(slot: BrowserSlot): void {
  if (!slot.pendingUrl) return;
  ensureWorkingViewport(slot);
  const pending = normalizeEmbeddedBrowserUrl(slot.pendingUrl);
  slot.pendingUrl = undefined;
  if (applyDirectoryNavigation(slot, pending)) return;
  void slot.view.webContents.loadURL(pending).catch(() => {});
}

/** Intercept local directory navigations — Chromium returns ERR_FILE_NOT_FOUND. */
function applyDirectoryNavigation(slot: BrowserSlot, url: string): boolean {
  const dir = localDirectoryPathFromUrl(url);
  if (!dir) {
    slot.directoryPath = undefined;
    slot.directoryUrl = undefined;
    return false;
  }
  slot.directoryPath = dir;
  slot.directoryUrl = url;
  slot.isLoading = false;
  slot.loadError = undefined;
  try { slot.view.webContents.stop(); } catch { /* ignore */ }
  // Do not loadURL — React shows a folder prompt while the native view is hidden.
  emitPageEvent({
    type: 'directory',
    pageId: slot.pageId,
    browserId: slot.id,
    url,
    directoryPath: dir,
    isLoading: false,
    title: dir.split(/[/\\]/).filter(Boolean).pop() || dir,
  });
  return true;
}

const slots = new Map<string, BrowserSlot>();
const pageIdToSlotId = new Map<number, string>();
let nextPageId = 1;
let selectedPageId: number | null = null;

export type EmbeddedPageListener = (event: {
  type: 'opened' | 'closed' | 'navigated' | 'selected' | 'loading' | 'loaded' | 'load-failed' | 'directory';
  pageId: number;
  browserId: string;
  url?: string;
  title?: string;
  isLoading?: boolean;
  error?: string;
  directoryPath?: string;
}) => void;

const pageListeners = new Set<EmbeddedPageListener>();

export function onEmbeddedPageEvent(listener: EmbeddedPageListener): () => void {
  pageListeners.add(listener);
  return () => { pageListeners.delete(listener); };
}

function emitPageEvent(event: Parameters<EmbeddedPageListener>[0]): void {
  for (const listener of pageListeners) {
    try { listener(event); } catch { /* ignore */ }
  }
  // Also push to the renderer so the right panel can open/sync tabs.
  const win = getWin();
  if (win && !win.isDestroyed()) {
    win.webContents.send('browser:page-event', event);
  }
}

function getWin(): BrowserWindow | null {
  return getMainWindow();
}

function allocatePageId(id: string): number {
  const existing = slots.get(id);
  if (existing) return existing.pageId;
  const pageId = nextPageId++;
  pageIdToSlotId.set(pageId, id);
  return pageId;
}

/**
 * Open target=_blank / window.open into a right-panel tab instead of an OS popup.
 * Emits `opened` so the renderer creates a tab (browserId must not be `eb_*`).
 */
function openUrlInNewEmbeddedTab(rawUrl: string): void {
  const target = normalizeEmbeddedBrowserUrl(rawUrl || 'about:blank');
  if (!target) return;
  // Deny non-navigable schemes (javascript:, etc.)
  if (!/^(https?:|file:|about:)/i.test(target)) return;
  const newId = `rb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const created = createEmbeddedBrowser(newId, target);
  if (created.ok && created.pageId !== null && created.pageId !== undefined) {
    selectedPageId = created.pageId;
    emitPageEvent({
      type: 'selected',
      pageId: created.pageId,
      browserId: newId,
      url: target,
      title: target === 'about:blank' ? 'New Tab' : target,
    });
  }
}

export function createEmbeddedBrowser(id: string, url?: string): { ok: boolean; pageId?: number; error?: string } {
  try {
    const win = getWin();
    if (!win) return { ok: false, error: 'No main window' };

    const prior = slots.get(id);
    const pageId = prior?.pageId ?? allocatePageId(id);
    if (prior) {
      destroyEmbeddedBrowser(id, { keepPageId: true });
    }

    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // Real working viewport from the start (hidden). Agent CDP can use it even
    // before the right panel mounts; UI later moves bounds onto the host rect.
    view.setBounds({
      x: 0,
      y: 0,
      width: DEFAULT_VIEWPORT.width,
      height: DEFAULT_VIEWPORT.height,
    });
    win.contentView.addChildView(view);
    try { (view as ViewWithVisibility).setVisible?.(false); } catch { /* ignore */ }

    // Links with target=_blank / window.open → new right-panel tab (no popup window).
    view.webContents.setWindowOpenHandler(({ url: openUrl }) => {
      const next = (openUrl || '').trim();
      if (next && next !== 'about:blank') {
        openUrlInNewEmbeddedTab(next);
        return { action: 'deny' };
      }
      // window.open() with no URL often uses about:blank then navigates.
      // Allow a hidden guest briefly, then steal the first real navigation into a tab.
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          show: false,
          width: 0,
          height: 0,
          webPreferences: {
            partition: PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    });
    view.webContents.on('did-create-window', (childWindow) => {
      const child = childWindow.webContents;
      let captured = false;
      const capture = (navUrl: string) => {
        if (captured) return;
        const next = (navUrl || '').trim();
        if (!next || next === 'about:blank') return;
        captured = true;
        try { childWindow.close(); } catch { /* ignore */ }
        openUrlInNewEmbeddedTab(next);
      };
      child.on('will-navigate', (e, navUrl) => {
        e.preventDefault();
        capture(navUrl);
      });
      child.on('did-navigate', (_e, navUrl) => capture(navUrl));
      child.on('page-title-updated', () => {
        const u = child.getURL();
        if (u && u !== 'about:blank') capture(u);
      });
      // Safety: never leave a hidden popup around.
      setTimeout(() => {
        if (!captured) {
          try { childWindow.close(); } catch { /* ignore */ }
        }
      }, 15_000);
    });

    view.webContents.on('page-title-updated', (_e, title) => {
      emitPageEvent({ type: 'navigated', pageId, browserId: id, url: view.webContents.getURL(), title });
    });
    view.webContents.on('did-navigate', (_e, navUrl) => {
      emitPageEvent({ type: 'navigated', pageId, browserId: id, url: navUrl, title: view.webContents.getTitle() });
    });
    view.webContents.on('did-navigate-in-page', (_e, navUrl) => {
      emitPageEvent({ type: 'navigated', pageId, browserId: id, url: navUrl, title: view.webContents.getTitle() });
    });
    view.webContents.on('did-start-loading', () => {
      const s = slots.get(id);
      if (!s) return;
      s.isLoading = true;
      s.loadError = undefined;
      emitPageEvent({
        type: 'loading',
        pageId,
        browserId: id,
        url: view.webContents.getURL(),
        isLoading: true,
      });
    });
    view.webContents.on('did-stop-loading', () => {
      const s = slots.get(id);
      if (!s) return;
      s.isLoading = false;
      emitPageEvent({
        type: 'loaded',
        pageId,
        browserId: id,
        url: view.webContents.getURL(),
        title: view.webContents.getTitle(),
        isLoading: false,
      });
    });
    view.webContents.on('did-fail-load', (_e, _code, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      const s = slots.get(id);
      if (!s) return;
      s.isLoading = false;
      const failedUrl = validatedURL || view.webContents.getURL();
      // Fallback: directory navigations that slipped past the pre-check.
      if (applyDirectoryNavigation(s, normalizeEmbeddedBrowserUrl(failedUrl))) return;
      s.loadError = errorDescription || 'Load failed';
      emitPageEvent({
        type: 'load-failed',
        pageId,
        browserId: id,
        url: failedUrl,
        isLoading: false,
        error: s.loadError,
      });
    });
    view.webContents.on('did-finish-load', () => {
      const s = slots.get(id);
      if (s?.visible) alignLayoutViewportToUi(s);
    });

    const slot: BrowserSlot = {
      id,
      pageId,
      view,
      visible: false,
      pendingUrl: url ? normalizeEmbeddedBrowserUrl(url) : undefined,
      isLoading: false,
      lastUiWidth: DEFAULT_VIEWPORT.width,
      lastUiHeight: DEFAULT_VIEWPORT.height,
    };
    slots.set(id, slot);
    pageIdToSlotId.set(pageId, id);
    if (selectedPageId === null) selectedPageId = pageId;
    flushPendingUrl(slot);

    emitPageEvent({
      type: 'opened',
      pageId,
      browserId: id,
      url: url || 'about:blank',
      title: view.webContents.getTitle() || url || 'New Tab',
    });
    return { ok: true, pageId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function destroyEmbeddedBrowser(
  id: string,
  opts?: { keepPageId?: boolean },
): { ok: boolean } {
  const slot = slots.get(id);
  if (!slot) return { ok: true };
  try {
    const win = getWin();
    if (win) {
      try { win.contentView.removeChildView(slot.view); } catch { /* already removed */ }
    }
    try {
      if (slot.view.webContents.debugger.isAttached()) {
        slot.view.webContents.debugger.detach();
      }
    } catch { /* ignore */ }
    try { (slot.view.webContents as unknown as { destroy?: () => void }).destroy?.(); } catch { /* ignore */ }
  } catch { /* ignore */ }

  const pageId = slot.pageId;
  slots.delete(id);
  if (!opts?.keepPageId) {
    pageIdToSlotId.delete(pageId);
    if (selectedPageId === pageId) {
      const next = pageIdToSlotId.keys().next();
      selectedPageId = next.done ? null : next.value;
    }
    emitPageEvent({ type: 'closed', pageId, browserId: id });
  }
  return { ok: true };
}

/**
 * When the panel is showing, the painted host size must drive CSS layout.
 * Agent tools (resize_page / emulate / snapshot) often set a sticky
 * Emulation.setDeviceMetricsOverride (e.g. 1280px) which makes sites like
 * bilibili lay out wider than the panel and appear clipped. Clear that
 * override whenever the UI is visible so window.innerWidth matches the host.
 */
function alignLayoutViewportToUi(slot: BrowserSlot): void {
  if (!slot.visible) return;
  const w = slot.lastUiWidth;
  const h = slot.lastUiHeight;
  if (!w || !h || w < 2 || h < 2) return;
  const wc = slot.view.webContents;
  void (async () => {
    try {
      if (!wc.debugger.isAttached()) {
        try { wc.debugger.attach('1.3'); } catch { /* may already be attaching */ }
      }
      if (wc.debugger.isAttached()) {
        await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
        slot.hasDeviceMetricsOverride = false;
      }
    } catch {
      slot.hasDeviceMetricsOverride = false;
    }
    // Nudge responsive layouts that already locked to a prior width.
    try {
      await wc.executeJavaScript(
        `void (function(){ try { window.dispatchEvent(new Event('resize')); } catch (e) {} })()`,
        true,
      );
    } catch { /* ignore */ }
  })();
}

export function setEmbeddedBrowserBounds(
  id: string,
  bounds: { x: number; y: number; width: number; height: number },
  visible = true,
): { ok: boolean; error?: string } {
  const slot = slots.get(id);
  if (!slot) return { ok: false, error: 'Browser not found' };
  try {
    const w = Math.max(0, Math.round(bounds.width));
    const h = Math.max(0, Math.round(bounds.height));
    const x = Math.round(bounds.x);
    const y = Math.round(bounds.y);
    if (!visible || w < 2 || h < 2) {
      // Hide painting only — keep last/default viewport so background agent
      // tools (snapshot/screenshot/click) still see a real page size.
      ensureWorkingViewport(slot);
      setSlotPainted(slot, false);
      slot.layoutAligned = false;
    } else {
      const sizeChanged = slot.lastUiWidth !== w || slot.lastUiHeight !== h;
      slot.view.setBounds({ x, y, width: w, height: h });
      slot.lastUiX = x;
      slot.lastUiY = y;
      slot.lastUiWidth = w;
      slot.lastUiHeight = h;
      setSlotPainted(slot, true);
      // Re-align when size changes, when first shown, or when agent left a
      // sticky device-metrics override (common after snapshot/resize_page).
      if (sizeChanged || slot.hasDeviceMetricsOverride || !slot.layoutAligned) {
        alignLayoutViewportToUi(slot);
        slot.layoutAligned = true;
      }
      flushPendingUrl(slot);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function navigateEmbeddedBrowser(id: string, url: string): { ok: boolean; error?: string } {
  const slot = slots.get(id);
  if (!slot) return { ok: false, error: 'Browser not found' };
  try {
    ensureWorkingViewport(slot);
    slot.pendingUrl = undefined;
    const target = normalizeEmbeddedBrowserUrl(url);
    if (applyDirectoryNavigation(slot, target)) return { ok: true };
    void slot.view.webContents.loadURL(target);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function embeddedBrowserAction(
  id: string,
  action: 'back' | 'forward' | 'reload' | 'stop',
): { ok: boolean; error?: string } {
  const slot = slots.get(id);
  if (!slot) return { ok: false, error: 'Browser not found' };
  const wc = slot.view.webContents;
  try {
    if (action === 'back' && wc.canGoBack()) wc.goBack();
    else if (action === 'forward' && wc.canGoForward()) wc.goForward();
    else if (action === 'reload') {
      if (slot.directoryUrl && applyDirectoryNavigation(slot, slot.directoryUrl)) {
        return { ok: true };
      }
      wc.reload();
    } else if (action === 'stop') wc.stop();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function getEmbeddedBrowserState(id: string): {
  ok: boolean;
  url?: string;
  title?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  isLoading?: boolean;
  loadError?: string;
  directoryPath?: string;
  pageId?: number;
  error?: string;
} {
  const slot = slots.get(id);
  if (!slot) return { ok: false, error: 'Browser not found' };
  const wc = slot.view.webContents;
  return {
    ok: true,
    // Prefer the directory file:// URL so the address bar stays meaningful.
    url: slot.directoryUrl || wc.getURL(),
    title: slot.directoryPath
      ? (slot.directoryPath.split(/[/\\]/).filter(Boolean).pop() || slot.directoryPath)
      : wc.getTitle(),
    canGoBack: wc.canGoBack(),
    canGoForward: wc.canGoForward(),
    isLoading: slot.isLoading || wc.isLoading(),
    loadError: slot.loadError,
    directoryPath: slot.directoryPath,
    pageId: slot.pageId,
  };
}

export function listEmbeddedBrowserPages(): Array<{
  pageId: number;
  browserId: string;
  url: string;
  title: string;
  selected: boolean;
}> {
  const pages: Array<{ pageId: number; browserId: string; url: string; title: string; selected: boolean }> = [];
  for (const slot of slots.values()) {
    const wc = slot.view.webContents;
    pages.push({
      pageId: slot.pageId,
      browserId: slot.id,
      url: wc.getURL() || 'about:blank',
      title: wc.getTitle() || '',
      selected: slot.pageId === selectedPageId,
    });
  }
  pages.sort((a, b) => a.pageId - b.pageId);
  return pages;
}

export function selectEmbeddedBrowserPage(pageId: number): { ok: boolean; error?: string } {
  if (!pageIdToSlotId.has(pageId)) return { ok: false, error: `Page ${pageId} not found` };
  selectedPageId = pageId;
  const browserId = pageIdToSlotId.get(pageId)!;
  const state = getEmbeddedBrowserState(browserId);
  emitPageEvent({
    type: 'selected',
    pageId,
    browserId,
    url: state.url,
    title: state.title,
  });
  return { ok: true };
}

export function getSelectedEmbeddedBrowserId(): string | null {
  if (selectedPageId === null) return null;
  return pageIdToSlotId.get(selectedPageId) ?? null;
}

export function resolveEmbeddedBrowserId(pageId?: number): string | null {
  if (pageId !== undefined && pageId !== null) {
    return pageIdToSlotId.get(pageId) ?? null;
  }
  return getSelectedEmbeddedBrowserId();
}

/** Run JS in the embedded page (agent / DevTools-style control). */
export async function executeInEmbeddedBrowser(
  id: string,
  code: string,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const slot = slots.get(id);
  if (!slot) return { ok: false, error: 'Browser not found' };
  try {
    const result = await slot.view.webContents.executeJavaScript(code, true);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Capture a PNG screenshot of the embedded page (base64). */
export async function captureEmbeddedBrowser(
  id: string,
): Promise<{ ok: boolean; pngBase64?: string; error?: string }> {
  const slot = slots.get(id);
  if (!slot) return { ok: false, error: 'Browser not found' };
  try {
    const image = await slot.view.webContents.capturePage();
    return { ok: true, pngBase64: image.toPNG().toString('base64') };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Send a raw CDP command via webContents.debugger (agent automation). */
export async function debuggerSendEmbeddedBrowser(
  id: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const slot = slots.get(id);
  if (!slot) return { ok: false, error: 'Browser not found' };
  const wc = slot.view.webContents;
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
    }
    const result = await wc.debugger.sendCommand(method, params);
    if (method === 'Emulation.setDeviceMetricsOverride') {
      slot.hasDeviceMetricsOverride = true;
      // Panel is on screen: don't keep a wider-than-panel layout lock.
      // Agent automation while hidden can still use arbitrary resize_page sizes.
      if (slot.visible) alignLayoutViewportToUi(slot);
    } else if (method === 'Emulation.clearDeviceMetricsOverride') {
      slot.hasDeviceMetricsOverride = false;
    }
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Hide every embedded WebContentsView without destroying sessions or
 * shrinking the page viewport. Used when leaving Team so native views
 * don't paint over Overview and other pages; agents can keep using CDP.
 */
export function hideAllEmbeddedBrowsers(): { ok: boolean } {
  for (const slot of slots.values()) {
    try {
      ensureWorkingViewport(slot);
      setSlotPainted(slot, false);
    } catch { /* ignore */ }
  }
  return { ok: true };
}

/** Clear all embedded browsers (e.g. on window close). */
export function destroyAllEmbeddedBrowsers(): void {
  for (const id of [...slots.keys()]) {
    destroyEmbeddedBrowser(id);
  }
  nextPageId = 1;
  selectedPageId = null;
}

/** Expose the partition session for cookie inspection if needed later. */
export function getEmbeddedBrowserSession() {
  return session.fromPartition(PARTITION);
}

export function hasEmbeddedBrowsers(): boolean {
  return slots.size > 0;
}
