import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Feishu inbound routing GOLDEN snapshot (C10-B2 §B2 "golden 路由快照 + 双跑 diff=0").
 *
 * ── What this locks, and what it must never do ───────────────────────────────
 *
 * C10-B adds a *delivery envelope* to the inbound chain. The acceptance bar for
 * B2 is "**zero routing change**": everything that already decided — who answers
 * a message, under which conversation key, with which kind/reply — must keep
 * deciding exactly the same thing. This file is that bar, made executable.
 *
 * It therefore locks **EXISTING** behaviour at the exact change surface:
 *
 *   real FeishuAdapter.processMessageEvent / processCardAction   (adapter.ts:504 / :557)
 *        ↓ adapter.onMessage / onAction  (wired ONCE by registerAdapter → wireAdapter)
 *   real MessageRouter.routeIncomingMessage / dispatchAction     (router.ts:548 / :299)
 *        ↓
 *   recording handlers (agent handler returns 'ack', action handler records)
 *
 * Transport setup (long connection, webhook, event_id dedup) is *upstream* of
 * these two dispatch points and untouched by B2 — it is already covered by
 * `feishu-adapter.test.ts` and is deliberately not re-locked here.
 *
 * ── Why the projection is an explicit allowlist ──────────────────────────────
 *
 * Only fields that exist at base are projected. A *new* field added by C10-B
 * (the delivery envelope's `from`/`external_thread_ref`/`auth`, a pre-ensured
 * work-unit ref …) can therefore never leak into the baseline: the harness
 * proves "the old facts did not move" without pre-judging the new contract
 * (the contract seams S1–S3 are owned by C10-B, not by this harness).
 *
 * Two fields are intrinsically non-deterministic, so they are projected as
 * **kind descriptors**, never values:
 *   • `message.id` — `msgId()` mints a fresh random `msg_<24 hex>` per dispatch,
 *     while the native Feishu id lives in `threadId`. Recorded as `idKind`.
 *   • `timestamp` — `new Date().toISOString()`. Recorded as `timestampKind`
 *     (with a shape assertion, so a format regression still bites).
 *
 * ── Modes ────────────────────────────────────────────────────────────────────
 *   • CI (default): compare the computed snapshot to the committed baseline
 *     `test/golden/feishu-inbound-routing.json`.
 *   • `GOLDEN_EMIT=<path>`: write the snapshot instead of comparing (used to
 *     create the baseline and to run the impl-time dual-run `diff`, §3).
 */

// ── Lark SDK mock — copied from feishu-adapter.test.ts:13-49 ─────────────────
// The adapter imports the SDK at module scope; nothing here opens a socket.
const sdkState = vi.hoisted(() => ({
  dispatcher: undefined as undefined | { handlers: Record<string, (data: unknown) => void> },
  wsStarts: 0,
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  WSClient: class {
    async start(): Promise<void> {
      sdkState.wsStarts += 1;
    }
    close(_params?: { force?: boolean }): void {}
  },
  EventDispatcher: class {
    handlers: Record<string, (data: unknown) => void> = {};
    constructor(_opts?: unknown) {}
    register(map: Record<string, (data: unknown) => void>) {
      this.handlers = map;
      sdkState.dispatcher = this;
      return this;
    }
  },
  LoggerLevel: { error: 0, warn: 1, info: 2, debug: 3 },
  Client: class {},
}));

import { FeishuAdapter } from '../src/feishu/adapter.js';
import type { FeishuClient } from '../src/feishu/client.js';
import { MessageRouter } from '../src/router.js';
import type { InboundAction, SendOptions } from '../src/adapter.js';
import type { BindingLookup, ResolvedInboundTarget, ScopeBinding } from '../src/gateway/inbound.js';
import type { Message } from '@markus/shared';

