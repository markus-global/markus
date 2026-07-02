---
sidebar_position: 2
---

# Agents API

## List Agents

```http
GET /api/agents
```

Returns a paginated list of all agents.

**Query Parameters:**

| Param    | Type    | Description                          |
| -------- | ------- | ------------------------------------ |
| `status` | string  | Filter by status (`idle`, `working`, `busy`, `offline`) |
| `page`   | integer | Page number (default: `1`)           |
| `limit`  | integer | Items per page (default: `20`)       |

**Response** `200 OK`:

```json
{
  "data": [
    {
      "id": "agt_abc123",
      "name": "Alice",
      "status": "idle",
      "skills": ["web-search", "code-review"],
      "created_at": "2024-01-15T10:30:00Z"
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 42 }
}
```

## Create Agent

```http
POST /api/agents
```

Register a new agent.

**Request Body:**

```json
{
  "name": "Alice",
  "skills": ["web-search", "code-review"],
  "config": { "timeout_ms": 60000 }
}
```

**Response** `201 Created`:

```json
{
  "id": "agt_abc123",
  "name": "Alice",
  "status": "idle",
  "skills": ["web-search", "code-review"],
  "created_at": "2024-01-15T10:30:00Z"
}
```

## Get Agent

```http
GET /api/agents/:id
```

Retrieve a single agent by ID.

**Response** `200 OK`:

```json
{
  "id": "agt_abc123",
  "name": "Alice",
  "status": "idle",
  "skills": ["web-search", "code-review"],
  "created_at": "2024-01-15T10:30:00Z"
}
```

**Response** `404 Not Found`:

```json
{ "error": "agent not found", "code": 404 }
```

## Update Agent

```http
PATCH /api/agents/:id
```

Partially update an agent's fields.

**Request Body:**

```json
{
  "status": "busy",
  "skills": ["web-search", "code-review", "memory"]
}
```

**Response** `200 OK`:

```json
{
  "id": "agt_abc123",
  "name": "Alice",
  "status": "busy",
  "skills": ["web-search", "code-review", "memory"],
  "updated_at": "2024-01-15T11:00:00Z"
}
```

## Delete Agent

```http
DELETE /api/agents/:id
```

Remove an agent from the system.

**Response** `204 No Content` — no body returned.

**Response** `404 Not Found`:

```json
{ "error": "agent not found", "code": 404 }
```
