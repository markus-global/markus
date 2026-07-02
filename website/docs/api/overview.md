---
sidebar_position: 1
---

# API Overview

The Markus API provides programmatic access to all Markus platform features, including agent management, task orchestration, project tracking, and more.

## Base URL

```
http://localhost:8056
```

All API requests should be prefixed with the base URL above. For production deployments, replace `localhost:8056` with your configured host and port.

## Authentication

Markus uses **JWT (JSON Web Token)** for authentication. Tokens are obtained via the `/api/auth/login` endpoint and must be included in every subsequent request using one of two methods:

- **Cookie**: The token is automatically set as an `auth_token` cookie upon successful login.
- **Bearer Header**: Manually include the token in the `Authorization` header:
  ```
  Authorization: Bearer <your-jwt-token>
  ```

## Content Type

All requests and responses use `application/json` unless otherwise specified. Ensure your requests include the following header:

```
Content-Type: application/json
```

## Common Response Format

Successful responses follow a consistent structure:

```json
{
  "success": true,
  "data": { ... }
}
```

List endpoints return paginated results:

```json
{
  "success": true,
  "data": [ ... ],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "total": 100
  }
}
```

## Error Handling

Errors return appropriate HTTP status codes along with a descriptive payload:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error description"
  }
}
```

Common HTTP status codes: `400` (Bad Request), `401` (Unauthorized), `403` (Forbidden), `404` (Not Found), `409` (Conflict), `429` (Too Many Requests), `500` (Internal Server Error).

## Rate Limiting

API endpoints are rate-limited to ensure fair usage. Limits are applied per authentication token or IP address. When a rate limit is exceeded, a `429 Too Many Requests` response is returned along with `Retry-After` headers. Please back off and retry after the specified delay.

## API Endpoint Groups

| Group          | Description                                 | Base Path                     |
|----------------|---------------------------------------------|-------------------------------|
| Agents         | Manage AI agents, status, and assignments   | `/api/agents`                 |
| Tasks          | CRUD and lifecycle management for tasks     | `/api/tasks`                  |
| Projects       | Create and configure projects               | `/api/projects`               |
| Requirements   | Define and track requirements               | `/api/requirements`           |
| Chat           | Real-time messaging with agents             | `/api/chat`                   |
| Deliverables   | Upload and manage task deliverables         | `/api/deliverables`           |
| Integrations   | External tool and service integrations      | `/api/integrations`           |