// ── Mock client — copied from feishu-adapter.test.ts:52-63 ───────────────────
function makeMockClient(): Partial<FeishuClient> {
  return {
    getTenantToken: vi.fn().mockResolvedValue('mock-token'),
    sendTextMessage: vi.fn().mockResolvedValue('om_mock_sent'),
    sendInteractiveMessage: vi.fn().mockResolvedValue('om_mock_card'),
    sendLocalImage: vi.fn().mockResolvedValue('om_mock_image'),
    replyMessage: vi.fn().mockResolvedValue('om_mock_reply'),
    replyCard: vi.fn().mockResolvedValue('om_mock_reply_card'),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Binding fixture (implements BindingLookup, gateway/inbound.ts:40) ───────
// Instance-exact channel rows for the receiving bot (`registerAdapter` defaults
// the instance id to the platform, so the bot's identity is `feishu`).
const CHANNEL_BINDINGS: ScopeBinding[] = [
  { scope: 'channel', instanceId: 'feishu', nativeId: 'oc_bound', kind: null, agentId: 'agt_a' },
  { scope: 'channel', instanceId: 'feishu', nativeId: 'oc_notify', kind: 'notification', agentId: 'agt_n' },
  { scope: 'channel', instanceId: 'feishu', nativeId: 'oc_main', kind: 'main', agentId: 'agt_m' },
  { scope: 'global', instanceId: null, nativeId: null, kind: null, agentId: 'agt_sec' },
];

const standardLookup: BindingLookup = {
  bindings: (_orgId, platform) => (platform === 'feishu' ? CHANNEL_BINDINGS : []),
  platformDefaultAgent: (_orgId, platform) => (platform === 'feishu' ? 'agt_p' : undefined),
  orgDefaultAgent: () => 'agt_sec',
};

/** No bindings, no platform default, no Secretary: the unbound-drop case. */
const emptyLookup: BindingLookup = {
  bindings: () => [],
  platformDefaultAgent: () => undefined,
  orgDefaultAgent: () => undefined,
};

// ── Chain under test: real adapter → real router → recording handlers ───────
interface ReplyCall {
  method: 'sendReply' | 'sendMessage';
  channelId: string;
  threadId?: string;
  markdown: boolean;
}

interface Chain {
  adapter: FeishuAdapter;
  router: MessageRouter;
  agentCalls: Array<{ target: ResolvedInboundTarget; message: Message }>;
  actionCalls: InboundAction[];
  replyCalls: ReplyCall[];
}

interface ChainOptions {
  lookup?: BindingLookup;
  /** Case 20: a router with NO action handler registered at all. */
  withActionHandler?: boolean;
}

/**
 * A fresh adapter + router PER CASE, so handler lists and any in-adapter state
 * (`processedEvents`, actor-name cache) can never cross cases.
 */
function makeChain(opts: ChainOptions = {}): Chain {
  const adapter = new FeishuAdapter();
  const mockClient = makeMockClient();
  // Instantiation pattern: feishu-adapter.test.ts:106-112 (private field
  // injection). Cast through `unknown` so the harness is type-clean; the
  // upstream test reaches the same fields via a direct cast.
  const internals = adapter as unknown as Record<string, unknown>;
  internals['client'] = mockClient;
  internals['connected'] = true;

  const router = new MessageRouter('default');
  router.setBindingLookup(opts.lookup ?? standardLookup);
  // registerAdapter → wireAdapter → adapter.onMessage/onAction append the
  // router's ports (once; router.ts:129 + :466).
  router.registerAdapter(adapter);

  const agentCalls: Chain['agentCalls'] = [];
  const actionCalls: InboundAction[] = [];
  const replyCalls: ReplyCall[] = [];

  router.setAgentHandler(async (target, message) => {
    agentCalls.push({ target, message });
    return 'ack';
  });

  if (opts.withActionHandler !== false) {
    router.setActionHandler(async (action) => {
      actionCalls.push(action);
    });
  }

  // Spy the two reply paths on the real adapter (router.ts:636 / :638) instead
  // of letting them reach the mocked platform client.
  vi.spyOn(adapter, 'sendReply').mockImplementation(
    async (channelId: string, threadId: string, _content: string, options?: SendOptions) => {
      replyCalls.push({ method: 'sendReply', channelId, threadId, markdown: options?.markdown === true });
      return 'sent';
    },
  );
  vi.spyOn(adapter, 'sendMessage').mockImplementation(
    async (channelId: string, _content: string, options?: SendOptions) => {
      replyCalls.push({ method: 'sendMessage', channelId, markdown: options?.markdown === true });
      return 'sent';
    },
  );

  return { adapter, router, agentCalls, actionCalls, replyCalls };
}

/** Drive the private dispatch points exactly as the transports do (card-resolved.test.ts:150). */
async function driveMessage(chain: Chain, event: Record<string, unknown>): Promise<void> {
  await (
    chain.adapter as unknown as { processMessageEvent(e: unknown): Promise<void> }
  ).processMessageEvent(event);
}

async function driveAction(chain: Chain, event: Record<string, unknown>): Promise<void> {
  await (
    chain.adapter as unknown as { processCardAction(e: Record<string, unknown>): Promise<void> }
  ).processCardAction(event);
}

// ── Corpus (fixed order; 20 cases) ──────────────────────────────────────────
interface MessagePayloadOptions {
  name: string;
  messageId?: string;
  content?: string;
  chatId?: string;
  chatType?: 'p2p' | 'group';
  mentions?: Array<{ key: string; open_id?: string; name?: string }>;
  senderType?: string;
  openId?: string;
  /** Case 7: `event.message` is absent (sender only). */
  omitMessage?: boolean;
  /** Case 8: `event.sender` is absent (message only). */
  omitSender?: boolean;
  /** Case 10: `sender.sender_id` is absent entirely. */
  omitSenderId?: boolean;
}

/** The FeishuEvent envelope the long-connection path synthesises (adapter.ts:338-346). */
function messageEvent(opts: MessagePayloadOptions): Record<string, unknown> {
  const event: Record<string, unknown> = {};
  if (!opts.omitMessage) {
    const message: Record<string, unknown> = {
      message_id: opts.messageId ?? `om_${opts.name}`,
      chat_id: opts.chatId ?? 'oc_bound',
      chat_type: opts.chatType ?? 'group',
      content: opts.content ?? '{"text":"hello"}',
      message_type: 'text',
    };
    if (opts.mentions) {
      message['mentions'] = opts.mentions.map((m) => ({
        key: m.key,
        id: m.open_id ? { open_id: m.open_id } : {},
        name: m.name ?? 'User',
      }));
    }
    event['message'] = message;
  }
  if (!opts.omitSender) {
    const sender: Record<string, unknown> = { sender_type: opts.senderType ?? 'user' };
    if (!opts.omitSenderId) sender['sender_id'] = { open_id: opts.openId ?? 'ou_u1' };
    event['sender'] = sender;
  }
  return {
    header: {
      event_id: `e_${opts.name}`,
      event_type: 'im.message.receive_v1',
      create_time: '0',
      token: '',
    },
    event,
  };
}

interface CorpusCase {
  name: string;
  kind: 'message' | 'action';
  payload: Record<string, unknown>;
  lookup?: BindingLookup;
  withActionHandler?: boolean;
}

/** Native Feishu message id carried by a message case (for `idKind`). */
function nativeMessageIdOf(c: CorpusCase): string | undefined {
  const event = c.payload['event'] as Record<string, unknown> | undefined;
  const message = event?.['message'] as Record<string, unknown> | undefined;
  return message?.['message_id'] as string | undefined;
}

const CARD_V2 = {
  action: { value: { action: 'approve', approvalId: 'ap_1' } },
  operator: { open_id: 'ou_op' },
  context: { open_message_id: 'om_c' },
};

const CORPUS: CorpusCase[] = [
  // ── message path (processMessageEvent) ──
  {
    name: 'p2p-text',
    kind: 'message',
    payload: messageEvent({ name: 'p2p-text', chatType: 'p2p', content: '{"text":"hello"}' }),
  },
  {
    name: 'group-text',
    kind: 'message',
    payload: messageEvent({ name: 'group-text', chatType: 'group', content: '{"text":"hi all"}' }),
  },
  {
    name: 'group-mention',
    kind: 'message',
    payload: messageEvent({
      name: 'group-mention',
      chatType: 'group',
      content: '{"text":"@_u_1 hi"}',
      mentions: [{ key: '@_u_1', open_id: 'ou_u1', name: 'User One' }],
    }),
  },
  {
    name: 'bot-sender',
    kind: 'message',
    payload: messageEvent({ name: 'bot-sender', senderType: 'bot' }),
  },
  {
    name: 'empty-after-mention',
    kind: 'message',
    payload: messageEvent({
      name: 'empty-after-mention',
      content: '{"text":"@_u_1"}',
      mentions: [{ key: '@_u_1', open_id: 'ou_u1', name: 'User One' }],
    }),
  },
  {
    name: 'non-json-content',
    kind: 'message',
    payload: messageEvent({ name: 'non-json-content', content: 'plain' }),
  },
  {
    name: 'missing-message',
    kind: 'message',
    payload: messageEvent({ name: 'missing-message', omitMessage: true }),
  },
  {
    name: 'missing-sender',
    kind: 'message',
    payload: messageEvent({ name: 'missing-sender', omitSender: true }),
  },
  {
    name: 'empty-text',
    kind: 'message',
    payload: messageEvent({ name: 'empty-text', content: '{"text":""}' }),
  },
  {
    name: 'no-open-id',
    kind: 'message',
    payload: messageEvent({ name: 'no-open-id', omitSenderId: true }),
  },
  {
    name: 'unbound-channel',
    kind: 'message',
    payload: messageEvent({ name: 'unbound-channel', chatId: 'oc_unbound', chatType: 'group' }),
  },
  {
    name: 'notification-channel',
    kind: 'message',
    payload: messageEvent({ name: 'notification-channel', chatId: 'oc_notify', chatType: 'group' }),
  },
  {
    name: 'main-channel',
    kind: 'message',
    payload: messageEvent({ name: 'main-channel', chatId: 'oc_main', chatType: 'group' }),
  },
  {
    name: 'nothing-bound',
    kind: 'message',
    payload: messageEvent({ name: 'nothing-bound', chatId: 'oc_bound', chatType: 'group' }),
    lookup: emptyLookup,
  },

  // ── action path (processCardAction → router.dispatchAction) ──
  { name: 'card-v2', kind: 'action', payload: CARD_V2 },
  {
    name: 'card-legacy',
    kind: 'action',
    payload: {
      action: { value: { action: 'reject', approvalId: 'ap_2' } },
      open_id: 'ou_op2',
      open_message_id: 'om_c2',
    },
  },
  { name: 'card-no-value', kind: 'action', payload: { action: {} } },
  { name: 'card-no-action', kind: 'action', payload: {} },
  {
    name: 'card-no-operator',
    kind: 'action',
    payload: { action: { value: { action: 'approve', approvalId: 'ap_3' } } },
  },
  {
    name: 'action-no-handler',
    kind: 'action',
    payload: CARD_V2,
    withActionHandler: false,
  },
];

// ── Structural projection (explicit allowlist; kind descriptors for volatile values) ──
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const GENERATED_ID_PATTERN = /^msg_[0-9a-f]{24}$/;

/** ISO shape is asserted; only the *kind* is recorded, never the value. */
function timestampKindOf(timestamp: string | undefined): 'iso' {
  expect(timestamp, 'inbound timestamp must be an ISO-8601 UTC string').toMatch(ISO_PATTERN);
  return 'iso';
}

function idKindOf(id: string, nativeMessageId: string | undefined): 'native' | 'generated' | 'other' {
  if (nativeMessageId !== undefined && id === nativeMessageId) return 'native';
  return GENERATED_ID_PATTERN.test(id) ? 'generated' : 'other';
}

/** Only the existing MessageContent fields; absent ones stay absent. */
function projectContent(content: Message['content']): Record<string, unknown> {
  const out: Record<string, unknown> = { type: content.type };
  if (content.text !== undefined) out['text'] = content.text;
  if (content.richText !== undefined) out['richText'] = content.richText;
  if (content.fileUrl !== undefined) out['fileUrl'] = content.fileUrl;
  if (content.imageUrl !== undefined) out['imageUrl'] = content.imageUrl;
  if (content.actionCard !== undefined) out['actionCard'] = content.actionCard;
  return out;
}

function projectMessage(message: Message, nativeMessageId: string | undefined): Record<string, unknown> {
  return {
    platform: message.platform,
    direction: message.direction,
    channelId: message.channelId,
    senderId: message.senderId,
    senderName: message.senderName,
    agentId: message.agentId,
    content: projectContent(message.content),
    replyToId: message.replyToId ?? null,
    threadId: message.threadId ?? null,
    channelKind: message.channelKind ?? null,
    instanceId: message.instanceId ?? null,
    idKind: idKindOf(message.id, nativeMessageId),
    timestampKind: timestampKindOf(message.timestamp),
  };
}

/** ResolvedInboundTarget in full — the routing decision itself. */
function projectTarget(target: ResolvedInboundTarget): Record<string, unknown> {
  return {
    instanceId: target.instanceId ?? null,
    agentId: target.agentId,
    conversationKey: target.conversationKey,
    matchedScope: target.matchedScope,
    kind: target.kind,
    ignored: target.ignored,
  };
}

function projectAction(action: InboundAction): Record<string, unknown> {
  return {
    platform: action.platform,
    instanceId: action.instanceId,
    actorId: action.actorId ?? null,
    messageId: action.messageId ?? null,
    payload: action.payload,
    timestampKind: timestampKindOf(action.timestamp),
  };
}

// ── Snapshot ────────────────────────────────────────────────────────────────
interface CaseSnapshot {
  name: string;
  agentCalls: Array<{ target: Record<string, unknown>; message: Record<string, unknown> }>;
  actionCalls: Array<Record<string, unknown>>;
  replyCalls: ReplyCall[];
}

async function runCase(corpusCase: CorpusCase): Promise<CaseSnapshot> {
  const chain = makeChain({ lookup: corpusCase.lookup, withActionHandler: corpusCase.withActionHandler });
  const nativeMessageId = corpusCase.kind === 'message' ? nativeMessageIdOf(corpusCase) : undefined;

  if (corpusCase.kind === 'message') {
    await driveMessage(chain, corpusCase.payload);
  } else {
    await driveAction(chain, corpusCase.payload);
  }

  return {
    name: corpusCase.name,
    agentCalls: chain.agentCalls.map(({ target, message }) => ({
      target: projectTarget(target),
      message: projectMessage(message, nativeMessageId),
    })),
    actionCalls: chain.actionCalls.map(projectAction),
    replyCalls: chain.replyCalls,
  };
}

async function buildSnapshot(): Promise<{ cases: CaseSnapshot[] }> {
  const cases: CaseSnapshot[] = [];
  // Fixed corpus order, one fresh chain per case.
  for (const corpusCase of CORPUS) {
    cases.push(await runCase(corpusCase));
  }
  return { cases };
}

// ── Stable serialization: recursively sorted keys, 2-space indent, trailing \n ──
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key]);
    return out;
  }
  return value;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

