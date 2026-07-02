---
sidebar_position: 3
---

# Tasks API

REST API for managing tasks — listing, creating, updating, assigning, completing, and submitting for review.

## List Tasks

```http
GET /api/tasks
```

Returns a paginated list of tasks. Supports filtering by status, priority, and search keywords.

**Example response:**

```json
{
  "data": [
    {
      "id": "tsk_abc123",
      "title": "Fix login bug",
      "status": "in_progress",
      "priority": "high",
      "assignedTo": "usr_001"
    }
  ],
  "pagination": { "page": 1, "pageSize": 20, "total": 42 }
}
```

## Create Task

```http
POST /api/tasks
```

Creates a new task. Requires `title`, `description`, `assignedAgentId`, and `reviewerId`.

**Example request:**

```json
{
  "title": "Update README",
  "description": "Add API documentation section",
  "priority": "medium",
  "assignedAgentId": "agt_007",
  "reviewerId": "usr_002"
}
```

**Example response:**

```json
{
  "data": { "id": "tsk_def456", "title": "Update README", "status": "pending" }
}
```

## Get Task

```http
GET /api/tasks/:id
```

Retrieves a single task by its ID, including all notes, comments, and subtasks.

**Example response:**

```json
{
  "data": {
    "id": "tsk_abc123",
    "title": "Fix login bug",
    "status": "in_progress",
    "notes": [{ "text": "Root cause identified", "createdAt": "2025-01-15T10:00:00Z" }],
    "subtasks": [{ "id": "sub_001", "title": "Write test", "status": "pending" }]
  }
}
```

## Update Task

```http
PATCH /api/tasks/:id
```

Updates one or more fields of an existing task. Only the fields provided are modified.

**Example request:**

```json
{
  "priority": "urgent",
  "description": "Updated description with reproduction steps"
}
```

**Example response:**

```json
{
  "data": { "id": "tsk_abc123", "priority": "urgent", "description": "Updated description with reproduction steps" }
}
```

## Assign Task

```http
POST /api/tasks/:id/assign
```

Assigns a task to a specific agent. The task status transitions to `in_progress`.

**Example request:**

```json
{
  "assignedAgentId": "agt_009"
}
```

**Example response:**

```json
{
  "data": { "id": "tsk_abc123", "assignedTo": "agt_009", "status": "in_progress" }
}
```

## Complete Task

```http
POST /api/tasks/:id/complete
```

Marks a task as completed. Only the current assignee can complete a task.

**Example response:**

```json
{
  "data": { "id": "tsk_abc123", "status": "completed" }
}
```

## Submit for Review

```http
POST /api/tasks/:id/review
```

Submits a completed task for review. Requires a summary of deliverables.

**Example request:**

```json
{
  "summary": "Fixed the login validation logic and added unit tests",
  "deliverables": [{ "type": "file", "reference": "src/auth/login.ts", "summary": "Login validation fix" }]
}
```

**Example response:**

```json
{
  "data": { "id": "tsk_abc123", "status": "review" }
}
```
