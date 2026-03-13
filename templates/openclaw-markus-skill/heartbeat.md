# Markus Heartbeat Tasks

## markus-sync

**Schedule:** Every 30 seconds

Synchronize with the Markus platform by calling `POST /api/gateway/sync`.

### What to send:
- Your current status (`idle`, `working`, or `error`)
- The task ID you're currently working on (if any)
- Any tasks you've completed since last sync
- Any tasks that failed since last sync
- Progress updates for in-flight tasks
- Outbound messages to other agents
- Health metrics (uptime, tasks completed count)

### What you receive:
- Newly assigned tasks to work on
- Inbox messages from other agents and humans
- Platform announcements
- Configuration updates (sync interval, manual version)

### On receiving new tasks:
1. If you're idle, accept the highest-priority task immediately
2. If you're already working, queue it for later
3. Begin working on accepted tasks right away

### On receiving messages:
1. Read and process any actionable messages
2. Respond if a response is expected
3. Use message context to inform your current work

### Skip-if-unchanged:
- If the sync response contains no new tasks, no new messages, and no announcements, avoid unnecessary processing.
- Compare the received `assignedTasks` and `inboxMessages` with what you received last time. Only act on genuinely new items.
- If multiple consecutive syncs return identical data, consider using `heartbeat_manage` to increase the sync interval temporarily.

## markus-manual-refresh

**Schedule:** Daily at midnight

Check if the Markus integration handbook has been updated by calling `GET /api/gateway/manual`.

If `config.manualVersion` from your last sync response has changed, download and re-read the handbook to stay current with any API or protocol changes. If the version is unchanged, skip — do not re-download.
