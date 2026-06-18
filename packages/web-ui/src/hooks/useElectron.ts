/**
 * Electron detection and helper hook for the web UI.
 * Returns utilities that adapt behavior based on whether we're in Electron.
 */

export function isElectron(): boolean {
  return !!window.markusDesktop;
}

export function isMASBuild(): boolean {
  return window.markusDesktop?.isMAS ?? false;
}

/**
 * Open a URL externally. In Electron, uses the IPC bridge to open in system browser.
 * In a regular browser, uses window.open.
 */
export function openExternal(url: string): void {
  if (window.markusDesktop) {
    window.markusDesktop.openExternal(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
