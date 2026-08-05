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
import {
  WebContentsView,
  BrowserWindow,
  session,
  type BrowserWindowConstructorOptions,
  type Cookie,
  type Event as ElectronEvent,
  type Session,
} from 'electron';
import { getMainWindow } from './window.js';

const PARTITION = 'persist:markus-embedded-browser';

/**
 * Spoof a normal Chrome UA. Default Electron UA contains "Electron/…", which
 * Magic / wallet / auth SDKs often detect and then blank, loop, or force odd
 * login redirects that real Chrome never hits.
 */
function chromeLikeUserAgent(): string {
  const chromeVer = process.versions.chrome || '134.0.0.0';
  const platformPart = process.platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platformPart}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`;
}

let embeddedSessionReady = false;
function ensureEmbeddedBrowserSession(): ReturnType<typeof session.fromPartition> {
  const ses = session.fromPartition(PARTITION);
  if (!embeddedSessionReady) {
    embeddedSessionReady = true;
    try {
      ses.setUserAgent(chromeLikeUserAgent());
    } catch { /* ignore */ }
  }
  return ses;
}

/**
 * In-app OAuth / login popups — Electron / Ferdium-style policy:
 *
 * 1. `window.open` → `allow` a BrowserWindow that shares the panel's Session
 *    object (cookies) and keeps `window.opener` when opened from page JS.
 * 2. Same-tab navigations to an IdP are re-issued as in-page `window.open`
 *    (not `new BrowserWindow`), so opener is not lost.
 * 3. Never intercept navigations *inside* the popup.
 * 4. Assist completion only when the site cannot: after an IdP hop the popup
 *    settles on the opener's site outside a handshake URL. Then main-process
 *    closes the popup and refreshes the panel (page `window.close` / opener
 *    often fail for WebContentsView-hosted flows).
 * 5. Ordinary foreground/background tabs → right-panel tab, not a popup.
 */

/** IdP hosts that must not run inside the panel WebContentsView. */
function isIdentityProviderHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === 'magic.link'
    || h.endsWith('.magic.link')
    || h === 'privy.io'
    || h.endsWith('.privy.io')
    || h.endsWith('.walletconnect.com')
    || h === 'verify.walletconnect.com'
    || h === 'accounts.google.com'
    || h === 'appleid.apple.com'
    || h === 'login.microsoftonline.com'
    || h.endsWith('.auth0.com')
    || h.endsWith('.okta.com')
    || h.endsWith('.clerk.accounts.dev')
    || h.endsWith('.dynamic.xyz')
    || h.endsWith('.web3auth.io')
  );
}

/** True for Google / Magic / … absolute URLs (same-tab panel hijack only). */
export function isIdentityProviderUrl(raw: string): boolean {
  const u = (raw || '').trim();
  if (!u || u === 'about:blank') return false;
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`);
    return isIdentityProviderHost(parsed.hostname);
  } catch {
    const lower = u.toLowerCase();
    return lower.includes('magic.link')
      || lower.includes('accounts.google.com')
      || lower.includes('walletconnect');
  }
}

/**
 * URLs that should use an OAuth-style popup when opened via window.open /
 * address bar (IdP hosts + common /oauth authorize paths).
 */
