/**
 * 任务执行器
 * 负责任务执行、状态管理和进度跟踪
 */

import { TaskQueue, TaskPriority, TaskType, TaskStatus, TaskOptions, QueuedTask } from './task-queue.js';

export interface TaskExecutorOptions {
  agentId: string;
  maxConcurrentTasks?: number;
  defaultPriority?: TaskPriority;
}

export interface TaskExecutionResult {
  taskId: string;
  status: TaskStatus;
  result?: any;
  error?: Error;
  startedAt: Date;
  completedAt: Date;
  duration: number; // 毫秒
}

export interface TaskProgressEvent {
  taskId: string;
  type: TaskType;
  status: TaskStatus;
  progress: number;
  currentStep?: string;
  timestamp: Date;
}

/**
 * 任务执行器
 * 包装TaskQueue，提供更高级的任务管理功能
 */
export class TaskExecutor {
  private taskQueue: TaskQueue;
  private eventListeners: Map<string, ((event: TaskProgressEvent) => void)[]> = new Map();

  constructor(private options: TaskExecutorOptions) {
    this.taskQueue = new TaskQueue({
      maxConcurrent: options.maxConcurrentTasks || 5,
      defaultPriority: options.defaultPriority || TaskPriority.MEDIUM,
      name: `executor-${options.agentId}`,
      autoStart: true,
    });
  }

  /**
   * 执行聊天任务
   */
  async executeChatTask(
    taskId: string,
    executeFn: () => Promise<any>,
    options?: {
      priority?: TaskPriority;
      onProgress?: (progress: number, currentStep?: string) => void;
      cancelToken?: { cancelled: boolean };
    }
  ): Promise<TaskExecutionResult> {
    return this.executeTask({
      id: taskId,
      type: TaskType.CHAT,
      priority: options?.priority || TaskPriority.HIGH,
      execute: executeFn,
      onProgress: (taskId: string, progress: number, currentStep?: string) => {
        this.emitProgressEvent(taskId, TaskType.CHAT, progress, currentStep);
        if (options?.onProgress) {
          options.onProgress(progress, currentStep);
        }
      },
      cancelToken: options?.cancelToken,
    });
  }

  /**
   * 执行普通任务
   */
  async executeTaskTask(
    taskId: string,
    executeFn: () => Promise<any>,
    options?: {
      priority?: TaskPriority;
      onProgress?: (progress: number, currentStep?: string) => void;
      cancelToken?: { cancelled: boolean };
    }
  ): Promise<TaskExecutionResult> {
    return this.executeTask({
      id: taskId,
      type: TaskType.TASK,
      priority: options?.priority || TaskPriority.MEDIUM,
      execute: executeFn,
      onProgress: (taskId: string, progress: number, currentStep?: string) => {
        this.emitProgressEvent(taskId, TaskType.TASK, progress, currentStep);
        if (options?.onProgress) {
          options.onProgress(progress, currentStep);
        }
      },
      cancelToken: options?.cancelToken,
    });
  }

  /**
   * 执行心跳任务
   */
  async executeHeartbeatTask(
    taskId: string,
    executeFn: () => Promise<any>,
    options?: {
      onProgress?: (progress: number, currentStep?: string) => void;
      cancelToken?: { cancelled: boolean };
    }
  ): Promise<TaskExecutionResult> {
    return this.executeTask({
      id: taskId,
      type: TaskType.HEARTBEAT,
      priority: TaskPriority.LOW,
      execute: executeFn,
      onProgress: (taskId: string, progress: number, currentStep?: string) => {
        this.emitProgressEvent(taskId, TaskType.HEARTBEAT, progress, currentStep);
        if (options?.onProgress) {
          options.onProgress(progress, currentStep);
        }
      },
      cancelToken: options?.cancelToken,
    });
  }

