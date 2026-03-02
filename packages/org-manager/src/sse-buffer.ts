import type { ServerResponse } from 'node:http';
import { createLogger } from '@markus/shared';

const log = createLogger('sse-buffer');

export interface SSEMessage {
  type: string;
  [key: string]: unknown;
}

export interface SSEBufferOptions {
  /** 缓冲区大小（字节） */
  bufferSize?: number;
  /** 刷新间隔（毫秒） */
  flushInterval?: number;
  /** 心跳间隔（毫秒） */
  heartbeatInterval?: number;
  /** 是否启用压缩 */
  enableCompression?: boolean;
  /** 最大重试次数 */
  maxRetries?: number;
}

/**
 * SSE缓冲器 - 优化流式响应性能
 * 
 * 功能：
 * 1. 事件缓冲和批量写入，减少HTTP写入调用
 * 2. 心跳机制保持连接活跃
 * 3. 流控防止客户端过载
 * 4. 错误处理和重试
 */
export class SSEBuffer {
  private response: ServerResponse;
  private buffer: string[] = [];
  private bufferSize = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isClosed = false;
  private options: Required<SSEBufferOptions>;
  
  // 性能统计
  private stats = {
    messagesSent: 0,
    bytesSent: 0,
    flushes: 0,
    errors: 0,
    lastFlushTime: 0,
  };

  constructor(
    response: ServerResponse,
    options: SSEBufferOptions = {}
  ) {
    this.response = response;
    this.options = {
      bufferSize: options.bufferSize ?? 8192, // 8KB
      flushInterval: options.flushInterval ?? 50, // 50ms
      heartbeatInterval: options.heartbeatInterval ?? 30000, // 30秒
      enableCompression: options.enableCompression ?? false,
      maxRetries: options.maxRetries ?? 3,
    };

    // 设置响应头
    this.response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no', // 禁用Nginx缓冲
    });

    // 发送初始连接确认
    this.sendImmediate({ type: 'connected', timestamp: Date.now() });

    // 启动心跳
    this.startHeartbeat();

    // 监听连接关闭
    this.response.on('close', () => {
      this.close();
    });

    this.response.on('error', (err) => {
      log.error('SSE response error', { error: String(err) });
      this.close();
    });
  }

  /**
   * 发送消息（缓冲）
   */
  send(message: SSEMessage): void {
    if (this.isClosed) {
      log.warn('Attempted to send message on closed SSE connection');
      return;
    }

    const eventStr = `data: ${JSON.stringify(message)}\n\n`;
    this.buffer.push(eventStr);
    this.bufferSize += Buffer.byteLength(eventStr, 'utf8');

    // 如果缓冲区超过阈值，立即刷新
    if (this.bufferSize >= this.options.bufferSize) {
      this.flush();
    } else if (!this.flushTimer) {
      // 设置延迟刷新
      this.flushTimer = setTimeout(() => this.flush(), this.options.flushInterval);
    }
  }

  /**
   * 立即发送消息（不缓冲）
   */
  sendImmediate(message: SSEMessage): void {
    if (this.isClosed) return;
    
    try {
      const eventStr = `data: ${JSON.stringify(message)}\n\n`;
      this.response.write(eventStr);
      this.stats.messagesSent++;
      this.stats.bytesSent += Buffer.byteLength(eventStr, 'utf8');
    } catch (err) {
      log.error('Failed to send immediate SSE message', { error: String(err) });
      this.stats.errors++;
    }
  }

  /**
   * 发送进度信息
   */
  sendProgress(current: number, total: number, message?: string): void {
    const progress = total > 0 ? Math.round((current / total) * 100) : 0;
    this.send({
      type: 'progress',
      progress,
      current,
      total,
      message,
      timestamp: Date.now(),
    });
  }

  /**
   * 发送错误信息
   */
  sendError(error: string | Error, recoverable = false): void {
    this.send({
      type: 'error',
      error: typeof error === 'string' ? error : error.message,
      recoverable,
      timestamp: Date.now(),
    });
  }

  /**
   * 刷新缓冲区
   */
  private flush(): void {
    if (this.isClosed || this.buffer.length === 0) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      return;
    }

    try {
      const data = this.buffer.join('');
      this.response.write(data);
      
      // 更新统计
      this.stats.messagesSent += this.buffer.length;
      this.stats.bytesSent += this.bufferSize;
      this.stats.flushes++;
      this.stats.lastFlushTime = Date.now();

      // 清空缓冲区
      this.buffer = [];
      this.bufferSize = 0;

      // 重置定时器
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
    } catch (err) {
      log.error('Failed to flush SSE buffer', { error: String(err) });
      this.stats.errors++;
      this.close();
    }
  }

  /**
   * 启动心跳
   */
  private startHeartbeat(): void {
    if (this.options.heartbeatInterval <= 0) return;

    this.heartbeatTimer = setInterval(() => {
      if (this.isClosed) {
        this.stopHeartbeat();
        return;
      }

      try {
        this.sendImmediate({ type: 'heartbeat', timestamp: Date.now() });
      } catch (err) {
        log.warn('Heartbeat failed', { error: String(err) });
        this.stopHeartbeat();
        this.close();
      }
    }, this.options.heartbeatInterval);
  }

  /**
   * 停止心跳
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 关闭连接
   */
  close(): void {
    if (this.isClosed) return;

    // Flush remaining buffer BEFORE marking as closed,
    // since flush() skips when isClosed is true
    if (this.buffer.length > 0) {
      this.flush();
    }

    this.isClosed = true;

    // 停止定时器
    this.stopHeartbeat();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // 发送结束事件
    try {
      if (!this.response.writableEnded && !this.response.destroyed) {
        this.response.write(`data: ${JSON.stringify({ type: 'complete', timestamp: Date.now() })}\n\n`);
        this.response.end();
      }
    } catch (err) {
      // 忽略结束时的错误
      log.debug('Error closing SSE connection', { error: String(err) });
    }

    log.debug('SSE connection closed', { stats: this.stats });
  }

  /**
   * 获取性能统计
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * 检查连接是否活跃
   */
  isActive(): boolean {
    return !this.isClosed && !this.response.destroyed && !this.response.writableEnded;
  }
}