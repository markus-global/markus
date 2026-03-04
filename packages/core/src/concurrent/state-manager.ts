/**
 * Agent状态管理器
 * 负责同步TaskExecutor和Agent的状态
 */

import { TaskExecutor, TaskProgressEvent } from './task-executor.js';
import { TaskStatus, TaskType, TaskPriority } from './task-queue.js';

export interface AgentState {
  agentId: string;
  status: 'idle' | 'working' | 'paused' | 'offline' | 'error';
  activeTaskCount: number;
  activeTaskIds: string[];
  currentTaskId?: string;
  lastHeartbeat?: string;
  containerId?: string;
  tokensUsedToday: number;
}

export interface TaskInfo {
  id: string;
  type: TaskType;
  priority: TaskPriority;
  status: TaskStatus;
  progress: number;
  currentStep?: string;
  startedAt?: Date;
  completedAt?: Date;
  error?: Error;
  result?: any;
}

export class AgentStateManager {
  private state: AgentState;
  private taskExecutor: TaskExecutor;
  private statusListeners: ((state: AgentState) => void)[] = [];

  constructor(agentId: string, taskExecutor: TaskExecutor) {
    this.state = {
      agentId,
      status: 'idle',
      activeTaskCount: 0,
      activeTaskIds: [],
      tokensUsedToday: 0,
    };

    this.taskExecutor = taskExecutor;

    // 监听任务进度事件
    this.taskExecutor.addProgressListener((event: TaskProgressEvent) => {
      this.handleTaskProgress(event);
    });
  }

  /**
   * 处理任务进度事件
   */
  private handleTaskProgress(event: TaskProgressEvent): void {
    const tasks = this.taskExecutor.getAllTasks();
    const runningTasks = tasks.filter((task: any) => task.status === TaskStatus.RUNNING);
    
    // 更新任务状态（不更新Agent状态）
    this.state.activeTaskCount = runningTasks.length;
    this.state.activeTaskIds = runningTasks.map((task: any) => task.id);

    // 如果有当前任务，更新currentTaskId
    if (runningTasks.length > 0) {
      // 优先显示高优先级任务
      const highPriorityTask = runningTasks.find((task: any) => task.priority === TaskPriority.HIGH);
      this.state.currentTaskId = highPriorityTask?.id || runningTasks[0].id;
    } else {
      this.state.currentTaskId = undefined;
    }

    // 通知监听器
    this.notifyStateChange();
  }

  /**
   * 获取当前状态
   */
  getState(): AgentState {
    return { ...this.state };
  }

  /**
   * 更新状态
   */
  updateState(updates: Partial<AgentState>): void {
    this.state = { ...this.state, ...updates };
    this.notifyStateChange();
  }

  /**
   * 更新令牌使用量
   */
  updateTokensUsed(tokens: number): void {
    this.state.tokensUsedToday += tokens;
  }

  /**
   * 获取令牌使用量
   */
  getTokensUsed(): number {
    return this.state.tokensUsedToday;
  }

  /**
   * Reset daily token counter to zero
   */
  resetTokensUsed(): void {
    this.state.tokensUsedToday = 0;
  }

  /**
   * 获取任务信息
   */
  getTaskInfo(taskId: string): TaskInfo | undefined {
    const task = this.taskExecutor.getTaskStatus(taskId);
    if (!task) return undefined;

    return {
      id: task.id,
      type: task.type,
      priority: task.priority,
      status: task.status,
      progress: task.progress,
      currentStep: task.currentStep,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      error: task.error,
      result: task.result,
    };
  }

  /**
   * 获取所有任务信息
   */
  getAllTaskInfo(): TaskInfo[] {
    const tasks = this.taskExecutor.getAllTasks();
    return tasks.map((task: any) => ({
      id: task.id,
      type: task.type,
      priority: task.priority,
      status: task.status,
      progress: task.progress,
      currentStep: task.currentStep,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      error: task.error,
      result: task.result,
    }));
  }

  /**
   * 获取运行中的任务信息
   */
  getRunningTaskInfo(): TaskInfo[] {
    const tasks = this.taskExecutor.getRunningTasks();
    return tasks.map((task: any) => ({
      id: task.id,
      type: task.type,
      priority: task.priority,
      status: task.status,
      progress: task.progress,
      currentStep: task.currentStep,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      error: task.error,
      result: task.result,
    }));
  }

  /**
   * 获取状态摘要
   */
  getStatusSummary() {
    const stats = this.taskExecutor.getStats();
    const runningTasks = this.getRunningTaskInfo();
    
    return {
      agentId: this.state.agentId,
      isBusy: runningTasks.length > 0,
      activeTaskCount: runningTasks.length,
      queueStats: stats,
      currentTasks: runningTasks.map(task => ({
        id: task.id,
        type: task.type,
        priority: task.priority as unknown as string,
        status: task.status,
        progress: task.progress,
        currentStep: task.currentStep,
        startedAt: task.startedAt,
      })),
    };
  }

  /**
   * 添加状态监听器
   */
  addStateListener(listener: (state: AgentState) => void): () => void {
    this.statusListeners.push(listener);
    
    // 返回移除函数
    return () => {
      const index = this.statusListeners.indexOf(listener);
      if (index !== -1) {
        this.statusListeners.splice(index, 1);
      }
    };
  }

  /**
   * 通知状态变化
   */
  private notifyStateChange(): void {
    const state = this.getState();
    this.statusListeners.forEach(listener => {
      try {
        listener(state);
      } catch (error) {
        console.error(`Error in state listener: ${error}`);
      }
    });
  }
}