import {
  resolveWhich,
  execSafeSync,
  type ToolAdapter,
  type ToolAdapterDetectResult,
  type ToolAdapterBuildArgsResult,
  type ToolAdapterBuildOpts,
  type ToolAdapterModelsResult,
  type CodingToolEvent,
  type ToolCostReport,
} from '@markus/shared';

export class ClaudeCodeAdapter implements ToolAdapter {
  readonly name = 'claude-code' as const;
  readonly displayName = 'Claude Code';
  readonly binaryName = 'claude';

  async detect(): Promise<ToolAdapterDetectResult> {
    const path = resolveWhich('claude');
    if (!path) {
      return { available: false, installHint: 'npm install -g @anthropic-ai/claude-code' };
    }

    let version: string | undefined;
    const verResult = execSafeSync(path, ['--version'], { timeout: 5000 });
    if (verResult.exitCode === 0 && verResult.stdout) version = verResult.stdout;

    let authenticated = false;
    let authUser: string | undefined;
    const statusResult = execSafeSync(path, ['api-key-status'], { timeout: 10_000 });
    const statusOut = statusResult.stdout;
    if (statusOut) {
      authenticated = !statusOut.toLowerCase().includes('not authenticated') && !statusOut.toLowerCase().includes('invalid api key');
      if (authenticated && statusOut.length < 200) authUser = statusOut;
    }

    return {
      available: true,
      version,
      path,
      authenticated,
      authHint: authenticated ? undefined : 'Run `claude` to complete interactive login, or set ANTHROPIC_API_KEY',
      authUser,
    };
  }

  async listModels(): Promise<ToolAdapterModelsResult> {
    return {
      models: [
        { id: 'sonnet', name: 'Claude Sonnet (latest)', isDefault: true },
        { id: 'opus', name: 'Claude Opus (latest)' },
        { id: 'haiku', name: 'Claude Haiku (latest)' },
        { id: 'fable', name: 'Claude Fable (latest)' },
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
        { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
        { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
        { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
      ],
      source: 'static',
    };
  }

  buildArgs(opts: ToolAdapterBuildOpts): ToolAdapterBuildArgsResult {
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--max-turns', '50',
    ];

    const effectiveModel = opts.model || opts.config?.defaultModel;
    if (effectiveModel) args.push('--model', effectiveModel);

    const mode = opts.mode || 'bypassPermissions';
    args.push('--permission-mode', mode);

    if (opts.effort) args.push('--effort', opts.effort);

    const budgetUsd = opts.maxBudgetUsd ?? opts.config?.maxBudgetPerSessionUsd;
    if (budgetUsd !== null && budgetUsd !== undefined && budgetUsd > 0) args.push('--max-budget-usd', String(budgetUsd));

    if (opts.config?.defaultArgs) {
      args.push(...opts.config.defaultArgs);
    }

    args.push(opts.prompt);

    const env: Record<string, string> = {
      ...opts.config?.env,
    };

    return { args, env };
  }

  parseOutput(line: string): CodingToolEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    try {
      const event = JSON.parse(trimmed);
      const timestamp = new Date().toISOString();

      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'text') {
            return { type: 'progress', content: block.text, timestamp };
          }
          if (block.type === 'tool_use') {
            const name = block.name || 'unknown';
            return {
              type: name.includes('edit') || name.includes('write') ? 'file_edit' : 'tool_use',
              content: `${name}: ${JSON.stringify(block.input || {}).slice(0, 200)}`,
              metadata: { toolName: name, input: block.input },
              timestamp,
            };
          }
        }
      }

      if (event.type === 'result') {
        return {
          type: 'completed',
          content: typeof event.result === 'string' ? event.result : JSON.stringify(event.result),
          metadata: {
            costUsd: event.cost_usd,
            inputTokens: event.input_tokens,
            outputTokens: event.output_tokens,
          },
          timestamp,
        };
      }

      return null;
    } catch {
      if (trimmed.length > 0) {
        return { type: 'progress', content: trimmed, timestamp: new Date().toISOString() };
      }
      return null;
    }
  }

  extractCost(output: string): ToolCostReport | null {
    for (const line of output.split('\n')) {
      try {
        const event = JSON.parse(line.trim());
        if (event.type === 'result') {
          return {
            inputTokens: event.input_tokens,
            outputTokens: event.output_tokens,
            cacheReadTokens: event.cache_read_tokens,
            cacheWriteTokens: event.cache_write_tokens,
            estimatedCostUsd: event.cost_usd,
            source: 'tool_output',
          };
        }
      } catch {
        continue;
      }
    }
    return null;
  }
}
