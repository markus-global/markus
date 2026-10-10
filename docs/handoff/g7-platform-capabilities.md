# G7 handoff — Slack Socket Mode + Discord gateway (no public URL)

**Slice:** G7 of `req_f2610b70e3196b1201d4bf1b` (通用消息网关) · design `docs/design/messaging-gateway.md` §8/§10
**Base:** G4 tip (`tsk_055fc765af49815c7316acee`) — the outbound dispatcher must exist before
inbound transports are added, so this branch sits on G4, matching the natural merge order
G1 → G3 → G4 → G7.

---

## 1. What this slice delivers

Two platforms can now be reached **without a publicly reachable URL**, plus the capability
model that makes "which transport?" a table lookup instead of a platform `if`.

| # | Deliverable | File |
|---|---|---|
| 1 | Slack Socket Mode transport (real WebSocket, ack-on-receipt, reconnect) | `packages/comms/src/slack/socket.ts` |
| 2 | Ack normalisation — idempotent, deadline-armed handles | `packages/comms/src/gateway/ack.ts` |
| 3 | Slack adapter wiring: `socketMode` path, injectable wire, single copy of de-duplication | `packages/comms/src/slack/adapter.ts` |
| 4 | Capability model: `inboundModes`, `requiresPublicUrl`, `ackDeadlineMs`, `outboundKinds`, `extra`, and the one reader `activeInboundMode` | `packages/comms/src/platforms/registry.ts` |
| 5 | Tests (ack / socket / registry) | `packages/comms/test/{gateway-ack,slack-socket,platform-registry}.test.ts` |
| 6 | Loopback probe over a **real** WebSocket | `packages/cli/scripts/verify-g7-real-data.mjs` |

Discord's gateway already existed (`packages/comms/src/discord/client.ts`, injected
`DiscordGatewayTransport`) — this slice **declares** it (`inboundModes: ['gateway']`,
`requiresPublicUrl: false`) and pins that declaration in `platform-registry.test.ts`,
rather than rewriting a working client. **Correction (G8):** an earlier version of this
file claimed the *probe* pinned Discord too. It does not — `verify-g7-real-data.mjs`
exercises Slack only (zero Discord references). Discord's transport behaviour is covered
by `platform-registry.test.ts` (the declaration) and the pre-existing
`discord-transport.test.ts` (the wire), not by the probe.

## 2. The two platform gaps, and the shape of the fix

**Gap A — Slack could not connect without a public URL.** The old adapter treated Socket
Mode as unsupported: `connect()` literally threw *"Socket Mode requires a webhookPort"*.
Socket Mode inverts the connection: `POST apps.connections.open` with the **app-level** token
(`xapp-…`) returns a `wss://` URL, and every event arrives over that socket as an envelope
that **must be ACKed within ~3 s** or Slack redelivers.

**Gap B — the ACK window was not normalised.** The natural implementation hangs the ACK off
the agent turn, which takes seconds. Slack then times out, redelivers, and the user gets a
duplicate answer. The fix is structural: the ACK rides the **read path** and the handler is
dispatched **without being awaited**.

### The invariant that keeps it correct
`createDeadlineAck` is **idempotent** — first `ack()` wins, the timer is disarmed, every later
call is a no-op. This matters because a transport may both ack on receipt *and* arm a safety
deadline; two ACKs for one envelope is a protocol error on several platforms. Exactly one ACK
per envelope, always.

## 3. Capability model — the `if (platform === …)` ban, enforced by a table

```ts
capabilities: {
  inbound: true, outbound: true, threads: true, cards: true,   // v1 flags — untouched
  inboundModes: ['socket', 'webhook'],                          // how inbound arrives
  requiresPublicUrl: false,                                     // honest transport fact
  ackDeadlineMs: 3000,                                          // platform ack window
  outboundKinds: ['text', …, 'replyRef'],                       // what we may render
  extra: { blockKit: true, modals: true, shortcuts: true },      // platform-unique
}
```

