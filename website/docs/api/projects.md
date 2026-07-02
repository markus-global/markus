---
sidebar_position: 4
---

# Projects API

Endpoints for managing Markus projects.

## List Projects

`GET /api/projects`

Returns all projects the authenticated user has access to.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "proj_abc123",
      "name": "My Project",
      "description": "Project description",
      "status": "active",
      "createdAt": "2025-01-01T00:00:00Z"
    }
  ]
}
```

## Create Project

`POST /api/projects`

Creates a new project.

**Body:** `name` (string, required), `description` (string, optional).

**Response:** `201 Created` with the new project object.

## Get Project

`GET /api/projects/:id`

Retrieves a single project by its ID, including associated repositories and teams.

**Response:** `200 OK` with project details. Returns `404` if not found.

## Update Project

`PATCH /api/projects/:id`

Partially updates a project. Accepts `name`, `description`, `status`, `repositories`, `teamIds`, and `governancePolicy`.

**Note:** Changing `description` alone executes immediately; other field changes require user approval and return `202 Accepted`.

**Response:** Updated project object.

## Delete Project

`DELETE /api/projects/:id`

Permanently deletes a project and unlinks all associated tasks and requirements. Requires user approval.

**Response:** `202 Accepted` with a confirmation message.
