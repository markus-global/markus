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

## Connection Modes

Markus supports three ways to connect to Chrome, listed from best to fallback:

### Mode 1: Markus Chrome Extension (recommended)

The **Markus Browser Automation** Chrome extension provides the smoothest experience:
- **No debugging dialog** — the extension uses `chrome.debugger` API internally
- **Works when screen is locked or sleeping** — no OS-level interaction needed
- **Cross-platform** — works on macOS, Windows, and Linux identically
- **Instant startup** — no `npx` download, no child process spawn
- **No extra permissions** — no macOS Accessibility or Windows UI Automation needed

**How to install:**

1. Build the extension (one-time):
   ```
   cd packages/chrome-extension && pnpm install && pnpm run build
   ```
2. Open Chrome → `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked** → select `packages/chrome-extension/dist`
5. The Markus icon appears in the toolbar

**How it works:**

When Markus starts, it launches a WebSocket bridge on `ws://127.0.0.1:9333`. The extension
auto-connects to this bridge. All browser tool calls are routed through the extension instead
of spawning an external MCP process.

Check connection status in **Settings > Browser Automation > Chrome Extension**:
- Green dot = Connected (extension is active, all tools route through it)
- Gray dot = Not Connected (Markus falls back to Mode 2 or 3)

The extension reconnects automatically within 3 seconds if the connection drops.

**Note:** Chrome shows a yellow infobar ("Markus Browser Automation started debugging this
tab") on debugged tabs. This is cosmetic and doesn't affect functionality. To hide it, launch
Chrome with `--silent-debugger-extension-api`.

### Mode 2: Auto-Connect with Auto-Click (fallback)

If the extension is not installed, Markus falls back to `chrome-devtools-mcp` via `npx`.
Chrome shows an "Allow remote debugging?" dialog each time. Markus can auto-click this
dialog on supported platforms:

**macOS:** Requires Accessibility permission.
1. Open System Settings > Privacy & Security > Accessibility
2. Add the app running Markus (Markus.app, Terminal, or iTerm)
3. Enable "Auto-Allow Chrome Debugging Dialog" in Settings > Browser Automation

**Windows:** No additional permissions needed. Enable the toggle in Settings.

**Linux:** Auto-click is not supported. Use Mode 1 (extension) or Mode 3 (debugging port).

Limitations of auto-click:
- Does not work when the screen is locked or display is sleeping
- Requires OS-specific permissions (Accessibility on macOS)
- Has timing dependencies on npx download and dialog detection

### Mode 3: Persistent Debugging Port (manual)

Launch Chrome with a fixed debugging port to bypass the dialog entirely:

- **macOS**: `/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222`
- **Linux**: `google-chrome --remote-debugging-port=9222`
- **Windows**: `"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222`

Set the same port in **Settings > Browser Automation > Remote Debugging Port**.

## Installation & Setup

### 1. Check if Chrome is installed

- **macOS**: `ls /Applications/Google\ Chrome.app` or `mdfind "kMDItemCFBundleIdentifier == com.google.Chrome"`
- **Linux**: `which google-chrome || which google-chrome-stable || which chromium-browser`
- **Windows**: `where chrome` or check `"C:\Program Files\Google\Chrome\Application\chrome.exe"`

Chrome version **144+** is required (146+ recommended). Check with:
- **macOS**: `/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --version`
- **Linux**: `google-chrome --version`

**If Chrome is NOT installed:**
- **macOS**: `brew install --cask google-chrome` or download from https://www.google.com/chrome/
- **Linux (Debian/Ubuntu)**: `wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo apt-key add - && sudo apt update && sudo apt install google-chrome-stable`
- **Windows**: Download from https://www.google.com/chrome/

### 2. Choose a connection mode

- **Best experience**: Install the Markus Chrome Extension (Mode 1 above)
- **Quick start**: Just ensure Chrome is running — Markus will auto-connect and prompt for permission
- **Unattended use without extension**: Launch Chrome with `--remote-debugging-port=9222` (Mode 3)

### 3. Verify Connection

- With extension: Click the Markus icon in Chrome toolbar — status should show "Connected to Markus"
- With auto-connect: Open `chrome://inspect/#remote-debugging` in Chrome and verify tabs are listed
- In Markus: Go to Settings > Browser Automation — check the extension status or run the auto-click test

### Troubleshooting

- **Extension shows "Not Connected"**: Ensure Markus is running (`pnpm dev`). The bridge starts on port 9333 by default. Check if another process is using that port.
- **Port conflict**: If port 9333 is in use, change `browser.extensionBridgePort` in Markus config.
- **Permission dialog keeps appearing**: Install the Chrome extension (Mode 1) to eliminate it entirely.
- **Memory Saver freezes tabs**: Disable at `chrome://settings/performance` or upgrade to Chrome 146+.
- **Connection timeout**: On first use without extension, `npx` may need to download `chrome-devtools-mcp`. Wait up to 60 seconds. Subsequent connections are faster.
- **Firewall**: Ensure localhost access to the debugging/bridge port is not blocked.

**If browser automation fails, advise the user:**
1. First choice: Install the Markus Chrome Extension (Settings > Browser Automation shows install path)
2. Second choice: Enable auto-click in Settings > Browser Automation (macOS/Windows only)
3. Third choice: Launch Chrome with `--remote-debugging-port=9222` and set the port in Settings

## Configurable behavior (Settings > Browser Automation)

| Setting | Default | Description |
|---------|---------|-------------|
| **Chrome Extension** | — | Shows connection status of the Markus Chrome Extension (Connected / Not Connected). |
| **Bring to Foreground** | Off | When on, Chrome tabs are brought to the foreground during agent operations. When off (default), agents operate silently in background tabs. |
| **Auto-close Tabs** | On | When on, agent-owned tabs are closed when the agent task completes or the agent is removed. |
| **Auto-Allow Debugging Dialog** | Off | Auto-click Chrome's "Allow remote debugging?" dialog via OS APIs. Only needed when extension is not installed. macOS requires Accessibility permission; Windows works out of the box; Linux not supported. |
| **Remote Debugging Port** | 0 (auto-connect) | Set to a port number (e.g. 9222) to use a persistent debugging connection instead of auto-connect, eliminating repeated permission dialogs. |
| **Extension Bridge Port** | 9333 | WebSocket port for communication between Markus and the Chrome extension. Change if 9333 conflicts with another service. |

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
you interact with Chrome. **By default, you must never cause Chrome to steal window focus.**

The system enforces this automatically based on the "Bring to Foreground" setting
(Settings > Browser Automation). When the setting is **off** (default):

- **`new_page`**: The system automatically opens tabs in the background.
- **`select_page`**: The system automatically prevents Chrome from coming to foreground.
- **`navigate_page`**: The system handles background selection automatically.

When the setting is **on**, the system will bring Chrome to the foreground during operations,
which is useful when you want to watch what the agent is doing in real-time.

Regardless of the setting:
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
