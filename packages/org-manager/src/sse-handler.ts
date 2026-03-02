import type { ServerResponse } from 'node:http';
import type { Agent } from '@markus/core';
import { createLogger, type LLMStreamEvent } from '@markus/shared';
import { SSEBuffer } from './sse-buffer.js';

const log = createLogger('sse-handler');

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
}

/**
 * 处理SSE流式响应的统一处理器
 */
export class SSEHandler {
  private options: SSEMessageHandlerOptions;
  private sseBuffer: SSEBuffer | null = null;
  private msgSegments: Array<{type: 'text'; content: string} | {type: 'tool'; tool: string; status: 'done' | 'error'}> = [];
  private textBuf = '';
  private totalTokens = 0;
  private processedTokens = 0;
  private isProcessing = false;
  private isComplete = false;

  constructor(options: SSEMessageHandlerOptions) {
    this.options = options;
  }

  /**
   * 处理流式消息
   */
  async handle(res: ServerResponse): Promise<void> {
    if (this.isProcessing) {
      throw new Error('SSE handler is already processing');
    }

    this.isProcessing = true;
    
    try {
      this.sseBuffer = new SSEBuffer(res, {
        bufferSize: 4096,
        flushInterval: 30,
        heartbeatInterval: 15000,
      });

      // 持久化用户消息（如果提供了持久化函数）
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
        segments: this.msgSegments 
      });

      // 立即刷新缓冲区，确保完成事件被发送
      if (this.sseBuffer) {
        const buffer = this.sseBuffer as unknown as { flush?: () => void };
        if (buffer.flush) {
          buffer.flush();
        }
      }

      // 持久化助手消息（如果提供了持久化函数）
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

    } catch (error) {
      log.error('SSE handler error', { 
        agentId: this.options.agentId, 
        error: String(error) 
      });
      
      this.handleError(error, res);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * 处理流式事件
   */
  private handleStreamEvent(event: AgentStreamEvent): void {
    if (!this.sseBuffer) return;

    // 发送事件到SSE缓冲器
    this.sseBuffer.send({ ...event });
    
    if (event.type === 'text_delta' && event.text) {
      this.textBuf += event.text;
      
      // 广播到WebSocket（如果提供了广播器）
      if (this.options.wsBroadcaster) {
        this.options.wsBroadcaster.broadcastChat(this.options.agentId, event.text, 'agent');
      }
      
      // 调用自定义文本处理函数
      if (this.options.onTextDelta) {
        this.options.onTextDelta(event.text);
      }
      
      // 更新进度（假设每个字符大约0.75个token）
      const tokenEstimate = Math.ceil(event.text.length * 0.75);
      this.processedTokens += tokenEstimate;
      this.totalTokens = Math.max(this.totalTokens, this.processedTokens + 50);
      
      // 每处理约50个token发送一次进度更新
      if (tokenEstimate >= 50 || this.processedTokens % 50 < tokenEstimate) {
        this.sseBuffer.sendProgress(this.processedTokens, this.totalTokens, '正在生成回复...');
      }
    } else if (event.type === 'agent_tool') {
      if (this.options.onToolEvent) {
        this.options.onToolEvent(event);
      }
      
      if (event.phase === 'start') {
        if (this.textBuf) { 
          this.msgSegments.push({ type: 'text', content: this.textBuf }); 
          this.textBuf = ''; 
        }
        this.sseBuffer.sendProgress(this.processedTokens, this.totalTokens, `正在执行工具: ${event.tool}`);
      } else if (event.phase === 'end' && event.tool) {
        this.msgSegments.push({ 
          type: 'tool', 
          tool: event.tool, 
          status: event.success === false ? 'error' : 'done' 
        });
        this.sseBuffer.sendProgress(this.processedTokens, this.totalTokens, `工具执行完成: ${event.tool}`);
      }
    } else if (event.type === 'message_end') {
      // 处理消息结束事件
      if (this.textBuf) {
        this.msgSegments.push({ type: 'text', content: this.textBuf });
        this.textBuf = '';
      }
      // 更新总token数
      if (event.usage?.outputTokens) {
        this.totalTokens = Math.max(this.totalTokens, event.usage.outputTokens);
        this.processedTokens = event.usage.outputTokens;
      }
      this.sseBuffer.sendProgress(this.processedTokens, this.totalTokens, '回复生成完成');
    }
  }

  /**
   * 处理错误
   */
  private handleError(error: unknown, res: ServerResponse): void {
    try {
      if (this.sseBuffer) {
        this.sseBuffer.sendError(error instanceof Error ? error : String(error), false);
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
        res.write(`data: ${JSON.stringify({ type: 'error', message: String(error) })}\\n\\n`);
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
    return {
      current: this.processedTokens,
      total: this.totalTokens,
      message: this.isComplete ? '完成' : '处理中'
    };
  }

  /**
   * 获取消息片段
   */
  getSegments(): Array<{type: 'text'; content: string} | {type: 'tool'; tool: string; status: 'done' | 'error'}> {
    return [...this.msgSegments];
  }

  /**
   * 获取当前文本缓冲区
   */
  getTextBuffer(): string {
    return this.textBuf;
  }
}