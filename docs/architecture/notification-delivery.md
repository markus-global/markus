# Notification & approval delivery

Status: **implemented** (2026-10). This is the design of the **outbound
notification path** — how a notification or an approval produced inside Markus
reaches a person's IM, and the invariants it holds. It supersedes the "honest
residual" notes formerly in `messaging-gateway.md` §7.4 / §11: on a live install
those residuals *were* the bug (a "connected" integration where every
notification was silently dropped).

The path is **platform-generic**. Feishu was merely the first platform where a
user configured a destination and noticed; the same structural holes existed for
every IM.

## Merge record

> **合并于 2026-11-15** — §12 (in-app user notifications) and §13 (agent→user tools:
> `notify_user` vs `request_user_input`) were merged **verbatim** from
> [`mailbox-system.md`](./mailbox-system.md) §12/§13, which now carry pointers only. The
> pre-existing structure (§1–§11, the outbound-to-IM path) is unchanged; the merged chapters
> keep their source numbering, so `mailbox-system.md §12.x / §13.x` references map one-to-one
> onto this file.
>
> Layering, so the two halves cannot contradict each other: §1–§11 describe **outbound to a
> person's IM** (destination resolution, send fidelity, approval cards, one-message-per-
> notification); §12 describes the **in-app** store + WebSocket fan-out; §13 describes the
> **agent-side tools** that feed both. They meet at `HITLService.notify()`, and the mechanism
> description is taken from `mailbox-system.md` as authoritative: `notify()` fans out
> **per person** for the in-app bell/WS and emits **exactly once** on the channel stream the
> IM dispatcher subscribes to (§12.5 here, §9 above).
>
> What stays in [`mailbox-system.md`](./mailbox-system.md): enqueue, priority, merging,
> leasing and retry of the mailbox items these paths produce. The mailbox only owns
> *enqueueing and priority*; the delivery contract is this document.

## 1. The model — a destination is a concrete, sendable address

First principle: **a notification destination is an address**
`(platform, instanceId, nativeId, receiveIdType?)` that the transport can actually
send to. It is obtained two ways, both first-class:

- **derived** — from a binding conversation (a chat the agent already lives in);
- **declared** — an explicit destination on the *instance* (a chat id), independent
  of any binding.

The lookup port (`NotifyTargetLookup`, production impl `RepoNotifyTargetLookup`)
exposes three readers — `agentTarget` / `instanceTarget` / `globalTarget` — and
`resolveNotifyTarget(orgId, origin, lookup)` walks them **first-hit-wins**. The walk
ends **loudly** (`{ delivered: false, reason: 'no-notify-target' }`), never with a
silent drop.

## 2. The resolution walk

The walk **enumerates candidates, most specific first, and returns the first one
that may actually be sent through**:

1. **agent** — the producing agent's own conversation binding (if any).
2. **instance** — the **declared notification destination** on the instance,
   read from `platform_instances.config` via the generic annotation (§3). This is
   the reliable terminus: it does not depend on any binding existing.
3. **instance** — an explicit `kind = 'notification'` binding sink on one of those
   instances.
4. **instance fallback** — the instance's `notifyAgentId` → that agent's
   conversation (best-effort).
5. **global** — the Secretary's conversation, else any global-scope binding with a
   native id.
6. **no candidates at all** → a visible **undelivered** state (surfaced in Settings
   and in one log line), once per message, not once per platform.
7. **candidates existed, every one ineligible** → an explicit **suppressed** state
   carrying *each* skipped candidate and why it was passed over — distinct from
   `undelivered`, so "deliberately switched off" can never again stand in for
   "mis-routed".

Level 2 is what makes delivery predictable on a fresh install: a destination set in
Settings is honoured even when no chat has ever bound to an agent.

### 2.1 Where-could-it-go and may-it-go-there are separate questions

`lookup.candidates()` answers only the first (it is a pure enumeration, ordered by
the rules below). Whether a candidate is **eligible** is a single predicate supplied
by the dispatcher — the notification preferences for *this* message (§6). The walk
applies it as a **filter**, moving on to the next candidate rather than stopping.

Collapsing the two into "pick one, then check it" is what silently dropped every
notification for an org on 2026-10-16: the walk landed on a bot whose notification
master switch was off and the drop was logged as `notify-disabled`, which reads like
an intentional setting. An ineligible candidate is now just skipped.

