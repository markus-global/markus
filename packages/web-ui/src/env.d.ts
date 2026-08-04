/// <reference types="vite/client" />
declare const __APP_VERSION__: string;

declare module '@plantuml/core' {
  export function renderToString(
    lines: string[],
    onSuccess: (svg: string) => void,
    onError: (msg: string) => void,
    options?: { dark?: boolean },
  ): void;
}

interface MarkusDesktopAPI {
  platform: string;
  isMAS: boolean;
  getAppVersion(): Promise<string>;
  /** Desktop process cwd used as default embedded-terminal working directory. */
  getDefaultCwd?(): Promise<string>;
  openExternal(url: string): Promise<void>;
  openInBrowser(): Promise<void>;
  showNotification(title: string, body: string): Promise<void>;
  checkForUpdates(): Promise<{ available: boolean; version?: string; error?: string }>;
  getLoginItemSettings(): Promise<{ openAtLogin: boolean }>;
  setLoginItemSettings(openAtLogin: boolean): Promise<{ openAtLogin: boolean; error?: string }>;
  onUpdateAvailable(callback: (info: { version: string }) => void): void;
  onUpdateDownloaded(callback: (info: { version: string }) => void): void;
  onAppShortcut?(callback: (event: { type: 'close-tab' | 'new-tab' }) => void): () => void;
  onNotification(callback: (data: { title: string; body: string; type: string }) => void): void;
  onNotificationClick(callback: (nav: { page?: string; params?: Record<string, string>; openNotifications?: boolean }) => void): void;
  onDeepLinkAuth(callback: (data: { session: string }) => void): void;
  consumePendingDeepLinkAuth(): Promise<string | null>;
  onDeepLinkInstall?(callback: (data: { id: string; type: string }) => void): void;
  consumePendingDeepLinkInstall?(): Promise<{ id: string; type: string } | null>;
  setTrafficLightPosition(x: number, y: number): Promise<void>;
  browser?: {
    create(id: string, url?: string): Promise<{ ok: boolean; pageId?: number; error?: string }>;
    destroy(id: string): Promise<{ ok: boolean }>;
    setBounds(id: string, bounds: { x: number; y: number; width: number; height: number }, visible?: boolean): Promise<{ ok: boolean; error?: string }>;
    hideAll(): Promise<{ ok: boolean }>;
    navigate(id: string, url: string): Promise<{ ok: boolean; error?: string }>;
    action(id: string, action: 'back' | 'forward' | 'reload' | 'stop'): Promise<{ ok: boolean; error?: string }>;
    getState(id: string): Promise<{ ok: boolean; url?: string; title?: string; canGoBack?: boolean; canGoForward?: boolean; isLoading?: boolean; loadError?: string; directoryPath?: string; pageId?: number; error?: string }>;
    executeJs(id: string, code: string): Promise<{ ok: boolean; result?: unknown; error?: string }>;
    capture(id: string): Promise<{ ok: boolean; pngBase64?: string; error?: string }>;
    cdp(id: string, method: string, params?: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }>;
    onPageEvent?(callback: (event: {
      type: 'opened' | 'closed' | 'navigated' | 'selected' | 'loading' | 'loaded' | 'load-failed' | 'directory';
      pageId: number;
      browserId: string;
      url?: string;
      title?: string;
      isLoading?: boolean;
      error?: string;
      directoryPath?: string;
    }) => void): () => void;
  };
  terminal?: {
    create(id: string, opts?: { cwd?: string; title?: string; cols?: number; rows?: number }): Promise<{
      ok: boolean;
      error?: string;
      info?: { id: string; title: string; cwd: string; pid?: number; exited?: boolean; exitCode?: number };
    }>;
    destroy(id: string): Promise<{ ok: boolean }>;
    write(id: string, data: string): Promise<{ ok: boolean; error?: string }>;
    resize(id: string, cols: number, rows: number): Promise<{ ok: boolean; error?: string }>;
    list(): Promise<Array<{ id: string; title: string; cwd: string; pid?: number; exited?: boolean; exitCode?: number }>>;
    getBuffer(id: string, opts?: { maxChars?: number; maxLines?: number }): Promise<{ ok: boolean; content?: string; error?: string }>;
    select(id: string): Promise<{ ok: boolean; error?: string }>;
    onData?(callback: (event: { id: string; data: string }) => void): () => void;
    onExit?(callback: (event: { id: string; exitCode: number }) => void): () => void;
    onEvent?(callback: (event: {
      type: 'opened' | 'closed' | 'selected' | 'cwd';
      id: string;
      title?: string;
      cwd?: string;
    }) => void): () => void;
  };
}

interface Window {
  markusDesktop?: MarkusDesktopAPI;
}
