---
name: feishu-interaction
description: Feishu/Lark platform interaction via MCP - documents, tasks, calendar, Bitable, messaging
---

# Feishu/Lark Platform Interaction

You have access to the Feishu/Lark platform via MCP tools (prefixed `feishu-lark__`).
This enables you to interact with the user's Feishu workspace: search and read documents,
manage tasks, create calendar events, operate Bitable databases, and send messages.

## Available Capabilities

### Documents (文档)
- `docx.v1.document.rawContent` — Read document content
- `docx.builtin.import` — Import documents (create new docs from content)
- `docx.builtin.search` — Search documents by keyword
- `wiki.v2.space.getNode` — Get Wiki node content
- `wiki.v1.node.search` — Search Wiki nodes

### Tasks (任务)
- `task.v2.task.create` — Create a new task with title, description, due date
- `task.v2.task.patch` — Update an existing task
- `task.v2.task.addMembers` — Add members to a task
- `task.v2.task.addReminders` — Add reminders to a task

### Calendar (日历)
- `calendar.v4.calendarEvent.create` — Create a calendar event
- `calendar.v4.calendarEvent.patch` — Modify a calendar event
- `calendar.v4.calendarEvent.get` — Get calendar event details
- `calendar.v4.freebusy.list` — Query free/busy status
- `calendar.v4.calendar.primary` — Get primary calendar info

### Bitable (多维表格)
- `bitable.v1.appTable.list` — List tables in a base
- `bitable.v1.appTableField.list` — List fields in a table
- `bitable.v1.appTableRecord.search` — Search records
- `bitable.v1.appTableRecord.create` — Create records
- `bitable.v1.appTableRecord.update` — Update records

### Messaging (消息)
- `im.v1.message.create` — Send a message to a chat or user
- `im.v1.message.list` — List messages in a chat
- `im.v1.chat.create` — Create a new group chat
- `im.v1.chat.list` — List chats the bot is in

### Contacts (通讯录)
- `contact.v3.user.batchGetId` — Batch get user IDs by email/mobile

## Best Practices

### Document Operations
1. **Search before read** — Always search for documents first to find the correct `document_id`
2. **Prefer Wiki nodes** — If the user mentions "知识库" or "Wiki", use wiki APIs
3. **Cite sources** — When referencing document content in replies, include the document title

### Task Management
1. **Match user intent** — When user says "帮我创建一个任务", use `task.v2.task.create`
2. **Set due dates** — Always ask for or infer a due date when creating tasks
3. **Add members** — If the user mentions specific people, resolve their user IDs via contacts API first

### Calendar Events
1. **Check availability** — Before creating an event, use `freebusy.list` to check conflicts
2. **Time zones** — Default to Asia/Shanghai unless the user specifies otherwise
3. **Include details** — Set description, location, and attendees when provided

### Bitable Operations
1. **Discover structure** — List tables and fields before searching records
2. **Filter queries** — Use search with filter conditions rather than fetching all records
3. **Batch operations** — For multiple records, prefer batch create/update when available

### Messaging
1. **Format appropriately** — Use markdown formatting for rich messages
2. **Respect context** — Only send messages when the user explicitly asks to notify someone
3. **Interactive cards** — For structured information, use `msg_type: 'interactive'` with card JSON

## Important Notes

- Tool names are prefixed with `feishu-lark__` (e.g., `feishu-lark__docx.builtin.search`)
- Document editing is NOT supported — you can only read and import
- File upload/download is NOT supported via MCP
- Always handle API errors gracefully and report them to the user
- Respect rate limits: 1000 requests/minute per API endpoint