### 2.2 Candidate ordering is stated, never inherited from `ORDER BY label`

`platform_instances` is stored ordered by `(platform, label)`. Letting that *be* the
routing priority is how a bot labelled `CTO` silently outranked one labelled
`default`. The order is now declared in the lookup:

1. the instances the producing agent already works in (its own bindings);
2. the instance named by the org's declared global sink (`scope = 'global'`);
3. the Secretary's instances;
4. the rest, by creation time then id — a deterministic *tie-break*, never a
   semantic preference.

When more than one instance-scoped destination is available and one of them wins,
the dispatcher logs which bot was chosen and what else was on offer — so "why did
this land in *that* chat?" has an answer that is not "list order".

### 2.3 A switched-off bot is not a candidate at all

`platform_instances.enabled` is the bot's master switch (the toggle beside its
connection status). A disabled instance is not connected (`start.ts` skips it), so
it cannot deliver; it is excluded during enumeration — structurally, not via a
policy the resolver has to know about.

## 3. Generic destination declaration (`notifyTarget`)

A manifest field may carry `notifyTarget: 'chat' | 'user'`. The resolver scans a
platform's annotated fields (in manifest order) and needs **no platform branch** —
a new platform becomes a notification target by declaring a field rather than
adding an `if (platform === …)`. Field reference and the per-platform table live in
`packages/comms/docs/platform-manifest.md`.

The kind maps onto a wire receive-id type (`receiveIdTypeForDestination`:
`chat → chat_id`, `user → open_id`); an adapter whose user token differs translates
at the edge. Destination fields are always **optional** — a required field would
silently disable the platform.

## 4. A destination is a group, never a person

Approvals and notifications are posted into a **chat the bot has been added to**. A
bot that holds only a personal address is not a notification channel — and an
individual address made a bot with no group count as "configured" while nothing
reached the group, which is the failure this removes. Every platform with group
semantics therefore declares exactly one `chat` destination; a bot with no group is
honestly **unconfigured**.

The single exception is **WhatsApp**, whose Cloud API has no groups: its only
addressable recipient is a `wa_id`, so it declares a `user` destination.

## 5. Send fidelity — the render decision reaches the adapter

`renderOutbound()` picks `format = 'card' | 'markdown' | 'text'` by capability, but
the decision is only real if the transport honours it. `RouterOutboundSink.send()`
forwards the renderer's `format` **and** `NotifyTarget.receiveIdType` to the
adapter: `card → the adapter's interactive-card call` (Feishu
`sendInteractiveMessage`, Slack blocks, …), `markdown`/`text → text`. This is what
makes an approval **tappable** wherever the platform supports cards, instead of
degrading every notification to text with a literal `[label] ref`.

Capability degradation is a total function: `cards|buttons → 'card'`,
`markdown → 'markdown'`, otherwise `'text'`. The plain-text projection always exists
and always carries the action labels **and their refs** — a platform without buttons
shows the same content as text, it never drops it.

Notification bodies are Markdown; the adapter renders them as the platform's rich
form (Feishu `lark_md`). **Attribution is envelope, not payload** (§5.1): at the
single delivery point the dispatcher stamps the message's `origin` with the
producing agent's name and, when it has one, its **team** — and each renderer
places that fact once, in its own way.

### 5.1 Origin attribution — structure, not a body prefix

Who sent a message is *structure* (`origin.agentName` / `origin.teamName`), never a
line spliced into the body for a later stage to parse back out:

- **Text / markdown platforms** get a plain-text line from the one renderer,
  `originLine()` — `来自：{agent}（团队：{team}）`, or `来自：{agent}` with no team. It
  is deliberately markdown-free: the old in-band `**来自**：…` prefix leaked its `**`
  straight into text-only platforms, and left no room for the team.
- **Card platforms** keep `body` clean and receive `origin` as a field, which each
  adapter renders in its own extension slot — a Feishu `note` footnote, a Slack
  `context` block. Names are escaped per dialect (Slack mrkdwn) so an agent name
  cannot inject a mention or link.

