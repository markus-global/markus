/**
 * Internal types for the external mode package.
 */
import type { ExternalContext } from '@markus/shared';

export type ExternalMiddlewareHandler = (
  ctx: ExternalContext,
  next: () => Promise<void>,
) => Promise<void>;

export interface ExternalMiddlewareDefinition {
  name: string;
  handler: ExternalMiddlewareHandler;
}

export interface SessionWorkerConfig {
  serviceId: string;
  sessionId: string;
  systemPrompt: string;
  maxIterations: number;
  tokenBudget: number;
  toolNames: string[];
}

export interface StreamEvent {
  type: 'text_delta' | 'tool_start' | 'tool_end' | 'done' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
}

export type StreamCallback = (event: StreamEvent) => void;
