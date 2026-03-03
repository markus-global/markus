// @ts-nocheck — WIP module, not yet aligned with latest LongTaskProgress interface
import { createLogger } from '@markus/shared';

const log = createLogger('long-task-progress');

export interface TaskStage {
  id: string;
  name: string;
  description: string;
  weight: number; // 权重，用于计算整体进度
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  progress: number; // 0-100
  startedAt?: number;
  completedAt?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface LongTaskProgressOptions {
  taskId: string;
  taskName: string;
  description?: string;
  stages: TaskStage[];
  onProgressUpdate?: (progress: LongTaskProgress) => void;
  onStageChange?: (stage: TaskStage, previousStage?: TaskStage) => void;
  persistProgress?: (progress: LongTaskProgress) => Promise<void>;
}

export class LongTaskProgress {
  private options: LongTaskProgressOptions;
  private currentStageIndex = 0;
  private startTime = 0;
  private lastUpdateTime = 0;
  private isCancelled = false;
  private isPaused = false;
  private pauseResumeCallbacks: Array<() => void> = [];

  constructor(options: LongTaskProgressOptions) {
    this.options = options;
    this.startTime = Date.now();
    this.lastUpdateTime = this.startTime;
  }

  /**
   * 开始任务
   */
  async start(): Promise<void> {
    log.info('Starting long task', { 
      taskId: this.options.taskId, 
      taskName: this.options.taskName,
      stageCount: this.options.stages.length 
    });
    
    // 发送初始进度
    await this.updateProgress();
    
    // 开始第一个阶段
    if (this.options.stages.length > 0) {
      await this.startStage(0);
    }
  }

  /**
   * 开始特定阶段
   */
  async startStage(stageIndex: number): Promise<void> {
    if (stageIndex < 0 || stageIndex >= this.options.stages.length) {
      throw new Error(`Invalid stage index: ${stageIndex}`);
    }

    if (this.isCancelled) {
      throw new Error('Task has been cancelled');
    }

    // 等待暂停状态
    await this.waitIfPaused();

    const previousStage = this.currentStageIndex >= 0 ? this.options.stages[this.currentStageIndex] : undefined;
    this.currentStageIndex = stageIndex;
    
    const stage = this.options.stages[stageIndex];
    stage.status = 'in_progress';
    stage.startedAt = Date.now();
    stage.progress = 0;

    log.info('Starting task stage', { 
      taskId: this.options.taskId, 
      stageId: stage.id,
      stageName: stage.name,
      stageIndex 
    });

    // 通知阶段变化
    if (this.options.onStageChange) {
      this.options.onStageChange(stage, previousStage);
    }

    // 更新进度
    await this.updateProgress();
  }

  /**
   * 更新当前阶段进度
   */
  async updateStageProgress(progress: number, metadata?: Record<string, unknown>): Promise<void> {
    if (this.currentStageIndex < 0 || this.currentStageIndex >= this.options.stages.length) {
      return;
    }

    if (this.isCancelled) {
      return;
    }

    // 等待暂停状态
    await this.waitIfPaused();

    const stage = this.options.stages[this.currentStageIndex];
    const oldProgress = stage.progress;
    stage.progress = Math.max(0, Math.min(100, progress));
    
    if (metadata) {
      stage.metadata = { ...stage.metadata, ...metadata };
    }

    // 如果进度有显著变化，更新整体进度
    if (Math.abs(stage.progress - oldProgress) >= 5 || Date.now() - this.lastUpdateTime > 1000) {
      await this.updateProgress();
    }
  }

  /**
   * 完成当前阶段
   */
  async completeStage(success: boolean = true, error?: string, metadata?: Record<string, unknown>): Promise<void> {
    if (this.currentStageIndex < 0 || this.currentStageIndex >= this.options.stages.length) {
      return;
    }

    const stage = this.options.stages[this.currentStageIndex];
    stage.status = success ? 'completed' : 'failed';
    stage.progress = 100;
    stage.completedAt = Date.now();
    
    if (error) {
      stage.error = error;
    }
    
    if (metadata) {
      stage.metadata = { ...stage.metadata, ...metadata };
    }

    log.info('Completed task stage', { 
      taskId: this.options.taskId, 
      stageId: stage.id,
      stageName: stage.name,
      success,
      duration: stage.completedAt - (stage.startedAt || stage.completedAt)
    });

    // 更新进度
    await this.updateProgress();

    // 自动开始下一个阶段（如果存在且任务未取消）
    if (!this.isCancelled && this.currentStageIndex + 1 < this.options.stages.length) {
      await this.startStage(this.currentStageIndex + 1);
    }
  }

  /**
   * 更新整体进度
   */
  private async updateProgress(): Promise<void> {
    this.lastUpdateTime = Date.now();
    
    // 计算整体进度
    const overallProgress = this.calculateOverallProgress();
    const elapsedTime = Date.now() - this.startTime;
    const estimatedRemainingTime = this.estimateRemainingTime(overallProgress, elapsedTime);
    
    const progressData = {
      taskId: this.options.taskId,
      taskName: this.options.taskName,
      description: this.options.description,
      overallProgress,
      elapsedTime,
      estimatedRemainingTime,
      currentStage: this.currentStageIndex >= 0 ? this.options.stages[this.currentStageIndex] : undefined,
      stages: this.options.stages,
      isCancelled: this.isCancelled,
      isPaused: this.isPaused,
      timestamp: this.lastUpdateTime
    };

    log.debug('Task progress update', { 
      taskId: this.options.taskId, 
      overallProgress,
      currentStage: progressData.currentStage?.name 
    });

    // 调用进度更新回调
    if (this.options.onProgressUpdate) {
      try {
        this.options.onProgressUpdate(progressData);
      } catch (error) {
        log.error('Error in progress update callback', { error: String(error) });
      }
    }

    // 持久化进度
    if (this.options.persistProgress) {
      try {
        await this.options.persistProgress(progressData);
      } catch (error) {
        log.error('Error persisting progress', { error: String(error) });
      }
    }
  }