// ── Baseline location + modes ───────────────────────────────────────────────
const GOLDEN_PATH = fileURLToPath(new URL('./golden/feishu-inbound-routing.json', import.meta.url));

let snapshotPromise: Promise<{ cases: CaseSnapshot[] }> | undefined;
function snapshot(): Promise<{ cases: CaseSnapshot[] }> {
  snapshotPromise ??= buildSnapshot();
  return snapshotPromise;
}

describe('feishu inbound routing — golden snapshot (C10-B2 routing zero-change)', () => {
  it('covers the fixed 20-case corpus, in order', async () => {
    expect(CORPUS).toHaveLength(20);
    const { cases } = await snapshot();
    expect(cases.map((c) => c.name)).toEqual(CORPUS.map((c) => c.name));
    // The message/action split is part of the lock surface: 14 message cases,
    // 6 card-action cases.
    expect(CORPUS.filter((c) => c.kind === 'message')).toHaveLength(14);
    expect(CORPUS.filter((c) => c.kind === 'action')).toHaveLength(6);
  });

  it('matches the committed baseline at packages/comms/test/golden/feishu-inbound-routing.json', async () => {
    const computed = await snapshot();
    const serialized = stableJson(computed);

    const emitPath = process.env['GOLDEN_EMIT'];
    if (emitPath) {
      // Emit mode: write the snapshot, never compare (baseline creation + dual-run diff).
      mkdirSync(dirname(emitPath), { recursive: true });
      writeFileSync(emitPath, serialized, 'utf8');
      expect(existsSync(emitPath)).toBe(true);
      return;
    }

    expect(
      existsSync(GOLDEN_PATH),
      `golden baseline missing at ${GOLDEN_PATH} — regenerate with ` +
        `GOLDEN_EMIT=${GOLDEN_PATH} npx vitest run packages/comms/test/feishu-inbound-routing.golden.test.ts`,
    ).toBe(true);

    const committedRaw = readFileSync(GOLDEN_PATH, 'utf8');
    // 1) The facts are unchanged.
    expect(computed).toEqual(JSON.parse(committedRaw) as unknown);
    // 2) The committed file is itself canonically serialized, so a dual-run
    //    `diff` can only ever be empty.
    expect(stableJson(JSON.parse(committedRaw) as unknown)).toBe(serialized);
  });
});