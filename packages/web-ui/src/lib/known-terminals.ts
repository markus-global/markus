/** Terminal IDs already owned by the UI tab pool (avoids PTY event → openRightPanel loops). */
export const knownTerminalIds = new Set<string>();

export function rememberTerminalId(id: string | undefined | null): void {
  if (id) knownTerminalIds.add(id);
}

export function forgetTerminalId(id: string | undefined | null): void {
  if (id) knownTerminalIds.delete(id);
}
