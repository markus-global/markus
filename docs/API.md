# Markus API Reference

Base URL: `http://localhost:8056`

All requests require authentication via one of:
- **JWT Cookie**: `markus_token` (set automatically on login)
- **Header**: `Authorization: Bearer <token>`

---

## Authentication

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | Login, returns JWT Cookie |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/auth/me` | Get current user info |
| POST | `/api/auth/change-password` | Change password |

---

## Agent Management

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/agents` | List all agents |
| POST | `/api/agents` | Hire a new agent `{ name, role, description }` |
| GET | `/api/agents/:id` | Get agent details |
| DELETE | `/api/agents/:id` | Fire agent |
| POST | `/api/agents/:id/start` | Start agent |
| POST | `/api/agents/:id/stop` | Stop agent |
| GET | `/api/agents/:id/profile` | Get agent full profile (memory, tools, etc.) |

---

## Messages & Conversations

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/agents/:id/message` | Send message to agent (SSE streaming) |
| GET | `/api/sessions` | List conversation sessions |
| GET | `/api/sessions/:id/messages` | Get session message history |
| GET | `/api/channels/:channel/messages` | Get channel history |
| POST | `/api/channels/:channel/messages` | Send channel message (supports SSE streaming) |

---

## Tasks

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks` | List tasks (supports `?status=`, `?assignedAgentId=` filters) |
| POST | `/api/tasks` | Create task |
| GET | `/api/taskboard` | Get Kanban board data |
| PATCH | `/api/tasks/:id` | Update task (status, notes, etc.) |

---

## Teams

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/teams` | List teams |
| POST | `/api/teams` | Create team |
| GET | `/api/teams/:id` | Get team details |
| PUT | `/api/teams/:id` | Update team |
| DELETE | `/api/teams/:id` | Delete team |

---

## Governance & System Control

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/system/status` | Global status (paused/emergency mode) |
| POST | `/api/system/pause-all` | Pause all agents |
| POST | `/api/system/resume-all` | Resume all agents |
| POST | `/api/system/emergency-stop` | Emergency stop |
| GET | `/api/system/announcements` | Get system announcements |
| POST | `/api/system/announcements` | Create system announcement |
| GET | `/api/governance/policy` | View governance policy |
| PUT | `/api/governance/policy` | Update governance policy |

---

## Projects

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List projects |
| POST | `/api/projects` | Create project |
| GET | `/api/projects/:id` | Get project |
| PUT | `/api/projects/:id` | Update project |
| DELETE | `/api/projects/:id` | Delete project |

---

## Delivery & Review

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/tasks/:id/accept` | Accept task delivery |
| POST | `/api/tasks/:id/revision` | Request revision |
| POST | `/api/tasks/:id/archive` | Archive task |

---

## Reports & Knowledge

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/reports` | List reports |
| POST | `/api/reports/generate` | Trigger report generation |
| GET | `/api/reports/:id` | Report details |
| POST | `/api/reports/:id/plan/approve` | Approve plan |
| POST | `/api/reports/:id/plan/reject` | Reject plan |
| GET | `/api/reports/:id/feedback` | Get report feedback |
| POST | `/api/reports/:id/feedback` | Create report feedback |
| POST | `/api/knowledge` | Contribute knowledge |
| GET | `/api/knowledge/search` | Search knowledge base |

---

## Users

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/users` | List human users |
| POST | `/api/users` | Create human user |
| PUT | `/api/users/:id` | Update user info |
| DELETE | `/api/users/:id` | Delete user |

---

## Roles

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/roles` | List available role templates |
| GET | `/api/roles/:name` | Get role template details |

---

## Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check (returns `{ status, version, agents }`) |

---

## Builder Service

Builder Service allows installation and management of Agent, Team, and Skill artifacts. It operates on the `~/.markus/builder-artifacts` directory.

### Service Location
- **File**: `packages/org-manager/src/builder-service.ts`
- **Instantiated by**: OrgService during initialization

### Types

