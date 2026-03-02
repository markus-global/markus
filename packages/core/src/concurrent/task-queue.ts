/**
 * 并发任务队列系统
 * 支持优先级队列、并发控制、任务隔离
 */

export enum TaskPriority {
  HIGH = 0,    // 用户交互、紧急任务
  MEDIUM = 1,  // 普通任务
  LOW = 2,     // 后台任务、心跳
}

export enum TaskStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum TaskType {
  CHAT = 'chat',      // 用户聊天交互
  TASK = 'task',      // 任务执行
  HEARTBEAT = 'heartbeat', // 后台心跳
}

export interface TaskOptions {
  id: string;
  type: TaskType;
  priority: TaskPriority;
  execute: () => Promise<any>;
  onStart?: (taskId: string) => void;
  onComplete?: (taskId: string, result: any) => void;
  onError?: (taskId: string, error: Error) => void;
  onProgress?: (taskId: string, progress: number, currentStep?: string) => void;
  cancelToken?: { cancelled: boolean };
  metadata?: Record<string, any>;
}

export interface QueuedTask extends TaskOptions {
  status: TaskStatus;
  progress: number; // 0-100
  currentStep?: string;
  startedAt?: Date;
  completedAt?: Date;
  error?: Error;
  result?: any;
}

export interface TaskQueueStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  total: number;
}

export interface TaskQueueOptions {
  maxConcurrent: number;
  defaultPriority: TaskPriority;
  name?: string;
  autoStart?: boolean;
}

/**
 * 并发任务队列
 * 支持优先级队列、并发控制、任务状态跟踪
 */