export function isAuthPopupUrl(raw: string): boolean {
  const u = (raw || '').trim();
  if (!u || u === 'about:blank') return false;
  let hostname = '';
  let pathname = '';
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`);
    hostname = parsed.hostname.toLowerCase();
    pathname = parsed.pathname.toLowerCase();
  } catch {
    const lower = u.toLowerCase();
    return lower.includes('magic.link')
      || lower.includes('/oauth')
      || lower.includes('/authorize')
      || lower.includes('walletconnect');
  }
  if (isIdentityProviderHost(hostname)) return true;
  return pathname.includes('/oauth')
    || pathname.includes('/authorize')
    || pathname.includes('/auth/login')
    || pathname.includes('/auth/callback')
    || pathname.includes('/auth/connect');
}

function oauthPopupBrowserOptions(
  openerSession?: Session,
): BrowserWindowConstructorOptions {
  const parent = getMainWindow();
  const width = 520;
  const height = 740;
  let x: number | undefined;
  let y: number | undefined;
  if (parent && !parent.isDestroyed()) {
    const b = parent.getBounds();
    x = Math.round(b.x + (b.width - width) / 2);
    y = Math.round(b.y + (b.height - height) / 2);
  }
  return {
    // No modal parent — parenting under a WebContentsView host often blanks.
    show: true,
    width,
    height,
    minWidth: 360,
    minHeight: 480,
    x,
    y,
    autoHideMenuBar: true,
    title: 'Sign in',
    webPreferences: {
      // Prefer the opener's Session object (not only partition string) so the
      // popup and panel share one cookie jar and opener wiring stays intact.
      ...(openerSession
        ? { session: openerSession }
        : { partition: PARTITION }),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}

/** Live popups spawned from each panel tab (opener slot id). */
const popupsByOpener = new Map<string, Set<BrowserWindow>>();
/** Opener slots currently applying a post-login panel refresh. */
const oauthAssistInFlight = new Set<string>();

/**
 * Generation counter per browser id. Closing a tab bumps the epoch so an
 * in-flight EmbeddedBrowser effect cannot recreate the same id after destroy
 * (that reloaded Bilibili from t=0 with no UI tab).
 */
const browserEpoch = new Map<string, number>();

/**
 * Ids that were fully closed. Panel browserIds (`eb_*`) are never reused, but
 * React effects can still call create(id, url) after destroy — that spawned a
 * headless WebContents (App ignores eb_* "opened" events) and audio restarted
 * from t=0 with no tab. Keep forever; ids are unique per tab mint.
 */
const closedBrowserIds = new Set<string>();

function currentBrowserEpoch(id: string): number {
  return browserEpoch.get(id) ?? 0;
}

function bumpBrowserEpoch(id: string): number {
  const next = currentBrowserEpoch(id) + 1;
  browserEpoch.set(id, next);
  return next;
}

function discardOrphanView(view: WebContentsView): void {
  try {
    const win = getWin();
    if (win) {
      try { win.contentView.removeChildView(view); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  try {
    const wc = view.webContents;
    if (wc.isDestroyed()) return;
    try { wc.setAudioMuted(true); } catch { /* ignore */ }
    const closable = wc as typeof wc & {
      destroy?: () => void;
      close?: (opts?: { waitForBeforeUnload?: boolean }) => void;
    };
    if (typeof closable.destroy === 'function') closable.destroy();
    else if (typeof closable.close === 'function') closable.close({ waitForBeforeUnload: false });
  } catch { /* ignore */ }
}

function openerPageUrl(openerSlotId: string): string | null {
  const slot = slots.get(openerSlotId);
  if (!slot) return null;
  try {
    const url = slot.view.webContents.getURL();
    return url && url !== 'about:blank' ? url : null;
  } catch {
    return null;
  }
}

function sameSiteHost(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.endsWith(`.${b}`) || b.endsWith(`.${a}`)) return true;
  const stripWww = (h: string) => h.replace(/^www\./, '');
  return stripWww(a) === stripWww(b);
}

/** Handshake pages — refreshing these restarts OAuth instead of showing the session. */
function isOauthHandshakeUrl(raw: string): boolean {
  const u = (raw || '').trim();
  if (!u || u === 'about:blank') return false;
  try {
    const parsed = new URL(u);
    const path = parsed.pathname.toLowerCase();
    if (isIdentityProviderHost(parsed.hostname)) return true;
    return path.includes('/login/oauth')
      || path.includes('/oauth/authorize')
      || path.includes('/oauth/login')
      || path.includes('/auth/login')
      || path.includes('/auth/callback')
      || path.includes('/auth/connect')
      || path.includes('/sessions/google')
      || path.includes('/signin')
      || path.includes('/two-factor')
      || path.includes('/2fa')
      || path.includes('/mfa')
      || /\/login\/?$/.test(path);
  } catch {
    return false;
  }
}

function waitForCookieActivity(originUrl: string, timeoutMs: number): Promise<void> {
  const ses = ensureEmbeddedBrowserSession();
  let originHost = '';
  try { originHost = new URL(originUrl).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try { ses.cookies.removeListener('changed', onChanged); } catch { /* ignore */ }
      resolve();
    };
    const onChanged = (
      _event: ElectronEvent,
      cookie: Cookie,
      _cause: string,
      removed: boolean,
    ) => {
      if (removed || !originHost) return;
      const domain = (cookie.domain || '').replace(/^\./, '').replace(/^www\./, '');
      if (
        domain === originHost
        || domain.endsWith(`.${originHost}`)
        || originHost.endsWith(`.${domain}`)
      ) {
        done();
      }
    };
    try { ses.cookies.on('changed', onChanged); } catch { /* ignore */ }
    setTimeout(done, timeoutMs);
  });
}

function refreshOpenerAfterOauth(openerSlotId: string): void {
  const slot = slots.get(openerSlotId);
  if (!slot) return;
  try {
    const wc = slot.view.webContents;
    if (wc.isDestroyed()) return;
    const current = wc.getURL();
    // Never reload an authorize/login handshake URL — that restarts Google SSO.
    if (isOauthHandshakeUrl(current)) {
      const u = new URL(current);
      void wc.loadURL(`${u.protocol}//${u.host}/`);
      return;
    }
    wc.reload();
  } catch { /* ignore */ }
}

