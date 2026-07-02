# FTS5 全文搜索 — 设计文档

> Last updated: 2026-07-02

---

## 1. 概述

FTS5 全文搜索为 Markus 平台提供高效的**关键字全文检索**能力，覆盖 Agent 的长期记忆、对话历史、渠道消息和活动记录。它作为 `memory_search` 工具的中间召回层（Tier 2），填补了向量搜索（Tier 1）和 Like 子串匹配（Tier 3）之间的空白。

### 设计目标

| 目标 | 说明 |
|------|------|
| **高效索引** | 使用 SQLite FTS5 虚拟表，毫秒级全文检索 |
| **自动同步** | 触发器机制保证源表与 FTS 索引实时同步 |
| **优雅降级** | FTS5 不可用时自动回退到 LIKE 搜索 |
| **多源覆盖** | 覆盖聊天消息、渠道消息、活动记录、记忆库 4 个来源 |
| **中英文支持** | 使用 `unicode61` tokenizer + 查询转义支持 CJK |

---

## 2. 架构概览

```
┌──────────────────────────────────────────────────────────────┐
│                        Agent Process                        │
│  Agent Loop → Tool Execution → memory_search tool           │
│       ↓                                                     │
│  Tier 1: Vector semantic search (SemanticMemorySearch)      │
│  Tier 2: FTS5 full-text search (ftsSearch callback)  ◄──   │
│  Tier 3: LIKE substring fallback                            │
└──────────────────────────┬───────────────────────────────────┘
                           │ agent-manager.ts → ftsSearch callback
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                    start.ts (CLI wiring)                     │
│  storage.chatSessionRepo.searchMessages(query, limit)        │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│               @markus/storage (SQLite layer)                 │
│                                                              │
│  SqliteChatSessionRepo.searchMessages()                      │
│    ├── Try FTS5 MATCH → escapeFtsQuery → ranked results     │
│    └── Fallback → _searchMessagesLike() (LIKE %q%)          │
│                                                              │
│  SqliteChannelMessageRepo.searchMessages()                   │
│    └── Same FTS5-first + LIKE-fallback pattern              │
│                                                              │
│  ensureFtsIndex() — Populate FTS index from existing data   │
│  escapeFtsQuery() — Sanitize user query for FTS5 MATCH      │
│  isFtsAvailable() — Probe FTS5 availability                 │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                    SQLite Database                            │
│                                                              │
│  Source Tables:          FTS5 Virtual Tables:                │
│  chat_messages ──────── chat_messages_fts (content)          │
│  channel_messages ───── channel_messages_fts (text)          │
│  agent_activities ───── agent_activities_fts (summary/...)   │
│  memories ───────────── memories_fts (content)               │
│                                                              │
│  Auto-sync triggers: _ai _ad _au (insert/delete/update)     │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. Schema 设计

### 3.1 FTS5 虚拟表定义

SQLite FTS5 虚拟表定义在 `openSqlite()` 中创建（`sqlite-storage.ts` 第 669-771 行）。

#### chat_messages_fts

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
    content,                  -- 可搜索的文本内容
    session_id UNINDEXED,     -- 会话 ID（仅存储，不索引）
    agent_id UNINDEXED,       -- Agent ID（仅存储，不索引）
    role UNINDEXED,           -- 消息角色（user/assistant）
    content=chat_messages,    -- 外部内容表
    content_rowid=rowid,      -- 关联到源表的 rowid
    tokenize='unicode61'      -- Unicode tokenizer（支持中文）
);
```

#### channel_messages_fts

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS channel_messages_fts USING fts5(
    text,                     -- 可搜索的文本内容
    channel UNINDEXED,        -- 频道名称
    sender_id UNINDEXED,      -- 发送者 ID
    sender_name UNINDEXED,    -- 发送者名称
    content=channel_messages,
    content_rowid=rowid,
    tokenize='unicode61'
);
```

#### agent_activities_fts

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS agent_activities_fts USING fts5(
    summary,                  -- 活动摘要（可搜索）
    keywords,                 -- 关键字（可搜索）
    label,                    -- 标签（可搜索）
    agent_id UNINDEXED,       -- Agent ID
    type UNINDEXED,           -- 活动类型
    task_id UNINDEXED,        -- 关联任务 ID
    content=agent_activities,
    content_rowid=rowid,
    tokenize='unicode61'
);
```

#### memories_fts

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,                  -- 记忆内容（可搜索）
    type UNINDEXED,           -- 记忆类型
    agent_id UNINDEXED,       -- Agent ID
    content=memories,
    content_rowid=rowid,
    tokenize='unicode61'
);
```

### 3.2 自动同步触发器

每张源表有 3 个触发器（以 `chat_messages` 为例）：

```sql
-- INSERT 触发：自动将新内容同步到 FTS 索引
CREATE TRIGGER chat_messages_fts_ai AFTER INSERT ON chat_messages BEGIN
    INSERT INTO chat_messages_fts(rowid, content, session_id, agent_id, role)
    VALUES (new.rowid, new.content, new.session_id, new.agent_id, new.role);