export class TaskQueue {
  private queue: QueuedTask[] = [];
  private runningTasks: Map<string, QueuedTask> = new Map();
  private completedTasks: Map<string, QueuedTask> = new Map();
  private isProcessing = false;
  private stats: TaskQueueStats = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    total: 0,
  };

  constructor(private options: TaskQueueOptions) {
    if (options.autoStart !== false) {
      this.start();
    }
  }

  /**
   * 添加任务到队列
   */
  async addTask(options: TaskOptions): Promise<string> {
    const task: QueuedTask = {
      ...options,
      status: TaskStatus.PENDING,
      progress: 0,
    };

    // 插入队列，按优先级排序
    this.insertTaskByPriority(task);
    this.stats.pending++;
    this.stats.total++;

    // 触发处理
    this.processQueue();

    return task.id;
  }

  /**
   * 按优先级插入任务
   */
  private insertTaskByPriority(task: QueuedTask): void {
    let insertIndex = 0;
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].priority > task.priority) {
        insertIndex = i;
        break;
      }
      insertIndex = i + 1;
    }
    this.queue.splice(insertIndex, 0, task);
  }

  /**
   * 启动队列处理
   */
  start(): void {
    if (this.isProcessing) return;
    this.isProcessing = true;
    this.processQueue();
  }

  /**
   * 停止队列处理
   */
  stop(): void {
    this.isProcessing = false;
  }

  /**
   * 处理队列中的任务
   */
  private async processQueue(): Promise<void> {
    if (!this.isProcessing) return;

    // 检查并发限制
    const availableSlots = this.options.maxConcurrent - this.runningTasks.size;
    if (availableSlots <= 0) return;

    // 获取可执行的任务
    const tasksToExecute = this.queue.splice(0, availableSlots);

    for (const task of tasksToExecute) {
      this.executeTask(task);
    }
  }

  /**
   * 执行单个任务
   */
  private async executeTask(task: QueuedTask): Promise<void> {
    // 更新状态
    task.status = TaskStatus.RUNNING;
    task.startedAt = new Date();
    this.runningTasks.set(task.id, task);
    this.stats.pending--;
    this.stats.running++;

    // 触发开始回调
    if (task.onStart) {
      try {
        task.onStart(task.id);
      } catch (error) {
        console.error(`Error in task onStart callback: ${error}`);
      }
    }

    try {
      // 检查是否取消
      if (task.cancelToken?.cancelled) {
        task.status = TaskStatus.CANCELLED;
        task.completedAt = new Date();
        this.stats.running--;
        this.stats.cancelled++;
        this.completedTasks.set(task.id, task);
        this.runningTasks.delete(task.id);
        return;
      }

      // 执行任务
      const result = await task.execute();
      
      // 更新状态
      task.status = TaskStatus.COMPLETED;
      task.progress = 100;
      task.result = result;
      task.completedAt = new Date();
      this.stats.running--;
      this.stats.completed++;
      this.completedTasks.set(task.id, task);
      this.runningTasks.delete(task.id);

      // 触发完成回调
      if (task.onComplete) {
        try {
          task.onComplete(task.id, result);
        } catch (error) {
          console.error(`Error in task onComplete callback: ${error}`);
        }
      }
    } catch (error) {
      // 处理错误
      task.status = TaskStatus.FAILED;
      task.error = error instanceof Error ? error : new Error(String(error));
      task.completedAt = new Date();
      this.stats.running--;
      this.stats.failed++;
      this.completedTasks.set(task.id, task);
      this.runningTasks.delete(task.id);

      // 触发错误回调
      if (task.onError) {
        try {
          task.onError(task.id, task.error);
        } catch (callbackError) {
          console.error(`Error in task onError callback: ${callbackError}`);
        }
      }
    } finally {
      // 继续处理队列
      this.processQueue();
    }
  }

  /**
   * 更新任务进度
   */
  updateProgress(taskId: string, progress: number, currentStep?: string): boolean {
    const task = this.runningTasks.get(taskId);
    if (!task) return false;

    task.progress = Math.max(0, Math.min(100, progress));
    if (currentStep) {
      task.currentStep = currentStep;
    }

    // 触发进度回调
    if (task.onProgress) {
      try {
        task.onProgress(taskId, progress, currentStep);
      } catch (error) {
        console.error(`Error in task onProgress callback: ${error}`);
      }
    }

    return true;
  }

  /**
   * 取消任务
   */
  cancelTask(taskId: string): boolean {
    // 检查是否在队列中
    const queueIndex = this.queue.findIndex(t => t.id === taskId);
    if (queueIndex !== -1) {
      const task = this.queue[queueIndex];
      task.status = TaskStatus.CANCELLED;
      task.completedAt = new Date();
      this.queue.splice(queueIndex, 1);
      this.stats.pending--;
      this.stats.cancelled++;
      this.completedTasks.set(taskId, task);
      return true;
    }

    // 检查是否在运行中
    const runningTask = this.runningTasks.get(taskId);
    if (runningTask) {
      if (runningTask.cancelToken) {
        runningTask.cancelToken.cancelled = true;
        return true;
      }
    }

    return false;
  }

  /**
   * 获取任务状态
   */
  getTaskStatus(taskId: string): QueuedTask | undefined {
    return this.runningTasks.get(taskId) || 
           this.queue.find(t => t.id === taskId) ||
           this.completedTasks.get(taskId);
  }

  /**
   * 获取所有任务
   */
  getAllTasks(): QueuedTask[] {
    return [
      ...this.queue,
      ...Array.from(this.runningTasks.values()),
      ...Array.from(this.completedTasks.values()),
    ];
  }

  /**
   * 获取运行中的任务
   */
  getRunningTasks(): QueuedTask[] {
    return Array.from(this.runningTasks.values());
  }

  /**
   * 获取队列中的任务
   */
  getPendingTasks(): QueuedTask[] {
    return this.queue;
  }

  /**
   * 获取统计信息
   */
  getStats(): TaskQueueStats {
    return { ...this.stats };
  }

  /**
   * 清空队列
   */
  clearQueue(): void {
    // 取消所有队列中的任务
    for (const task of this.queue) {
      task.status = TaskStatus.CANCELLED;
      task.completedAt = new Date();
      this.stats.pending--;
      this.stats.cancelled++;
      this.completedTasks.set(task.id, task);
    }
    this.queue = [];
  }

  /**
   * 等待所有任务完成
   */
  async waitForAll(): Promise<void> {
    while (this.runningTasks.size > 0 || this.queue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}