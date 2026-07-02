---
sidebar_position: 6
---

# Requirements API

## List Requirements

```http
GET /api/requirements
```

Returns a paginated list of all requirements.

**Query Parameters:**

| Param       | Type    | Description                                      |
|-------------|---------|--------------------------------------------------|
| `status`    | string  | Filter by status (`pending`, `approved`, `rejected`, `completed`, `cancelled`) |
| `project_id`| string  | Filter by project ID                             |
| `page`      | integer | Page number (default: `1`)                       |
| `limit`     | integer | Items per page (default: `20`)                   |

**Response** `200 OK`:

```json
{
  "data": [
    {
      "id": "req_abc123",
      "title": "Add user authentication",
      "description": "Implement OAuth2-based login flow",
      "status": "approved",
      "priority": "high",
      "project_id": "proj_xyz789",
      "created_at": "2024-01-15T10:30:00Z"
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 35 }
}
```

## Create Requirement

```http
POST /api/requirements
```

Submit a new requirement for review.

**Request Body:**

```json
{
  "title": "Add user authentication",
  "description": "Implement OAuth2-based login flow with Google and GitHub providers",
  "priority": "high",
  "project_id": "proj_xyz789"
}
```

**Response** `201 Created`:

```json
{
  "id": "req_abc123",
  "title": "Add user authentication",
  "description": "Implement OAuth2-based login flow with Google and GitHub providers",
  "status": "pending",
  "priority": "high",
  "project_id": "proj_xyz789",
  "created_at": "2024-01-15T10:30:00Z"
}
```

## Get Requirement

```http
GET /api/requirements/:id
```

Retrieve a single requirement by ID.

**Response** `200 OK`:

```json
{
  "id": "req_abc123",
  "title": "Add user authentication",
  "description": "Implement OAuth2-based login flow with Google and GitHub providers",
  "status": "approved",
  "priority": "high",
  "project_id": "proj_xyz789",
  "tags": ["auth", "security"],
  "created_at": "2024-01-15T10:30:00Z",
  "updated_at": "2024-01-16T08:15:00Z"
}
```

**Response** `404 Not Found`:

```json
{ "error": "requirement not found", "code": 404 }
```

## Update Requirement

```http
PATCH /api/requirements/:id
```

Partially update a requirement's fields.

**Request Body:**

```json
{
  "title": "Add OAuth2 user authentication",
  "priority": "urgent",
  "tags": ["auth", "security", "oauth2"]
}
```

**Response** `200 OK`:

```json
{
  "id": "req_abc123",
  "title": "Add OAuth2 user authentication",
  "description": "Implement OAuth2-based login flow with Google and GitHub providers",
  "status": "approved",
  "priority": "urgent",
  "project_id": "proj_xyz789",
  "tags": ["auth", "security", "oauth2"],
  "updated_at": "2024-01-16T09:00:00Z"
}
```