END;

-- DELETE 触发：从 FTS 索引中删除
CREATE TRIGGER chat_messages_fts_ad AFTER DELETE ON chat_messages BEGIN
    INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
END;

-- UPDATE 触发：删除旧记录 + 插入新记录
CREATE TRIGGER chat_messages_fts_au AFTER UPDATE ON chat_messages BEGIN
    INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
    INSERT INTO chat_messages_fts(rowid, content, session_id, agent_id, role)
    VALUES (new.rowid, new.content, new.session_id, new.agent_id, new.role);
END;
```

**命名约定**: `{table}_fts_{ai|ad|au}`（After Insert / After Delete / After Update）

---

## 4. 核心函数

### 4.1 `ensureFtsIndex(db)`

在数据库打开后调用，将已有的数据批量导入 FTS5 索引。幂等安全 — 仅当 FTS 虚拟表为空时执行导入。

```typescript
export function ensureFtsIndex(db: DatabaseSync): void;
```

导入顺序：chat_messages → channel_messages → agent_activities → memories。

### 4.2 `escapeFtsQuery(query)`

将用户输入的搜索查询转义为 FTS5 MATCH 兼容的语法。

```typescript
export function escapeFtsQuery(query: string): string;
```

**转义规则**:

| 输入 | 输出 | 说明 |
|------|------|------|
| `hello world` | `hello* world*` | ASCII 词 → 添加前缀通配符 |
| `搜索测试` | `"搜索测试"` | CJK 文本 → 短语引用 |
| `hello 测试` | `hello* "测试"` | 混合查询 |
| `(special*chars)` | `special chars` | 特殊字符被移除 |
| `  ` | `''` | 空结果返回空字符串 |

### 4.3 `isFtsAvailable(db)`

探测当前 SQLite 构建是否支持 FTS5 扩展。

```typescript
export function isFtsAvailable(db: DatabaseSync): boolean;
```

实现：对 `chat_messages_fts` 执行 `SELECT count(*)`，若抛出异常则返回 false。

### 4.4 `searchMessages(query, limit)`

**SqliteChatSessionRepo**:

```typescript
searchMessages(query: string, limit = 30): Array<{ ...msgFields, sessionAgentId }>
```

1. 调用 `escapeFtsQuery(query)` 转义查询
2. 执行 FTS5 MATCH — JOIN chat_messages + chat_sessions 获取完整消息数据
3. 按 `fts.rank` 排序（FTS5 内置相关性评分）
4. 若 FTS5 查询失败，回退到 `_searchMessagesLike()` — `LIKE %query%`

**SqliteChannelMessageRepo**:

```typescript
searchMessages(query: string, channel?: string, limit = 30): Array<...>
```

同名函数，额外支持 channel 过滤参数。

---

## 5. 集成接口

### 5.1 FtsSearchCallback

定义在 `core/src/agent-manager.ts` 中：

```typescript
type FtsSearchCallback = (
    agentId: string,
    query: string,
    opts?: { limit?: number }
) => Array<{
    id: string;
    agentId: string;
    type: string;
    content: string;
    createdAt: string;
}>;
```

### 5.2 CLI 集成（start.ts）

在 `AgentManager` 初始化后设置回调：

```typescript
agentManager.setFtsSearchCallback((agentId, query, opts) => {
    const results = storage.chatSessionRepo!.searchMessages(query, limit);
    return results
        .filter(r => r.sessionAgentId === agentId)   // 仅返回当前 Agent 的数据
        .map(r => ({ id, agentId, type, content, createdAt }));
});
```

### 5.3 memory_search 工具中的位置

在 `core/src/tools/memory.ts` 中，FTS5 作为 memory_search 的 **Tier 2** 搜索层：

```
Tier 1: Vector semantic search (如果配置了嵌入模型)
Tier 2: FTS5 full-text search (如果 ftsSearch callback 已设置)  ← FTS5 在此
Tier 3: LIKE substring search (FTS5 不可用时的最终兜底)
```

FTS5 命中即返回结果，不继续向 Tier 3 降级。

### 5.4 API 层

FTS5 搜索目前**不暴露为独立的 REST API 端点**。它通过以下方式供 Agent 使用：

| 使用途径 | 说明 |
|----------|------|
| `memory_search` 工具 | Agent 通过工具调用触发 FTS5 搜索 |
| `setFtsSearchCallback` | CLI 启动时注入 AgentManager |
| 内部 API `searchMessages()` | 仓储层方法，供上层调用 |

未来如果暴露 REST API，预期路径为 `GET /api/search?q=...`（见 `docs/API.md` 更新）。

---

## 6. 类型定义

定义在 `@markus/shared` 的 `types/fts.ts` 中：

```typescript
type FtsResultSource = 'chat_message' | 'channel_message' | 'memory' | 'activity';

