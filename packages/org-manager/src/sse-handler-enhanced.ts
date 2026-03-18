// @ts-nocheck — WIP module, not yet aligned with latest AgentStreamEvent interface
import type { ServerResponse } from 'node:http';
import type { Agent } from '@markus/core';
import { createLogger, type LLMStreamEvent } from '@markus/shared';
import { SSEBuffer } from './sse-buffer.js';

const log = createLogger('sse-handler-enhanced');

type AgentStreamEvent = LLMStreamEvent & { agentEvent?: string };

export interface SSEMessageHandlerOptions {
  agentId: string;
  agent: Agent;
  userText: string;
  senderId?: string;
  senderInfo?: { name: string; role: string };
  wsBroadcaster?: { broadcastChat: (agentId: string, message: string, sender: 'agent' | 'user') => void };
  persistUserMessage?: (agentId: string, text: string, senderId?: string) => Promise<string | null>;
  persistAssistantMessage?: (sessionId: string | null, agentId: string, reply: string, tokensUsed: number, meta?: unknown) => Promise<void>;
  onTextDelta?: (text: string) => void;
  onToolEvent?: (event: AgentStreamEvent) => void;
  onComplete?: (reply: string, segments: Array<{type: string; content?: string; tool?: string; status?: string}>, tokensUsed: number) => Promise<void>;
  onError?: (error: Error, retryCount: number) => Promise<boolean>; // 返回true表示重试
  maxRetries?: number;
  retryDelayMs?: number;
}

/**
 * 增强的SSE流式响应处理器，支持错误处理和重试机制
 */
export class SSEHandlerEnhanced {
  private options: SSEMessageHandlerOptions;
  private sseBuffer: SSEBuffer | null = null;
  private msgSegments: Array<{type: 'text'; content: string} | {type: 'tool'; tool: string; status: 'done' | 'error'}> = [];
  private textBuf = '';
  private totalTokens = 0;
  private processedTokens = 0;
  private isProcessing = false;
  private isComplete = false;
  private retryCount = 0;
  private lastError: Error | null = null;
  private connectionStartTime = 0;
  private lastActivityTime = 0;

  constructor(options: SSEMessageHandlerOptions) {
    this.options = {
      maxRetries: 3,
      retryDelayMs: 1000,
      ...options
    };
  }

  /**
   * 处理流式消息，支持重试机制
   */
  async handle(res: ServerResponse): Promise<void> {
    if (this.isProcessing) {
      throw new Error('SSE handler is already processing');
    }

    this.isProcessing = true;
    this.connectionStartTime = Date.now();
    this.lastActivityTime = Date.now();
    
    try {
      await this.handleWithRetry(res);
    } catch (error) {
      log.error('SSE handler failed after all retries', { 
        agentId: this.options.agentId, 
        error: String(error),
        retryCount: this.retryCount
      });
      this.handleError(error, res, true); // 最终错误
    }
  }

  /**
   * 带重试的处理逻辑
   */
  private async handleWithRetry(res: ServerResponse): Promise<void> {
    while (this.retryCount <= this.options.maxRetries!) {
      try {
        await this.processMessage(res);
        return; // 成功完成
      } catch (error) {
        this.lastError = error instanceof Error ? error : new Error(String(error));
        this.retryCount++;
        
        log.warn('SSE handler error, retrying', { 
          agentId: this.options.agentId, 
          error: String(error),
          retryCount: this.retryCount,
          maxRetries: this.options.maxRetries
        });
        
        // 发送错误事件
        this.sendErrorEvent(error);
        
        // 检查是否应该重试
        const shouldRetry = await this.shouldRetry(error);
        if (!shouldRetry || this.retryCount > this.options.maxRetries!) {
          throw error; // 不再重试
        }
        
        // 等待重试延迟（指数退避）
        const delay = this.options.retryDelayMs! * Math.pow(2, this.retryCount - 1);
        log.info('Waiting before retry', { delay, retryCount: this.retryCount });
        await new Promise(resolve => setTimeout(resolve, delay));
        
        // 重置状态，准备重试
        this.resetForRetry();
      }
    }
  }

  /**
   * 处理单次消息
   */
  private async processMessage(res: ServerResponse): Promise<void> {
    this.sseBuffer = new SSEBuffer(res, {
      bufferSize: 4096,
      flushInterval: 30,
      heartbeatInterval: 15000,
    });

    // 发送连接事件
    this.sseBuffer.send({ type: 'connected', timestamp: Date.now(), retryCount: this.retryCount });

    // 持久化用户消息
    let userMsgPersisted = null;
    if (this.options.persistUserMessage) {
      userMsgPersisted = await this.options.persistUserMessage(
        this.options.agentId,
        this.options.userText,
        this.options.senderId
      );
    }

    const reply = await this.options.agent.handleMessageStream(
      this.options.userText,
      (event) => this.handleStreamEvent(event),
      this.options.senderId,
      this.options.senderInfo,
    );

    // 处理剩余的文本缓冲区
    if (this.textBuf) {
      this.msgSegments.push({ type: 'text', content: this.textBuf });
      this.textBuf = '';
    }

    // 发送完成事件
    this.sseBuffer.send({ 
      type: 'done', 
      content: reply, 
      agentId: this.options.agentId,
      segments: this.msgSegments,
      totalTime: Date.now() - this.connectionStartTime
    });

    // 立即刷新缓冲区
    if (this.sseBuffer) {
      const buffer = this.sseBuffer as unknown as { flush?: () => void };
      if (buffer.flush) {
        buffer.flush();
      }
    }

    // 持久化助手消息
    if (this.options.persistAssistantMessage && userMsgPersisted) {
      const msgMeta = this.msgSegments.length > 0 ? { segments: this.msgSegments } : undefined;
      await this.options.persistAssistantMessage(
        userMsgPersisted,
        this.options.agentId,
        reply,
        this.options.agent.getState().tokensUsedToday,
        msgMeta
      );
    }

    // 调用完成回调
    if (this.options.onComplete) {
      await this.options.onComplete(reply, this.msgSegments, this.options.agent.getState().tokensUsedToday);
    }

    this.isComplete = true;
    
    // 延迟关闭连接
    setTimeout(() => {
      if (this.sseBuffer) {
        this.sseBuffer.close();
      }
    }, 100);

  }

