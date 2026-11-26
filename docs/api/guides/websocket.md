# WebSocket events

**Hand-written on purpose.** `docs/api/reference.md` is generated from the route
table; WebSocket events are not routes — they are emitted from
`packages/org-manager/src/ws-server.ts` and consumed by `packages/web-ui/src/api.ts`
and the desktop notification bridge. Nothing generates this list, so **treat it as
a guide, not a contract**: verify against `ws-server.ts` before relying on an event.
(Generating it is possible — read the emit sites — but it is not done yet, and this
note is the honest marker rather than a silent gap.)

**Connection**: `ws://localhost:8056`

| Event | Direction | Description |
|-------|-----------|-------------|
| `agent:update` | Server → Client | Agent status change |
| `agent:mailbox` | Server → Client | New item in agent mailbox |
| `agent:decision` | Server → Client | Agent attention decision |
| `agent:focus` | Server → Client | Agent switches focus |
| `task:update` | Server → Client | Task status update |
| `task:create` | Server → Client | New task created |
| `requirement:created` | Server → Client | New requirement proposed |
| `chat` | Server → Client | Agent message in channel |
| `task:comment` | Server → Client | New task comment (includes `replyTo`, `replyToAuthor`, `replyToContent`) |
| `requirement:comment` | Server → Client | New requirement comment (includes `replyTo`, `replyToAuthor`, `replyToContent`) |
| `chat:message` | Server → Client | Channel/DM/group message (members only; includes `replyToId`, `replyToSender`, `replyToText`) |
| `chat:proactive_message` | Server → Client | Agent activity log or proactive message |
| `chat:group_created` | Server → Client | Group chat created |
| `chat:group_updated` | Server → Client | Group chat membership changed |
| `chat:group_deleted` | Server → Client | Group chat deleted |
| `notification` | Server → Client (targeted) | User notification (targeted by userId) |
| `system:announcement` | Server → Client | System announcement broadcast |
| `system:pause-all` | Server → Client | Global pause event |
| `system:resume-all` | Server → Client | Global resume event |
| `system:emergency-stop` | Server → Client | Emergency stop event |

## Adding an event

An event's name is declared as a loose `string` in **three** places — the server
(`ws-server.ts`), the web UI (`api.ts`), and the desktop notification bridge. There
is no union type, so there is no compile-time exhaustiveness check. Adding an event
means updating all three and giving the client a fallback for unknown types; a
client that silently drops an unknown event makes the next debugging session
pointless.