interface FtsSearchQuery {
    query: string;          // 搜索词（最少 2 字符）
    limit?: number;         // 最大条数（默认 30，最大 100）
    source?: FtsResultSource | 'all';  // 按来源过滤
    agentId?: string;       // 按 Agent 过滤
    sessionId?: string;     // 按会话过滤
    channel?: string;       // 按频道过滤
}

interface FtsSearchResult {
    id: string;
    source: FtsResultSource;
    text: string;
    rank: number;
    sessionId?: string;
    agentId?: string;
    role?: string;
    channel?: string;
    memoryType?: string;
    activityType?: string;
    activityTaskId?: string;
    senderName?: string;
    createdAt: string;
}

interface FtsSearchResponse {
    results: FtsSearchResult[];
    total: number;
    query: string;
}
```

---

## 7. 设计决策

| 决策 | 选项 | 选择 | 理由 |
|------|------|------|------|
| **外部内容表** (external content) | 内部/外部 | 外部 content table | 避免数据冗余，源表与 FTS 索引自动同步 |
| **Tokenize** | porter/unicode61/trigram | unicode61 | 原生 CJK 支持，无需额外分词器 |
| **同步机制** | 定时重建/触发器/应用层 | 触发器 | 实时同步，零代码维护 |
| **降级策略** | 抛出异常/LIKE 回退 | LIKE 回退 | 用户体验无感知 |
| **查询转义** | 拒绝特殊字符/清洗 | 清洗+转义 | 更宽容的用户输入处理 |
| **暴露方式** | REST API / 工具回调 | 工具回调 | FTS5 主要为 Agent 内部使用，REST 是未来选项 |

### 7.1 为什么用外部内容表（external content）

- 数据零冗余：FTS 索引仅存储分词数据和 rowid，原始数据在源表
- 自动同步：触发器保证源表变更实时反映到 FTS 索引
- JOIN 获取完整数据：查询时 JOIN chat_messages 获取完整字段

### 7.2 为什么不用向量搜索替代 FTS5

FTS5 和向量搜索是互补而非替代关系：

| 维度 | 向量搜索 | FTS5 全文搜索 |
|------|----------|---------------|
| 匹配方式 | 语义相似度 | 关键字精确匹配 |
| 语言要求 | 需要嵌入模型 | 无需外部依赖 |
| CJK 支持 | 依赖模型 | unicode61 原生支持 |
| 离线能力 | 需要 API 调用 | 完全本地 |
| 使用场景 | "找意思相近的" | "找包含这个词的" |

---

## 8. 测试覆盖

| 测试用例 | 文件 | 验证内容 |
|---------|------|---------|
| `FTS5: searchMessages returns results via FTS5 virtual table` | sqlite-comprehensive.test.ts | 插入消息后 FTS5 能检索到 |
| `FTS5: ensureFtsIndex is idempotent` | sqlite-comprehensive.test.ts | 调用两次不抛异常 |
| `FTS5: escapeFtsQuery handles special FTS5 characters` | sqlite-comprehensive.test.ts | ASCII 前缀匹配、CJK 短语、混合、空值 |
| `FTS5: isFtsAvailable returns true for node:sqlite` | sqlite-comprehensive.test.ts | Node.js 原生 SQLite 支持 FTS5 |
| `searchMessages` (channel) | sqlite-comprehensive.test.ts | 渠道消息搜索 |

---

## 9. 未来改进方向

1. **REST API 端点**: 暴露 `GET /api/search` 供 UI 或外部系统调用
2. **联合搜索**: 支持一次查询跨 4 个 FTS 表 + 向量搜索的联合召回
3. **自定义分词**: 对中文场景可挂载 jieba 分词器提升召回精度
4. **高亮片段**: FTS5 原生 `snippet()` 函数可用于搜索结果预览
5. **分页**: 当前 limit 硬限制 30，未来可支持 offset 分页

---

## 附录：文件清单

| 文件 | 用途 |
|------|------|
| `packages/shared/src/types/fts.ts` | FTS5 类型定义（FtsSearchQuery, FtsSearchResult 等） |
| `packages/shared/src/index.ts` | 导出 FTS5 类型 |
| `packages/storage/src/sqlite-storage.ts` | FTS5 表创建、触发器、查询实现、工具函数 |
| `packages/storage/src/index.ts` | 导出 ensureFtsIndex / escapeFtsQuery / isFtsAvailable |
| `packages/core/src/agent-manager.ts` | FtsSearchCallback 类型 + setFtsSearchCallback |
| `packages/core/src/tools/memory.ts` | memory_search 工具集成（Tier 2） |
| `packages/cli/src/commands/start.ts` | CLI 启动时注入 FTS5 回调 |
| `packages/storage/test/sqlite-comprehensive.test.ts` | FTS5 测试用例 |
