/**
 * The one outbound shape (messaging-gateway.md §7.4, slice G4).
 *
 * Everything the gateway sends — an approval, a task result, an agent report —
 * is normalised into an {@link OutboundMessage} *before* any platform is chosen.
 * Renderers and transports only ever see this shape, so adding a platform or a
 * severity cannot introduce a second, parallel "notification" representation
 * (the structural reason Feishu used to be the only platform that could carry an
 * approval: it was the only code path that spoke the notification's real shape).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * How urgently a message must go out. This drives *routing and timing*, never
 * content: an `action_required` message is pushed immediately (someone is
 * blocked on it), while `info` may be digested into a periodic summary.
 */
export type OutboundSeverity = 'action_required' | 'info';

/**
 * The five notification-priority levels a message may carry — the same set the
 * manifest's `notifyPriority` select offers. Kept distinct from
 * {@link OutboundSeverity}: severity drives *routing and timing*, priority drives
 * the user's *preference filter* (design §3, R6).
 */
export const OUTBOUND_PRIORITIES = ['low', 'normal', 'medium', 'high', 'urgent'] as const;
export type OutboundPriority = (typeof OUTBOUND_PRIORITIES)[number];

/**
 * A button on an outbound message. `ref` is a **signed, opaque token** — the
 * internal approval/entity id never travels in the clear, so a click cannot be
 * replayed against a different record and the user never sees an internal id.
 */
export interface OutboundAction {
  id: string;
  label: string;
  style?: 'primary' | 'default' | 'danger';
  /**
   * This choice cannot be recorded without a written reason. A channel that cannot
   * collect free text must not offer it — the renderer withholds it and says where
   * to act instead.
   */
  requiresComment?: boolean;
  /**
   * This choice is only an answer together with typed input (“give you the
   * numbers”). A channel that cannot collect free text must not offer it as a
   * one-tap button — the tap would be recorded as the answer.
   */
  requiresFreeform?: boolean;
  /** Signed reference (see {@link signActionRef}) resolved back on the inbound side. */
  ref: string;
}

export interface OutboundAttachment {
  name: string;
  url: string;
  mimeType?: string;
}

/** Who produced this message — carried through so the receiver can see the origin. */
export interface OutboundOrigin {
  agentId?: string;
  taskId?: string;
  /**
   * The origin agent's display name, when known. Envelope, not payload: the
   * dispatcher resolves it from {@link agentId} and the renderer surfaces it, so a
   * notification landing in a shared group says *which agent* it came from
   * instead of arriving anonymously.
   */
  agentName?: string;
  /**
   * The name of the team the origin agent belongs to, when it belongs to one.
   * Kept separate from {@link agentName} so a renderer can place it in its own
   * extension slot (a card's footnote) rather than cramming it into the body.
   */
  teamName?: string;
}

/**
 * Where a reply (or a threaded follow-up) should land. Carries the *instance*, not
 * just the platform: with several bots of one platform, "the platform's channel"
 * is no longer a thing (design §4).
 */
export interface OutboundReplyRef {
  platform: string;
  instanceId?: string;
  nativeId: string;
  kind?: string;
}

/** The single outbound shape every renderer and transport consumes. */
export interface OutboundMessage {
  title: string;
  body: string;
  severity: OutboundSeverity;
  /**
   * The message's priority level, when the source declares one. Consumed by the
   * dispatcher's preference filter (`notifyPriority`); absent means "the source
   * did not classify it", and the priority filter then does not narrow it.
   */
  priority?: OutboundPriority;
  actions?: OutboundAction[];
  /**
   * What to say when an action had to be withheld because the destination cannot
   * collect the free text that action requires. Set by the dispatcher (which owns
   * the locale), applied by the renderer (which owns the destination's
   * capabilities) — neither has to know the other's half.
   */
  commentRequiredNote?: string;
  /** Same contract as {@link commentRequiredNote}, for choices needing typed input. */
  freeformRequiredNote?: string;
  attachments?: OutboundAttachment[];
  replyRef?: OutboundReplyRef;
  origin?: OutboundOrigin;
}

// ── Signed action references ────────────────────────────────────────────────

