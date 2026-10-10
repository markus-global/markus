#!/usr/bin/env node
/**
 * G7 real-data probe — Slack Socket Mode over a REAL WebSocket.
 *
 * Why: the unit suite injects a *fake* socket, so it pins our protocol logic but
 * never exercises the shipped `NativeSocket` (the real `WebSocket` client) or the
 * actual async ordering of ack-vs-handler on a live connection. This probe stands
 * up a real WebSocket server that plays Slack, and drives the real
 * `SlackSocketMode` / `SlackAdapter` against it.
 *
 * What it does NOT prove: that Slack itself accepts our app token. There is no
 * Slack app in this environment; real-credential connectivity stays flagged in
 * the handoff. Everything below is local loopback.
 *
 * Run: node packages/cli/scripts/verify-g7-real-data.mjs
 */
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

const COMMS_DIST = new URL('../../comms/dist/index.js', import.meta.url).pathname;
const { SlackSocketMode, SlackAdapter, createDeadlineAck } = await import(COMMS_DIST);

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

// ── A real local WebSocket server, standing in for Slack's wss:// endpoint ───
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(wss, 'listening');
const wsUrl = `ws://127.0.0.1:${wss.address().port}`;

const connections = [];
const ackedFrames = [];
wss.on('connection', (socket) => {
  connections.push(socket);
  socket.on('message', (data) => ackedFrames.push(JSON.parse(String(data))));
  socket.send(JSON.stringify({ type: 'hello' }));
});

// ── The REST stand-in for apps.connections.open ─────────────────────────────
const openCalls = [];
const rest = {
  fetch: async (input, init) => {
    openCalls.push({ url: String(input), method: init?.method, auth: init?.headers?.Authorization });
    return { ok: true, status: 200, json: async () => ({ ok: true, url: wsUrl }) };
  },
};

// ── A1: connect() over a real WebSocket resolves on `hello` ─────────────────
let handlerParked = 0;
let releaseParked;
const parkedGate = new Promise((resolve) => {
  releaseParked = resolve;
});
const mode = new SlackSocketMode({ appToken: 'xapp-1-probe', reconnectDelaysMs: [5] }, rest);
const seen = [];
await mode.connect(async (envelope) => {
  seen.push(envelope);
  handlerParked += 1;
  await parkedGate; // a slow agent turn
});

check('A1 real WebSocket connect() resolves on hello', mode.isConnected());
check(
  'A1b the opener was a POST to apps.connections.open bearing the app token',
  openCalls.length === 1 &&
    openCalls[0].method === 'POST' &&
    openCalls[0].url.endsWith('/apps.connections.open') &&
    openCalls[0].auth === 'Bearer xapp-1-probe',
  JSON.stringify(openCalls[0]),
);

// ── A4: "no public URL" by construction — the client only dials out ─────────
check(
  'A4 the client created no inbound listener; its only socket is the outbound dial',
  connections.length === 1 && !('webhookPort' in mode),
);

// ── A2/A3: ACK exactly once, and before the handler finishes ────────────────
const live = connections.at(-1);
live.send(
  JSON.stringify({
    type: 'events_api',
    envelope_id: 'env-real-1',
    payload: { type: 'event_callback', event: { type: 'message', text: 'hi', channel: 'C1', ts: '1.1' } },
  }),
);
await waitFor(() => ackedFrames.some((f) => f.envelope_id === 'env-real-1'));
const acks = ackedFrames.filter((f) => f.envelope_id === 'env-real-1');
check('A2 the real socket ACKed the envelope exactly once', acks.length === 1, `got ${acks.length}`);
check(
  'A3 the ACK landed while the handler was still parked (read loop not blocked)',
  handlerParked === 1,
  `handler entries=${handlerParked} envelopes=${seen.length}`,
);

// ── A5: a server-side close drives a real reconnect ─────────────────────────
live.close();
const reconnected = await waitFor(() => openCalls.length === 2, 3000);
check('A5 the socket reconnects with a fresh apps.connections.open after a close', reconnected, `opens=${openCalls.length}`);
mode.disconnect();
releaseParked();

// ── A6: the adapter projects a real socket frame into a Message ─────────────
const adapter = new SlackAdapter({ rest });
const messages = [];
adapter.onMessage((m) => messages.push(m));
await adapter.connect({
  platform: 'slack',
  botToken: 'xoxb-probe',
  appToken: 'xapp-1-probe',
  signingSecret: 'shh',
  socketMode: true,
});
check('A6a adapter connected in Socket Mode with no webhookPort', adapter.isConnected());

const adapterSocket = connections.at(-1);
adapterSocket.send(
  JSON.stringify({
    type: 'events_api',
    envelope_id: 'env-real-2',
    payload: {
      type: 'event_callback',
      event: { type: 'message', text: '<@U0BOT> hi from a real socket', channel: 'C-REAL', user: 'U-REAL', ts: '9.9' },
    },
  }),
);
await waitFor(() => messages.length === 1);
check(
  'A6b a real socket frame became a slack Message (mention stripped)',
  messages[0]?.content?.text === 'hi from a real socket' &&
    messages[0]?.channelId === 'C-REAL' &&
    messages[0]?.senderId === 'U-REAL',
  JSON.stringify(messages[0]?.content),
);
check('A6c the adapter also ACKed exactly once', ackedFrames.filter((f) => f.envelope_id === 'env-real-2').length === 1);
await adapter.disconnect();

// ── A7: the deadline helper with REAL timers (unit tests use fake ones) ─────
let deadlineAcks = 0;
createDeadlineAck(50, () => {
  deadlineAcks += 1;
});
await new Promise((r) => setTimeout(r, 150));
check('A7 createDeadlineAck auto-acks once under real timers', deadlineAcks === 1, `acks=${deadlineAcks}`);

await new Promise((r) => wss.close(r));
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} — ${failed === 0 ? 'G7 loopback verified' : 'see failures above'}`);
process.exit(failed === 0 ? 0 : 1);
