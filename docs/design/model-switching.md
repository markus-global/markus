# 会话级模型即时切换 — 设计文档

> **文档状态**: 已实现 (v1.0)
> **实现 PR**: [#233](https://github.com/markus-global/markus/pull/233)
> **最后更新**: 2026-07-02

---

## 1. 动机

用户在对话中需要临时切换 LLM 模型/提供商，而无需中断会话或修改全局路由配置。典型场景：

- **成本控制**: 简单问题切换到廉价模型（如 DeepSeek），复杂推理切回 Claude
- **能力需求**: 代码生成任务需要切换到特定模型（如 GPT-4o 的代码能力）
- **故障容错**: 当前提供商不可用，临时切换到备用提供商

---

## 2. 设计概览

```
┌─────────────────────────────────────────────────────────────────┐
│                         LLMRouter                                │
│                                                                  │
│  ┌──────────────┐    ┌──────────────────────────┐               │
│  │  Default      │    │  sessionOverrides Map    │               │
│  │  Routing      │    │  ┌────────────────────┐  │               │
│  │  (provider    │    │  │ "session-abc-123"  │  │               │
│  │   tiers,      │    │  │ → { provider:      │  │               │
│  │   capability  │    │  │     "anthropic",   │  │               │
│  │   routing)    │    │  │     model:         │  │               │
│  │               │    │  │     "claude-sonnet- │  │               │
│  │               │    │  │      4-20250514",  │  │               │
│  │               │    │  │     setAt:          │  │               │
│  │               │    │  │     "2026-07-..."   │  │               │
│  │               │    │  │   }                │  │               │
│  │               │    │  └────────────────────┘  │               │
│  └──────┬────────┘    └──────────┬───────────────┘               │
│         │                        │                                │
│         ▼                        ▼                                │
│  ┌──────────────────────────────────────────┐                    │
│  │        Priority Chain (high → low)       │                    │
│  │                                          │                    │
│  │  ① Per-request metadata override         │                    │
│  │     (modelOverride / providerOverride    │                    │
│  │      on LLMRequest.metadata)             │                    │
│  │  ② Session-level override               │                    │
│  │     (sessionOverrides map entry)         │                    │
│  │  ③ Explicit providerName parameter       │                    │
│  │     (passed to chat/chatStream)          │                    │
│  │  ④ Capability routing assignments        │                    │
│  │     (capabilityRouting config)           │                    │
│  │  ⑤ Route-level default / complexity      │                    │
│  │     (selectProvider fallback)            │                    │
│  └──────────────────────────────────────────┘                    │
└─────────────────────────────────────────────────────────────────┘
```

### 优先级顺序（高 → 低）

| 优先级 | 层级 | 作用域 | 设置方式 |
|--------|------|--------|---------|
| **1** (最高) | 请求元数据覆写 | 单次请求 | `LLMRequest.metadata.modelOverride` / `.providerOverride` |
| **2** | 会话覆写 | 整个会话 | `POST /api/sessions/:sessionId/model` API |
| **3** | 显式 Provider 参数 | 单次调用 | `chat(request, providerName)` 参数 |
| **4** | Capability 路由分配 | 全局 | `capabilityRouting.assignments` 配置 |
| **5** | 默认路由 (复杂度/层级选择) | 全局 | `selectProvider()` / `assessComplexity()` |

---

## 3. 数据结构

### SessionModelOverride (shared 类型)

```typescript
// packages/shared/src/types/llm.ts
interface SessionModelOverride {
  /** Provider name (e.g. "anthropic", "openai") */
  provider?: string;
  /** Model ID (e.g. "claude-sonnet-4-20250514") */
  model?: string;
  /** ISO timestamp when this override was set */
  setAt?: string;
}
```

### 内部存储

```typescript
// LLMRouter 内部
private sessionOverrides = new Map<string, SessionModelOverride>();
```

Map 以 `sessionId` 为 key。无持久化存储 — 重启后丢失（当前限制）。

### LLMRequest.metadata 扩展

```typescript
interface LLMMetadata {
  // ... 已有字段
  /** Per-request model override — switch model for this request only */
  modelOverride?: string;
  /** Per-request provider override — switch provider for this request only */
  providerOverride?: string;
}
```

---

## 4. 核心 API (LLMRouter 方法)

### 4.1 `setSessionModel(sessionId, override)`

```typescript
setSessionModel(sessionId: string, override: SessionModelOverride): void
```

- 将 override 存入 `sessionOverrides` Map
- 自动设置 `setAt` 为当前 ISO 时间戳
- 不做 provider 存在性校验（允许设置后在后续路由阶段由 `isAvailable()` 检查）

### 4.2 `getSessionModel(sessionId)`

```typescript
getSessionModel(sessionId: string): SessionModelOverride | undefined
```

- 返回指定会话的覆写配置
- 不存在时返回 `undefined`

### 4.3 `clearSessionModel(sessionId)`

```typescript
clearSessionModel(sessionId: string): void
```

- 删除指定会话的覆写，恢复默认路由

### 4.4 `clearAllSessionModels()`

```typescript
clearAllSessionModels(): void
```

- 清空所有会话的覆写（系统重置/维护场景）

---

## 5. 与核心路由的集成

### 5.1 `selectForCapability()` — 能力路由路径

```
请求 selectForCapability(capabilityType, request, sessionId)
  │
  ├── 检查 sessionOverrides[sessionId]?
  │     ├── 有且 provider 可用 (isAvailable) → 返回 session 覆写
  │     └── 无或 provider 不可用 → 继续
  │
  ├── 检查 capabilityRouting.assignments?
  │     ├── 有 → 返回 assignment
  │     └── 无 → 继续
  │
  ├── 检查 routingDefaultModel?
  │     ├── 有 → 返回默认模型
  │     └── 无 → 继续
  │
  └── selectProvider(request) → 基于复杂度的回退
```

### 5.2 `chat()` / `chatStream()` — 文本聊天路径

```
chat(request, providerName?, options?)
  │
  ├── 读取 request.metadata 中的 per-request 覆写
  │     ├── providerOverride → 如果存在且 provider 已注册，设为 providerName
  │     └── modelOverride → 设为 routedModel
  │
  ├── 读取 sessionOverrides[sessionId]
  │     ├── provider → 如果存在且未设置 providerName，设为 providerName
  │     └── model → 如果存在且未设置 routedModel，设为 routedModel
  │
  ├── 基于 providerName 选择 provider
  │     ├── 有 → selectProvider(request, providerName)
  │     └── 无 → selectForCapability() 或 selectProvider()
  │
  └── tryChat(provider, request, routedModel)
```

### 5.3 关键设计决策

| 决策 | 选项 | 选择理由 |
|------|------|---------|
| 持久化方案 | 内存 Map vs 数据库 | 内存 Map 足够——会话生命周期较短；数据库增加不必要的延迟 |
| Provider 校验时机 | 设置时 vs 路由时 | 路由时——允许在设置后动态添加 Provider |
| Override 作用域 | Session vs 更多粒度 | Session——粒度适中；单个会话内多次请求共享一个覆写 |
| 单次请求覆写 | metadata 字段 | Per-request 优先级最高，满足临时需求且不影响后续请求 |

---

## 6. HTTP API

3 条 REST 端点，用于管理会话级模型覆写：

### 6.1 GET /api/sessions/:sessionId/model

获取会话的当前模型覆写。

**响应 (200)**:
```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "setAt": "2026-07-02T10:30:00.000Z"
}
```

**响应 (200, 无覆写)**:
```json
{
  "provider": null,
  "model": null,
  "setAt": null
}
```

### 6.2 POST /api/sessions/:sessionId/model

设置会话的模型覆写。

**请求体**:
```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514"
}
```

**响应 (200)**:
```json
{
  "success": true,
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514"
}
```

**错误响应**:
- `400` — `{ "error": "provider (string) is required" }` 或 `{ "error": "model (string) is required" }`
- `503` — `{ "error": "LLM router not available" }`
- `403` — `{ "error": "Access denied: this session belongs to another user" }`

### 6.3 DELETE /api/sessions/:sessionId/model

清除会话的模型覆写。

**响应 (204)**: 无内容

**错误响应**:
- `503` — `{ "error": "LLM router not available" }`
- `403` — `{ "error": "Access denied: this session belongs to another user" }`

### 6.4 鉴权

所有端点均需 JWT 认证（`requireAuth` 中间件）。会话所有权检查：
- 如果 session 存在且属于其他 userId，返回 `403`
- 如果请求用户是 `admin` 或 `owner` 角色，可以操作任何会话（绕过所有权检查）

### 6.5 审计日志

`POST` 和 `DELETE` 操作记录审计日志：
- **类型**: `settings_changed`
- **动作**: `session_model_override` / `session_model_override_clear`
- **包含**: sessionId, provider, model, userId

---

## 7. 与 Wave 2 前端的对接约定

### 模型选择 UI 组件

Wave 2 前端将新增一个模型选择器组件，位于会话设置面板中：

```typescript
// 前端 UI 组件预期接口
interface ModelSwitcherProps {
  sessionId: string;
  currentOverride: { provider: string | null; model: string | null };
  availableProviders: Array<{ name: string; models: Array<{ id: string; name: string }> }>;
  onSwitch: (sessionId: string, provider: string, model: string) => Promise<void>;
  onClear: (sessionId: string) => Promise<void>;
}
```

### 数据流

```
用户选择模型 → 前端调用 POST /api/sessions/:id/model
  → 后端设置 sessionOverride
  → 后端更新前端状态（可选 WebSocket 广播）
  → 后续消息自动使用新模型
  → 用户可随时清除覆写（恢复默认路由）
```

### 可用 Provider/Model 列表

前端通过现有 `GET /api/models/routing-candidates` 端点获取可用 Provider 和模型列表。

---

## 8. 已知限制与后续优化

### TTL 回收

**当前状态**: 无自动回收。`sessionOverrides` Map 仅通过 `clearSessionModel()` 或 `clearAllSessionModels()` 手动清理。

**对系统的影响**:
- 内存占用随活跃会话数线性增长（每个条目约 200 字节）
- 假设 10,000 个活跃会话 → 约 2 MB 内存，可接受

**计划改进**:
```typescript
// Wave 2: 添加 TTL 回收
private SESSION_OVERRIDE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时

// 在 getSessionModel 中惰性回收
getSessionModel(sessionId: string): SessionModelOverride | undefined {
  const override = this.sessionOverrides.get(sessionId);
  if (override?.setAt) {
    const age = Date.now() - new Date(override.setAt).getTime();
    if (age > SESSION_OVERRIDE_TTL_MS) {
      this.sessionOverrides.delete(sessionId);
      return undefined;
    }
  }
  return override;
}
```

### Provider 可用性检查

当前 `setSessionModel()` 不做 Provider 可用性校验——校验延迟到路由时由 `isAvailable()` 执行。这意味着：
- ✅ Pro: 可以设置尚未配置的 Provider（先设置，后配置）
- ⚠️ 副作用: 无效 Provider 设置后不会报错，路由时静默降级

### 持久化

当前无持久化。服务重启后所有会话覆写丢失。如需持久化：
- `Redis/数据库`: 在 `setSessionModel()` / `clearSessionModel()` 时同步写 DB
- 在 `createRouter()` 时从 DB 恢复活跃会话的覆写

### 并发安全

当前 `Map` 操作非原子。在高并发场景下可能出现竞态条件：
- 两个请求同时设置同一个 sessionId → 后者覆盖前者
- 对于当前使用模式（单用户操作自己的会话），风险可控
