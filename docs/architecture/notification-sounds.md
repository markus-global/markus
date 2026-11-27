# Notification sounds (web UI)

Short auditory cues for events the user must notice while not looking at the screen.
This document is the human-readable mirror of the single source of truth in
`packages/web-ui/src/lib/notificationSounds.ts` — if the two disagree, the code wins
and this file is the bug.

## Why synthesized cues, not audio files

Every cue is a small group of oscillator notes (frequency / start / duration / waveform /
gain). No binary assets means no packaging path, no codec differences between browsers and
Electron, and the note table is plain data that unit tests can assert on. Total audible
length per cue stays under 0.6 s: a cue is a hint, not an interruption.

## Event catalogue

| Event id | Label (zh) | Trigger (authoritative source) | Cue |
|---|---|---|---|
| `agent-reply-complete` | Agent 回复完成 | `session:stream_state` WS event: the server-confirmed turn for a session goes `streaming: true → false` with status `done` | `chime` (rising two-note) |
| `input-requested` | Agent 在问你 | WS `notification` with `type = approval_request` **and** `metadata.askKind = "input"` (the agent called `request_user_input`) | `ask` (soft rising two-note) |
| `approval-requested` | 有审批待处理 | WS `notification` with `type = approval_request` and no `askKind: "input"` (a gate that needs a decision) | `attention` (triple ping) |
| `review-requested` | 任务待验收 | WS `task:update` whose `status` is `review`; or a notification typed `review_request` / `task_review` | `ding` (single ding) |
| `notification` | 收到通知 | Any other WS `notification` (`notify_user` and friends) | `pop` (soft pop) |
| `agent-reply-error` | Agent 回复出错 | Same stream transition as above, but the turn ends with status `error` | `alert` (falling two-note) |
| `task-failed` | 任务失败 | WS `task:update` whose `status` is `failed` | `alert` |

`cancelled` / `stopped` turns are deliberately silent: the user pressed stop, they already
know. Task transitions to `completed` / `pending` / `in_progress` are silent too — an agent
finishing everyday work must not create a soundtrack.

## Cue table

| Cue id | Notes | Peak gain | Length | Used by |
|---|---|---|---|---|
| `chime` | 698.46 Hz → 880 Hz, sine (+octave overtone) | 0.30 | 0.44 s | `agent-reply-complete` |
| `attention` | 880 Hz ×2 → 1174.66 Hz, triangle (+octave) | 0.28 | 0.62 s | `approval-requested` |
| `ding` | 1046.5 Hz triangle (+octave) + 2093 Hz sparkle | 0.28 | 0.34 s | `review-requested` |
| `pop` | 523.25 Hz → 659.25 Hz, sine (+octave) | 0.30 | 0.27 s | `notification` |
| `alert` | 392 Hz → 311.13 Hz, triangle (+octave) | 0.32 | 0.60 s | `agent-reply-error`, `task-failed` |
| `ask` | 587.33 Hz → 783.99 Hz, sine (+octave) | 0.28 | 0.47 s | `input-requested` |

### Loudness and duration — the numbers that listenable

Reference points (industry IM / system sounds): peak level around **−10 … −6 dBFS** (linear
0.30–0.50), daily-event cues **0.25–0.45 s**, "you must act" cues **0.5–0.7 s**. The first
revision of this feature shipped 0.11–0.16 peak with 0.2–0.3 s spans and was audibly too quiet
and too clipped (Owner, 2026-11-27).

What the current cue table follows:

- **Peak gain 0.26–0.32 per note** — same perceptual loudness as Slack / macOS cues. Every voice
  is clamped to `PEAK_LIMIT = 0.85` after the volume multiplier, so `loud` cannot clip.
- **Overtones instead of a louder fundamental** — a pure sine at a given level sounds markedly
  weaker than a triangle; each note may carry `overtones: [{ mult, gain }]` (an octave partial,
  sometimes a fifth) which adds body without the harshness of pushing the fundamental up.
- **Duration is a semantic signal** — recurring daily events stay short (`pop` 0.27 s, `ding`
  0.34 s), events that need a decision run longer (`attention` 0.62 s, `alert` 0.60 s). A busy
  queue therefore produces short ticks, while "you owe me an approval" gets attention.
- Frequencies stay in 310–1200 Hz (plus quiet octaves) so cues do not sit on top of speech.

Tests pin the floor (`peak ≥ 0.24`, long cues `≥ 550 ms`, daily cues `≥ 250 ms`) so a future
"let me make it subtle" edit cannot silently regress into inaudible territory.

