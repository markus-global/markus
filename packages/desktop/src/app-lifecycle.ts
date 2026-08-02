/** Shared quit flag so window close can hide-to-tray instead of exiting. */
let appQuitting = false;

export function setAppQuitting(value: boolean): void {
  appQuitting = value;
}

export function isAppQuitting(): boolean {
  return appQuitting;
}
