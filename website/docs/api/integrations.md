---
sidebar_position: 7
---

# Integrations API

Endpoints for configuring and managing third-party platform integrations.

## Configure a platform

**POST** `/api/integrations`

Create a new integration with a supported platform.

### Request Body

| Field | Type   | Required | Description                          |
|-------|--------|----------|--------------------------------------|
| name  | string | yes      | Display name for the integration     |
| platform | string | yes   | Platform identifier (e.g. `slack`, `jira`, `github`) |
| config    | object | yes  | Platform-specific configuration (API keys, webhook URLs, etc.) |

### Response

`201 Created`

```json
{
  "id": "int_abc123",
  "name": "Production Slack",
  "platform": "slack",
  "status": "active",
  "created_at": "2025-06-01T10:00:00Z"
}
```

## List integrations

**GET** `/api/integrations`

Retrieve all configured integrations, optionally filtered by platform or status.

### Query Parameters

| Field    | Type   | Required | Description                              |
|----------|--------|----------|------------------------------------------|
| platform | string | no       | Filter by platform name                  |
| status   | string | no       | Filter by status (`active`, `disabled`)  |

### Response

`200 OK`

```json
[
  {
    "id": "int_abc123",
    "name": "Production Slack",
    "platform": "slack",
    "status": "active"
  }
]
```

## Update an integration

**PATCH** `/api/integrations/:id`

Update the name, configuration, or status of an existing integration.

### Request Body

| Field  | Type   | Required | Description                              |
|--------|--------|----------|------------------------------------------|
| name   | string | no       | New display name                         |
| config | object | no       | Updated platform configuration           |
| status | string | no       | New status (`active` or `disabled`)      |

### Response

`200 OK`

```json
{
  "id": "int_abc123",
  "name": "Updated Slack",
  "platform": "slack",
  "status": "active"
}
```

## Remove an integration

**DELETE** `/api/integrations/:id`

Permanently delete an integration and revoke all associated credentials.

### Response

`204 No Content`
