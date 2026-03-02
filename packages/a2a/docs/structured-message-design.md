# 结构化A2A消息格式扩展设计

## 概述
基于现有A2A协议，扩展结构化消息格式以支持更丰富的Agent间协作场景。

## 现有协议回顾

### 当前消息类型
1. **任务相关**：
   - `task_delegate` - 任务委派
   - `task_update` - 任务更新
   - `task_complete` - 任务完成
   - `task_failed` - 任务失败

2. **信息交换**：
   - `info_request` - 信息请求
   - `info_response` - 信息响应

3. **协作相关**：
   - `collaboration_invite` - 协作邀请
   - `collaboration_accept` - 协作接受
   - `collaboration_decline` - 协作拒绝

4. **心跳**：
   - `heartbeat_ping` - 心跳ping
   - `heartbeat_pong` - 心跳pong

## 新增消息类型设计

### 1. 资源请求消息 (`resource_request`)
用于Agent向其他Agent请求资源（如计算资源、数据、工具访问权限等）。

**Payload接口**：
```typescript
export interface ResourceRequest {
  requestId: string;
  resourceType: 'compute' | 'storage' | 'tool' | 'data' | 'network' | 'other';
  resourceName: string;
  description: string;
  requirements?: {
    cpu?: number;  // CPU核心数
    memory?: number; // 内存大小（MB）
    timeout?: number; // 超时时间（毫秒）
    [key: string]: unknown;
  };
  urgency?: 'low' | 'normal' | 'high' | 'critical';
  deadline?: string; // ISO时间戳
}
```

### 2. 资源响应消息 (`resource_response`)
用于响应资源请求。

**Payload接口**：
```typescript
export interface ResourceResponse {
  requestId: string;
  granted: boolean;
  reason?: string;
  resourceInfo?: {
    endpoint?: string;
    credentials?: Record<string, string>;
    quota?: Record<string, number>;
    expiresAt?: string; // ISO时间戳
  };
  alternatives?: Array<{
    agentId: string;
    capability: string;
    contactInfo?: string;
  }>;
}
```

### 3. 进度同步消息 (`progress_sync`)
用于Agent间同步任务进度，支持复杂任务的协作。

**Payload接口**：
```typescript
export interface ProgressSync {
  taskId: string;
  phase: string;
  progress: number; // 0-100
  status: 'pending' | 'in_progress' | 'blocked' | 'completed' | 'failed';
  message?: string;
  artifacts?: Array<{
    name: string;
    type: string;
    url?: string;
    content?: string;
    size?: number;
  }>;
  dependencies?: Array<{
    taskId: string;
    status: string;
    required: boolean;
  }>;
  estimatedCompletion?: string; // ISO时间戳
}
```

### 4. 能力发现消息 (`capability_discovery`)
用于Agent发现其他Agent的能力和技能。

**Payload接口**：
```typescript
export interface CapabilityDiscovery {
  discoveryId: string;
  query?: {
    skills?: string[];
    capabilities?: string[];
    status?: string[];
    minAvailability?: number; // 0-100
  };
  response?: {
    agentId: string;
    name: string;
    role: string;
    skills: string[];
    capabilities: string[];
    currentLoad: number; // 0-100
    availability: 'idle' | 'working' | 'busy' | 'offline';
    endpoint?: string;
  };
}
```

### 5. 状态广播消息 (`status_broadcast`)
用于Agent向组织广播状态变化。

**Payload接口**：
```typescript
export interface StatusBroadcast {
  agentId: string;
  status: 'idle' | 'working' | 'busy' | 'blocked' | 'offline';
  currentTask?: {
    taskId: string;
    title: string;
    progress: number;
  };
  load: number; // 0-100
  capabilities: string[];
  availableForWork: boolean;
  nextAvailable?: string; // ISO时间戳
  health?: {
    cpu: number;
    memory: number;
    uptime: number;
    errors: number;
  };
}
```

## 消息信封扩展

现有`A2AEnvelope`接口保持不变，但`A2AMessageType`需要扩展：

```typescript
export type A2AMessageType =
  // 现有消息类型
  | 'task_delegate'
  | 'task_update'
  | 'task_complete'
  | 'task_failed'
  | 'info_request'
  | 'info_response'
  | 'collaboration_invite'
  | 'collaboration_accept'
  | 'collaboration_decline'
  | 'heartbeat_ping'
  | 'heartbeat_pong'
  // 新增消息类型
  | 'resource_request'
  | 'resource_response'
  | 'progress_sync'
  | 'capability_discovery'
  | 'status_broadcast';
```

## 向后兼容性考虑

1. **协议版本**：在信封中添加`version`字段（可选，默认为"1.0"）
2. **扩展字段**：所有新接口都使用可选字段，避免破坏现有实现
3. **默认处理**：对于未知消息类型，Agent应记录警告并忽略，而不是抛出错误

## 实施计划

1. **第一阶段**：更新协议定义（protocol.ts）
2. **第二阶段**：实现消息处理器（handlers）
3. **第三阶段**：更新A2A工具以支持结构化消息
4. **第四阶段**：集成测试和文档更新