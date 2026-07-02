# 工具自注册机制 — ToolRegistry 设计文档

> **Status**: 已实现 (PR #235 ✅)  
> **Last updated**: 2026-07-02  
> **相关任务**: T2b — 工具自注册机制 (tsk_10b66412d15be5d03e3906fe)  
> **追认文档**: 本设计文档在实现完成后编写，反映了实际代码状态。

---

## 1. 问题陈述

### 1.1 背景

在 Markus 核心引擎中，工具（Tool）是 Agent 与环境交互的核心接口。Agent 通过工具调用执行文件操作、搜索、Shell 命令、子代理(Subagent)管理、A2A 通信等任务。Markus 支持 30+ 内置工具，覆盖 10+ 功能域。

### 1.2 痛点（Tech Debt TOOL-003）

在引入 ToolRegistry 之前，工具的注册分散在 `agent-manager.ts` 中，手动拼接成 `AgentToolHandler[]` 数组传递给 Agent。以下是具体问题：

| 问题 | 影响 |
|------|------|
| **无中央注册表** | 工具注册逻辑散布在各处，难以审计哪些工具可用 |
| **无元数据** | 工具仅有 name + handler 函数，无类别、标签、优先级信息 |
| **无法运行时发现** | Agent 无法在运行时按功能需求搜索可用工具 |
| **难以扩展** | 新增工具需要在多个地方修改代码，容易遗漏 |
| **无法按类别过滤** | Agent 无法限定只使用某类工具（如只允许文件操作工具） |
| **无法动态卸载** | 运行时无法按需移除某个工具 |

### 1.3 设计目标

1. **中央注册**：所有工具在一个注册表中注册，提供统一的查询接口
2. **元数据关联**：每个工具附带 category、priority、tags 信息
3. **运行时发现**：Agent 可按名称、类别、标签搜索工具
4. **向后兼容**：不对现有工具调用流程产生破坏性变更
5. **渐进加载基础**：为后续 L0/L1/L2 分层的渐进加载机制奠定基础设施

---

## 2. 架构概览

### 2.1 核心概念

```
┌─────────────────────────────────────────────────────┐
│                  ToolRegistry                        │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ handlers Map  │  │registrations │  │category    │ │
│  │ name→handler  │  │ Map          │  │ index      │ │
│  └──────────────┘  │ name→meta    │  └────────────┘ │
│                    └──────────────┘  ┌────────────┐ │
│                                      │ tag index   │ │
│                                      └────────────┘ │
└──────────────────┬──────────────────────────────────┘
                   │
        ┌──────────┼──────────┐
        ▼          ▼          ▼
    agent.ts   builtin.ts   manager.ts
     (Agent     (通用工具     (管理工具
      初始化)     注册)        注册)
```

### 2.2 数据模型

```typescript
// ToolRegistration — 工具的完整注册信息
interface ToolRegistration {
  handler: AgentToolHandler;   // 工具处理函数（含 name + execute）
  category: ToolCategory;      // 所属类别
  priority: number;            // 类别内优先级（高=优先显示）
  tags: string[];              // 运行时搜索关键词
}

// ToolCategory — 工具类别描述
interface ToolCategory {
  name: string;                // 类别名: "shell", "file", "web" 等
  description: string;         // 人类可读描述
}
```

### 2.3 组件职责

| 组件 | 文件 | 职责 |
|------|------|------|
| **ToolRegistry** | `packages/core/src/tools/registry.ts` | 核心注册表类，管理工具注册、查询、卸载 |
| **globalToolRegistry** | `packages/core/src/tools/registry.ts` | 全局单例，所有 Agent 共享的默认注册表 |
| **createBuiltinTools (增强)** | `packages/core/src/tools/builtin.ts` | 生成工具列表时同步注册到 globalToolRegistry |
| **Agent.init (增强)** | `packages/core/src/agent.ts` | 初始化时从 globalToolRegistry 读取已注册工具 |
| **管理工具注册** | `packages/core/src/tools/manager.ts` | 管理类工具注册时也写入 globalToolRegistry |

---

## 3. 核心设计决策

### 3.1 全局单例 vs 每 Agent 独立 Registry

**决策：使用全局单例（globalToolRegistry）**

| 方案 | 优点 | 缺点 |
|------|------|------|
| **全局单例** ✅ | 一次注册全局可用；工具数量确定且共享；实现简单 | 不同 Agent 无法拥有不同的工具集 |
| **每 Agent 独立** | 可定制工具配置 | 注册重复；跨 Agent 协调复杂 |

**理由**：当前 Markus 的 Agent 使用相同的工具集，无 Agent 级别差异化需求。全局单例也在初始化时同步使用的模式(`toolModule.globalToolRegistry`)与现有架构一致。后续如需差异化，可在全局注册表上叠加 Agent 级别过滤层。

### 3.2 三索引结构

ToolRegistry 内部维护三个索引以支持不同的查询模式：

| 索引 | 键类型 | 值类型 | 查询场景 |
|------|--------|--------|---------|
| `handlers` | `string` (工具名) | `AgentToolHandler` | 按名称精确查找（get） |
| `registrations` | `string` (工具名) | `ToolRegistration` | 按名称获取完整元数据 |
| `indexedByCategory` | `string` (类别名) | `ToolRegistration[]` | 按类别过滤（findByCategory） |
| `indexedByTag` | `string` (标签) | `ToolRegistration[]` | 按标签搜索（未直接暴露，被 search 使用） |

**索引一致性**：`register()` 自动维护所有索引；`unregister()` 清理所有对应条目。

### 3.3 注册时机 — 构建时立即注册（非懒加载）

工具注册发生在模块加载阶段（构建工具列表时），而非 Agent 启动时：

```typescript
// builtin.ts (增强后)
export function createBuiltinTools(opts?: BuiltinToolsOptions): AgentToolHandler[] {
  const tools = [/* ...创建工具实例... */];
  for (const handler of tools) {
    globalToolRegistry.register({ handler, category, priority, tags });
  }
  return tools;
}
```

这意味着工具在 `pnpm build`/`pnpm dev` 后的首次 import 时即完成注册。

### 3.4 discover_tools 集成

运行时 `discover_tools` 工具利用 ToolRegistry 的 `search()` 和 `findByCategory()` 来响应 Agent 的发现请求。当 Agent 调用 `discover_tools({ name: ["shell"] })` 时，系统查询注册表返回匹配结果。

---

## 4. 类别系统

### 4.1 类别定义

类别在 `builtin.ts` 和 `manager.ts` 中定义。当前定义的类别：

| 类别名 | 包含工具 | 优先级范围 |
|--------|---------|-----------|
| `shell` | shell 执行 | 100 |
| `file` | read, write, edit, grep, glob, listDir | 90 |
| `web` | web_fetch, web_search, web_extract | 80 |
| `memory` | memory_save, memory_search 等 | 70 |
| `agent` | agent_send_message, agent_broadcast_status 等 | 60 |
| `task` | task_list, task_create, task_note 等 | 50 |
| `package` | package_list, package_install | 40 |
| `configuration` | llm_list_providers, llm_switch_model 等 | 30 |
| `subagent` | spawn_subagent, spawn_subagents | 20 |

### 4.2 优先级约定

- **100**: 基础系统工具（shell）
- **90-80**: 通用工具（file, web）
- **70-50**: 功能工具（memory, agent, task）
- **40-30**: 管理工具（package, configuration）
- **20-10**: 高级工具（subagent）

---

## 5. API 参考

### 5.1 ToolRegistry 方法

| 方法 | 签名 | 描述 |
|------|------|------|
| `register` | `(entry: ToolRegistration): void` | 注册一个工具（含元数据），同名工具覆盖更新 |
| `get` | `(name: string): AgentToolHandler \| undefined` | 按名称获取工具处理函数 |
| `getAll` | `(): AgentToolHandler[]` | 获取所有已注册的处理函数 |
| `getAllRegistrations` | `(): ToolRegistration[]` | 获取所有完整注册记录 |
| `findByCategory` | `(categoryName: string): ToolRegistration[]` | 按类别查找工具 |
| `search` | `(query: string): ToolRegistration[]` | 按名称或标签搜索（大小写不敏感） |
| `unregister` | `(name: string): boolean` | 卸载工具，返回是否成功 |

### 5.2 全局单例

```typescript
import { globalToolRegistry, type ToolRegistration } from '@markus/core/tools/registry.js';

// 注册自定义工具
globalToolRegistry.register({
  handler: myCustomTool,
  category: { name: 'custom', description: 'Custom tools' },
  priority: 50,
  tags: ['custom', 'my-plugin'],
});

// 检索
const tool = globalToolRegistry.get('myCustomTool');
const fileTools = globalToolRegistry.findByCategory('file');
const results = globalToolRegistry.search('read');
```

---

## 6. 集成点

### 6.1 Agent 初始化（agent.ts）

Agent 在初始化时从 `globalToolRegistry` 获取已注册的工具列表：

```typescript
// agent.ts (增强)
import * as toolModule from './tools/index.js';
// ...
this.tools = toolModule.globalToolRegistry.getAll();
this.discoverToolsHandler = toolModule.globalToolRegistry;
```

### 6.2 内置工具注册（builtin.ts）

`createBuiltinTools` 在构造工具列表后，逐个注册到 `globalToolRegistry`：

```typescript
// builtin.ts (增强)
import { globalToolRegistry } from './registry.js';
// 在每个工具创建后：
globalToolRegistry.register({
  handler: shellTool,
  category: { name: 'shell', description: 'Execute shell commands' },
  priority: 100,
  tags: ['shell', 'command', 'exec'],
});
```

### 6.3 管理工具注册（manager.ts）

类似地，管理类工具也在创建时注册：

```typescript
// manager.ts (增强)
import { globalToolRegistry } from './registry.js';
// 在每个管理工具创建后调用 globalToolRegistry.register(...)
```

### 6.4 跨 Agent 通信 — discover_tools 工具

`discover_tools` 功能利用 ToolRegistry 实现运行时发现。入口点见 `agent.ts` 中的 `handleDiscoverTools` 工具，它当前返回所有注册的工具名称列表。

---

## 7. 边界情况

| 场景 | 行为 |
|------|------|
| **重复注册同名工具** | 覆盖更新：新的 handler 替换旧的，`registrations` 和 `handlers` 覆盖映射条目。**注意**：旧类别的索引（`indexedByCategory` 和 `indexedByTag`）当前不会被清理 — 仅在 `unregister` 时清除当前注册的索引。这是一个已知技术债，不影响正常运行，但跨类别覆盖后卸载可能导致旧类别索引残留。 |
| **卸载不存在的工具** | 静默失败，返回 false |
| **查询空类别** | 返回空数组 `[]` |
| **搜索空字符串** | 返回所有注册项（全匹配） |
| **多标签索引** | 一个工具可出现在多个标签索引中 |
| **并发注册** | 当前为同步操作，无并发安全保护（JS 单线程） |
| **未注册任何工具** | `getAll()` 返回空数组；`get(name)` 返回 undefined |

---

## 8. 后续扩展方向

| 方向 | 优先级 | 说明 |
|------|--------|------|
| **L0/L1/L2 渐进加载** | P0 | 利用注册表的 category + priority 实现分层加载（当前正在实现） |
| **Capability-based routing** | P1 | 按能力（读文件、写文件、网络访问）而非名称选择工具 |
| **权限/安全过滤** | P2 | 在注册表层面添加 allowlist/blocklist 机制 |
| **工具使用统计** | P3 | 追踪每个工具的调用频率、成功率 |
| **Rate limiting 集成** | P3 | 在注册表层面添加工具级别速率限制 |

---

## 9. 相关文件

| 文件 | 角色 |
|------|------|
| `packages/core/src/tools/registry.ts` | ToolRegistry 类 + globalToolRegistry 单例 |
| `packages/core/src/tools/builtin.ts` | 通用工具注册（增强版） |
| `packages/core/src/tools/manager.ts` | 管理工具注册（增强版） |
| `packages/core/src/tools/index.ts` | 导出 registry.ts 的公共 API |
| `packages/core/src/agent.ts` | Agent 初始化时从 registry 读取工具 |
| `packages/core/src/tools/agent.ts` | 定义 AgentToolHandler 接口 |
| `packages/core/test/tool-registry.test.ts` | ToolRegistry 独立单元测试 |
