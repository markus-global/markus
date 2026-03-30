---
name: chrome-devtools
description: Chrome DevTools browser automation via MCP - control a live Chrome browser
---

# Chrome DevTools Browser Automation

You have access to a live Chrome browser via Chrome DevTools MCP tools (prefixed `chrome-devtools__`).
This gives you full browser automation: navigation, clicking, typing, screenshots, JS evaluation,
network inspection, and performance profiling.

## When to use these tools

Use Chrome DevTools tools when you need to:
- Interact with web pages (click buttons, fill forms, navigate)
- Test web applications in a real browser
- Take screenshots of pages or elements
- Inspect console logs, network requests, or page structure
- Run Lighthouse audits or performance traces
- Debug frontend issues with live DOM inspection

Do NOT use these tools when `web_fetch` or `web_search` suffice (simple content retrieval or search).
Chrome DevTools is for interactive browser sessions that require a real rendering engine.

## Prerequisites

The MCP server connects to the user's running Chrome via `--autoConnect` (Chrome 144+).

**Setup steps:**
1. Chrome version must be 144 or newer (146+ recommended).
2. Open `chrome://inspect/#remote-debugging` in Chrome and enable remote debugging.
3. On first MCP connection, Chrome will show a permission dialog — the user must click **Allow**.

**Known limitation — frozen/suspended tabs cause connection timeout:**

