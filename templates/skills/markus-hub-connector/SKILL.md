---
name: markus-hub-connector
description: Search, download, and publish agents/teams/skills on Markus Hub
---

# Markus Hub Connector

You have access to the Markus Hub community marketplace via MCP tools (prefixed `markus-hub__`).
This lets you search for shared packages, download them locally, publish user creations, and manage published items.

## When to use these tools

Use Hub tools when the user wants to:
- Find agents, teams, or skills shared by the community
- Download a package from Hub to try locally
- Share/publish a builder artifact to Hub
- Check what they've published on Hub

Do NOT use these tools for local skill/agent management — those are separate operations.

## Authentication

Hub operations that modify data (download, publish, my_items) require the user to be logged in to Markus Hub via the web UI. If a tool returns an authentication error, tell the user to log in to Hub from the Markus web interface first.

The login state is synced automatically — no manual token setup is needed.

## Tool reference

| Tool | Purpose | Auth required |
|------|---------|:---:|
| `markus-hub__hub_search` | Search Hub for packages by keyword, type, category | No |
| `markus-hub__hub_download` | Download a package to local builder-artifacts | Yes |
| `markus-hub__hub_publish` | Publish a local artifact to Hub | Yes |
| `markus-hub__hub_my_items` | List the user's published items | Yes |

## Common workflows

### Finding and downloading a skill
```
1. markus-hub__hub_search → query="code review", type="skill"
2. Review results, confirm with user which one to download
3. markus-hub__hub_download → id="<item_id>"
4. Tell user to install from Builder page
```

### Publishing a builder artifact
```
1. markus-hub__hub_publish → directory="~/.markus/builder-artifacts/skills/my-skill"
   (auto-reads manifest + files from directory)
2. Share the Hub URL with the user
```

### Checking published items
```
1. markus-hub__hub_my_items → see all published packages
2. Report status to user
```

## Best practices

1. **Always confirm before publishing**: Show the user what will be published (name, description, files) before calling `hub_publish`.
2. **Use directory mode for publish**: When publishing a local artifact, pass the `directory` parameter — it auto-reads the manifest and all files.
3. **Guide on auth errors**: If a tool returns an auth error, tell the user to log in via the Hub icon in the Markus web UI.
4. **Search before download**: Help the user find the right package before downloading.
