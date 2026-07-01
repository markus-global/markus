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
  onUpdateAvailable(callback: (info: { version: string }) => void): void;
  onUpdateDownloaded(callback: (info: { version: string }) => void): void;
  onNotification(callback: (data: { title: string; body: string; type: string }) => void): void;
  onNotificationClick(callback: (nav: { page?: string; params?: Record<string, string>; openNotifications?: boolean }) => void): void;
  setTrafficLightPosition(x: number, y: number): Promise<void>;
}

interface Window {
  markusDesktop?: MarkusDesktopAPI;
}