Declarations shipped in this slice:

| platform | `inboundModes` | `requiresPublicUrl` | `ackDeadlineMs` | `extra` |
|---|---|---|---|---|
| feishu | `webhook`, `socket` (`wsMode`) | `false` | 3000 | `wsMode`, `cardKit`, `scanToCreateApp` |
| telegram | `polling`, `webhook` | `false` | — | `inlineKeyboards` |
| slack | `socket`, `webhook` | `false` | 3000 | `blockKit`, `modals`, `shortcuts` |
| discord | `gateway` | `false` | 3000 | `slashCommands`, `components`, `forumChannels` |
| whatsapp | `webhook` | `true` | — | `messageTemplates` |

The v1 booleans are kept verbatim: they are already on the Settings API wire and read as
booleans by the UI, so removing them would be a breaking change for zero gain.

`activeInboundMode(capabilities, config)` is the **single reader** of the table — precedence
`socket (opt-in) → polling (opt-in) → gateway → webhook`, defaulting to `webhook` for an
unknown platform. Nothing in core branches on a platform id to learn socket-vs-webhook.

## 4. Verification

| Layer | Command | Result |
|---|---|---|
| Unit (new) | `vitest run gateway-ack slack-socket platform-registry` | **62/62 pass** (written red first) |
| Package regression | `vitest run packages/comms` | **290/290 pass** |
| Types | `tsc -b` (whole repo) | **0 errors** |
| Lint | `eslint packages/comms/src packages/comms/test` | **0 errors** (36 pre-existing warnings, none in new files) |
| Real wire | `node packages/cli/scripts/verify-g7-real-data.mjs` | **10/10 PASS** |

### The real-wire probe (`verify-g7-real-data.mjs`)
Unit tests inject a *fake* socket, so they never touch the shipped `NativeSocket` or the real
ack-vs-handler ordering. The probe stands up a **real WebSocket server** that plays Slack and
drives the real `SlackSocketMode` / `SlackAdapter` against it:

- **A1/A1b** real `connect()` resolves on `hello`; the opener was a `POST` to
  `apps.connections.open` bearing `Bearer xapp-…`.
- **A2** the envelope is ACKed on the real wire **exactly once**.
- **A3** the ACK lands **while the handler is still parked** — the read loop is not blocked.
- **A4** the client created **no inbound listener**; its only socket is the outbound dial.
- **A5** a server-side close drives a real reconnect (a second `apps.connections.open`).
- **A6** adapter level: a real socket frame becomes a slack `Message` (bot mention stripped).
- **A7** `createDeadlineAck` auto-acks once under **real** timers (unit tests use fake timers).

### Behaviour change (intentional)
`packages/comms/test/slack-adapter.test.ts` asserted the old placeholder
*"connect throws when socket mode lacks webhookPort"*. That assertion pinned the defect this
slice removes; it now asserts the real contract — Socket Mode requires an `appToken`, and a
`webhookPort` is no longer needed.

## 5. Honest residuals

1. **Real-credential connectivity is NOT verified.** There is no Slack app / Discord bot in
   this environment. Everything proven here is loopback; that Slack accepts our `xapp-…` token
   and Discord accepts our bot token remains unverified until credentials exist.
2. **`slash_commands` / `interactive` envelopes are ACKed but not projected into messages.**
   They are recorded as capabilities (`extra.blockKit`) and logged, not turned into an agent
   turn — that projection is a separate feature.
3. **No PR.** Per slice discipline this is a single revertible commit handed to 老板 for
   manual verification.
4. Discord gateway is declared, not rewritten: it already connected without a public URL, so
   this slice added the capability declaration + registry-test coverage rather than
   speculative churn. The loopback probe is Slack-only and does **not** cover Discord
   (see the correction in §1).

## 6. Rollback

Single commit on `task/tsk_162bf5c1efae375961460b23`. `git revert <sha>` restores the prior
state exactly; nothing in this slice mutates data or schema.