The line is idempotent and best-effort: if the agent name cannot be resolved the
message is delivered anyway, unchanged; a missing team never withholds the agent
line nor the delivery. `RouterOutboundSink` forwards `origin` into the card
options; resolution happens once, in the dispatcher, from `agentId`.

## 6. One enforcement point for preferences

`notifyOnApproval` / `notifyOnNotification` / `notifyPriority` and the **master
switch** `notifyEnabled` are enforced in exactly one place — the dispatcher's
**eligibility predicate**, applied *inside* the walk (see §2.1) — reading the **same**
instance config as the destination (`RepoNotifyPreferenceSource`,
`suppressionReasonFor`). A preference is not a decorative field: toggling it changes
what is sent. Turning the master switch off removes exactly that bot from
consideration, at the same single point, not by greying out a button.

## 7. Single source of truth — the DB, never `markus.json`

The outbound wiring reads `platform_instances.config` (what Settings writes) and
**only** that. The legacy `markus.json` → `config.integrations.<platform>` read is
removed: a value the UI never wrote can no longer win. This is the "one fact, one
source" rule applied to the whole notification surface — the configured fact and the
consumed fact are the same row.

## 8. Approval round-trip (tap → record → visible, and the in-app banner)

An approval is a **one-shot card**: the platform never edits it for us. The
round-trip therefore has four observable steps, each with one owner:

1. **Outbound** — the card carries an action `ref`. Both the signing side and the
   verifying side call the *same* resolver, `resolveActionSecret()`
   (`@markus/shared`): an explicit `MARKUS_ACTION_SECRET` wins, otherwise a random
   secret is generated once and persisted at `~/.markus/action-secret` (0600),
   exactly like `resolveJwtSecret` / `resolveGatewaySecret`. **The operator never
   configures it** — signing is a defence-in-depth backstop, not the trust boundary
   (the inbound webhook / long-connection is authenticated by the platform itself).
   Unset is still accepted: `resolveCardActionValue(value, secret)` returns the
   `{approvalId, command}` from a *signed* token when a secret exists, and from a
   bare id (flagged `unverified`) when it does not — a tap is never silently
   discarded because a key was missing.