/**
 * When the site cannot close the popup / notify opener (common with
 * WebContentsView), finish the flow from the main process after a real IdP hop.
 */
async function assistOauthCompletion(openerSlotId: string): Promise<void> {
  if (oauthAssistInFlight.has(openerSlotId)) return;
  oauthAssistInFlight.add(openerSlotId);
  try {
    const openerUrl = openerPageUrl(openerSlotId);
    if (openerUrl) await waitForCookieActivity(openerUrl, 800);
    else await new Promise((r) => setTimeout(r, 400));
    closePopupsForOpener(openerSlotId);
    refreshOpenerAfterOauth(openerSlotId);
  } finally {
    setTimeout(() => oauthAssistInFlight.delete(openerSlotId), 1500);
  }
}

function preparePopupContents(popup: BrowserWindow, openerSlotId: string): void {
  const wc = popup.webContents;
  try { wc.setUserAgent(chromeLikeUserAgent()); } catch { /* ignore */ }

  const openerSlot = slots.get(openerSlotId);
  const openerSession = openerSlot?.view.webContents.session;

  wc.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: oauthPopupBrowserOptions(openerSession),
  }));
  wc.on('did-create-window', (child) => {
    trackOauthPopup(child, openerSlotId);
  });

  // Assist only after: IdP seen → settled back on opener site (not handshake).
  // Give the site a brief chance to close itself via opener; then assist.
  let sawIdentityProvider = false;
  let assistTimer: ReturnType<typeof setTimeout> | undefined;
  const onPopupNavigated = (navUrl: string) => {
    const next = (navUrl || '').trim();
    if (!next || next === 'about:blank') return;
    let host = '';
    try { host = new URL(next).hostname.toLowerCase(); } catch { return; }
    if (isIdentityProviderHost(host)) {
      sawIdentityProvider = true;
      if (assistTimer) clearTimeout(assistTimer);
      return;
    }
    if (!sawIdentityProvider) return;
    if (isOauthHandshakeUrl(next)) return;
    const openerUrl = openerPageUrl(openerSlotId);
    if (!openerUrl) return;
    let openerHost = '';
    try { openerHost = new URL(openerUrl).hostname.toLowerCase(); } catch { return; }
    if (!sameSiteHost(host, openerHost)) return;
    if (assistTimer) clearTimeout(assistTimer);
    // Site may still run opener.reload()+close(); only assist if it does not.
    assistTimer = setTimeout(() => {
      if (popup.isDestroyed()) return;
      void assistOauthCompletion(openerSlotId);
    }, 600);
  };
  wc.on('did-navigate', (_e, url) => onPopupNavigated(url));
  wc.on('did-navigate-in-page', (_e, url) => onPopupNavigated(url));
  wc.on('did-finish-load', () => {
    try { onPopupNavigated(wc.getURL()); } catch { /* ignore */ }
  });
  popup.on('closed', () => {
    if (assistTimer) clearTimeout(assistTimer);
  });
}

function trackOauthPopup(popup: BrowserWindow, openerSlotId: string): void {
  let set = popupsByOpener.get(openerSlotId);
  if (!set) {
    set = new Set();
    popupsByOpener.set(openerSlotId, set);
  }
  set.add(popup);
  preparePopupContents(popup, openerSlotId);
  popup.on('closed', () => {
    const live = popupsByOpener.get(openerSlotId);
    if (!live) return;
    live.delete(popup);
    if (live.size === 0) popupsByOpener.delete(openerSlotId);
  });
}

