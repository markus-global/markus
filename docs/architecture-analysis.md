# Markus 系统架构深度分析报告

> 版本：v0.7.0 | 分析日期：2026-03-04 | 基于源码深度调研

---

## 目录

1. [项目概述](#1-项目概述)
2. [整体架构](#2-整体架构)
3. [核心模块详解](#3-核心模块详解)
   - 3.1 [Agent 系统](#31-agent-系统)
   - 3.2 [Team 系统](#32-team-系统)
   - 3.3 [Task 系统](#33-task-系统)
   - 3.4 [Template 系统](#34-template-系统)
   - 3.5 [Chat 系统](#35-chat-系统)
   - 3.6 [Skill 系统](#36-skill-系统)
   - 3.7 [Workflow 引擎](#37-workflow-引擎)
   - 3.8 [LLM 路由层](#38-llm-路由层)
   - 3.9 [存储层](#39-存储层)
4. [模块间关系全景图](#4-模块间关系全景图)
5. [与业界框架对比分析](#5-与业界框架对比分析)
   - 5.1 [OpenClaw 架构借鉴](#51-openclaw-架构借鉴)
   - 5.2 [CrewAI / AutoGen / LangGraph / OpenAI Agents SDK](#52-crewai--autogen--langgraph--openai-agents-sdk)
6. [问题诊断与解决进展](#6-问题诊断与解决进展)
   - 6.1 [已解决的核心问题](#61-已解决的核心问题)
   - 6.2 [仍待解决的问题](#62-仍待解决的问题)
   - 6.3 [架构设计反思](#63-架构设计反思)
7. [实施进展总览](#7-实施进展总览)
8. [后续路线图](#8-后续路线图)
9. [附录](#9-附录)

---

## 1. 项目概述

Markus 定位为 **AI Native Digital Employee Platform**——一个 AI 原生的数字员工平台。其核心愿景是：用户可以创建一个虚拟组织（Organization），在其中部署多个 AI Agent 担任不同角色（开发、运维、产品、市场等），这些 Agent 组成 Team，自动执行 Task，并通过 Chat 与人类交互。

**技术栈**：TypeScript + pnpm monorepo + React + Drizzle ORM + SQLite

**包结构**：

| 包 | 职责 | 上游依赖 |
|---|---|---|
| `@markus/shared` | 共享类型、工具函数、日志、ID 生成 | 无（基础包） |
| `@markus/comms` | 通信原语（消息通道） | shared |
| `@markus/a2a` | Agent 间通信协议与消息总线 | shared |
| `@markus/gui` | GUI 自动化能力 | shared |
| `@markus/compute` | 计算资源管理（Docker 沙箱） | shared |
| `@markus/core` | Agent 运行时、LLM 路由、工具、技能、模板、工作流 | shared, comms, gui, a2a |
| `@markus/storage` | Drizzle ORM schema、Repository、迁移 | shared |
| `@markus/org-manager` | 组织/团队/任务管理、REST API、WebSocket | core, shared, storage |
| `@markus/cli` | 命令行工具 | shared, core, compute, comms, org-manager |
| `@markus/web-ui` | React + Vite 前端 | 无工作区内依赖 |

---

## 2. 整体架构

### 2.1 分层架构总览

```plantuml
@startuml markus-layered-architecture
!theme plain
skinparam backgroundColor #FEFEFE
skinparam componentStyle rectangle

package "Presentation Layer" as PL #E3F2FD {
  [Web UI\n(React + Vite)] as WebUI
  [CLI\n(Commander.js)] as CLI
}

package "API Layer" as AL #FFF3E0 {
  [REST API Server\n(Express)] as API
  [WebSocket Server\n(ws)] as WS
}

package "Business Logic Layer" as BL #E8F5E9 {
  [OrgService] as OrgSvc
  [TaskService] as TaskSvc
  [AgentManager] as AgentMgr
  [TeamService] as TeamSvc
  [UserService] as UserSvc
  [AuditService] as AuditSvc
}

package "Agent Runtime Layer" as ARL #F3E5F5 {
  [Agent] as Agent
  [ContextEngine] as CtxEng
  [ToolSelector] as ToolSel
  [HeartbeatScheduler] as HB
  [TaskExecutor\n(Concurrent)] as TaskExec
  [Memory Store] as Mem
  [SecurityGuard] as Sec
}

package "AI & Communication Layer" as ACL #FCE4EC {
  [LLM Router] as LLM
  [A2A Bus] as A2A
  [Skill Registry] as Skills
  [Workflow Engine] as WF
  [External Gateway] as GW
}

package "Infrastructure Layer" as IL #EFEBE9 {
  [LLM Providers\n(Anthropic/OpenAI/Google/Ollama)] as Providers
  [Storage\n(SQLite + Drizzle)] as DB
  [Compute\n(Docker Sandbox)] as Compute
}

WebUI --> API : HTTP/REST
WebUI --> WS : WebSocket
CLI --> API : HTTP/REST

API --> OrgSvc
API --> TaskSvc
API --> AgentMgr
API --> TeamSvc
API --> UserSvc

OrgSvc --> AgentMgr
TaskSvc --> Agent
AgentMgr --> Agent : create/manage

Agent --> CtxEng
Agent --> ToolSel
Agent --> HB
Agent --> TaskExec
Agent --> Mem
Agent --> Sec

Agent --> LLM : chat/chatStream
Agent --> A2A : agent-to-agent
Agent --> Skills : tool lookup

LLM --> Providers
AgentMgr --> WF
GW --> AgentMgr

OrgSvc --> DB
TaskSvc --> DB
AgentMgr --> DB
Agent --> Compute

@enduml
```

### 2.2 数据流概览

```plantuml
@startuml markus-data-flow
!theme plain
skinparam backgroundColor #FEFEFE

actor "Human User" as User
participant "Web UI" as UI
participant "API Server" as API
participant "OrgService" as Org
participant "Agent" as Agent
participant "ContextEngine" as Ctx
participant "LLM Router" as LLM
participant "Tool System" as Tools
database "Storage" as DB

User -> UI : 发送消息
UI -> API : POST /api/message\n(stream: true)
API -> Org : routeMessage()
Org -> Agent : handleMessageStream()

Agent -> Ctx : buildSystemPrompt()
note right of Ctx
  组装内容：
  1. Role 系统提示
  2. 身份信息
  3. 组织上下文
  4. 长期记忆
  5. 相关知识
  6. 任务看板
  7. 策略规则
end note
Ctx --> Agent : systemPrompt

Agent -> LLM : chatStream(messages, tools)
LLM --> Agent : text_delta / tool_call

alt 需要工具调用
  Agent -> Tools : executeTool(toolCall)
  Tools --> Agent : result
  Agent -> LLM : chatStream(messages + toolResult)
  LLM --> Agent : text_delta / tool_call
  note right: 循环直到 finishReason ≠ tool_use
end

Agent -> DB : 保存消息到 chatMessages
Agent --> UI : SSE stream events

@enduml
```

---

## 3. 核心模块详解

### 3.1 Agent 系统

Agent 是 Markus 的核心运行单元。每个 Agent 由 `AgentConfig` 配置、`RoleTemplate` 角色模板和一组运行时组件构成。

#### 3.1.1 Agent 类结构

```plantuml
@startuml agent-class-diagram
!theme plain
skinparam backgroundColor #FEFEFE

class Agent {
  +id: string
  +config: AgentConfig
  +role: RoleTemplate
  --
  -state: AgentState
  -eventBus: EventBus
  -heartbeat: HeartbeatScheduler
  -llmRouter: LLMRouter
  -memory: IMemoryStore
  -contextEngine: ContextEngine
  -tools: Map<string, AgentToolHandler>
  -toolSelector: ToolSelector
  -taskExecutor: TaskExecutor
  -sandbox?: SandboxHandle
  -enhancedMemory?: EnhancedMemorySystem
  -metricsCollector: AgentMetricsCollector
  -skillProficiency: Map<string, SkillStats>
  --
  +start(): Promise<void>
  +stop(): Promise<void>
  +handleMessage(msg, opts): Promise<string>
  +handleMessageStream(msg, opts): AsyncGenerator
  +executeTask(task): Promise<TaskResult>
  -executeTool(toolCall): Promise<string>
  -buildToolDefinitions(opts): LLMTool[]
  -consolidateMemory(): void
  -handleFailure(toolName, error): void
}

class AgentConfig {
  +id: string
  +name: string
  +roleId: string
  +orgId: string
  +teamId?: string
  +agentRole: 'manager' | 'worker'
  +skills: string[]
  +llmConfig: LLMAssignment
  +computeConfig: ComputeAssignment
  +channels: ChannelBinding[]
  +heartbeatIntervalMs: number
}

class AgentState {
  +agentId: string
  +status: AgentStatus
  +activeTaskCount: number
  +activeTaskIds: string[]
  +tokensUsedToday: number
}

enum AgentStatus {
  idle
  working
  paused
  offline
  error
}

Agent --> AgentConfig
Agent --> AgentState
AgentState --> AgentStatus

@enduml
```

#### 3.1.2 Agent 生命周期

```plantuml
@startuml agent-lifecycle
!theme plain
skinparam backgroundColor #FEFEFE

[*] --> Created : AgentManager.createAgent()

Created --> Idle : agent.start()
note right of Idle
  - 恢复最新会话
  - 启动心跳调度
  - 启动记忆整合定时器
end note

Idle --> Working : handleMessage() / executeTask()
Working --> Idle : 任务完成，无其他活跃任务
Working --> Working : 并发执行多个任务\n(TaskExecutor, max=5)

Idle --> Paused : 手动暂停
Paused --> Idle : 恢复

Working --> Error : 连续失败 > 3 次
Error --> Idle : 错误恢复

Idle --> Offline : agent.stop()
Working --> Offline : agent.stop()
Offline --> [*]

@enduml
```

#### 3.1.3 工具系统

Agent 的工具来源丰富，通过 `AgentManager.createAgent()` 在创建时注入：

| 工具类别 | 来源 | 示例 |
|---|---|---|
| 内置工具 | `createBuiltinTools()` | shell, file_read, file_write, file_edit, web_search, web_fetch |
| A2A 工具 | `createA2ATools()` | agent_send_message, agent_list_colleagues, agent_send_group_message |
| 结构化 A2A | `createStructuredA2ATools()` | agent_delegate_task, agent_request_resource, agent_sync_progress |
| 记忆工具 | `createMemoryTools()` | memory_save, memory_search, memory_list |
| 任务工具 | `createAgentTaskTools()` | task_create, task_list, task_update, task_assign |
| 管理工具 | `createManagerTools()` | team_list, team_status, delegate_message, create_task |
| 技能工具 | `SkillRegistry` | git_*, code_analysis_*, browser_* |
| MCP 工具 | `MCPClientManager` | 外部 MCP 服务器提供的工具 |
| 沙箱工具 | Sandbox override | sandboxed_shell, sandboxed_file_* |

**工具选择机制** (`ToolSelector`)：不是一次性暴露所有工具给 LLM，而是根据上下文动态选择：

- **基础工具**总是包含（agent_send_message, task_create, memory_save 等）
- **关键词匹配**：根据用户消息中的关键词激活相关工具
- **Manager 工具**：仅 `agentRole === 'manager'` 的 Agent 可用
- **任务执行工具**：执行任务时额外包含 code/shell/git 工具
- **元工具** `discover_tools`：允许 Agent 动态请求更多工具

**工具执行重试机制**：
- 最多重试 `TOOL_RETRY_MAX = 2` 次，指数退避
- 连续失败超过 `MAX_CONSECUTIVE_FAILURES = 3` 次后触发人类升级

---

### 3.2 Team 系统

Team 是 Agent 的组织容器，代表一个协作团队。

```plantuml
@startuml team-structure
!theme plain
skinparam backgroundColor #FEFEFE

class Organization {
  +id: string
  +name: string
  +ownerId: string
  +managerAgentId?: string
  +plan: 'free' | 'pro' | 'enterprise'
  +maxAgents: number
}

class Team {
  +id: string
  +orgId: string
  +name: string
  +description?: string
  +leadAgentId?: string
  +memberAgentIds: string[]
  +managerId?: string
  +managerType?: 'human' | 'agent'
  +humanMemberIds?: string[]
}

class "Agent (Manager)" as ManagerAgent {
  +agentRole: 'manager'
  拥有 manager 专属工具：
  team_list, team_status,
  delegate_message, create_task
}

class "Agent (Worker)" as WorkerAgent {
  +agentRole: 'worker'
  仅拥有基础工具 + 技能工具
}

class HumanUser {
  +id: string
  +name: string
  +role: HumanRole
  +orgId: string
  +teamId?: string
}

Organization "1" *-- "*" Team
Organization "1" *-- "1" ManagerAgent : managerAgentId
Team "1" o-- "*" WorkerAgent : memberAgentIds
Team "1" o-- "*" HumanUser : humanMemberIds
Team "1" o-- "0..1" ManagerAgent : leadAgentId

@enduml
```

**当前实现特点**：
- Team 主要是组织分组，Agent 通过 `config.teamId` 关联
- Manager Agent 拥有额外的管理工具，可以查看团队状态、委派消息、创建任务
- Agent 间通信通过 A2A 工具（`agent_send_message`）而非直接方法调用
- 团队内的协调主要依赖 Manager Agent 的 LLM 推理能力

---

### 3.3 Task 系统

Task 是 Markus 的核心工作单元，贯穿从创建到执行的完整生命周期。

```plantuml
@startuml task-lifecycle
!theme plain
skinparam backgroundColor #FEFEFE

[*] --> pending : task_create / API

pending --> assigned : task_assign(agentId)
assigned --> in_progress : task_update(in_progress)\n或 Agent Heartbeat 触发

in_progress --> completed : task_update(completed)\n包含 TaskResult
in_progress --> failed : 执行失败 / 超时
in_progress --> blocked : blockedBy 依赖未完成

blocked --> in_progress : 依赖完成

failed --> in_progress : 重试（带历史上下文）

pending --> cancelled : 手动取消
assigned --> cancelled : 手动取消
in_progress --> cancelled : 手动取消

completed --> [*]
failed --> [*]
cancelled --> [*]

@enduml
```

**Task 执行流程**（`TaskService.runTask()` → `Agent._executeTaskInternal()`）：

1. TaskService 检测 `status` 变为 `in_progress`，自动触发 `runTask()`
2. 加载分配的 Agent，构建任务描述（含历史执行记录，支持断点续做）
3. Agent 创建隔离 Session，构建系统提示（含任务上下文）
4. 通过 `llmRouter.chatStream()` 流式执行，支持工具调用循环
5. 执行日志（`status`, `text`, `tool_start`, `tool_end`, `error`）实时写入 `taskLogs`
6. 完成后产出 `TaskResult`（success, summary, artifacts, durationMs, tokensUsed）

**Task 层次结构**：支持 `parentTaskId` 和 `subtaskIds`，可构建任务树。支持 `blockedBy` 依赖关系。

---

### 3.4 Template 系统

Template 是 Agent 和 Team 的蓝图，分为角色模板和团队模板两个维度。

```plantuml
@startuml template-system
!theme plain
skinparam backgroundColor #FEFEFE

package "Role Templates\n(templates/roles/)" as RT {
  folder "developer/" {
    file "ROLE.md" as DevRole
    file "SKILLS.md" as DevSkills
  }
  folder "org-manager/" {
    file "ROLE.md" as MgrRole
    file "SKILLS.md" as MgrSkills
    file "HEARTBEAT.md" as MgrHB
    file "POLICIES.md" as MgrPol
  }
  folder "reviewer/" {
    file "ROLE.md" as RevRole
  }
  file "SHARED.md" as Shared
}

package "Team Templates\n(templates/teams/)" as TT {
  file "dev-team.json" as DevTeam
  file "startup-team.json" as StartupTeam
  file "marketing-team.json" as MktTeam
  file "support-team.json" as SupTeam
}

class RoleLoader {
  +loadRole(name): RoleTemplate
  -resolveRoleFiles(): Files
  -extractTitle(): string
  -parseSkillsList(): string[]
  -parseHeartbeatTasks(): HeartbeatTask[]
  -parsePolicies(): Policy[]
}

class RoleTemplate {
  +id: string
  +name: string
  +description: string
  +category: RoleCategory
  +systemPrompt: string
  +defaultSkills: string[]
  +defaultHeartbeatTasks: HeartbeatTask[]
  +defaultPolicies: Policy[]
  +builtIn: boolean
}

RoleLoader --> RT : 读取
RoleLoader --> RoleTemplate : 生成
RoleLoader --> Shared : 附加到所有角色

note bottom of RT
  当前 16 个内置角色：
  developer, qa-engineer, tech-writer,
  marketing, secretary, support, reviewer,
  project-manager, research-assistant,
  operations, hr, product-manager,
  finance, content-writer, devops,
  org-manager
end note

note bottom of TT
  团队模板定义 agents 数组：
  每个 agent 指定 name, role,
  agentRole, skills
end note

@enduml
```

**模板加载机制**：

`RoleLoader` 从 `templates/roles/<roleName>/` 目录加载：
- `ROLE.md` → 系统提示词（name, description, systemPrompt）
- `SKILLS.md` → 默认技能列表
- `HEARTBEAT.md` → 心跳任务定义
- `POLICIES.md` → 策略规则

`SHARED.md` 作为共享指令，追加到**所有**角色的系统提示词末尾。

---

### 3.5 Chat 系统

Chat 是人机交互的核心界面，支持多种交互模式。

```plantuml
@startuml chat-system
!theme plain
skinparam backgroundColor #FEFEFE

package "Chat Modes" {
  [Smart Route] as Smart
  [Channel] as Channel
  [Direct Message] as Direct
  [DM (Human)] as DM
}

package "Message Routing" {
  [OrgService.routeMessage()] as Router
}

package "Agent Interaction" {
  [Agent.handleMessageStream()] as Stream
  [Agent.handleMessage()] as Msg
}

package "Persistence" {
  database "chatSessions" as CS
  database "chatMessages" as CM
  database "channelMessages" as ChM
}

Smart --> Router : targetAgentId?\nchannelId?\ntext?
Channel --> ChM : channel 消息\n(#general, #dev, #support)
Direct --> Stream : 1:1 对话\n持久化 Session
DM --> ChM : 人对人消息

Router --> Stream : 路由到 Agent

note right of Router
  路由优先级：
  1. 显式指定 targetAgentId
  2. Channel 绑定的 Agent
  3. Org Manager Agent
  4. Org 中第一个 Agent
end note

Stream --> CS : 创建/恢复 Session
Stream --> CM : 保存消息
Stream ..> ChM : channel 模式

@enduml
```

**Chat UI 特点**：
- 支持流式响应（SSE），实时显示文本和工具调用状态
- 消息分段（segments）：文本段和工具调用段交错展示
- 活动指示器（ActivityIndicator）展示工具执行过程
- 支持 Markdown 渲染

---

### 3.6 Skill 系统

Skill 是 Agent 能力的模块化封装，每个 Skill 包含一组相关工具。

```plantuml
@startuml skill-system
!theme plain
skinparam backgroundColor #FEFEFE

interface SkillRegistry {
  +register(skill: SkillInstance): void
  +unregister(skillName: string): void
  +get(skillName: string): SkillInstance
  +list(): SkillManifest[]
  +getToolsForSkills(names: string[]): AgentToolHandler[]
}

class InMemorySkillRegistry {
  -skills: Map<string, SkillInstance>
}

class SkillManifest {
  +name: string
  +version: string
  +description: string
  +author: string
  +category: SkillCategory
  +tags?: string[]
  +tools: SkillToolDef[]
  +requiredEnv?: string[]
  +requiredPermissions?: Permission[]
}

class SkillInstance {
  +manifest: SkillManifest
  +tools: AgentToolHandler[]
}

SkillRegistry <|.. InMemorySkillRegistry
SkillInstance --> SkillManifest
SkillInstance --> "1..*" AgentToolHandler

note bottom of InMemorySkillRegistry
  内置技能：
  - git: Git 操作
  - code-analysis: 代码分析
  - browser: 网页浏览
  - gui / advanced-gui: GUI 自动化
  - feishu: 飞书集成（需配置环境变量）
end note

@enduml
```

**Agent-Skill 关联**：
- `AgentConfig.skills: string[]` 声明 Agent 拥有的技能
- `AgentManager.createAgent()` 调用 `SkillRegistry.getToolsForSkills(config.skills)` 获取工具
- Agent 内部维护 `skillProficiency` Map，跟踪每个工具的使用次数、成功率

---

### 3.7 Workflow 引擎

Workflow 引擎支持 DAG 形式的多 Agent 协作编排。

```plantuml
@startuml workflow-engine
!theme plain
skinparam backgroundColor #FEFEFE

class WorkflowEngine {
  -executions: Map<string, WorkflowExecution>
  -executor: WorkflowExecutor
  +start(def, inputs): WorkflowExecution
  +validate(def): string[]
  -executeGraph(execution, def): void
  -executeStep(step, execution): void
  -hasCycle(steps): boolean
}

interface WorkflowExecutor {
  +executeStep(agentId, desc, input): Record
  +findAgent(skills): string?
}

class WorkflowDefinition {
  +id: string
  +name: string
  +steps: StepDefinition[]
  +inputs?: Record
  +outputs?: Record
}

enum StepType {
  agent_task
  condition
  fan_out
  fan_in
  transform
  delay
  human_approval
}

class StepDefinition {
  +id: string
  +name: string
  +type: StepType
  +agentId?: string
  +requiredSkills?: string[]
  +dependsOn: string[]
  +condition?: ConditionDef
  +fanOut?: FanOutDef
  +fanIn?: FanInDef
  +taskConfig?: TaskConfig
  +maxRetries?: number
}

WorkflowEngine --> WorkflowExecutor
WorkflowEngine --> WorkflowDefinition
WorkflowDefinition --> "*" StepDefinition
StepDefinition --> StepType

note right of WorkflowEngine
  预定义组合模式：
  - createPipeline(): A → B → C
  - createFanOut(): 并行分发
  - createReviewChain(): 做→审→改
  - createParallelConsensus(): 多Agent投票
end note

note bottom of StepType
  human_approval 已定义
  但未实现审批 UI
end note

@enduml
```

---

### 3.8 LLM 路由层

```plantuml
@startuml llm-router
!theme plain
skinparam backgroundColor #FEFEFE

class LLMRouter {
  -providers: Map<string, LLMProviderInterface>
  -defaultProvider: string
  -autoSelect: boolean
  -providerTiers: ProviderTier[]
  -health: Map<string, ProviderHealth>
  --
  +chat(request): LLMResponse
  +chatStream(request): AsyncGenerator<LLMStreamEvent>
  +registerProvider(name, config): void
  -selectProvider(complexity): string
  -tryProviders(providers, request): LLMResponse
}

interface LLMProviderInterface {
  +chat(request): Promise<LLMResponse>
  +chatStream(request): AsyncGenerator<LLMStreamEvent>
}

class AnthropicProvider
class OpenAIProvider
class GoogleProvider
class OllamaProvider

LLMProviderInterface <|.. AnthropicProvider
LLMProviderInterface <|.. OpenAIProvider
LLMProviderInterface <|.. GoogleProvider
LLMProviderInterface <|.. OllamaProvider

LLMRouter --> "*" LLMProviderInterface

note right of LLMRouter
  智能路由策略：
  - 复杂度分级: simple / moderate / complex
  - Anthropic: 擅长 complex
  - OpenAI: complex + moderate
  - 其他兼容: simple + moderate
  - 健康检查 + 熔断（2 次失败降级，5 分钟恢复）
  - 自动 fallback
end note

@enduml
```

---

### 3.9 存储层

```plantuml
@startuml storage-schema
!theme plain
skinparam backgroundColor #FEFEFE

entity organizations {
  * id : text <<PK>>
  --
  name : text
  ownerId : text
  managerAgentId : text
  plan : text
  maxAgents : integer
}

entity teams {
  * id : text <<PK>>
  --
  orgId : text <<FK>>
  name : text
  description : text
  leadAgentId : text
  managerId : text
  managerType : text
}

entity agents {
  * id : text <<PK>>
  --
  orgId : text <<FK>>
  teamId : text <<FK>>
  name : text
  roleId : text
  status : text
  skills : text (JSON)
  llmConfig : text (JSON)
  channels : text (JSON)
}

entity tasks {
  * id : text <<PK>>
  --
  orgId : text <<FK>>
  title : text
  description : text
  status : text
  priority : text
  assignedAgentId : text <<FK>>
  parentTaskId : text <<FK>>
  result : text (JSON)
}

entity taskLogs {
  * id : text <<PK>>
  --
  taskId : text <<FK>>
  agentId : text <<FK>>
  seq : integer
  type : text
  content : text
  metadata : text (JSON)
}

entity chatSessions {
  * id : text <<PK>>
  --
  agentId : text <<FK>>
  userId : text
  title : text
}

entity chatMessages {
  * id : text <<PK>>
  --
  sessionId : text <<FK>>
  agentId : text
  role : text
  content : text
  metadata : text (JSON)
}

entity channelMessages {
  * id : text <<PK>>
  --
  orgId : text <<FK>>
  channel : text
  senderId : text
  senderType : text
  text : text
}

entity memories {
  * id : text <<PK>>
  --
  agentId : text <<FK>>
  type : text
  content : text
}

entity agentKnowledge {
  * id : text <<PK>>
  --
  agentId : text <<FK>>
  orgId : text
  category : text
  title : text
  content : text
  tags : text (JSON)
  importance : real
}

organizations ||--o{ teams
organizations ||--o{ agents
teams ||--o{ agents
agents ||--o{ tasks : assignedAgentId
tasks ||--o{ taskLogs
tasks ||--o{ tasks : parentTaskId
agents ||--o{ chatSessions
chatSessions ||--o{ chatMessages
agents ||--o{ memories
agents ||--o{ agentKnowledge

@enduml
```

---

## 4. 模块间关系全景图

```plantuml
@startuml module-relationships
!theme plain
skinparam backgroundColor #FEFEFE
skinparam packageStyle rectangle
left to right direction

package "@markus/shared" as Shared #FFF9C4 {
  [Types & Utils]
}

package "@markus/a2a" as A2A #FFCCBC {
  [A2ABus]
  [DelegationManager]
  [CollaborationManager]
}

package "@markus/core" as Core #C8E6C9 {
  [Agent]
  [AgentManager]
  [ContextEngine]
  [LLMRouter]
  [RoleLoader]
  [SkillRegistry]
  [ToolSelector]
  [WorkflowEngine]
  [SecurityGuard]
  [ExternalGateway]
  [EnhancedMemorySystem]
}

package "@markus/storage" as Storage #D1C4E9 {
  [Drizzle Schema]
  [Repositories]
}

package "@markus/org-manager" as OrgMgr #B3E5FC {
  [OrgService]
  [TaskService]
  [TeamService]
  [APIServer]
  [WSServer]
}

package "@markus/web-ui" as WebUI #F8BBD0 {
  [Dashboard]
  [Chat]
  [Agents Page]
  [Tasks Page]
  [Settings]
}

package "@markus/cli" as CLI #FFECB3 {
  [CLI Commands]
}

Shared <-- A2A
Shared <-- Core
Shared <-- Storage
Shared <-- OrgMgr

Core <-- OrgMgr
A2A <-- Core
Storage <-- OrgMgr

[APIServer] <-- WebUI : HTTP/WS
[APIServer] <-- CLI : HTTP

[AgentManager] --> [Agent] : create/manage
[Agent] --> [ContextEngine] : build prompts
[Agent] --> [LLMRouter] : LLM calls
[Agent] --> [ToolSelector] : select tools
[Agent] --> [SecurityGuard] : validate actions
[AgentManager] --> [RoleLoader] : load templates
[AgentManager] --> [SkillRegistry] : get skill tools
[AgentManager] --> [A2ABus] : agent messaging

[TaskService] --> [Agent] : executeTask()
[OrgService] --> [AgentManager] : route messages

[WorkflowEngine] --> [Agent] : orchestrate
[ExternalGateway] --> [AgentManager] : external agents

@enduml
```

---

## 5. 与业界框架对比分析

### 5.1 OpenClaw 架构借鉴

OpenClaw 是一个自托管的 AI 网关，将 AI Agent 连接到各种消息平台（WhatsApp, Telegram, Discord, Slack 等）。其核心设计思想对 Markus 有重要参考价值。

#### OpenClaw 核心架构

```plantuml
@startuml openclaw-architecture
!theme plain
skinparam backgroundColor #FEFEFE

package "Gateway Control Plane" as GCP #E3F2FD {
  [Session Manager]
  [Channel Router]
  [Access Control]
  [Health & Presence]
  [Cron Scheduler]
}

package "Channel Adapters" as CA #FFF3E0 {
  [WhatsApp]
  [Telegram]
  [Discord]
  [iMessage]
  [Slack]
  [Signal]
}

package "Agent Runtime" as AR #E8F5E9 {
  [Session Resolver]
  [Context Assembler]
  [LLM Invoker]
  [Tool Executor]
  [State Persistence]
}

package "Bootstrap Files" as BF #FCE4EC {
  file "USER.md" as User
  file "IDENTITY.md" as Identity
  file "SOUL.md" as Soul
  file "AGENTS.md" as Agents
  file "TOOLS.md" as Tools
  file "BOOTSTRAP.md" as Bootstrap
}

package "Tool Groups" as TG #F3E5F5 {
  [File System\n(read, write, edit, apply_patch)]
  [Runtime\n(exec, bash, process)]
  [Messaging\n(sessions_list/history/send/spawn)]
  [Web\n(web_search, web_fetch)]
  [Memory\n(memory_search, memory_get)]
  [Automation\n(cron, gateway)]
}

CA --> GCP
GCP --> AR
AR --> BF : inject context
AR --> TG : execute tools

@enduml
```

#### 关键借鉴点

| 维度 | OpenClaw 做法 | Markus 现状 | 借鉴建议 |
|---|---|---|---|
| **配置方式** | Bootstrap Files（Markdown 文件直接配置身份、规则、记忆） | ROLE.md + SKILLS.md 等，相似但更分散 | 统一为更直觉的配置方式，降低理解门槛 |
| **Session 工具** | `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn` | A2A 工具存在但未真正连通 | 实现可靠的 session-based A2A |
| **多 Agent 路由** | 基于 channel/sender 的精确路由配置 | 简单的 routeMessage 逻辑 | 支持声明式路由规则 |
| **工具策略** | 分层策略（global → per-agent → per-provider） | 单一 SecurityGuard | 实现分层安全策略 |
| **幂等性** | 工具执行使用幂等键，安全重试 | 简单重试，无幂等保证 | 为副作用工具添加幂等键 |
| **流式中断** | 队列模式（steer, followup, collect）支持中途干预 | 无中断机制 | 实现 steering 能力 |
| **工作区模型** | 一个 Agent 一个工作区（cwd） | 无明确工作区概念 | 给每个 Agent 分配独立工作区 |

### 5.2 CrewAI / AutoGen / LangGraph / OpenAI Agents SDK

```plantuml
@startuml framework-comparison
!theme plain
skinparam backgroundColor #FEFEFE

rectangle "CrewAI" as CrewAI #E3F2FD {
  card "Flows (流程)" as CFlow
  card "Crews (团队)" as CCrew
  card "Role-based Agents" as CAgent
  card "Tool Call Hooks" as CHook
  card "Human-in-the-Loop\n(task-level)" as CHITL
}

rectangle "AutoGen" as AutoGen #FFF3E0 {
  card "Core + Extensions" as ACore
  card "Conversable Agents" as AAgent
  card "Async Messaging" as AMsg
  card "save/load State" as AState
  card "OpenTelemetry" as AOTel
}

rectangle "LangGraph" as LangGraph #E8F5E9 {
  card "Graph Nodes + Edges" as LNode
  card "Typed State + Reducers" as LState
  card "Durable Execution\n(Checkpoints)" as LDurable
  card "interrupt() + Command" as LInterrupt
  card "LangSmith Tracing" as LTrace
}

rectangle "OpenAI Agents SDK" as OASDK #F3E5F5 {
  card "Agents + Handoffs" as OAgent
  card "Guardrails\n(Input/Output)" as OGuard
  card "Sessions" as OSession
  card "Tracing" as OTrace
  card "Realtime Voice" as OVoice
}

rectangle "Markus (当前)" as Markus #FFCDD2 {
  card "Agent + AgentManager" as MAgent
  card "Team + Task + Workflow" as MTeam
  card "SkillRegistry" as MSkill
  card "SecurityGuard (基础)" as MSec
  card "无持久化执行状态" as MNoState
  card "无可观测性" as MNoObs
  card "Human 升级仅日志" as MNoHITL
}

@enduml
```

#### 对比矩阵

| 能力维度 | CrewAI | AutoGen | LangGraph | OpenAI Agents SDK | **Markus (v0.7)** |
|---|---|---|---|---|---|
| **工具执行可靠性** | Tool Call Hooks (before/after) | OTel spans | 包装为确定性 task | Guardrails | ✅ ToolHookRegistry (before/after) + 幂等缓存 + 重试 |
| **状态持久化** | Pydantic state | save/load | 检查点 + 恢复 | Sessions | ✅ DB 持久化 (status, tokens, tasks, profile) |
| **错误恢复** | HITL 反馈重试 | Runtime 级处理 | 检查点恢复 | 企业级错误路径 | ✅ 重试 + HITL 审批 + 日 token 重置恢复 |
| **Human-in-the-Loop** | Task HITL, Flow 装饰器 | Human 作为 Agent 类型 | `interrupt()` + `Command` | 内建 HITL | ✅ 审批阻塞 + REST API + 超时自动拒绝 |
| **可观测性** | 基础日志 | OpenTelemetry | LangSmith | 内建 Tracing | ✅ Tracing (OTel 兼容) + Usage Dashboard |
| **Agent 定义** | Role + 目标 + 背景 | Conversable Agents | 图节点 | Instructions + Guardrails | ✅ ROLE.md + AgentProfile (工具白名单/预算) + Guardrails |
| **多 Agent 协作** | Crews + Flows | Multi-agent chat | 图组合 | Handoffs + agents-as-tools | ✅ A2A Bus + DelegationManager (真实任务委派) |
| **成本控制** | 基础 | 无内建 | 无内建 | 企业级 | ✅ 日 token 预算 + BillingService + Usage Dashboard |
| **生产就绪度** | 中高 | 高 | 高 | 高 | **中**（核心流程可靠，缺 RAG 和分布式） |

---

## 6. 问题诊断与解决进展

初始代码分析（v0.3.0）诊断出 6 个根因阻碍 Markus 从"玩具"变为"工具"。经过 4 轮迭代，绝大多数已解决。

### 6.1 已解决的核心问题

```plantuml
@startuml problem-status
!theme plain
skinparam backgroundColor #FEFEFE

rectangle "原始问题（v0.3.0）" as Problems #FFF3E0

rectangle "✅ 已解决" as Solved #C8E6C9 {
  card "根因 1：执行状态不持久化\n→ DB 持久化 (status, tokens, tasks, profile)" as S1
  card "根因 2：工具系统不成熟\n→ ToolHookRegistry + 幂等缓存 + 工作区隔离" as S2
  card "根因 3：A2A 协作未实现\n→ DelegationManager 真实任务委派" as S3
  card "根因 4：安全模型不完整\n→ HITL 审批阻塞 + AgentProfile 约束" as S4
  card "根因 5：缺乏可观测性\n→ Tracing + BillingService + Usage Dashboard" as S5
}

rectangle "⚠ 部分解决" as Partial #FFF9C4 {
  card "根因 6：上下文工程粗糙\n→ Memory Flush 改善了记忆保留\n⚠ 仍缺 RAG/向量检索" as P1
}

Problems --> Solved
Problems --> Partial

@enduml
```

| 根因 | 原始问题 | 当前状态 | 解决方案 |
|---|---|---|---|
| **1. 状态不持久化** | 进程重启丢失所有上下文 | ✅ 已解决 | Agent status/tokens/tasks/profile 持久化到 DB；启动时自动恢复 |
| **2. 工具系统不成熟** | 无隔离、无验证、无幂等 | ✅ 已解决 | 工作区路径隔离；ToolHookRegistry (before/after)；幂等缓存 (5min TTL) |
| **3. A2A 协作形同虚设** | DelegationManager 仅记日志 | ✅ 已解决 | 委派 → 自动创建 Task 并分配给目标 Agent；AgentCard 自动注册 |
| **4. 安全模型不完整** | needsApproval 不阻塞 | ✅ 已解决 | 审批阻塞 + Promise 等待 + REST API approve/reject + 超时自动拒绝 |
| **5. 缺乏可观测性** | 无 tracing、无成本统计 | ✅ 已解决 | OTel 兼容 Tracing；BillingService 接入执行流；Usage & Costs Dashboard |
| **6. 上下文工程粗糙** | Token 估算不准、无 RAG | ⚠ 部分 | Memory Flush 改善记忆保留；`agentKnowledge` 表存在但无向量检索 |

### 6.2 仍待解决的问题

#### P1：RAG / 向量语义检索

- `agentKnowledge` 表已定义但检索基于简单关键词匹配
- 长期记忆（`memory_search`）无法按语义相关性召回
- Token 估算仍使用 `Math.ceil(text.length / 2.5)`，对非英文内容不够准确
- **建议**：集成 pgvector 或外部向量 DB，为 `agentKnowledge` 和 `memories` 添加 embedding 列

#### P1：Workflow 持久化执行

- `WorkflowExecution` 完全内存化，进程重启后丢失
- 已定义 `human_approval` 步骤类型但无审批 UI
- **建议**：将 execution state 写入 DB，支持跨重启恢复

#### P2：文件操作事务性

- 文件写入失败可能留下半成品
- 无 rollback 机制
- **建议**：写入临时文件后原子 rename；或对关键操作添加 undo 日志

#### P2：分布式 Agent 运行时

- 所有 Agent 运行在单进程中，无法水平扩展
- **建议**：远期考虑基于消息队列的分布式执行

### 6.3 架构设计反思

#### "组织模拟"隐喻的演进

Markus 的"数字员工平台"隐喻在概念上吸引人，但实践中需要平衡**组织开销**与**使用便捷性**。当前采取的策略是保留组织模型但降低使用门槛：

- 启动即创建默认组织和 Agent，用户无需手动配置即可开始对话
- AgentProfile 约束了能力边界，避免角色仅停留在"提示词声称"层面
- 按需创建 Agent，而非要求预先规划完整组织结构

**对比参考**：
- OpenClaw：一个 Agent + 一个工作区，极简模式
- CrewAI：按任务组队，临时组合
- Markus：保留组织结构，但支持单 Agent 直接对话的"捷径"模式

---

## 7. 实施进展总览

### 7.1 迭代路线与完成状态

```plantuml
@startuml implementation-progress
!theme plain
skinparam backgroundColor #FEFEFE

rectangle "Phase 1: 基础可靠性 ✅" as P1 #C8E6C9 {
  card "✅ A2A 委派连通" as P1a
  card "✅ HITL 审批阻塞" as P1b
  card "✅ AgentProfile 结构化能力定义" as P1c
  card "✅ 执行状态持久化基础设施" as P1d
}

rectangle "Phase 2: 安全与可观测 ✅" as P2 #C8E6C9 {
  card "✅ Memory Flush 预压缩记忆" as P2a
  card "✅ Guardrails 输入/输出护栏" as P2b
  card "✅ 流式中断与 Steering" as P2c
  card "✅ OTel 兼容 Tracing" as P2d
}

rectangle "Phase 3: 工具与恢复 ✅" as P3 #C8E6C9 {
  card "✅ 工作区路径隔离" as P3a
  card "✅ Profile 持久化到 DB" as P3b
  card "✅ ToolHookRegistry + 幂等缓存" as P3c
  card "✅ Agent 状态完整恢复" as P3d
}

rectangle "Phase 4: 成本闭环 ✅" as P4 #C8E6C9 {
  card "✅ Token 持久化接线" as P4a
  card "✅ BillingService 接入执行流" as P4b
  card "✅ 每日 Token 重置调度器" as P4c
  card "✅ Usage & Costs Dashboard" as P4d
}

rectangle "Phase 5: 待实施" as P5 #FFE0B2 {
  card "⬜ RAG / 向量语义检索" as P5a
  card "⬜ Workflow 持久化执行" as P5b
  card "⬜ 审批 UI（Web UI）" as P5c
  card "⬜ 分布式 Agent 运行时" as P5d
}

P1 --> P2
P2 --> P3
P3 --> P4
P4 --> P5

@enduml
```

### 7.2 各 Phase 实施摘要

#### Phase 1 — 基础可靠性

| 改进项 | 解决的根因 | 关键实现 |
|---|---|---|
| A2A 委派连通 | 根因 3 (A2A 形同虚设) | `DelegationManager.onDelegationReceived()` → 自动创建 Task 并分配 |
| HITL 审批阻塞 | 根因 4 (安全模型不完整) | `ApprovalCallback` + `HITLService.requestApprovalAndWait()` + 超时拒绝 |
| AgentProfile | 根因 4 (无资源限制) | 工具白/黑名单、日 token 预算、并发限制、审批配置 |
| 状态持久化基础设施 | 根因 1 (状态内存化) | `stateChangeCallback` + DB 列 (active_task_ids, profile) |

**涉及文件**：`a2a/delegation.ts`, `core/agent.ts`, `core/agent-manager.ts`, `org-manager/hitl-service.ts`, `shared/types/agent.ts`, `storage/schema.ts`

#### Phase 2 — 安全与可观测

| 改进项 | 解决的根因 | 关键实现 |
|---|---|---|
| Memory Flush | 根因 6 (上下文粗糙) | 压缩前 ephemeral LLM 调用，持久化关键记忆 |
| Guardrails | 根因 4 (安全模型) | `GuardrailPipeline` 链式管线；内置 prompt injection/sensitive data 检测 |
| 流式中断 | 新需求 | `cancelToken` 三处检查点；`cancelActiveStream()` API |
| Tracing | 根因 5 (无可观测性) | `DefaultSpan` + `setTracingProvider()` 可替换为 OTel SDK |

**涉及文件**：`core/agent.ts`, `core/guardrails.ts` (新), `core/tracing.ts` (新), `core/llm/router.ts`

#### Phase 3 — 工具与恢复

| 改进项 | 解决的根因 | 关键实现 |
|---|---|---|
| 工作区隔离 | 根因 2 (工具不成熟) | Shell/File 工具 `workspacePath` 参数；路径越界检查 |
| Profile 持久化 | 根因 1 (状态不持久化) | DB `agents.profile` jsonb 列；`restoreAgent` 恢复 profile |
| ToolHookRegistry | 根因 2 (工具不成熟) | before/after 钩子；幂等缓存 (5min TTL)；审计日志钩子 |
| 状态恢复完善 | 根因 1 (状态不持久化) | `tokensUsedToday` + `activeTaskIds` 重启后恢复 |

**涉及文件**：`core/tools/shell.ts`, `core/tools/file.ts`, `core/tool-hooks.ts` (新), `core/agent-manager.ts`, `storage/schema.ts`

#### Phase 4 — 成本闭环

| 改进项 | 解决的根因 | 关键实现 |
|---|---|---|
| Token 持久化接线 | 根因 1 最后一公里 | `startServer()` 中 `setStateChangeHandler()` → DB 更新 |
| BillingService 接入 | 根因 5 (成本不可见) | 审计回调中 `billingService.recordUsage()`；`getAgentBreakdown()` |
| 每日 Token 重置 | 预算恢复 | `scheduleDailyReset()` 午夜触发；超限暂停后自动恢复 |
| Usage Dashboard | 根因 5 (无可视化) | `/api/usage/agents` 端点 + `Usage.tsx` 页面 + Sidebar 入口 |

**涉及文件**：`cli/index.ts`, `org-manager/api-server.ts`, `org-manager/billing-service.ts`, `web-ui/pages/Usage.tsx` (新)

---

## 8. 后续路线图

### 8.1 第一性原理分析

Agent 的有用性由两个因子决定：

```
Agent 有用性 = P(正确决策 | 上下文) × P(行动成功 | 决策)
```

- **P(行动成功 | 决策)**：工具可靠性。经过 4 轮迭代（重试、钩子、幂等、工作区隔离、HITL），**已达到可用水平**。
- **P(正确决策 | 上下文)**：LLM 看到什么。这完全取决于**上下文窗口的质量**——而这正是当前瓶颈。

**当前瓶颈诊断**：

| 问题 | 影响 | 严重度 |
|---|---|---|
| 记忆检索是纯子串匹配 (`content.includes(query)`) | Agent 无法语义召回历史上下文，"我们上周怎么处理的认证问题"找不到答案 | **致命** |
| Token 估算用固定 `length / 2.5` | 中文场景 ~2x 高估浪费上下文空间；代码场景不准确 | **高** |
| 无人验证端到端任务完成质量 | 基础设施完善但不知道 Agent 能否真正完成一个编码任务 | **高** |
| 新用户启动体验差 | 需要配置 LLM 密钥、理解组织模型才能开始 | **中** |

**砍掉的项目及理由**：

| 原计划项目 | 砍掉理由 |
|---|---|
| ~~审批请求 UI~~ | 后端审批机制已完整（API + WebSocket + 超时），没有证据表明审批请求频繁发生。为不存在的需求构建 UI |
| ~~Workflow 持久化~~ | 无人在生产中使用工作流。为没有用户的功能做持久化是过早优化 |
| ~~多租户与权限~~ | 单组织自部署场景，不存在多租户需求。Cloud 版本时再考虑 |
| ~~声明式路由规则~~ | 有大量 Agent 和复杂路由需求时才有价值。当前无此场景 |
| ~~插件/技能市场~~ | 产品策略文档显示 Phase 4 Marketplace 已完成（DB + API + UI），此处重复 |
| ~~分布式 Agent 运行时~~ | 单进程足够支撑数月的实际使用。过早优化 |
| ~~语音交互~~ | 与核心价值无关，无用户需求 |

### 8.2 修订后的路线图

```plantuml
@startuml revised-roadmap
!theme plain
skinparam backgroundColor #FEFEFE

rectangle "P0: Agent 核心能力" as P0 #FFCDD2 {
  card "记忆向量检索\n(pgvector + embedding)" as P0a
  card "Token 计量精准化\n(API 实际值 → tiktoken 回退)" as P0b
  card "运行环境感知\n(OS/工具/浏览器能力探测)" as P0c
}

rectangle "P1: 创作与体验" as P1 #BBDEFB {
  card "Builder 重新设计\n(引导式 + 实时预览 + 完整配置)" as P1a
  card "端到端任务验证\n(标准化场景 + 失败模式修复)" as P1b
  card "快速启动体验\n(markus init + 零配置)" as P1c
}

rectangle "P2: 生态与社区" as P2 #C8E6C9 {
  card "社区 GitHub 模式\n(公开/私有 + Fork + 版本)" as P2a
  card "上下文精细化\n(优先级裁剪 + 提示词优化)" as P2b
}

P0 --> P1
P1 --> P2

@enduml
```

### 8.3 各项目详解

---

#### P0.1 记忆向量语义检索

**问题**：`memory.search()` 是 `content.toLowerCase().includes(query.toLowerCase())`——纯子串匹配。Agent 搜索 "怎么处理 API 超时" 无法匹配到 "我们给 HTTP 请求加了 30 秒超时"。这是 Agent 长期能力的致命瓶颈。

**设计**：一步到位，直接引入 pgvector 向量语义检索。

**架构**：

```plantuml
@startuml memory-vector
!theme plain
skinparam backgroundColor #FEFEFE

actor Agent
database "PostgreSQL" as DB {
  collections "memories\n+ embedding vector(1536)" as Mem
  collections "agent_knowledge\n+ embedding vector(1536)" as Know
}
cloud "Embedding API" as Embed

Agent -> Agent : memory_save(content)
Agent -> Embed : embed(content)
Embed --> Agent : vector[1536]
Agent -> DB : INSERT (content, vector)

Agent -> Agent : memory_search(query)
Agent -> Embed : embed(query)
Embed --> Agent : query_vector
Agent -> DB : SELECT ... ORDER BY\nembedding <=> query_vector\nLIMIT topK
DB --> Agent : ranked results

@enduml
```

**数据库变更**：

```sql
-- 启用 pgvector 扩展
CREATE EXTENSION IF NOT EXISTS vector;

-- memories 表增加向量列
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding vector(1536);
CREATE INDEX idx_memories_embedding ON memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- agent_knowledge 表增加向量列
ALTER TABLE agent_knowledge ADD COLUMN IF NOT EXISTS embedding vector(1536);
CREATE INDEX idx_knowledge_embedding ON agent_knowledge USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

**Embedding 策略**：

| 维度 | 设计决策 | 理由 |
|------|----------|------|
| Provider | OpenAI `text-embedding-3-small` (1536 维) | 性价比最优，$0.02/1M tokens；同时支持通过 LLMRouter 抽象切换到其他 embedding 模型 |
| 写入时 | 同步生成 embedding 并存储 | 保证所有记忆都有向量，不存在"有内容无向量"的脏数据 |
| 查询时 | 将 query 转为向量，用余弦相似度 (`<=>`) 排序 | pgvector 原生支持，无需额外基础设施 |
| 降级 | 若 embedding API 不可用，回退到 PostgreSQL `pg_trgm` 三元组相似度 | 保证可用性，`pg_trgm` 无外部依赖 |
| 批量迁移 | 提供 `markus migrate-embeddings` CLI 命令，为历史记忆批量生成向量 | 平滑升级 |

**接口变更**：

```typescript
// IMemoryStore 接口扩展
interface IMemoryStore {
  // 现有方法保持不变...
  search(query: string): MemoryEntry[];  // 改为向量检索实现

  // 新增：带相似度分数的检索
  semanticSearch(query: string, opts?: {
    topK?: number;           // 默认 5
    minSimilarity?: number;  // 最低相似度阈值，默认 0.3
    filter?: { tier?: string; category?: string };
  }): Promise<Array<MemoryEntry & { similarity: number }>>;
}
```

**验收标准**：Agent 搜索 "怎么处理 API 超时" 能匹配到 "我们给 HTTP 请求加了 30 秒 timeout"；搜索 "数据库连接配置" 能匹配到 "PostgreSQL 连接池设为 20"。

---

#### P0.2 Token 计量精准化

**问题**：`context-engine.ts` 中 `Math.ceil(text.length / 2.5)` 用于 pre-flight 预算估算，偏差巨大：
- 英文文本：实际 ~4 chars/token，高估 ~60%（Agent 少看 38% 的上下文）
- 中文文本：实际 ~1.5 chars/token，低估 ~40%（可能溢出窗口，导致 API 报错或信息丢失）
- JSON/代码：变化极大，不可预测

**关键发现**：Anthropic 和 OpenAI 的 API 响应已经返回了精确的 token 用量（`usage.input_tokens`, `usage.output_tokens`）——我们的 `LLMRouter` 已经在记录这些数据。问题出在**请求前的预算估算**，而非请求后的计量。

**三层精准化策略**：

```
┌─────────────────────────────────────────────────────┐
│ 第 1 层：API 实际值（最准，事后获取）               │
│ → Anthropic/OpenAI 响应中的 usage 字段             │
│ → 用于计费、日 token 预算、成本仪表盘              │
│ → 已实现 ✅                                        │
├─────────────────────────────────────────────────────┤
│ 第 2 层：Anthropic Token Counting API（准确，预飞）  │
│ → POST /v1/messages/count_tokens                   │
│ → 请求前精确计算 token 数，指导上下文装配            │
│ → 仅 Anthropic 支持，其他 Provider 走第 3 层        │
├─────────────────────────────────────────────────────┤
│ 第 3 层：本地 tiktoken 计算（近似，通用回退）        │
│ → 使用 js-tiktoken (纯 JS，短文本 31K ops/sec)     │
│ → 或 @dqbd/tiktoken (WASM，长文本 2.4x 更快)      │
│ → 作为 OpenAI/Ollama/其他 Provider 的回退          │
└─────────────────────────────────────────────────────┘
```

**实现设计**：

```typescript
// token-counter.ts — 新模块
export interface TokenCounter {
  /** 精确计算 token 数（可能异步调 API） */
  countTokens(text: string, model?: string): Promise<number>;
  /** 快速本地估算（同步，用于粗略预算） */
  estimateTokens(text: string): number;
}

class SmartTokenCounter implements TokenCounter {
  private tiktoken: TiktokenEncoder | null = null;  // 延迟加载

  async countTokens(text: string, model?: string): Promise<number> {
    // 优先使用 Anthropic Token Counting API
    if (this.anthropicApiKey && model?.startsWith('claude')) {
      return this.anthropicCountTokens(text, model);
    }
    // 回退到本地 tiktoken
    return this.localCount(text);
  }

  estimateTokens(text: string): number {
    // 若 tiktoken 已加载，直接用
    if (this.tiktoken) return this.tiktoken.encode(text).length;
    // 否则用改进的启发式：按 CJK 比例动态调整
    const cjkRatio = countCJKChars(text) / text.length;
    const charsPerToken = 4 - (cjkRatio * 2.5);  // 纯英文 ~4, 纯中文 ~1.5
    return Math.ceil(text.length / charsPerToken);
  }
}
```

**LLM Provider 返回的实际 token 数反馈循环**：每次 LLM 请求完成后，将 API 返回的实际 token 数与预估值对比，动态校准 `estimateTokens` 的系数。这让估算越用越准。

**验收标准**：中英文混合文本的 pre-flight 估算误差 < 15%；Anthropic 模型使用精确 API 计数。

---

#### P0.3 Agent 运行环境感知

**问题**：当前 Agent 不知道自己运行在什么环境中——不知道操作系统、不知道有没有安装 Git/Docker/浏览器、不知道 Node.js 版本。这导致 Agent 可能尝试执行不存在的命令，或用错误的路径格式，浪费交互轮次和 token。

**业界参考**：
- **Cursor/Claude Code**：启动时检测 OS、shell、工作区路径，注入系统提示
- **Devin**：创建完整的开发环境画像，包括语言运行时、包管理器、已安装工具
- **OpenAI Agents SDK**：通过 `context` 对象传递运行时环境信息

**设计**：引入 `EnvironmentProfile`，在 Agent 启动时自动探测，注入系统提示。

```typescript
// environment-profile.ts — 新模块
export interface EnvironmentProfile {
  // 系统基础
  os: { platform: string; arch: string; release: string };  // e.g. darwin, arm64, 24.6.0
  shell: string;            // e.g. /bin/zsh
  homedir: string;
  workdir: string;

  // 开发工具
  tools: {
    name: string;           // e.g. 'git', 'docker', 'node', 'python'
    version: string;        // e.g. '2.43.0'
    path: string;           // e.g. '/usr/bin/git'
  }[];

  // 浏览器
  browsers: {
    name: string;           // e.g. 'chrome', 'firefox'
    path: string;
  }[];

  // 语言运行时
  runtimes: {
    name: string;           // e.g. 'node', 'python', 'java'
    version: string;
  }[];

  // 包管理器
  packageManagers: string[];  // e.g. ['npm', 'pnpm', 'pip', 'brew']

  // 资源约束
  resources: {
    cpuCores: number;
    memoryMB: number;
    diskFreeMB: number;
  };
}

// 自动探测实现
async function detectEnvironment(): Promise<EnvironmentProfile> {
  const checks = [
    { name: 'git', cmd: 'git --version' },
    { name: 'node', cmd: 'node --version' },
    { name: 'python', cmd: 'python3 --version' },
    { name: 'docker', cmd: 'docker --version' },
    { name: 'pnpm', cmd: 'pnpm --version' },
    { name: 'brew', cmd: 'brew --version' },
    // ... 更多工具
  ];
  // 并行执行所有检测，which/where 定位路径
  // 解析版本号，聚合为 EnvironmentProfile
}
```

**与系统提示集成**：`ContextEngine.buildSystemPrompt()` 新增环境段落：

```
## Your Environment
- OS: macOS 14.5 (arm64)
- Shell: /bin/zsh
- Working Directory: /Users/dev/project
- Available Tools: git 2.43.0, node 22.1.0, pnpm 9.1.0, docker 27.0.3, python 3.12
- Browsers: Chrome (/Applications/Google Chrome.app)
- Resources: 10 CPU cores, 16384 MB RAM, 52 GB free disk
- NOTE: Java is NOT available. Do not attempt Java/Maven/Gradle commands.
```

**影响**：Agent 不再"盲目操作"。知道有 Docker 才会建议容器化方案；知道没有 Python 就不会尝试 `pip install`；知道是 macOS arm64 就不会下载 x86 二进制。每次交互减少 1-2 次无效工具调用。

---

#### P1.1 Builder 重新设计

**当前问题诊断**：

| 问题 | 现状 | 影响 |
|------|------|------|
| 无引导流程 | 直接展示空表单，用户不知从何开始 | 新用户放弃率高 |
| 缺乏实时预览 | 填完表单才能看到效果，无法验证 | 试错成本高 |
| 模板配置不完整 | 缺少 LLM 配置（模型选择、温度）、工具白名单、token 预算 | 创建的 Agent 不符合预期 |
| 无环境需求声明 | 不能指定 Agent 需要 Docker/浏览器等环境 | 部署后才发现缺工具 |
| Workflow 编辑体验差 | 纯表单，无可视化 DAG，步骤关系难以理解 | 复杂工作流无法创建 |
| 无模板/工作流版本 | 无法回滚到之前的版本 | 改坏后无法恢复 |
| 无导入/导出 | 不能 JSON 导入/导出模板 | 无法分享或备份 |

**重新设计方案**：

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent Builder v2                          │
├─────────────────┬───────────────────────────────────────────┤
│                 │                                           │
│  创建向导        │   实时预览面板                             │
│  (左侧)         │   (右侧)                                  │
│                 │                                           │
│  Step 1: 角色    │   ┌─────────────────────────────────┐     │
│  - 选择预设模板  │   │  系统提示词预览                   │     │
│  - 或从零开始    │   │  (根据左侧配置实时生成)          │     │
│                 │   └─────────────────────────────────┘     │
│  Step 2: 能力    │   ┌─────────────────────────────────┐     │
│  - 工具白名单    │   │  能力雷达图                       │     │
│  - 技能选择      │   │  编码 ★★★★☆                      │     │
│  - 环境需求      │   │  协作 ★★★☆☆                      │     │
│                 │   │  分析 ★★☆☆☆                      │     │
│  Step 3: 约束    │   └─────────────────────────────────┘     │
│  - LLM 模型     │   ┌─────────────────────────────────┐     │
│  - Token 预算   │   │  预估月成本: ~$12.50             │     │
│  - 审批策略      │   │  建议预算: 50K tokens/day        │     │
│                 │   └─────────────────────────────────┘     │
│  Step 4: 部署    │                                           │
│  - 入职任务      │   [Test Agent]  [Deploy]  [Export JSON]   │
│  - 团队归属      │                                           │
│                 │                                           │
└─────────────────┴───────────────────────────────────────────┘
```

**核心改进**：

1. **引导式创建流程（Wizard）**：4 个步骤，每步聚焦一个维度，带进度指示
2. **实时系统提示预览**：右侧面板实时展示根据当前配置生成的完整系统提示词
3. **完整的 Agent 配置面板**：
   - LLM 配置：模型选择（按 Provider 分组）、temperature、max tokens
   - 工具白名单：可视化勾选，分类展示（文件/Shell/Git/Web/MCP/A2A）
   - Token 预算：日限额设置 + 预估月成本计算
   - 环境需求声明：勾选所需工具（Git/Docker/Browser/Python 等），部署时自动校验
4. **模板导入/导出**：JSON 格式，支持一键导入他人分享的模板
5. **Workflow 可视化编辑器**：
   - 节点拖拽 + 连线，直观表达 DAG 依赖
   - 步骤类型可视化区分（颜色/图标）
   - 执行路径模拟（高亮预期执行顺序）
6. **"Test Agent" 按钮**：创建前先用一个简单测试任务验证 Agent 能否正常工作

---

#### P1.2 端到端任务完成度验证

**问题**：基础设施完善但从未验证：**一个 Agent 能否独立完成一个真实的编码任务？**

**标准化验证场景**：

| 场景 | 输入 | 期望输出 | 考察能力 |
|------|------|----------|----------|
| 创建 REST endpoint | "在 api-server.ts 中添加 GET /api/health 端点" | 可工作的代码 + 测试 | 代码生成、文件操作、工具使用 |
| 修复 Bug | "Usage 页面进度条颜色不显示" + 相关代码 | 正确的修复 + 原因分析 | 代码理解、调试推理 |
| 写测试 | "为 billing-service.ts 写单元测试" | 覆盖核心逻辑的 Vitest 测试 | 代码理解、测试设计 |
| 代码重构 | "将 agent.ts 中的记忆相关方法提取为独立模块" | 功能不变、结构更清晰 | 大文件理解、重构能力 |
| 文档编写 | "为 Workflow Engine 写 API 文档" | 准确反映接口的 Markdown 文档 | 代码理解、技术写作 |

**执行方法**：
1. 为每个场景创建标准化 Task，通过 API 分配给 developer 角色 Agent
2. 记录完整执行轨迹（工具调用序列、token 消耗、时间、成功/失败）
3. 人工评估输出质量（正确性、完整性、代码风格）
4. 分析失败模式并分类（上下文不足 / 工具缺失 / LLM 能力限制 / 指令不清）

**验收标准**：5 个场景中 ≥ 3 个 Agent 可独立完成或仅需 1 次人工修正。

---

#### P1.3 快速启动体验

**问题**：新用户从 `git clone` 到"有一个能干活的 Agent"需要：配置数据库、设置 LLM API key、理解组织模型、创建 Agent。步骤多、概念重。

**方案**：

1. **`markus init` CLI 命令**：
   ```
   $ markus init
   Welcome to Markus! Let's set up your AI team.

   ? LLM Provider: (Anthropic / OpenAI / Ollama-local)
   ? API Key: sk-ant-...
   ? Database: (Auto-create PostgreSQL / Use existing / SQLite for quick start)

   ✓ Database ready
   ✓ Default organization "My Team" created
   ✓ Manager agent "Alice" deployed (role: project-manager)
   ✓ Developer agent "Bob" deployed (role: developer)

   Open http://localhost:3000 to start chatting with your team!
   ```

2. **零配置模式**：检测到无 DB 时自动使用 SQLite（通过 `better-sqlite3` + Drizzle 适配）；检测到无 LLM key 时提示并写入 `.env`
3. **首次引导 UI**：Web UI 检测到无 Agent 时，显示引导而非空白 Dashboard

**验收标准**：新用户 5 分钟内从 clone 到与 Agent 对话。

---

#### P2.1 社区生态 GitHub 模式

**问题**：当前 Marketplace 是扁平列表（`draft → pending_review → published`），缺少：
- 公开/私有区分
- Fork（基于别人的模板修改创建自己的版本）
- 版本历史
- 上游同步

**参考 GitHub 的核心模式**：

```
┌──────────────────────────────────────────────────────┐
│              Markus Community Hub                     │
├──────────────────────────────────────────────────────┤
│                                                      │
│  [Explore]  [My Templates]  [My Skills]              │
│                                                      │
│  ┌────────────────────────────────────────────┐      │
│  │  📦 senior-backend-dev          ★★★★☆ (23) │      │
│  │  by @alice  |  v2.1.0  |  Fork: 15        │      │
│  │  visibility: 🌐 public                    │      │
│  │                                            │      │
│  │  [Use Template]  [Fork]  [View Source]     │      │
│  └────────────────────────────────────────────┘      │
│                                                      │
│  ┌────────────────────────────────────────────┐      │
│  │  📦 my-custom-reviewer          (forked)   │      │
│  │  by @me  |  forked from @alice/reviewer    │      │
│  │  visibility: 🔒 private                   │      │
│  │  ↑ upstream has 2 new commits              │      │
│  │                                            │      │
│  │  [Edit]  [Sync Upstream]  [Make Public]    │      │
│  └────────────────────────────────────────────┘      │
│                                                      │
└──────────────────────────────────────────────────────┘
```

**数据库模型扩展**：

```sql
-- marketplace_templates 新增字段
ALTER TABLE marketplace_templates ADD COLUMN IF NOT EXISTS
  visibility varchar(16) NOT NULL DEFAULT 'public';   -- 'public' | 'private' | 'unlisted'
ALTER TABLE marketplace_templates ADD COLUMN IF NOT EXISTS
  forked_from varchar(64) REFERENCES marketplace_templates(id);
ALTER TABLE marketplace_templates ADD COLUMN IF NOT EXISTS
  fork_count integer DEFAULT 0;
ALTER TABLE marketplace_templates ADD COLUMN IF NOT EXISTS
  version_history jsonb DEFAULT '[]';  -- [{version, changelog, createdAt}]
ALTER TABLE marketplace_templates ADD COLUMN IF NOT EXISTS
  org_id varchar(64);  -- 归属组织

-- 同样应用于 marketplace_skills
```

**核心操作**：

| 操作 | 说明 |
|------|------|
| **Publish** | 将私有模板公开到社区 |
| **Fork** | 基于公开模板创建自己的副本，记录 `forked_from` |
| **Sync upstream** | 将上游模板的更新合并到 Fork 版本 |
| **Version** | 每次修改自动创建版本快照，支持回滚 |
| **Transfer** | 将模板所有权转移给另一个用户/组织 |

---

#### P2.2 上下文精细化

**上下文窗口优先级管理**：

系统提示已经很长（角色 + 身份 + 组织 + 策略 + 记忆 + 任务板 + 指令）。需要为各段落标注优先级权重，在 token budget 紧张时按优先级裁剪：

| 优先级 | 上下文段落 | 裁剪策略 |
|--------|-----------|----------|
| P0（不可裁剪） | 角色系统提示、当前任务描述 | 始终保留完整 |
| P1（优先保留） | 最近 3 轮对话、sender 身份、环境信息 | 超长时截断旧轮次 |
| P2（可压缩） | 任务板、同事列表 | 仅保留活跃任务，同事列表折叠为摘要 |
| P3（可裁剪） | 长期记忆、活动日志 | token 紧张时截断到最相关的 top-3 |
| P4（可丢弃） | 管理规则重复段落、通用指令 | 预算不足时完全省略 |

**Agent 角色提示词优化**：

16 个内置 ROLE.md 是理论设计，未经实际使用验证。基于 P1.2 的实测反馈：
- 改进最常用角色（developer, reviewer, project-manager）的系统提示
- 加入具体的工作流程指令（而非泛泛的角色描述）
- 减少 MANDATORY RULE 类指令的冗余（当前系统提示中有 4 段重复的 task management 规则，合并为 1 段）

---

## 9. 附录

### 9.1 PlantUML 渲染

以上所有 PlantUML 图表的源码已内嵌在对应章节中。渲染方式：

1. **VS Code 插件**：PlantUML extension（推荐）
2. **在线渲染**：https://www.plantuml.com/plantuml/uml/
3. **命令行**：`java -jar plantuml.jar docs/architecture-analysis.md`

### 9.2 关键文件索引

| 文件 | 职责 |
|---|---|
| `packages/core/src/agent.ts` | Agent 核心运行时（~1700 行） |
| `packages/core/src/agent-manager.ts` | Agent 生命周期管理 |
| `packages/core/src/context-engine.ts` | 上下文组装引擎 |
| `packages/core/src/tool-selector.ts` | 工具动态选择 |
| `packages/core/src/security.ts` | 安全策略执行 |
| `packages/core/src/guardrails.ts` | 输入/输出 Guardrail 管线 |
| `packages/core/src/tracing.ts` | OTel 兼容 Tracing |
| `packages/core/src/tool-hooks.ts` | 工具执行钩子 + 幂等缓存 |
| `packages/core/src/llm/router.ts` | LLM 多 Provider 路由 |
| `packages/core/src/workflow/engine.ts` | DAG 工作流引擎 |
| `packages/core/src/skills/registry.ts` | 技能注册中心 |
| `packages/core/src/role-loader.ts` | 角色模板加载器 |
| `packages/core/src/external-gateway.ts` | 外部 Agent 网关 |
| `packages/a2a/src/bus.ts` | Agent 间消息总线 |
| `packages/a2a/src/delegation.ts` | 任务委派管理 |
| `packages/org-manager/src/task-service.ts` | 任务生命周期管理 |
| `packages/org-manager/src/org-service.ts` | 组织服务与消息路由 |
| `packages/org-manager/src/api-server.ts` | REST/WS API |
| `packages/org-manager/src/hitl-service.ts` | 人类审批服务 |
| `packages/org-manager/src/billing-service.ts` | 计费与用量统计 |
| `packages/storage/src/schema.ts` | 数据库 Schema |
| `packages/storage/src/migrate.ts` | 迁移与启动安全网 |
| `packages/web-ui/src/pages/Chat.tsx` | 聊天界面 |
| `packages/web-ui/src/pages/Dashboard.tsx` | 运营仪表盘 |
| `packages/web-ui/src/pages/Usage.tsx` | Usage & Costs 仪表盘 |
| `packages/cli/src/index.ts` | 服务启动入口与接线 |
| `templates/roles/*/ROLE.md` | 16 个内置角色模板 |
| `templates/teams/*.json` | 4 个团队模板 |

---

> **总结**：Markus v0.7.0 已完成基础设施层面从"玩具"到"工具"的转变——状态持久化、工具可靠性、A2A 连通、HITL 审批、可观测性均已就位。下一阶段分三个层次推进：**P0 Agent 核心能力**（记忆向量检索一步到位 pgvector、Token 计量三层精准化策略、运行环境自动探测），**P1 创作与体验**（Builder 引导式重新设计 + 端到端实战验证 + 快速启动），**P2 生态与社区**（GitHub 模式的公开/私有/Fork 社区体系 + 上下文精细化）。核心原则：只做能让 Agent 更有用的事，拒绝"看起来重要但没人用"的功能。