  /**
   * 通用任务执行方法
   */
  private async executeTask(taskOptions: TaskOptions): Promise<TaskExecutionResult> {
    const startTime = new Date();
    let result: any;
    let error: Error | undefined;
    let status: TaskStatus = TaskStatus.PENDING;

    const taskId = await this.taskQueue.addTask({
      ...taskOptions,
      onStart: (id) => {
        status = TaskStatus.RUNNING;
        if (taskOptions.onStart) {
          taskOptions.onStart(id);
        }
      },
      onComplete: (id, res) => {
        status = TaskStatus.COMPLETED;
        result = res;
        if (taskOptions.onComplete) {
          taskOptions.onComplete(id, res);
        }
      },
      onError: (id, err) => {
        status = TaskStatus.FAILED;
        error = err;
        if (taskOptions.onError) {
          taskOptions.onError(id, err);
        }
      },
    });

    // 等待任务完成
    const task = await this.waitForTaskCompletion(taskId);
    const endTime = new Date();

    return {
      taskId,
      status: task.status,
      result: task.result,
      error: task.error,
      startedAt: task.startedAt || startTime,
      completedAt: task.completedAt || endTime,
      duration: (task.completedAt || endTime).getTime() - (task.startedAt || startTime).getTime(),
    };
  }

  /**
   * 等待任务完成
   */
  private async waitForTaskCompletion(taskId: string): Promise<QueuedTask> {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const task = this.taskQueue.getTaskStatus(taskId);
        if (task && task.status !== TaskStatus.PENDING && task.status !== TaskStatus.RUNNING) {
          clearInterval(checkInterval);
          resolve(task);
        }
      }, 100);
    });
  }

  /**
   * 更新任务进度
   */
  updateProgress(taskId: string, progress: number, currentStep?: string): boolean {
    return this.taskQueue.updateProgress(taskId, progress, currentStep);
  }

  /**
   * 取消任务
   */
  cancelTask(taskId: string): boolean {
    return this.taskQueue.cancelTask(taskId);
  }

  /**
   * 获取任务状态
   */
  getTaskStatus(taskId: string): QueuedTask | undefined {
    return this.taskQueue.getTaskStatus(taskId);
  }

  /**
   * 获取所有任务
   */
  getAllTasks(): QueuedTask[] {
    return this.taskQueue.getAllTasks();
  }

  /**
   * 获取运行中的任务
   */
  getRunningTasks(): QueuedTask[] {
    return this.taskQueue.getRunningTasks();
  }

  /**
   * 获取队列统计
   */
  getStats() {
    return this.taskQueue.getStats();
  }

  /**
   * 等待所有任务完成
   */
  async waitForAll(): Promise<void> {
    return this.taskQueue.waitForAll();
  }

  /**
   * 清空队列
   */
  clearQueue(): void {
    this.taskQueue.clearQueue();
  }

  /**
   * 添加进度事件监听器
   */
  addProgressListener(listener: (event: TaskProgressEvent) => void): () => void {
    const id = Math.random().toString(36).substring(2);
    if (!this.eventListeners.has('progress')) {
      this.eventListeners.set('progress', []);
    }
    this.eventListeners.get('progress')!.push(listener);

    // 返回移除函数
    return () => {
      const listeners = this.eventListeners.get('progress');
      if (listeners) {
        const index = listeners.indexOf(listener);
        if (index !== -1) {
          listeners.splice(index, 1);
        }
      }
    };
  }

  /**
   * 触发进度事件
   */
  private emitProgressEvent(taskId: string, type: TaskType, progress: number, currentStep?: string): void {
    const task = this.taskQueue.getTaskStatus(taskId);
    if (!task) return;

    const event: TaskProgressEvent = {
      taskId,
      type,
      status: task.status,
      progress,
      currentStep,
      timestamp: new Date(),
    };

    const listeners = this.eventListeners.get('progress');
    if (listeners) {
      listeners.forEach(listener => {
        try {
          listener(event);
        } catch (error) {
          console.error(`Error in progress event listener: ${error}`);
        }
      });
    }
  }

  /**
   * 获取Agent状态摘要
   */
  getAgentStatusSummary() {
    const stats = this.getStats();
    const runningTasks = this.getRunningTasks();
    
    return {
      agentId: this.options.agentId,
      isBusy: runningTasks.length > 0,
      activeTaskCount: runningTasks.length,
      queueStats: stats,
      currentTasks: runningTasks.map(task => ({
        id: task.id,
        type: task.type,
        priority: task.priority,
        status: task.status,
        progress: task.progress,
        currentStep: task.currentStep,
        startedAt: task.startedAt,
      })),
    };
  }
}