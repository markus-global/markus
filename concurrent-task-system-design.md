# 并发任务队列系统设计

## 问题分析

### 当前问题
1. **状态冲突**：Agent同一时间只能做一件事，busy状态可能冲突
2. **任务中断**：回复用户和任务执行可能同时发生，但回复完成后可能中断任务
3. **缺乏队列**：没有任务排队机制，超过并发限制直接失败
4. **状态显示不准确**：busy状态显示不准确，没有实时进度

### 现有机制
- `activeTasks: Set<string>` 跟踪并发任务ID
- `MAX_CONCURRENT_TASKS = 5` 并发限制
- 状态：`idle` | `working` | `error` | `offline`
- 没有优先级、没有队列、没有任务隔离

## 设计方案

### 1. 任务队列系统

#### TaskQueue 类
```typescript
interface TaskQueueOptions {
  maxConcurrent: number;
  defaultPriority: TaskPriority;
}

interface QueuedTask {
  id: string;
  type: 'chat' | 'task' | 'heartbeat';
  priority: TaskPriority;
  execute: () => Promise<void>;
  onStart?: () => void;
  onComplete?: (result: any) => void;
  onError?: (error: Error) => void;
  cancelToken?: { cancelled: boolean };
}

enum TaskPriority {
  HIGH = 0,    // 用户交互、紧急任务
  MEDIUM = 1,  // 普通任务
  LOW = 2,     // 后台任务、心跳
}
```

#### 核心功能
1. **优先级队列**：高优先级任务优先执行
2. **并发控制**：限制同时执行的任务数
3. **任务隔离**：不同类型任务互不干扰
4. **状态管理**：精确的任务状态跟踪

### 2. 状态管理机制

#### AgentState 扩展
```typescript
interface AgentState {
  agentId: string;
  status: 'idle' | 'working' | 'error' | 'offline';
  activeTaskCount: number;
  activeTaskIds: string[];
  tokensUsedToday: number;
  
  // 新增字段
  queueStats: {
    pending: number;
    running: number;
    completed: number;
    failed: number;
  };
  currentTasks: Array<{
    id: string;
    type: 'chat' | 'task' | 'heartbeat';
    priority: TaskPriority;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    progress?: number; // 0-100
    startedAt?: string;
    completedAt?: string;
  }>;
}
```

### 3. 任务隔离机制

#### 会话隔离
- **聊天会话**：用户交互，使用独立会话
- **任务会话**：任务执行，使用独立会话
- **心跳会话**：后台任务，使用独立会话

#### 资源隔离
- 内存会话分离
- 工具调用上下文分离
- 状态更新互不干扰

### 4. 实时状态显示

#### 进度数据结构
```typescript
interface TaskProgress {
  taskId: string;
  type: 'chat' | 'task' | 'heartbeat';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number; // 0-100
  currentStep?: string;
  steps: Array<{
    name: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    startedAt?: string;
    completedAt?: string;
  }>;
  startedAt: string;
  estimatedCompletion?: string;
}
```

#### UI组件设计
1. **Busy状态弹出面板**：点击busy图标显示
2. **实时进度条**：类似segments的展示效果
3. **任务列表**：显示所有运行中和排队的任务
4. **详细视图**：点击任务查看详细进度

## 实现步骤

### 阶段1：核心队列系统
1. 实现TaskQueue类
2. 集成到Agent类
3. 添加优先级支持

### 阶段2：状态管理改进
1. 扩展AgentState
2. 实现实时状态更新
3. 添加事件总线集成

### 阶段3：UI集成
1. 实现进度数据结构
2. 创建状态显示组件
3. 集成到Chat Tab

### 阶段4：优化和测试
1. 性能优化
2. 并发测试
3. 错误处理改进

## 预期效果

1. **解决并发冲突**：支持多任务并发执行
2. **避免任务中断**：任务隔离确保互不干扰
3. **改进状态显示**：实时进度可视化
4. **提升用户体验**：清晰的进度反馈