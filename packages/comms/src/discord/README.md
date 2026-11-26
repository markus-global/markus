# Discord adapter

`DiscordAdapter` implements `CommAdapter`, using a separate `DiscordClient` for
Discord Gateway WebSocket events and REST requests. Both are exported from
`@markus/comms`.

Discord is wired into the runtime through its platform manifest
(`packages/comms/src/platforms/registry.ts`, `id: 'discord'`), which owns the
configuration surface: bot token, notification channel, agent binding, and
optional API/Gateway overrides. This file records the transport contract; the
manifest records what is configurable. (An earlier revision of this file said the
adapter was not registered in the runtime — that stopped being true when the
adapters moved to manifest-driven registration.)

The client uses Node 22's native `fetch` and `WebSocket`, so no Discord SDK or
additional dependency is bundled. Tests substitute the REST and Gateway
transports and also exercise the native transport with a fake WebSocket.

Use a Discord bot token. Enable **Message Content Intent** in the Discord
Developer Portal, and grant the bot permission to view the target channels,
send messages, and read message history for replies. The adapter requests
`GUILD_MESSAGES` and `MESSAGE_CONTENT`; it handles guild text messages, including
messages in existing Discord threads. Bot and empty messages are ignored.

Incoming Discord message IDs are used as Markus `threadId` values so the router
can reply to the original message. `channelId` remains the Discord channel ID
(or thread channel ID). Discord message references map to `replyToId`.

Connection completes only after Gateway `READY`. Invalid credentials, an initial
Gateway failure, or a connection timeout reject `connect()`. The existing router
catches these errors and continues. Once connected, transient closures and missing
heartbeat acknowledgements reconnect with capped delays and resume the session
where possible. Fatal authentication or intent errors stop retries. Disconnect
cancels timers and closes the socket. REST errors, including rate limits, are
returned to the caller; sends are not automatically replayed.