/** What a signed action ref carries. Kept minimal and id-only on purpose. */
export interface ActionRefPayload {
  /** Internal approval id — never rendered, only encoded inside the signature. */
  approvalId?: string;
  /** Internal task id, when the action belongs to a task rather than an approval. */
  taskId?: string;
  /** The action the click represents, e.g. `approve` / `reject` / an option id. */
  action: string;
}

interface SignedEnvelope extends ActionRefPayload {
  /** Issued-at, seconds. Reserved for future expiry; ignored by verify today. */
  iat?: number;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function mac(payload: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(payload).digest());
}

/**
 * Sign an action payload into a compact `payload.signature` token. Deterministic
 * for a given secret so a re-rendered card carries the same ref.
 */
export function signActionRef(payload: ActionRefPayload, secret: string): string {
  const envelope: SignedEnvelope = { ...payload, iat: Math.floor(Date.now() / 1000) };
  const encoded = b64url(Buffer.from(JSON.stringify(envelope), 'utf8'));
  return `${encoded}.${mac(encoded, secret)}`;
}

/**
 * Verify and decode an action ref. Returns `undefined` for anything that is not a
 * valid, untampered token — a forged or stale ref resolves to *nothing* rather
 * than to the wrong approval (fail-closed, the opposite of "best effort decode").
 */
export function verifyActionRef(token: string, secret: string): ActionRefPayload | undefined {
  if (!token || typeof token !== 'string') return undefined;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return undefined;
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = mac(encoded, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SignedEnvelope;
    if (typeof parsed?.action !== 'string' || parsed.action.length === 0) return undefined;
    const out: ActionRefPayload = { action: parsed.action };
    if (typeof parsed.approvalId === 'string') out.approvalId = parsed.approvalId;
    if (typeof parsed.taskId === 'string') out.taskId = parsed.taskId;
    return out;
  } catch {
    return undefined;
  }
}

/**
 * The `value` map a platform sends back when an interactive-card button is
 * tapped. Field names vary: `ref`/`token` carry the gateway's reference; a
 * platform may also post `approvalId`/`action` directly.
 */
export interface CardActionValue {
  ref?: unknown;
  token?: unknown;
  approvalId?: unknown;
  action?: unknown;
}

export interface ResolvedCardAction {
  approvalId?: string;
  command?: string;
  /**
   * True when the ref could not be verified but was still accepted — the bare
   * approval-id fallback used when `MARKUS_ACTION_SECRET` is unset. Callers
   * log this once so a real deployment notices the missing secret.
   */
  unverified: boolean;
}

/**
 * Resolve an inbound card action back to `{ approvalId, command }` — the ONE
 * reader of the ref contract that {@link signActionRef} (signed, secret set) and
 * the dispatcher's bare-id fallback (no secret, pre-G4) write.
 *
 * The two halves must never disagree: whatever the gateway emitted in `ref`, a
 * tap resolves here. When a secret is set a forged/stale ref fails *closed* (to
 * nothing, never the wrong record); with no secret the bare id is accepted and
 * flagged `unverified` rather than dropped — dropping it made every card tap a
 * no-op (the 2026-10-13 Feishu "tap does nothing" defect).
 */
export function resolveCardActionValue(
  value: Record<string, unknown> | undefined,
  secret?: string,
): ResolvedCardAction {
  const v = value ?? {};
  const ref =
    typeof v['ref'] === 'string' ? (v['ref'] as string)
      : typeof v['token'] === 'string' ? (v['token'] as string)
        : undefined;

  if (ref && secret) {
    const verified = verifyActionRef(ref, secret);
    if (!verified) return { unverified: false };
    return { approvalId: verified.approvalId, command: verified.action, unverified: false };
  }

  const approvalId = typeof v['approvalId'] === 'string' ? (v['approvalId'] as string) : ref;
  const command = typeof v['action'] === 'string' ? (v['action'] as string) : undefined;
  return { approvalId, command, unverified: Boolean(ref) && !secret };
}

/**
 * Map a HITL notification (type + priority) to a severity. Type is authoritative;
 * an `urgent` priority escalates anything to `action_required` because that flag
 * is set precisely when a human is being asked to act now.
 */
export function severityOfNotification(input: { type?: string; priority?: string }): OutboundSeverity {
  const type = input.type ?? '';
  if (type === 'approval_request' || type === 'task_failed') return 'action_required';
  if (input.priority === 'urgent') return 'action_required';
  return 'info';
}