2. **Record** — the resolved action is handed to `hitlService.respondToApproval`;
   the decision is persisted, and the recorded actor is preserved (a second tap does
   not overwrite the first decision's actor).
3. **Rewrite the card** — after the decision is recorded, the wiring calls
   `router.updateResolvedCard(platform, instanceId, messageId, resolution)`: the
   adapter re-renders the same card with its action row replaced by a status line
   (`✅ 已批准` / `❌ 已驳回`, actor, time) and the header recoloured. The message id
   comes from the action (`InboundAction.messageId`, Feishu
   `context.open_message_id`); title/body are re-read from the approval record —
   never scraped back out of the card. Two contract rules make this safe: the
   capability is **optional** on `CommAdapter` (a platform that cannot edit messages
   omits it, and `updateResolvedCard` returns `false` rather than throwing), and it
   is **best-effort** (a failed rewrite is logged, never rolls back a recorded
   decision). The PATCH is **scheduled after the callback ack**
   (`scheduleCardRewrite`, `CARD_REWRITE_DELAY_MS = 1000`, `unref`) so it is the
   last write the tapper's client sees — an in-ack PATCH is visually overwritten by
   the client's re-render of the card as it was at tap time. A repeated tap
   re-reads the approval and rewrites again, so an old-looking card self-heals.
4. **Dismiss the in-app banner** — the decision must invalidate every derived view,
   whoever triggered it. Terminal transitions (approve / reject / cancel / timeout)
   emit through one hook, `HITLService.onApprovalChanged`; api-server **broadcasts**
   `approval:resolved`; the Team banner and the notification bell subscribe and
   refresh. The event fires at the **transition itself**, not at each call site, so a
   decision made from an external IM (a different process path than the HTTP route)
   dismisses the in-app banner just the same. Invariant: *any terminal approval
   transition invalidates all derived views, regardless of who caused it.*

## 9. One logical notification ⇒ one message

The dispatcher subscribes to **one** notification stream, and the sources are split
by semantics at a single point:

- `HITLService.notify()` fans out **per person** (app bell / WS) **N** times, and
  emits on the **channel** stream (`onChannelNotification`) **exactly once**. The
  dispatcher subscribes to the channel stream (`attachNotifications`), so one
  logical notification yields **one** IM message — decoupled from the number of
  human users. Subscribing to the per-person stream (the pre-fix wiring) multiplied
  every message by the human count; that is the duplicate-delivery bug.
- The EventBus path (`attachEventBus`: `task:completed` / `task:failed`) is a
  **separate** notification — the agent's *execution* terminus, not a copy of the
  status-transition notice. The task state machine emits no `task:*` events, so a
  single transition cannot fire both paths. There is no "second source" to
  de-duplicate; de-duplicating would be a guard for a writer that does not exist.

**Inbound duplicates** are a distinct layer, fixed structurally: an adapter's
on-message **handler is wired at registration, not at connect**. Registration
dedupes by adapter identity and `connect` only establishes transport, so repeated
reconnects (a settings save, a "verify connection", a platform reconnect) cannot
stack handlers. Invariant: *subscribing is a registration-time act; connecting only
moves bytes.*

## 10. Invariants

- A destination is a sendable address; if none is **eligible** the result is a
  **visible** state — `undelivered` when nothing was configured, `suppressed` (with
  every skipped candidate and its reason) when candidates existed and all were
  switched off. Never a silent drop.
- An ineligible candidate is a **filter**, never a dead end: the walk continues to
  the next destination. One switched-off bot cannot swallow a notification another
  bot could deliver.
- Destination, send fidelity, preference enforcement and attribution all read the
  **same** instance config (the DB) — one fact, one source.
- Attribution is **structure** (`origin.{agentName,teamName}`), placed exactly once per
  rendering: an inline, markdown-free line for text platforms, a native extension slot
  for card platforms — never both, never a body prefix a later stage must parse.
- A notification platform with buttons renders a tappable card; capability
  degradation is total and never loses content.
- **Exactly one** IM message per logical notification, independent of user count.
- A notification **names its subject**. An event that carries no human-readable
  title/summary is an internal signal, not a notification, and is not sent — the
  dispatcher never falls back to the raw event name as a title (2026-10-16: an
  agent-execution `task:completed`, payload `{ taskId, agentId }`, was pushed to
  Feishu as the literal string `"task:completed"`). The user-facing task facts
  belong to the status machine → HITL, which always carries the title.
- A tap always produces visible evidence; the card rewrite is post-ack, optional and
  best-effort.
- Any terminal approval transition invalidates all derived UI, from any trigger.

## 11. Not claimed

- Real-service connectivity for Slack / Telegram / Discord is unverifiable on a
  desktop install (no public URL); Feishu long-connection is the proven path.
- A desktop install with no group configured for a bot is correctly
  **unconfigured** — that is the designed state, not a defect.

---

## 12. User Notifications (Human Mailbox)

> Merged 2026-11-15 from `mailbox-system.md` §12 (verbatim below). This is the **in-app**
> layer — a DB row plus a WebSocket fan-out — i.e. the user-facing counterpart of the agent
> mailbox. Outbound-to-IM delivery of the same notification is §1–§11 above; both are fed by
> `HITLService.notify()`.

Just as agents have a mailbox for incoming stimuli, users have a **persistent notification system** for events that require their attention. This is the user-facing counterpart to the agent mailbox.

### 12.1 Storage

```sql
CREATE TABLE user_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,             -- UserNotificationType
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  priority TEXT DEFAULT 'normal', -- 'low' | 'normal' | 'high' | 'urgent'
  read INTEGER DEFAULT 0,
  action_type TEXT,               -- 'navigate' | 'open_chat' | null
  action_target TEXT,             -- JSON: { path } or { agentId, sessionId }
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 12.2 Notification Type Registry

Analogous to `MAILBOX_TYPE_REGISTRY`, user notification types are defined in `USER_NOTIFICATION_TYPE_REGISTRY` in `@markus/shared`:

| Type | Label | Icon | Default Priority | Action | Category |
|------|-------|------|-----------------|--------|----------|
| `approval_request` | Approval Request | 🔐 | high | navigate | approval |
| `task_created` | Task Created | 📋 | normal | navigate | task |
| `task_completed` | Task Completed | ✅ | normal | navigate | task |
| `task_review` | Task Review | 👁️ | normal | navigate | task |
| `task_failed` | Task Failed | ❌ | high | navigate | task |
| `requirement_created` | Requirement Proposed | 📝 | high | navigate | task |
| `requirement_decision` | Requirement Decision | ⚖️ | normal | navigate | task |
| `agent_report` | Agent Report | 📊 | normal | none | agent |
| `system` | System | ⚙️ | normal | none | system |

### 12.3 Action Types

Notifications can be **actionable** — clicking them navigates the user to the relevant context:

| `action_type` | `action_target` format | Behaviour |
|---------------|----------------------|-----------|
| `navigate` | `{ "path": "/work?task=T123" }` | Navigate to the specified route |
| `open_chat` | `{ "agentId": "...", "sessionId": "..." }` | Open chat with agent, resume session |
| `none` | — | Notification only, no navigation |

### 12.4 REST API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/notifications?type=...&limit=...&offset=...` | List notifications with filtering, returns `totalCount` and `unreadCount` |
| POST | `/api/notifications/:id/read` | Mark single notification as read |
| POST | `/api/notifications/mark-all-read` | Mark all notifications as read |

### 12.5 Real-Time Delivery

When a notification is created (via `HITLService.notify()`), a WebSocket `notification` event is broadcast. The frontend `App.tsx` listens for this and dispatches a `markus:notifications-changed` custom DOM event, which triggers the `NotificationBell` component to refresh.

---

## 13. Agent-to-User Communication

> Merged 2026-11-15 from `mailbox-system.md` §13 (verbatim below). The distinction is a
> contract, not guidance: `notify_user` informs (one-way), `request_user_input` asks
> (blocking, returns the answer). Mailbox-side, the resulting items are ordinary mailbox
> items — see [mailbox-system.md](./mailbox-system.md) §5 for enqueue and §4 for the
> approval-wait backstop (`APPROVAL_WAIT_TIMEOUT_MS`, 24 h).

Agents have two distinct modes for communicating with users. **They are not
interchangeable** — the choice is decided by one question: *do I need an answer
before I can continue?*

| I need… | Tool | Semantics |
|---|---|---|
| to inform (status, report, alert, finding) | `notify_user` | **one-way**; do NOT expect a reply; must not wait for it |
| an answer / authorization / a decision | `request_user_input` | **blocks** until the human responds; returns the answer |

A question asked through `notify_user` does not block, brings no answer back, and
leaves the agent permanently blocked — which in practice produces repeated
notifications of the same ask (2026-10-25: 12 identical sends in 3 minutes). A
notification sent through `request_user_input` would hold a turn open for an
answer nobody needs to give. Each tool's own description states this boundary;
it is enforced by the tools' contracts, not by caller discipline.

### 13.1 `notify_user` — Proactive Chat Message + Notification

Proactive messages that appear in the agent's chat **and** the user's notification bell. The user can reply in chat, and the agent has full context of what it sent.

```typescript
// Tool schema
{
  name: 'notify_user',
  parameters: {
    title: string,     // Short headline (1 line)
    body: string,      // Full message content (visible in chat)
    priority: 'low' | 'normal' | 'high' | 'urgent',  // optional, default 'normal'
    related_task_id?: string,  // deep-link to task if applicable
    target_user_id?: string    // target specific user (defaults to currentInteractingUserId)
  }
}
```

**When to use**: Status updates, task completion notices, FYI messages, findings, alerts — any proactive communication where the user may want to reply.

**Flow**: `agent.executeTool('notify_user')` → builds formatted message with embedded context → `memory.appendMessage()` (in-memory session) → `eventBus.emit('agent:notify-user')` → `start.ts` handler: `chatSessionRepo.appendMessage()` (with `notifyUser` metadata) + `ws.broadcastProactiveMessage()` (with metadata) + `hitlService.notify()`

**Notification routing**: With `related_task_id` → `actionType: 'navigate'` to Work page. Without task → `actionType: 'open_chat'` with `sessionId` to agent's chat.

#### Message Metadata & Context Embedding

Every `notify_user` message is persisted with **two layers of context**:

1. **DB metadata** (`metadata` column): `{ notifyUser: true, priority, taskId?, requirementId? }` — used by the frontend to display context links and badges.

2. **Embedded context comment** (appended to message content): `<!-- notify_context: task_id=xxx, requirement_id=yyy -->` — survives through `restoreSessionFromHistory()` (which only reads `role` + `content`), ensuring the agent retains context about what it notified the user about when the user replies.

The agent's `chat` scenario system prompt instructs it to parse these `notify_context` references and use tools like `recall_activity` or `search_tasks` to retrieve full context before responding to user follow-ups.

> **Referencing resources in the body**: `notify_user` bodies (and any chat/comment/report markdown) should reference Markus resources using the conventions in [prompt-engineering.md §2.2 "Referencing Markus Resources"](./prompt-engineering.md#referencing-markus-resources) — bare IDs (`tsk_…`, `dlv_…`, …), titled links `[Title](task:tsk_…)`, or a reference alone on its own line to render a card. This is separate from the `related_task_id` metadata (which drives the notification's deep-link badge).

#### Real-time Visibility

All `notify_user` messages are buffered in the frontend for every agent conversation immediately upon WebSocket receipt — regardless of whether the user is currently viewing that agent's chat. This ensures messages are visible as soon as the user navigates to the agent, without requiring a page reload.

### 13.2 `request_user_input` — Blocking Decision Request

Requests input or a decision from the user. The tool **blocks** until the user
responds — no timeout. Supports multiple questions, default Approve/Reject
options, custom options, and optional freeform text input.
`request_user_approval` is a deprecated alias with identical behaviour, kept only
so older prompts keep working.

**Use it whenever you cannot continue without an answer** — an authorization, a
scope call, an ambiguous choice, a fact only the human has ("I am blocked, I need
one line of approval"). Asking through `notify_user` instead leaves the turn
unblocked, brings no answer back, and produces repeated notifications of the same
ask; the blocking tool is the only correct choice for a question that needs an
answer.

```typescript
// Tool schema
{
  name: 'request_user_input',
  parameters: {
    title: string,           // Short headline
    description: string,     // Detailed context
    options?: Array<{        // Custom options (defaults to Approve/Reject)
      id: string,
      label: string,
      description?: string
    }>,
    allow_freeform?: boolean, // Allow user to type custom text
    related_task_id?: string,
    priority?: 'normal' | 'high' | 'urgent'
  }
}
// Returns: { status: 'ok', approved: boolean, selected_option: string, comment: string }
```

**When to use**: Approval requests, design decisions, choosing between approaches, anything requiring user input or decision.

**Flow**: `agent.executeTool('request_user_input')` → `attentionController.setWaitingForApproval(true)` → `HITLService.requestApprovalAndWait(options)` → notification + WebSocket → NotificationBell renders options → user responds → `HITLService.respondToApproval(selectedOption)` → promise resolves → agent receives result

The attention controller uses `APPROVAL_WAIT_TIMEOUT_MS` (24h) instead of the normal 45-minute backstop (`MAILBOX_PROCESSING_TIMEOUT_MS`) while waiting for approval, preventing the mailbox item from being requeued prematurely.

### 13.3 Prompt Guidance

The system prompt includes scenario-specific guidance on which tool to use:

| Situation | Tool |
|-----------|------|
| Status report, progress update, FYI alert | `notify_user` — one-way; the user may reply, but do not wait |
| Task completed notification | `notify_user` with `related_task_id` |
| **Blocked: needs an authorization / decision to continue** | **`request_user_input`** (blocks, returns the answer) |
| Need user to approve/reject something | `request_user_input` (default options) |
| Need user to choose between approaches | `request_user_input` with custom `options` |
| Need user freeform input | `request_user_input` with `allow_freeform: true` |
| Want to discuss interactively | Mention user via task/requirement comment |
| Need to review past execution details | `recall_activity` (list activities or get logs) |

---

## 14. What this document does *not* own

- **Enqueueing, priority, merging, leasing, retry** of the notification / approval /
  `a2a_message` items these paths produce — [`mailbox-system.md`](./mailbox-system.md) §4-§6,
  §14, §17-§18.
- **Which agent gets an inter-agent message and how** —
  [`a2a-communication.md`](./a2a-communication.md) §11.
- **Addresses, envelopes and bounces** (`refOrigin`, delivery facts, `bounced`) —
  [`mailbox-system.md`](./mailbox-system.md) §28.
