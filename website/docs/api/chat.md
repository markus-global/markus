---
sidebar_position: 5
---

# Chat API

## POST /api/chat

Send a message to the chat assistant. Returns a **Server-Sent Events (SSE)** stream.

**Request body**

| Field    | Type     | Description                    |
|----------|----------|--------------------------------|
| content  | `string` | The user message text          |
| sessionId| `string` | Optional. Existing session ID  |

**SSE streaming response format**

```
event: message
data: {"content":"Hello","role":"assistant"}

event: message
data: {"content":" How can","role":"assistant"}

event: done
data: {"sessionId":"abc123"}
```

Events: `message` (chunk of assistant reply), `done` (stream complete, includes `sessionId`).

**Example — cURL**

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"content":"What is Markus?"}'
```

---

## GET /api/chat/sessions

List all chat sessions for the authenticated user.

**Response**

| Field      | Type       | Description                  |
|------------|------------|------------------------------|
| sessions   | `object[]` | Array of session objects     |
| sessions[].id | `string` | Session ID                |
| sessions[].title | `string` | Auto-generated title    |
| sessions[].createdAt | `string` | ISO-8601 timestamp   |

**Example response**

```json
{
  "sessions": [
    {
      "id": "abc123",
      "title": "What is Markus?",
      "createdAt": "2025-01-15T10:30:00Z"
    }
  ]
}
```

---

## DELETE /api/chat/sessions/:id

Delete a specific chat session and all its messages.

| Parameter | Type     | Description            |
|-----------|----------|------------------------|
| id        | `string` | Path parameter — session ID |

**Response** — `204 No Content`

**Errors**

| Status Code | Description                      |
|-------------|----------------------------------|
| 404         | Session not found                |
| 401         | Unauthorized — invalid or missing token |