### How `input-requested` is told apart from an approval gate

Both a human question (`request_user_input`) and a decision gate arrive as the same
notification type (`approval_request`), so the distinction must be carried by the producer,
not guessed by the consumer. `HITLService.requestApproval({ askKind })` accepts
`'input' | 'approval'` and copies it into `notification.metadata.askKind`; the CLI's
`userApprovalRequester`装配点 — reached **only** from the agent's `request_user_input` tool —
passes `askKind: 'input'`.

The tempting shape-based proxy is wrong: `metadata.formOnly` / `questions` answer "can one
tap finish it", not "is this a question or a gate" — a multi-question real approval has
exactly the same shape as a question. A notification without `askKind` is therefore treated
as a gate (conservative: better to over-alert on a decision than to whisper a gate).

Cue names are localized (`settings:sounds.cues.*`) and shown next to each event row in
Settings → General → Notification sounds, together with a **Preview** button that plays the
cue while bypassing the switches (the user clicked it on purpose).

## Where the sound is triggered

`packages/web-ui/src/hooks/useNotificationSounds.ts` is mounted once in `App.tsx` (next to
`useAttentionBadge`) and is the only wiring point:

1. **Turn end** — subscribes to `sessionStreamState` (the client-side authority for
   "is this session generating", fed by server `session:stream_state` pushes plus batch
   reconciliation). It compares consecutive snapshots and fires only when a previous
   snapshot said *this session was streaming* and the new one says the server confirmed it
   ended. Consequences:
   - reattaching mid-stream on app start does not replay a cue later for a turn that never
     started while the app was running; the first snapshot is treated as a baseline;
   - switching tabs, reconnecting the socket, or a reconciliation poll cannot fire a cue
     for a session that was already finished;
   - a local optimistic `false` (the moment the user presses stop) never fires — only the
     server's verdict does.
2. **Approvals / notifications** — WS `notification`.
3. **Task review / failure** — WS `task:update`.

No second judgement lives in the hook: classification is `soundEventFor*` and suppression
is `SoundGate`, both pure.

## Switching and throttling

Preferences live in `localStorage` under `markus-notification-sounds` as
`{ enabled: boolean, disabledEvents: string[], volume: 'quiet' | 'normal' | 'loud' }`. They are
deliberately device-scoped (like the theme): "should this machine make noise" is not an
account-level trait.

`volume` multiplies every note's gain (`quiet` 0.6, `normal` 1, `loud` 1.7) and is clamped per
voice, so the loud step cannot clip. Settings → General → Notification sounds shows the three
steps and plays the selected level on click — a volume control the user cannot hear while
adjusting is a guess, not a setting. The Preview button for each event also uses the current
level, so what you audition is what you will hear.

The gate applies three rules in order, short-circuiting:

1. master switch off → nothing plays;
2. the event is individually disabled → that event does not play;
3. `EVENT_COOLDOWN_MS` (4 s) per event and `GLOBAL_GAP_MS` (0.7 s) between any two cues —
   ten sessions finishing at once yields one chime, not a chord.

Changing the preference broadcasts `markus:notification-sounds-changed` (and `storage`
events cover other tabs), so an open Settings page and the running app never disagree.

## Adding a new sound

1. Add the event id to `NotificationSoundEvent` **and** to `NOTIFICATION_SOUND_EVENTS`
   with an existing cue (or add a new cue to `SOUND_CUES`).
2. Add `settings:sounds.events.<event>.label` / `.desc` in `en`, `zh-CN` and `es`.
3. Add a `soundEventFor*` classifier branch (or extend an existing one) and wire it in
   `useNotificationSounds.ts` if it comes from a new signal.
4. Extend `packages/web-ui/test/notificationSounds.test.ts`; the existing tests fail on a
   missing cue or a missing translation, by design.

## Known limitations

- Browser autoplay policy: audio needs one user gesture before the first cue. The player
  resumes the `AudioContext` opportunistically and silently skips a cue if the context is
  still suspended — the next event after any click works.
- Cues fire for every agent, including background sessions and other tabs' conversations.
  That is intentional (the point is "something finished while you were elsewhere"), but it
  means a busy team can produce a cue every few seconds; per-event switches exist for that.
- The user's own actions (approving, submitting for review, stopping a turn) are not
  suppressed by identity yet — if the UI later emits the same WS event for a self-service
  action, a cue would fire. `soundEventForTaskUpdate` only reacts to `review` / `failed`,
  which are agent-driven transitions today.
