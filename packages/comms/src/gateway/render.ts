/**
 * Capability-driven rendering (messaging-gateway.md §7.4, slice G4).
 *
 * Rendering is a **total** function: whatever the platform can do, something is
 * produced. The old shape assumed a rich card and lost the message where that was
 * impossible; here the worst case (a platform that can do nothing special) still
 * gets the full title, body and — crucially — every action label *and* its signed
 * ref, so a button-less platform shows the same content instead of dropping it.
 */
import type { OutboundAction, OutboundMessage, OutboundOrigin } from './outbound.js';

/** What a platform/instance can render. Absent flags mean "assume nothing". */
export interface RenderCapabilities {
  /** Interactive cards with real buttons. */
  cards?: boolean;
  /** Inline action buttons without a full card. */
  buttons?: boolean;
  /** Markdown (or the platform's formatting dialect). */
  markdown?: boolean;
}

/** The representation the renderer chose. */
export type OutboundFormat = 'card' | 'markdown' | 'text';

export interface RenderedOutbound {
  format: OutboundFormat;
  /** Whether the platform can render tappable actions (not just their text). */
  interactive: boolean;
  title: string;
  body: string;
  /** Plain-text projection — **always** present, whatever the format. */
  text: string;
  actions: OutboundAction[];
  /**
   * The message's origin, when it has one. Carried as **structure** so a card can
   * place the sender in its own extension slot; the plain-text projection already
   * includes {@link originLine} for platforms that can only show text.
   */
  origin?: OutboundOrigin;
}

/**
 * The one rendering of "who sent this" as a line of text. Deliberately free of
 * markdown: it is prepended to the plain-text projection, which a button-less /
 * text-only platform shows verbatim — the old in-band `**来自**：…` prefix leaked
 * its `**` straight into those platforms' output.
 */
export function originLine(origin: OutboundOrigin | undefined): string | undefined {
  const name = origin?.agentName?.trim();
  if (!name) return undefined;
  const team = origin?.teamName?.trim();
  return team ? `来自：${name}（团队：${team}）` : `来自：${name}`;
}

/**
 * Derive render capabilities from a manifest capability block. A platform that
 * declares interactive cards gets card + markdown; anything else that formats
 * gets markdown; an unknown platform (no capability block at all) gets neither and
 * therefore renders as plain text.
 */
export function renderCapabilitiesOf(
  caps: { cards?: boolean } | undefined,
): RenderCapabilities {
  if (!caps) return {};
  return caps.cards ? { cards: true, markdown: true } : { cards: false, markdown: true };
}

function plainText(msg: OutboundMessage, actions: OutboundAction[], origin?: string): string {
  const parts: string[] = [];
  if (origin) parts.push(origin, '');
  parts.push(msg.title, '', msg.body);
  if (actions.length > 0) {
    parts.push('');
    for (const a of actions) {
      // Label *and* ref: a platform with no buttons must still carry the means to
      // act (the ref is what the inbound side verifies).
      parts.push(`[${a.label}] ${a.ref}`);
    }
  }
  return parts.join('\n');
}

/**
 * Choose the richest representation the platform supports and build it. Degrades
 * `card → markdown → text`; the plain-text projection is identical in all three.
 */
export function renderOutbound(msg: OutboundMessage, caps: RenderCapabilities = {}): RenderedOutbound {
  const actions = msg.actions ?? [];
  const interactive = Boolean(caps.cards || caps.buttons);
  const format: OutboundFormat = interactive ? 'card' : caps.markdown ? 'markdown' : 'text';

  return {
    format,
    interactive,
    title: msg.title,
    // Body stays clean: a card renders the origin from `origin` (its own slot),
    // and the text projection below carries the line. One fact, placed once.
    body: msg.body,
    text: plainText(msg, actions, originLine(msg.origin)),
    actions,
    ...(msg.origin ? { origin: msg.origin } : {}),
  };
}