```typescript
interface ArtifactInfo {
  type: string;           // 'agent' | 'team' | 'skill'
  name: string;
  description?: string;
  meta: Record<string, unknown>;
  path: string;            // Absolute filesystem path
  updatedAt: string;       // ISO timestamp
}

interface InstallResult {
  type: string;
  installed: {
    name: string;
    path: string;
    status: string;
  };
}
```

---

### `listArtifacts(type?)`

Lists all installed artifacts (agents, teams, skills).

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | `'agent' \| 'team' \| 'skill'` | No | Filter by artifact type |

**Returns:** `ArtifactInfo[]` — Array of artifact information

**Example:**
```typescript
const allArtifacts = builderService.listArtifacts();
// => [{ type: 'agent', name: 'Secretary', path: '/...', ... }, ...]

const agentsOnly = builderService.listArtifacts('agent');
// => [{ type: 'agent', name: 'Secretary', ... }, ...]
```

**Behavior:**
- Scans `~/.markus/builder-artifacts/{agents,teams,skills}/` directories
- Reads `manifest.json` from each artifact directory
- Returns empty array if directory doesn't exist

---

### `installArtifact(artifactUrl, type)`

Installs an artifact from a URL (local path or GitHub remote).

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `artifactUrl` | `string` | Yes | Local path (`~/...`) or GitHub (`owner/repo/path`) |
| `type` | `'agent' \| 'team' \| 'skill'` | Yes | Target artifact type |

**Returns:** `InstallResult` — Installation result with status

**Example:**
```typescript
// Install from local path
const result = await builderService.installArtifact(
  '~/my-agent',
  'agent'
);

// Install from GitHub
const result = await builderService.installArtifact(
  'markus-global/markus/agents/my-agent',
  'agent'
);
```

**Behavior:**
1. Validates URL format (local path or GitHub shorthand)
2. Fetches/clones artifact if remote URL
3. Validates `manifest.json` schema
4. Copies to `~/.markus/builder-artifacts/{type}/{name}/`
5. For agents: creates agent entry in database
6. For skills: registers in runtime skill registry

**Error Handling:**
| Error | Condition | Result |
|-------|-----------|--------|
| `Invalid artifact URL` | Malformed URL | Throws `Error` |
| `Invalid manifest` | Missing/invalid manifest.json | Throws `Error` |
| `Artifact already installed` | Duplicate name | Returns existing info |

---

### `hireFromTemplate(templateName, agentName, options?)`

Creates a new agent from a template artifact.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `templateName` | `string` | Yes | Template artifact name (from `listArtifacts('agent')`) |
| `agentName` | `string` | Yes | Name for the new agent |
| `options` | `HireOptions` | No | Additional configuration |

```typescript
interface HireOptions {
  description?: string;      // Agent description
  teamId?: string;           // Assign to team
  assignedAgentId?: string;   // Initial assigned agent
  reviewerAgentId?: string;  // Reviewer for this agent
}
```

**Returns:** `InstallResult` with `type: 'agent'` — New agent details

**Example:**
```typescript
// Basic hire
const agent = await builderService.hireFromTemplate(
  'Secretary',
  'MySecretary'
);

// Hire with options
const agent = await builderService.hireFromTemplate(
  'Developer',
  'BackendDev',
  {
    description: 'Backend development specialist',
    teamId: 'team_123',
  }
);
```

**Behavior:**
1. Validates template exists in builder artifacts
2. Creates copy in `~/.markus/agents/{agentId}/`
3. Generates `manifest.json` with new name
4. Registers agent in org service
5. Assigns to team if specified

**Error Handling:**
| Error | Condition | Result |
|-------|-----------|--------|
| `Template not found` | Template artifact doesn't exist | Throws `Error` |
| `Agent already exists` | Duplicate agent name | Throws `Error` |
| `Team not found` | Invalid teamId | Throws `Error` |

---

## WebSocket

**Connection**: `ws://localhost:8056`

| Event | Description |
|-------|-------------|
| `agent:update` | Agent status change |
| `task:update` | Task status update |
| `chat` | Agent message in channel |
| `system:announcement` | System announcement broadcast |
| `system:pause-all` | Global pause event |
| `system:emergency-stop` | Emergency stop event |
