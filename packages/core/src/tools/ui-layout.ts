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
  | { kind: 'deliverable'; deliverableId: string };

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
  const title = typeof args.title === 'string' ? args.title.trim() : undefined;

  const kinds = [url && 'url', path && 'file', deliverableId && 'deliverable'].filter(Boolean);
  if (kinds.length === 0) {
    return {
      ok: false,
      error: 'Provide one of: url, path, or deliverable_id.',
    };
  }
  if (kinds.length > 1) {
    return {
      ok: false,
      error: 'Provide only one of: url, path, or deliverable_id.',
    };
  }

  if (url) {
    let normalized = url;
    if (normalized !== 'about:blank' && !/^https?:\/\//i.test(normalized) && !normalized.startsWith('file:')) {
      normalized = `https://${normalized}`;
    }
    return { ok: true, panel: { kind: 'url', url: normalized, title } };
  }
  if (path) {
    return { ok: true, panel: { kind: 'file', path, title } };
  }
  return { ok: true, panel: { kind: 'deliverable', deliverableId } };
}
