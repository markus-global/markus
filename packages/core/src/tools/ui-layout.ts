/**
 * Team Chat UI layout tools — open / collapse the right-side panel.
 *
 * These are synthetic tools (like notify_user): offered by ToolSelector in
 * chat scenario only, and special-cased in Agent.executeTool. They emit
 * `agent:ui-layout` for the CLI/WS bridge to deliver to the user's Team UI.
 */

export type UiLayoutOpenPayload =
  | { kind: 'url'; url: string; title?: string }
  | { kind: 'file'; path: string; title?: string }
  | { kind: 'deliverable'; deliverableId: string }
  | { kind: 'terminal'; terminalId?: string; title?: string; cwd?: string };

export type UiLayoutEvent =
  | {
      agentId: string;
      targetUserId?: string;
      action: 'open';
      panel: UiLayoutOpenPayload;
    }
  | {
      agentId: string;
      targetUserId?: string;
      action: 'collapse';
    };

/** Parse and validate open_right_panel tool args. */
export function parseOpenRightPanelArgs(
  args: Record<string, unknown>,
): { ok: true; panel: UiLayoutOpenPayload } | { ok: false; error: string } {
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  const path = typeof args.path === 'string' ? args.path.trim() : '';
  const deliverableId = typeof args.deliverable_id === 'string'
    ? args.deliverable_id.trim()
    : (typeof args.deliverableId === 'string' ? args.deliverableId.trim() : '');
  const kindArg = typeof args.kind === 'string' ? args.kind.trim().toLowerCase() : '';
  const wantTerminal = kindArg === 'terminal'
    || args.terminal === true
    || typeof args.terminalId === 'string'
    || typeof args.terminal_id === 'string';
  const title = typeof args.title === 'string' ? args.title.trim() : undefined;
  const cwd = typeof args.cwd === 'string' ? args.cwd.trim() : undefined;
  const terminalId = typeof args.terminalId === 'string'
    ? args.terminalId.trim()
    : (typeof args.terminal_id === 'string' ? args.terminal_id.trim() : undefined);

  const kinds = [
    url && 'url',
    path && 'file',
    deliverableId && 'deliverable',
    wantTerminal && 'terminal',
  ].filter(Boolean);
  if (kinds.length === 0) {
    return {
      ok: false,
      error: 'Provide one of: url, path, deliverable_id, or kind:"terminal".',
    };
  }
  if (kinds.length > 1) {
    return {
      ok: false,
      error: 'Provide only one of: url, path, deliverable_id, or kind:"terminal".',
    };
  }

  if (url) {
    let normalized = url.trim();
    if (normalized !== 'about:blank' && !/^[a-z][a-z0-9+.-]*:/i.test(normalized)) {
      // Absolute local paths → file://; bare hosts → https://
      if (
        normalized.startsWith('/')
        || /^[a-zA-Z]:[\\/]/.test(normalized)
        || normalized.startsWith('\\\\')
      ) {
        const p = normalized.replace(/\\/g, '/');
        normalized = /^[a-zA-Z]:\//.test(p)
          ? `file:///${encodeURI(p).replace(/#/g, '%23')}`
          : `file://${encodeURI(p).replace(/#/g, '%23')}`;
      } else {
        normalized = `https://${normalized}`;
      }
    }
    return { ok: true, panel: { kind: 'url', url: normalized, title } };
  }
  if (path) {
    return { ok: true, panel: { kind: 'file', path, title } };
  }
  if (wantTerminal) {
    return { ok: true, panel: { kind: 'terminal', terminalId, title, cwd } };
  }
  return { ok: true, panel: { kind: 'deliverable', deliverableId } };
}
