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
  openExternal(url: string): Promise<void>;
  openInBrowser(): Promise<void>;
  showNotification(title: string, body: string): Promise<void>;
  checkForUpdates(): Promise<{ available: boolean; version?: string; error?: string }>;
  getLoginItemSettings(): Promise<{ openAtLogin: boolean }>;
  setLoginItemSettings(openAtLogin: boolean): Promise<{ openAtLogin: boolean; error?: string }>;
  onUpdateAvailable(callback: (info: { version: string }) => void): void;
  onUpdateDownloaded(callback: (info: { version: string }) => void): void;
  onNotification(callback: (data: { title: string; body: string; type: string }) => void): void;
  onNotificationClick(callback: (nav: { page?: string; params?: Record<string, string>; openNotifications?: boolean }) => void): void;
  onDeepLinkAuth(callback: (data: { session: string }) => void): void;
  consumePendingDeepLinkAuth(): Promise<string | null>;
  setTrafficLightPosition(x: number, y: number): Promise<void>;
  browser?: {
    create(id: string, url?: string): Promise<{ ok: boolean; pageId?: number; error?: string }>;
    destroy(id: string): Promise<{ ok: boolean }>;
    setBounds(id: string, bounds: { x: number; y: number; width: number; height: number }, visible?: boolean): Promise<{ ok: boolean; error?: string }>;
    hideAll(): Promise<{ ok: boolean }>;
    navigate(id: string, url: string): Promise<{ ok: boolean; error?: string }>;
    action(id: string, action: 'back' | 'forward' | 'reload' | 'stop'): Promise<{ ok: boolean; error?: string }>;
    getState(id: string): Promise<{ ok: boolean; url?: string; title?: string; canGoBack?: boolean; canGoForward?: boolean; pageId?: number; error?: string }>;
    executeJs(id: string, code: string): Promise<{ ok: boolean; result?: unknown; error?: string }>;
    capture(id: string): Promise<{ ok: boolean; pngBase64?: string; error?: string }>;
    cdp(id: string, method: string, params?: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }>;
    onPageEvent?(callback: (event: {
      type: 'opened' | 'closed' | 'navigated' | 'selected';
      pageId: number;
      browserId: string;
      url?: string;
      title?: string;
    }) => void): () => void;
  };
}

interface Window {
  markusDesktop?: MarkusDesktopAPI;
}
