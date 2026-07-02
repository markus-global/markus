---
sidebar_position: 7
---

# Deliverables API

Endpoints for managing deliverables — artifacts that track work products produced by agents.

## List Deliverables

```http
GET /api/deliverables
```

Returns a paginated list of deliverables. Supports optional filtering by `project_id`, `agent_id`, `type` (`file` | `directory`), and `status` (`active` | `verified` | `outdated`).

**Query Parameters:**

| Parameter    | Type   | Description                                |
|-------------|--------|--------------------------------------------|
| project_id  | string | Filter by project ID                       |
| agent_id    | string | Filter by agent ID                         |
| type        | string | `file` or `directory`                      |
| status      | string | `active`, `verified`, or `outdated`        |
| limit       | number | Max results (default: 50)                  |

## Create Deliverable

```http
POST /api/deliverables
```

Register a new deliverable. The actual file or directory must already exist on disk — this endpoint records the metadata.

**Request Body:**

| Field     | Type   | Required | Description                         |
|-----------|--------|----------|-------------------------------------|
| type      | string | yes      | `file` or `directory`               |
| title     | string | yes      | Searchable title                    |
| summary   | string | yes      | Brief description of the artifact   |
| reference | string | no       | Path to the file or directory       |
| format    | string | no       | Content format (auto-detected)      |
| tags      | string | no       | Comma-separated tags                |

## Get Deliverable

```http
GET /api/deliverables/:id
```

Returns the full record for a single deliverable by its ID.

**Path Parameters:**

| Parameter | Type   | Description          |
|-----------|--------|----------------------|
| id        | string | The deliverable ID   |

## Update Deliverable

```http
PATCH /api/deliverables/:id
```

Update a deliverable's metadata. To update the actual file content, modify the file on disk first, then update the summary or reference via this endpoint.

**Path Parameters:**

| Parameter | Type   | Description          |
|-----------|--------|----------------------|
| id        | string | The deliverable ID   |

**Request Body (all optional):**

| Field     | Type   | Description                         |
|-----------|--------|-------------------------------------|
| title     | string | New title                           |
| summary   | string | Updated summary                     |
| reference | string | Updated file path or URL            |
| status    | string | `active`, `verified`, or `outdated` |
| tags      | string | New comma-separated tags            |
