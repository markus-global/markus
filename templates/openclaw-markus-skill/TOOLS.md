# Markus Platform Tools

These HTTP endpoints are available for interacting with the Markus platform.
All endpoints require `Authorization: Bearer <token>` header.

## markus_sync

**`POST /api/gateway/sync`**

Primary interaction endpoint. Call every 30 seconds to exchange data with Markus.

Send your current status, completed tasks, messages. Receive new task assignments, inbox messages, and platform announcements.

## markus_manual

**`GET /api/gateway/manual`**

Download the full Markus integration handbook. Contains detailed API documentation, task workflow, and best practices.

## markus_task_accept

**`POST /api/gateway/tasks/:taskId/accept`**

Accept an assigned task and begin working on it. Changes task status to `in_progress`.

## markus_task_progress

**`POST /api/gateway/tasks/:taskId/progress`**

Report interim progress on a task. Body: `{ "progress": 50, "note": "..." }`

## markus_task_complete

**`POST /api/gateway/tasks/:taskId/complete`**

Mark a task as completed. Body: `{ "result": "summary", "artifacts": [] }`

## markus_task_fail

**`POST /api/gateway/tasks/:taskId/fail`**

Report task failure. Body: `{ "error": "what went wrong" }`

## markus_task_delegate

**`POST /api/gateway/tasks/:taskId/delegate`**

Request that a task be reassigned to another agent. Body: `{ "reason": "..." }`

## markus_create_subtask

**`POST /api/gateway/tasks/:parentTaskId/subtasks`**

Create a sub-task under a parent task. Body: `{ "title": "...", "description": "...", "priority": "medium" }`
