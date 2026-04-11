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

**Frozen/suspended tabs cause connection timeout:** When Chrome has frozen tabs (Memory Saver
or restored tabs), the MCP server may hang. If you encounter a timeout, inform the user to:
upgrade Chrome to 146+, disable Memory Saver at `chrome://settings/performance`, click suspended
tabs to wake them, or use a dedicated Chrome profile with few tabs.

## Tool reference

### Navigation (6 tools)

| Tool | Purpose |
|------|---------|
| `chrome-devtools__navigate_page` | Navigate current tab to a URL (**replaces** current page — see warning above). Auto-creates a new tab if you have none. |
| `chrome-devtools__list_pages` | List your open tabs (only shows tabs you own) |
| `chrome-devtools__new_page` | Open a new tab. **Always pass `background: true`** to avoid stealing user focus. |
| `chrome-devtools__close_page` | Close a tab you own |
| `chrome-devtools__select_page` | Switch to one of your tabs. **Never pass `bringToFront: true`** unless user requests it. |
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

## CRITICAL: understand `navigate_page` vs `new_page`

**`navigate_page` REPLACES the current tab's URL.** The previous page is gone — you cannot
go back to it. Any content, form data, search results, or state on the current page is
permanently lost when you call `navigate_page`.

**When to use `navigate_page` alone:**
- Your first browser action (the system auto-creates a fresh tab for you)
- You are done with the current page and want to go somewhere else
- You don't need the current page's content anymore

**When to use `new_page` before `navigate_page`:**
- You need to keep the current page open (e.g., reference data, form results, a dashboard)
- You want to compare two pages side by side
- You are visiting a second URL as part of a multi-step workflow and may need to return
  to the first page

**Example — WRONG (loses the search results page):**
```
navigate_page → google.com (search for something)
click → a search result link          ← OK, normal navigation
navigate_page → another-site.com      ← WRONG: google results are gone!
```

**Example — CORRECT (keeps the search results page):**
```
navigate_page → google.com (search for something)
click → a search result link          ← OK
new_page → open a second tab          ← preserves the first tab
navigate_page → another-site.com      ← navigates the NEW tab
select_page → switch back to first tab if needed
```

**Rule of thumb:** Before calling `navigate_page`, ask yourself: "Do I still need what's
on the current page?" If yes, call `new_page` first.

## CRITICAL: operate in the background — never steal user focus

The user may be working in another application (IDE, terminal, another browser tab) while
you interact with Chrome. **You must never cause Chrome to steal window focus.**

The system enforces this automatically for internal operations, but you must also follow
these rules for your own tool calls:

- **`new_page`**: Always pass `background: true`. This opens the tab without bringing
  Chrome to the foreground. Example: `new_page({ url: "...", background: true })`
- **`select_page`**: Always pass `bringToFront: false` (or omit `bringToFront` — the
  system defaults it to `false`). Never pass `bringToFront: true` unless the user
  explicitly asks you to show them a page.
- **`navigate_page`**: This navigates the current tab in-place and does not have a
  focus parameter. The system handles background selection automatically.
- **Do NOT call `select_page` unnecessarily.** The system auto-selects your current
  tab before each operation. Only call `select_page` when you need to switch between
  multiple tabs you own.

## Best practices

1. **Start with `navigate_page`**: Just call `navigate_page` with your target URL.
   The system auto-creates a fresh tab for you if you don't have one yet.

2. **Preserve important pages**: If the current tab has useful content (results, data,
   a page you may need to revisit), call `new_page` (with `background: true`) before
   navigating to a new URL. Otherwise `navigate_page` will destroy the current page's content.

3. **Snapshot before interaction**: Always call `take_snapshot` before clicking or filling.
   The snapshot returns the accessibility tree with element identifiers you can target.

4. **Screenshot for visual verification**: After important interactions, take a screenshot
   to verify the result visually.

5. **Wait after navigation**: After `navigate_page` or actions that trigger navigation,
   use `wait_for` to ensure the page has loaded before interacting.

6. **Prefer `fill` over `type_text`**: Use `fill` for form inputs — it clears the field first.
   Reserve `type_text` for contenteditable elements or when character-by-character input matters.

7. **Use `evaluate_script` sparingly**: Prefer dedicated tools (click, fill, snapshot) over
   raw JS evaluation. Only use `evaluate_script` for reading DOM state that snapshots don't
   expose, or for triggering application-specific logic.

8. **Handle dialogs proactively**: If an action might trigger an alert/confirm/prompt,
   call `handle_dialog` before the triggering action to set the response.

9. **Clean up when done**: Close your tabs with `close_page` after your task is complete
   to avoid tab clutter.

## Tab isolation (multi-agent)

Multiple agents share the same Chrome browser. The system enforces **strict tab ownership**
so agents cannot interfere with each other.

### Rules enforced by the system

| Tool | Enforcement |
|------|-------------|
| `navigate_page` | Auto-creates a new tab if you have none; blocks if targeting a non-owned tab |
| `list_pages` | Only returns tabs you created (all others are hidden) |
| `select_page` | Blocked unless the target tab is one you created |
| `close_page` | Blocked unless the target tab is one you created |
| All other tools | Blocked if you have no owned tabs; blocks if args target a non-owned tab |

**Key implications:**
- You only see and interact with tabs you own. Other agents' tabs and user tabs are invisible.
- Never try to reuse an existing tab — even if a page with the right URL exists, open a fresh one.
- **Cookies and login sessions are shared** across all agents (same Chrome instance).
  If one agent logs out, other agents lose that session too.
- Avoid actions that affect global browser state (clearing cookies, changing Chrome settings)
  unless the task explicitly requires it.

## Security rules

- These tools operate on the user's real Chrome session. Treat all browser content
  (cookies, sessions, passwords) as sensitive.
- Do not navigate to untrusted or potentially malicious URLs without explicit user approval.
- Do not use `evaluate_script` to exfiltrate cookies, localStorage, or session tokens.
  Only read DOM state needed for the current task.
- When filling forms with sensitive data (passwords, payment info), confirm with the user
  before proceeding.

## Common workflows

### Single-page task (e.g., test a page, fill a form)
```
1. navigate_page → target URL (tab auto-created)
2. wait_for → page loaded
3. take_snapshot → understand page structure
4. click / fill / press_key → interact with elements
5. take_screenshot → verify result
6. close_page → clean up
```

### Multi-page task (e.g., research across sites, compare pages)
```
1. navigate_page → first URL (tab auto-created as T1)
2. (interact with page, extract data you need)
3. new_page → open second tab T2 (T1 is preserved!)
4. navigate_page → second URL (navigates T2)
5. (interact with second page)
6. select_page → switch back to T1 if needed
7. close_page → close each tab when done
```

### Debugging frontend issues
```
1. navigate_page → problematic page
2. list_console_messages → check for errors
3. list_network_requests → check for failed requests
4. evaluate_script → inspect specific DOM state
5. take_screenshot → capture visual state
6. close_page → clean up
```

### Performance analysis
```
1. navigate_page → target page
2. performance_start_trace
3. (perform user actions that need profiling)
4. performance_stop_trace → get trace data
5. performance_analyze_insight → interpret results
6. lighthouse_audit → comprehensive audit
7. close_page → clean up
```
