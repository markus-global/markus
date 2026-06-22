import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  resolveBinary,
  isWindows,
  type CodingToolName,
  type CodingToolConfig,
  type CodingToolSession,
  type CodingToolResult,
  type CodingToolEvent,
  type ToolAdapter,
  type TaskContextResponse,
} from '@markus/shared';

export interface RuntimeOptions {
  adapter: ToolAdapter;
  config?: CodingToolConfig;
  /** Root directory of the repository */
  repoPath: string;
  /** Task context for context injection */
  taskContext: TaskContextResponse;
  /** Skills to inject */
  skills?: Array<{ name: string; content: string }>;
  /** Markus CLI path */
  markusCli?: string;
  /** Markus API server URL */
  serverUrl?: string;
  /** Event callback for streaming progress */
  onEvent?: (event: CodingToolEvent) => void;
  /** Session status change callback */
  onStatusChange?: (session: CodingToolSession) => void;
  /** Per-invocation model override */
  model?: string;
  /** Per-invocation mode override */
  mode?: string;
  /** Per-invocation effort override */
  effort?: string;
  /** Per-session budget cap in USD */
  maxBudgetUsd?: number;
}

export class CodingToolRuntime {
  private sessions = new Map<string, CodingToolSession>();
  private processes = new Map<string, ChildProcess>();

  /**
   * Execute a coding tool session:
   * 1. Create session
   * 2. Set up worktree (or use repoPath directly for now)
   * 3. Inject context
   * 4. Spawn tool CLI
   * 5. Stream & parse output
   * 6. Collect result
   */
  async execute(prompt: string, options: RuntimeOptions): Promise<CodingToolSession> {
    const session = this.createSession(options.adapter.name, prompt, options.taskContext.task.id);
    this.sessions.set(session.id, session);
    options.onStatusChange?.(session);

    try {
      const workdir = options.repoPath;
      session.worktreePath = workdir;

      const { injectContext } = await import('./context-injector.js');
      const injection = injectContext({
        workdir,
        tool: options.adapter.name,
        taskContext: options.taskContext,
        skills: options.skills,
        markusCli: options.markusCli,
        serverUrl: options.serverUrl,
      });

      this.updateSession(session.id, { status: 'context_injected' });
      options.onStatusChange?.(session);

      const { args, env: adapterEnv } = options.adapter.buildArgs({
        prompt,
        workdir,
        config: options.config,
        model: options.model,
        mode: options.mode,
        effort: options.effort,
        maxBudgetUsd: options.maxBudgetUsd,
      });

      const env = {
        ...process.env,
        ...adapterEnv,
        ...injection.envVars,
        ...options.config?.env,
      };

      this.updateSession(session.id, { status: 'running', startedAt: new Date().toISOString() });
      options.onStatusChange?.(session);

      const result = await this.spawnTool(
        session.id,
        options.adapter,
        workdir,
        args,
        env,
        options.config?.timeoutMs ?? 600_000,
        options.onEvent,
        options.config?.binaryPath,
      );

      const cost = options.adapter.extractCost(result.rawOutput ?? '');

      const current = this.sessions.get(session.id);
      if (current?.status !== 'cancelled') {
        this.updateSession(session.id, {
          status: result.success ? 'completed' : 'failed',
          completedAt: new Date().toISOString(),
          result,
          cost: cost ?? undefined,
        });
        options.onStatusChange?.(session);
      } else if (result.rawOutput) {
        this.updateSession(session.id, { result });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.updateSession(session.id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        result: { success: false, summary: errorMsg, error: errorMsg, exitCode: -1 },
      });
      options.onStatusChange?.(session);
    }

    return this.sessions.get(session.id)!;
  }

  /** Cancel a running session */
  cancel(sessionId: string): void {
    const proc = this.processes.get(sessionId);
    if (proc && !proc.killed) {
      // On Windows, SIGTERM/SIGKILL are not real signals; proc.kill() sends SIGTERM
      // which is enough for most cases, and taskkill is the nuclear option.
      proc.kill();
      setTimeout(() => {
        try {
          if (!proc.killed) proc.kill('SIGKILL');
        } catch { /* already dead */ }
      }, 5000);
    }
    this.updateSession(sessionId, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
    });
  }

  /** Get a session by ID */
  getSession(id: string): CodingToolSession | undefined {
    return this.sessions.get(id);
  }

  private createSession(tool: CodingToolName, prompt: string, taskId: string): CodingToolSession {
    return {
      id: randomUUID(),
      taskId,
      tool,
      status: 'created',
      prompt,
      createdAt: new Date().toISOString(),
    };
  }

  private updateSession(id: string, updates: Partial<CodingToolSession>): void {
    const session = this.sessions.get(id);
    if (session) {
      Object.assign(session, updates);
    }
  }

  private spawnTool(
    sessionId: string,
    adapter: ToolAdapter,
    workdir: string,
    args: string[],
    env: Record<string, string | undefined>,
    timeoutMs: number,
    onEvent?: (event: CodingToolEvent) => void,
    binaryPath?: string,
  ): Promise<CodingToolResult> {
    return new Promise((resolve, reject) => {
      const binary = resolveBinary(adapter.binaryName, binaryPath) ?? adapter.binaryName;
      const proc = spawn(binary, args, {
        cwd: workdir,
        env: env as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: isWindows(),
      });

      this.processes.set(sessionId, proc);
      proc.stdin?.end();

      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        proc.kill();
        setTimeout(() => {
          try {
            if (!proc.killed) proc.kill('SIGKILL');
          } catch { /* already dead */ }
        }, 5000);
        this.updateSession(sessionId, { status: 'timeout' });
        reject(new Error(`Tool execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;

        for (const line of text.split('\n')) {
          const event = adapter.parseOutput(line);
          if (event) {
            onEvent?.(event);
            if (event.type === 'progress') {
              this.updateSession(sessionId, { progressMessage: event.content });
            }
          }
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        this.processes.delete(sessionId);

        const session = this.sessions.get(sessionId);
        if (session?.status === 'cancelled') {
          resolve({
            success: false,
            summary: 'Session cancelled',
            exitCode: code ?? -1,
          });
          return;
        }

        const success = code === 0;
        const rawOutput = stdout.slice(0, 50_000);

        resolve({
          success,
          summary: success ? 'Tool completed successfully' : `Tool exited with code ${code}`,
          rawOutput,
          error: success ? undefined : stderr || `Exit code: ${code}`,
          exitCode: code ?? -1,
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        this.processes.delete(sessionId);
        reject(err);
      });
    });
  }
}
