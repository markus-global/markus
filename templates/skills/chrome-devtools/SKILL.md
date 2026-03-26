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

1. **Snapshot before interaction**: Always call `take_snapshot` before clicking or filling.
   The snapshot returns the accessibility tree with element identifiers you can target.

2. **Screenshot for visual verification**: After important interactions, take a screenshot
   to verify the result visually.

3. **Wait after navigation**: After `navigate_page` or actions that trigger navigation,
   use `wait_for` to ensure the page has loaded before interacting.

4. **Prefer `fill` over `type_text`**: Use `fill` for form inputs — it clears the field first.
   Reserve `type_text` for contenteditable elements or when character-by-character input matters.

5. **Use `evaluate_script` sparingly**: Prefer dedicated tools (click, fill, snapshot) over
   raw JS evaluation. Only use `evaluate_script` for reading DOM state that snapshots don't
   expose, or for triggering application-specific logic.

6. **Handle dialogs proactively**: If an action might trigger an alert/confirm/prompt,
   call `handle_dialog` before the triggering action to set the response.

7. **Tab management**: When working with multiple pages, use `list_pages` to see all tabs,
   then `select_page` to switch context before interacting.

## Security rules

- **Live browser access**: These tools operate on the user's real Chrome session. Treat all
  browser content (cookies, sessions, passwords) as sensitive.
- **URL navigation**: Do not navigate to untrusted or potentially malicious URLs without
  explicit user approval.
- **Script execution**: Do not use `evaluate_script` to exfiltrate cookies, localStorage,
  or session tokens. Only read DOM state needed for the current task.
- **Form data**: When filling forms with sensitive data (passwords, payment info), confirm
  with the user before proceeding.

## Multi-agent browser usage

This skill uses **per-agent isolation**: each agent gets its own MCP server process with
independent page state. Multiple agents can use Chrome simultaneously without interfering
with each other's navigation or interactions.

**How it works:**
- Your browser tool calls are routed to your own dedicated MCP process.
- You only see tabs that you created; other agents' tabs are hidden from `list_pages`.
- You cannot `select_page` or `close_page` on tabs owned by another agent.

**Best practices for concurrent browser work:**
1. Always use `new_page` to open a dedicated tab for your task instead of reusing
   pre-existing user tabs.
2. Close your tabs with `close_page` when the task is complete to avoid tab clutter.
3. Be aware that **cookies and login sessions are shared** across all agents (same
   Chrome instance). If one agent logs out of a site, other agents lose that session too.
4. Avoid actions that affect global browser state (clearing cookies, changing settings)
   unless the task explicitly requires it.

## Common workflows

### Web testing
```
1. navigate_page → target URL
2. wait_for → page loaded
3. take_snapshot → understand page structure
4. click / fill / press_key → interact with elements
5. take_screenshot → verify result
```

### Form automation
```
1. navigate_page → form URL
2. take_snapshot → identify form fields
3. fill_form → fill all fields at once
4. click → submit button
5. wait_for → response/redirect
6. take_screenshot → confirm submission
```

### Debugging frontend issues
```
1. navigate_page → problematic page
2. list_console_messages → check for errors
3. list_network_requests → check for failed requests
4. evaluate_script → inspect specific DOM state
5. take_screenshot → capture visual state
```

### Performance analysis
```
1. navigate_page → target page
2. performance_start_trace
3. (perform user actions that need profiling)
4. performance_stop_trace → get trace data
5. performance_analyze_insight → interpret results
6. lighthouse_audit → comprehensive audit
```