function closePopupsForOpener(openerSlotId: string): void {
  const set = popupsByOpener.get(openerSlotId);
  if (!set) return;
  popupsByOpener.delete(openerSlotId);
  for (const win of [...set]) {
    try { if (!win.isDestroyed()) win.close(); } catch { /* ignore */ }
  }
}

/**
 * disposition-aware: JS `window.open` is `new-window`; <a target=_blank> is often
 * a tab disposition. OAuth SDKs use new-window + about:blank bootstrap.
 */
function shouldOpenAsOauthPopup(url: string, disposition?: string): boolean {
  const next = (url || '').trim();
  if (!next || next === 'about:blank') return true;
  if (disposition === 'new-window') return true;
  return isAuthPopupUrl(next);
}

/**
 * Open an IdP URL as a page-initiated popup so `window.opener` is preserved.
 * Falls back to a main-process BrowserWindow if scripted open fails.
 */
function openOauthPopupFromOpenerPage(rawUrl: string, openerSlotId: string): void {
  const url = (rawUrl || '').trim();
  if (!url || !/^https?:/i.test(url)) return;
  const slot = slots.get(openerSlotId);
  if (!slot) return;
  const wc = slot.view.webContents;
  const openerSession = wc.session;
  void wc.executeJavaScript(
    `window.open(${JSON.stringify(url)}, "_blank", "popup=yes,width=520,height=740");`,
  ).then((handle) => {
    // null handle ⇒ opener wiring failed; fall back so the user can still sign in.
    if (handle == null) openOauthPopupWithUrl(url, openerSlotId, openerSession);
  }).catch(() => {
    openOauthPopupWithUrl(url, openerSlotId, openerSession);
  });
}

function openOauthPopupWithUrl(
  rawUrl: string,
  openerSlotId: string,
  openerSession?: Session,
): void {
  const url = (rawUrl || '').trim();
  if (!url || !/^https?:/i.test(url)) return;
  const slot = slots.get(openerSlotId);
  const sessionRef = openerSession ?? slot?.view.webContents.session;
  const win = new BrowserWindow(oauthPopupBrowserOptions(sessionRef));
  trackOauthPopup(win, openerSlotId);
  void win.loadURL(url);
  try { win.focus(); } catch { /* ignore */ }
}