When Chrome has frozen or suspended tabs (common with Memory Saver or "Continue where you left off"),
the MCP server may hang on the first tool call. This is a known upstream issue
(puppeteer [#12808](https://github.com/puppeteer/puppeteer/issues/12808),
chrome-devtools-mcp [#775](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/775)).

If you encounter a tool call timeout, inform the user and suggest these steps (in order):
1. **Upgrade Chrome to 146+** — contains a partial fix for frozen tab handling.
2. **Disable Memory Saver** — go to `chrome://settings/performance` and turn off "Memory Saver"
   so Chrome stops freezing inactive tabs.
3. **Activate suspended tabs** — click on each unloaded tab to wake it up, especially tabs
   restored after a Chrome restart.
4. **Use a dedicated Chrome profile** — create a clean profile with few tabs for development use,
   reducing the chance of frozen targets blocking the connection.

## Tool reference

### Navigation (6 tools)

| Tool | Purpose |
|------|---------|
| `chrome-devtools__navigate_page` | Navigate to a URL |
| `chrome-devtools__list_pages` | List all open tabs/pages |
| `chrome-devtools__new_page` | Open a new tab |
| `chrome-devtools__close_page` | Close a tab |
| `chrome-devtools__select_page` | Switch to a specific tab |
| `chrome-devtools__wait_for` | Wait for selector, navigation, or network idle |

### Input (9 tools)

| Tool | Purpose |
|------|---------|
| `chrome-devtools__click` | Click an element by selector |
| `chrome-devtools__fill` | Clear and fill a form field (preferred over type_text) |
| `chrome-devtools__fill_form` | Fill multiple form fields at once |
| `chrome-devtools__type_text` | Type text character by character (use for contenteditable) |
| `chrome-devtools__press_key` | Press keyboard keys (Enter, Tab, Escape, etc.) |
| `chrome-devtools__hover` | Hover over an element |
| `chrome-devtools__drag` | Drag from one element to another |
| `chrome-devtools__handle_dialog` | Accept or dismiss browser dialogs (alert/confirm/prompt) |
| `chrome-devtools__upload_file` | Upload a file to a file input element |

### Inspection (6 tools)

| Tool | Purpose |
|------|---------|
| `chrome-devtools__take_screenshot` | Capture screenshot (full page or viewport) |
| `chrome-devtools__take_snapshot` | Get page accessibility tree (best for finding elements) |
| `chrome-devtools__evaluate_script` | Execute JavaScript in the page context |
| `chrome-devtools__get_console_message` | Get a specific console message |
| `chrome-devtools__list_console_messages` | List recent console messages |
| `chrome-devtools__lighthouse_audit` | Run a Lighthouse audit |

### Network (2 tools)

| Tool | Purpose |
|------|---------|
| `chrome-devtools__list_network_requests` | List captured network requests |
| `chrome-devtools__get_network_request` | Get details of a specific request |

### Performance (4 tools)

| Tool | Purpose |
|------|---------|
| `chrome-devtools__performance_start_trace` | Start a performance trace |
| `chrome-devtools__performance_stop_trace` | Stop trace and get results |
| `chrome-devtools__performance_analyze_insight` | Analyze performance data |
| `chrome-devtools__take_memory_snapshot` | Capture heap snapshot |

### Emulation (2 tools)

| Tool | Purpose |
|------|---------|
| `chrome-devtools__emulate` | Emulate device (mobile, tablet) |
| `chrome-devtools__resize_page` | Resize browser viewport |

## Best practices

1. **Always open your own tab first**: Call `new_page` before any browser interaction.
   Never reuse existing tabs — they may belong to the user or another agent.

2. **Snapshot before interaction**: Always call `take_snapshot` before clicking or filling.
   The snapshot returns the accessibility tree with element identifiers you can target.

3. **Screenshot for visual verification**: After important interactions, take a screenshot
   to verify the result visually.

4. **Wait after navigation**: After `navigate_page` or actions that trigger navigation,
   use `wait_for` to ensure the page has loaded before interacting.

5. **Prefer `fill` over `type_text`**: Use `fill` for form inputs — it clears the field first.
   Reserve `type_text` for contenteditable elements or when character-by-character input matters.

6. **Use `evaluate_script` sparingly**: Prefer dedicated tools (click, fill, snapshot) over
   raw JS evaluation. Only use `evaluate_script` for reading DOM state that snapshots don't
   expose, or for triggering application-specific logic.

7. **Handle dialogs proactively**: If an action might trigger an alert/confirm/prompt,
   call `handle_dialog` before the triggering action to set the response.

8. **Tab management**: Use `list_pages` to see your owned tabs, `select_page` to switch
   between them. You will only see tabs you created — this is by design.

## Security rules

- **Live browser access**: These tools operate on the user's real Chrome session. Treat all
  browser content (cookies, sessions, passwords) as sensitive.
- **URL navigation**: Do not navigate to untrusted or potentially malicious URLs without
  explicit user approval.
- **Script execution**: Do not use `evaluate_script` to exfiltrate cookies, localStorage,
  or session tokens. Only read DOM state needed for the current task.
- **Form data**: When filling forms with sensitive data (passwords, payment info), confirm
  with the user before proceeding.

## Multi-agent browser usage — Tab Ownership Discipline

Multiple agents share the same Chrome browser. To prevent agents from interfering with
each other (closing tabs, navigating away from pages another agent is using), **strict
tab ownership** is enforced at both the code and prompt level.

### Core rule: You can ONLY interact with tabs you created

The system enforces strict ownership. You will only see, select, and close tabs that
**you** explicitly opened with `new_page`. All other tabs (user tabs, other agents' tabs)
are invisible to you and cannot be operated on.

### Mandatory workflow

1. **ALWAYS start with `new_page`**: Before doing anything in the browser, call `new_page`
   to create your own tab. Even if you know a page with the right URL already exists in
   the browser, you MUST open a fresh tab. That existing tab may belong to the user or
   another agent.

2. **Track your owned tabs**: Remember the `targetId` returned by `new_page`. This is
   your tab. When working with multiple tabs, keep a mental list of all targetIds you own.

3. **Only navigate your own tabs**: After `new_page`, use `navigate_page` to go to your
   target URL. If you call `navigate_page` without first creating a tab with `new_page`,
   the call will be blocked.

4. **Only close your own tabs**: When your task is done, close tabs you opened with
   `close_page`. Never attempt to close tabs you did not create — the system will
   reject the call.

5. **Never reuse existing tabs**: Even if `list_pages` shows a tab at the URL you need,
   open a new one. That tab may be actively used by another agent or the user.

### What the system enforces (code-level)

| Tool | Enforcement |
|------|-------------|
| `new_page` | Creates a tab and registers it as yours |
| `list_pages` | Only returns tabs you created (all others are hidden) |
| `select_page` | Blocked unless the target tab is one you created |
| `close_page` | Blocked unless the target tab is one you created |
| `navigate_page` | Blocked if you have no owned tabs (must call `new_page` first) |

### Shared state warning

- **Cookies and login sessions are shared** across all agents (same Chrome instance).
  If one agent logs out of a site, other agents lose that session too.
- Avoid actions that affect global browser state (clearing cookies, changing Chrome
  settings, closing all tabs) unless the task explicitly requires it.

### Example: correct multi-agent workflow

```
Agent A:                              Agent B:
1. new_page → gets tab T1             1. new_page → gets tab T2
2. navigate_page T1 → localhost:3000  2. navigate_page T2 → localhost:3000
3. (test feature X on T1)             3. (test feature Y on T2)
4. close_page T1                      4. close_page T2
```

Both agents work on the same URL but in separate tabs without interference.

## Common workflows

### Web testing
```
1. new_page → create your own tab (remember targetId)
2. navigate_page → target URL
3. wait_for → page loaded
4. take_snapshot → understand page structure
5. click / fill / press_key → interact with elements
6. take_screenshot → verify result
7. close_page → clean up when done
```

### Form automation
```
1. new_page → create your own tab
2. navigate_page → form URL
3. take_snapshot → identify form fields
4. fill_form → fill all fields at once
5. click → submit button
6. wait_for → response/redirect
7. take_screenshot → confirm submission
8. close_page → clean up when done
```

### Debugging frontend issues
```
1. new_page → create your own tab
2. navigate_page → problematic page
3. list_console_messages → check for errors
4. list_network_requests → check for failed requests
5. evaluate_script → inspect specific DOM state
6. take_screenshot → capture visual state
7. close_page → clean up when done
```

### Performance analysis
```
1. new_page → create your own tab
2. navigate_page → target page
3. performance_start_trace
4. (perform user actions that need profiling)
5. performance_stop_trace → get trace data
6. performance_analyze_insight → interpret results
7. lighthouse_audit → comprehensive audit
8. close_page → clean up when done
```
