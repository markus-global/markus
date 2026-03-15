import { createLogger } from '@markus/shared';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const log = createLogger('llm-logger');

export interface LLMLogEntry {
  timestamp: string;
  agentId?: string;
  taskId?: string;
  sessionId?: string;
  provider: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  tools?: Array<{ name: string }>;
  responseContent: string;
  responseToolCalls?: Array<{ name: string; args: string }>;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  finishReason: string;
}

export class LLMLogger {
  private logDir: string;
  private enabled: boolean;

  constructor(logDir?: string) {
    this.logDir = logDir ?? join(homedir(), '.markus', 'llm-logs');
    this.enabled = process.env.MARKUS_LLM_LOG !== 'false';
    if (this.enabled) {
      try {
        mkdirSync(this.logDir, { recursive: true });
      } catch {
        log.warn('Failed to create LLM log directory', { dir: this.logDir });
        this.enabled = false;
      }
    }
  }

  log(entry: LLMLogEntry): void {
    if (!this.enabled) return;
    try {
      const date = new Date().toISOString().slice(0, 10);
      const filePath = join(this.logDir, `${date}.jsonl`);
      const line = JSON.stringify(entry) + '\n';
      appendFileSync(filePath, line, 'utf-8');
    } catch (err) {
      log.warn('Failed to write LLM log entry', { error: String(err) });
    }
  }
}