  /**
   * 处理流式事件
   */
  private handleStreamEvent(event: AgentStreamEvent): void {
    this.lastActivityTime = Date.now();
    
    try {
      if (this.sseBuffer) {
        this.sseBuffer.send(event);
      }

      // 处理文本增量
      if (event.type === 'text_delta' && event.content) {
        this.textBuf += event.content;
      }

      // 处理进度更新
      if (event.type === 'progress') {
        this.processedTokens = event.processedTokens || 0;
        this.totalTokens = event.totalTokens || 0;
      }

      // 处理工具事件
      if (event.type === 'tool_call_start' || event.type === 'tool_call_delta' || event.type === 'tool_call_end') {
        // 可以在这里添加工具事件处理逻辑
      }

    } catch (error) {
      log.error('Error handling stream event', { error: String(error) });
      throw error;
    }
  }

  /**
   * 发送错误事件
   */
  private sendErrorEvent(error: unknown): void {
    try {
      if (this.sseBuffer) {
        this.sseBuffer.sendError(error instanceof Error ? error : String(error), false);
      }
    } catch (e) {
      log.error('Error sending error event', { error: String(e) });
    }
  }

  /**
   * 检查是否应该重试
   */
  private async shouldRetry(error: unknown): Promise<boolean> {
    // 如果是连接错误或超时，应该重试
    const errorStr = String(error).toLowerCase();
    const isRetryable = 
      errorStr.includes('connection') ||
      errorStr.includes('timeout') ||
      errorStr.includes('network') ||
      errorStr.includes('socket') ||
      errorStr.includes('econnreset') ||
      errorStr.includes('econnrefused') ||
      errorStr.includes('enotfound') ||
      errorStr.includes('getaddrinfo') ||
      errorStr.includes('fetch failed') ||
      errorStr.includes('dns') ||
      errorStr.includes('etimedout');
    
    if (!isRetryable) {
      return false;
    }
    
    // 调用自定义错误处理回调
    if (this.options.onError) {
      try {
        return await this.options.onError(
          error instanceof Error ? error : new Error(String(error)),
          this.retryCount
        );
      } catch (e) {
        log.error('Error in onError callback', { error: String(e) });
        return false;
      }
    }
    
    return true;
  }

  /**
   * 重置状态以进行重试
   */
  private resetForRetry(): void {
    // 清理当前缓冲区
    if (this.sseBuffer) {
      this.sseBuffer.close();
      this.sseBuffer = null;
    }
    
    // 重置消息段（保留用户消息）
    this.textBuf = '';
    this.msgSegments = [];
    this.processedTokens = 0;
    this.totalTokens = 0;
    
    // 保持 isProcessing 为 true，因为仍在处理中
    this.isComplete = false;
  }

  /**
   * 处理最终错误
   */
  private handleError(error: unknown, res: ServerResponse, isFinal: boolean = false): void {
    try {
      if (this.sseBuffer) {
        this.sseBuffer.sendError(error instanceof Error ? error : String(error), isFinal);
        setTimeout(() => {
          if (this.sseBuffer) {
            this.sseBuffer.close();
          }
        }, 100);
      } else {
        // 如果SSE缓冲器不存在，回退到原始方式
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        res.write(`data: ${JSON.stringify({ 
          type: 'error', 
          message: String(error),
          isFinal,
          retryCount: this.retryCount
        })}\\\\n\\\\n`);
        res.end();
      }
    } catch (e) {
      log.error('Error handling SSE error', { error: String(e) });
    }
  }

  /**
   * 取消处理
   */
  cancel(): void {
    if (this.sseBuffer) {
      this.sseBuffer.close();
      this.sseBuffer = null;
    }
    this.isProcessing = false;
  }

  /**
   * 检查是否完成
   */
  isCompleted(): boolean {
    return this.isComplete;
  }

  /**
   * 获取进度信息
   */
  getProgress(): { current: number; total: number; message: string } {
    const progress = this.totalTokens > 0 ? Math.round((this.processedTokens / this.totalTokens) * 100) : 0;
    return {
      current: this.processedTokens,
      total: this.totalTokens,
      message: `Processing${this.retryCount > 0 ? ` (retry ${this.retryCount})` : ''}`
    };
  }

  /**
   * 获取连接状态
   */
  getConnectionStatus(): {
    isConnected: boolean;
    retryCount: number;
    lastError: string | null;
    connectionTime: number;
    lastActivityTime: number;
  } {
    return {
      isConnected: this.sseBuffer !== null,
      retryCount: this.retryCount,
      lastError: this.lastError?.message || null,
      connectionTime: this.connectionStartTime,
      lastActivityTime: this.lastActivityTime
    };
  }
}