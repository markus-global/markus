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
 * A button on an outbound message. `ref` is a **signed, opaque token** — the
 * internal approval/entity id never travels in the clear, so a click cannot be
 * replayed against a different record and the user never sees an internal id.
 */
export interface OutboundAction {
  id: string;
  label: string;
  style?: 'primary' | 'default' | 'danger';
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
  actions?: OutboundAction[];
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