function resolveOpenerSlotId(preferred?: string): string | undefined {
  if (preferred && slots.has(preferred)) return preferred;
  if (selectedPageId != null) {
    const id = pageIdToSlotId.get(selectedPageId);
    if (id && slots.has(id)) return id;
  }
  return preferred;
}

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
  // Do not mute on hide — background tabs should keep playing audio (music, etc.).
  // Media is halted only in destroyEmbeddedBrowser when the tab is closed.
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
  if (isAuthPopupUrl(pending)) {
    openOauthPopupWithUrl(pending, slot.id);
    return;
  }
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
function openUrlInNewEmbeddedTab(rawUrl: string, openerSlotId?: string): void {
  const target = normalizeEmbeddedBrowserUrl(rawUrl || 'about:blank');
  if (!target) return;
  // Deny non-navigable schemes (javascript:, etc.)
  if (!/^(https?:|file:|about:)/i.test(target)) return;
  if (isAuthPopupUrl(target)) {
    const opener = resolveOpenerSlotId(openerSlotId);
    if (opener) openOauthPopupWithUrl(target, opener);
    return;
  }
  const newId = `rb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  void createEmbeddedBrowser(newId, target).then((created) => {
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
  });
}

export async function createEmbeddedBrowser(
  id: string,
  url?: string,
): Promise<{ ok: boolean; pageId?: number; error?: string }> {
  try {
    const win = getWin();
    if (!win) return { ok: false, error: 'No main window' };
    // Hard block: full close tombstones the id. Catches creates that start
    // AFTER destroy (epoch-at-start alone cannot — they capture the new epoch).
    if (closedBrowserIds.has(id)) {
      return { ok: false, error: 'Browser was closed' };
    }
    ensureEmbeddedBrowserSession();

    const epochAtStart = currentBrowserEpoch(id);
    const prior = slots.get(id);
    const pageId = prior?.pageId ?? allocatePageId(id);
    if (prior) {
      await destroyEmbeddedBrowser(id, { keepPageId: true });
    }
    // Tab was closed while we awaited teardown of a prior view — do not revive.
    if (closedBrowserIds.has(id) || currentBrowserEpoch(id) !== epochAtStart) {
      return { ok: false, error: 'Browser was closed' };
    }

    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // Belt-and-suspenders: session UA + per-contents UA (some navigations reset).
    try { view.webContents.setUserAgent(chromeLikeUserAgent()); } catch { /* ignore */ }
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

    if (closedBrowserIds.has(id) || currentBrowserEpoch(id) !== epochAtStart) {
      discardOrphanView(view);
      return { ok: false, error: 'Browser was closed' };
    }

    // When the embedded page has focus, route Cmd/Ctrl+W/T to the app (close/new tab)
    // instead of letting the guest page or OS window-close handle them.
    view.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const mod = process.platform === 'darwin' ? input.meta : input.control;
      if (!mod || input.alt || input.shift) return;
      const key = (input.key || '').toLowerCase();
      if (key !== 'w' && key !== 't') return;
      event.preventDefault();
      try {
        win.webContents.send('app:shortcut', { type: key === 'w' ? 'close-tab' : 'new-tab' });
      } catch { /* window gone */ }
    });

    // Popup policy — see shouldOpenAsOauthPopup / oauthPopupBrowserOptions.
    view.webContents.setWindowOpenHandler(({ url: openUrl, disposition }) => {
      const next = (openUrl || '').trim();
      if (shouldOpenAsOauthPopup(next, disposition)) {
        // Panel is applying a just-finished login — ignore SPA re-open noise.
        if (oauthAssistInFlight.has(id)) return { action: 'deny' };
        return {
          action: 'allow',
          overrideBrowserWindowOptions: oauthPopupBrowserOptions(view.webContents.session),
        };
      }
      if (next && /^(https?:|file:)/i.test(next)) {
        openUrlInNewEmbeddedTab(next, id);
      }
      return { action: 'deny' };
    });
    view.webContents.on('did-create-window', (childWindow) => {
      trackOauthPopup(childWindow, id);
    });

    // Same-tab IdP navigation → re-issue as in-page window.open (keeps opener).
    // Do not hook will-redirect — denying redirects blanks mid-flow.
    view.webContents.on('will-navigate', (e, navUrl) => {
      if (!isIdentityProviderUrl(navUrl)) return;
      e.preventDefault();
      openOauthPopupFromOpenerPage(navUrl, id);
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
      // Pages that finish loading just after a show/restack can paint blank
      // until bounds are reapplied — nudge a few times (SPA paint is delayed).
      if (s.visible) {
        nudgeEmbeddedBrowserPaint(s);
        setTimeout(() => nudgeEmbeddedBrowserPaint(s), 50);
        setTimeout(() => nudgeEmbeddedBrowserPaint(s), 250);
      }
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

    if (closedBrowserIds.has(id) || currentBrowserEpoch(id) !== epochAtStart) {
      discardOrphanView(view);
      return { ok: false, error: 'Browser was closed' };
    }

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

/**
 * Destroy a panel browser. Must fully dispose the WebContents — a crashed
 * renderer that is not closed will be recovered by Chromium and reload the
 * last URL (audio restarts from the beginning with no UI tab).
 */
export async function destroyEmbeddedBrowser(
  id: string,
  opts?: { keepPageId?: boolean },
): Promise<{ ok: boolean }> {
  // Tombstone + bump BEFORE any await so a racing create(id, url) cannot
  // spawn a headless Bilibili tab while we wait on about:blank.
  if (!opts?.keepPageId) {
    closedBrowserIds.add(id);
    bumpBrowserEpoch(id);
  }

  const slot = slots.get(id);
  if (!slot) return { ok: true };
  // Drop from the registry first so no UI path can revive this id mid-teardown.
  slots.delete(id);
  closePopupsForOpener(id);

  const pageId = slot.pageId;
  const view = slot.view;
  const wc = view.webContents;
  try {
    if (!wc.isDestroyed()) {
      try { wc.setAudioMuted(true); } catch { /* ignore */ }
      try { wc.stop(); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  // Tear down immediately. Do not await loadURL('about:blank') — that left an
  // ~800ms window where React effects recreated the same id as a zombie.
  // Do not forcefullyCrashRenderer: Chromium recovers and reloads the URL.
  const win = getWin();
  if (win) {
    try { win.contentView.removeChildView(view); } catch { /* already removed */ }
  }
  try {
    if (!wc.isDestroyed() && wc.debugger.isAttached()) {
      wc.debugger.detach();
    }
  } catch { /* ignore */ }
  try {
    if (!wc.isDestroyed()) {
      const closable = wc as typeof wc & {
        destroy?: () => void;
        close?: (opts?: { waitForBeforeUnload?: boolean }) => void;
      };
      if (typeof closable.destroy === 'function') closable.destroy();
      else if (typeof closable.close === 'function') closable.close({ waitForBeforeUnload: false });
    }
  } catch { /* ignore */ }

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
 *
 * Important: only attach CDP for this clear, then detach. Leaving the debugger
 * attached permanently makes some sites (Polymarket / Magic) detect automation
 * and blank the page after first paint.
 */
function alignLayoutViewportToUi(slot: BrowserSlot): void {
  if (!slot.visible) return;
  const w = slot.lastUiWidth;
  const h = slot.lastUiHeight;
  if (!w || !h || w < 2 || h < 2) return;
  const wc = slot.view.webContents;
  void (async () => {
    let attachedHere = false;
    try {
      if (!wc.debugger.isAttached()) {
        try {
          wc.debugger.attach('1.3');
          attachedHere = true;
        } catch { /* may already be attaching */ }
      }
      if (wc.debugger.isAttached()) {
        await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
        slot.hasDeviceMetricsOverride = false;
      }
    } catch {
      slot.hasDeviceMetricsOverride = false;
    } finally {
      if (attachedHere) {
        try { wc.debugger.detach(); } catch { /* ignore */ }
      }
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

/** Open DevTools for the guest page (not the Markus Electron shell). */
export function openEmbeddedBrowserDevTools(id: string): { ok: boolean; error?: string } {
  const slot = slots.get(id);
  if (!slot) return { ok: false, error: 'Browser not found' };
  try {
    // Detached window: docking into the main window changes host bounds and
    // often hides / blanks the native WebContentsView under the HTML layer.
    slot.view.webContents.openDevTools({ mode: 'detach' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Force a compositor / visibility nudge when the view is on screen. */
function nudgeEmbeddedBrowserPaint(slot: BrowserSlot): void {
  if (!slot.visible) return;
  try {
    const b = slot.view.getBounds();
    if (b.width < 2 || b.height < 2) return;
    slot.view.setBounds(b);
    setSlotPainted(slot, true);
  } catch { /* ignore */ }
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
      // Guest WebContentsView often keeps keyboard focus after hide; return it
      // to the Markus shell so Cmd+T blank tabs can focus the address bar.
      const win = getWin();
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        try { win.webContents.focus(); } catch { /* ignore */ }
      }
    } else {
      const sizeChanged = slot.lastUiWidth !== w || slot.lastUiHeight !== h;
      const becomingVisible = !slot.visible;
      // Only re-stack when showing a hidden view. Doing remove/addChildView on
      // every bounds sync (scroll/ResizeObserver) tears down the compositor and
      // leaves a blank page until the next layout change.
      if (becomingVisible) {
        const win = getWin();
        if (win) {
          try { win.contentView.removeChildView(slot.view); } catch { /* not attached */ }
          try { win.contentView.addChildView(slot.view); } catch { /* ignore */ }
        }
      }
      slot.view.setBounds({ x, y, width: w, height: h });
      slot.lastUiX = x;
      slot.lastUiY = y;
      slot.lastUiWidth = w;
      slot.lastUiHeight = h;
      setSlotPainted(slot, true);
      // Re-align when size changes, when first shown, or when agent left a
      // sticky device-metrics override (common after snapshot/resize_page).
      if (sizeChanged || becomingVisible || slot.hasDeviceMetricsOverride || !slot.layoutAligned) {
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
    if (isAuthPopupUrl(target)) {
      openOauthPopupWithUrl(target, id);
      return { ok: true };
    }
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
  void Promise.all([...slots.keys()].map((id) => destroyEmbeddedBrowser(id))).finally(() => {
    nextPageId = 1;
    selectedPageId = null;
  });
}

/** Expose the partition session for cookie inspection if needed later. */
export function getEmbeddedBrowserSession() {
  return ensureEmbeddedBrowserSession();
}

export function hasEmbeddedBrowsers(): boolean {
  return slots.size > 0;
}