  /**
   * 计算整体进度
   */
  private calculateOverallProgress(): number {
    if (this.options.stages.length === 0) {
      return 0;
    }

    let totalWeight = 0;
    let weightedProgress = 0;

    for (const stage of this.options.stages) {
      totalWeight += stage.weight;
      
      let stageProgress = 0;
      if (stage.status === 'completed') {
        stageProgress = 100;
      } else if (stage.status === 'in_progress') {
        stageProgress = stage.progress;
      }
      // pending, failed, cancelled 状态进度为0
      
      weightedProgress += stage.weight * stageProgress;
    }

    return totalWeight > 0 ? weightedProgress / totalWeight : 0;
  }

  /**
   * 估计剩余时间
   */
  private estimateRemainingTime(currentProgress: number, elapsedTime: number): number | null {
    if (currentProgress <= 0 || currentProgress >= 100) {
      return null;
    }

    const estimatedTotalTime = elapsedTime / (currentProgress / 100);
    return Math.max(0, estimatedTotalTime - elapsedTime);
  }

  /**
   * 取消任务
   */
  async cancel(reason?: string): Promise<void> {
    if (this.isCancelled) {
      return;
    }

    this.isCancelled = true;
    
    // 取消当前阶段
    if (this.currentStageIndex >= 0 && this.currentStageIndex < this.options.stages.length) {
      const stage = this.options.stages[this.currentStageIndex];
      if (stage.status === 'in_progress') {
        stage.status = 'cancelled';
        stage.completedAt = Date.now();
        if (reason) {
          stage.error = reason;
        }
      }
    }

    log.info('Task cancelled', { 
      taskId: this.options.taskId, 
      reason,
      elapsedTime: Date.now() - this.startTime 
    });

    await this.updateProgress();
  }

  /**
   * 暂停任务
   */
  pause(): void {
    if (this.isPaused || this.isCancelled) {
      return;
    }

    this.isPaused = true;
    log.info('Task paused', { taskId: this.options.taskId });
  }

  /**
   * 恢复任务
   */
  resume(): void {
    if (!this.isPaused || this.isCancelled) {
      return;
    }

    this.isPaused = false;
    
    // 调用所有恢复回调
    for (const callback of this.pauseResumeCallbacks) {
      try {
        callback();
      } catch (error) {
        log.error('Error in pause/resume callback', { error: String(error) });
      }
    }
    this.pauseResumeCallbacks = [];

    log.info('Task resumed', { taskId: this.options.taskId });
  }

  /**
   * 等待暂停状态
   */
  private async waitIfPaused(): Promise<void> {
    if (!this.isPaused) {
      return;
    }

    return new Promise<void>((resolve) => {
      this.pauseResumeCallbacks.push(resolve);
    });
  }

  /**
   * 获取任务状态
   */
  getStatus(): {
    taskId: string;
    taskName: string;
    overallProgress: number;
    elapsedTime: number;
    estimatedRemainingTime: number | null;
    currentStage: TaskStage | undefined;
    stages: TaskStage[];
    isCancelled: boolean;
    isPaused: boolean;
    isComplete: boolean;
  } {
    const overallProgress = this.calculateOverallProgress();
    const elapsedTime = Date.now() - this.startTime;
    const estimatedRemainingTime = this.estimateRemainingTime(overallProgress, elapsedTime);
    
    const isComplete = this.options.stages.every(stage => 
      stage.status === 'completed' || stage.status === 'failed' || stage.status === 'cancelled'
    );

    return {
      taskId: this.options.taskId,
      taskName: this.options.taskName,
      overallProgress,
      elapsedTime,
      estimatedRemainingTime,
      currentStage: this.currentStageIndex >= 0 ? this.options.stages[this.currentStageIndex] : undefined,
      stages: this.options.stages,
      isCancelled: this.isCancelled,
      isPaused: this.isPaused,
      isComplete
    };
  }

  /**
   * 创建SSE兼容的进度事件
   */
  createSSEProgressEvent(): {
    type: 'long_task_progress';
    taskId: string;
    taskName: string;
    overallProgress: number;
    elapsedTime: number;
    estimatedRemainingTime: number | null;
    currentStage: TaskStage | undefined;
    stages: TaskStage[];
    isCancelled: boolean;
    isPaused: boolean;
    timestamp: number;
  } {
    const status = this.getStatus();
    
    return {
      type: 'long_task_progress',
      taskId: status.taskId,
      taskName: status.taskName,
      overallProgress: status.overallProgress,
      elapsedTime: status.elapsedTime,
      estimatedRemainingTime: status.estimatedRemainingTime,
      currentStage: status.currentStage,
      stages: status.stages,
      isCancelled: status.isCancelled,
      isPaused: status.isPaused,
      timestamp: Date.now()
    };
  }
}