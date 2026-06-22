import {
  resolveWhich,
  execSafeSync,
  type ToolAdapter,
  type ToolAdapterDetectResult,
  type ToolAdapterBuildArgsResult,
  type ToolAdapterBuildOpts,
  type ToolAdapterModel,
  type ToolAdapterModelsResult,
  type CodingToolEvent,
  type ToolCostReport,
} from '@markus/shared';

let _codexModelsCache: { models: ToolAdapterModel[]; expiresAt: number } | null = null;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

export class CodexAdapter implements ToolAdapter {
  readonly name = 'codex' as const;
  readonly displayName = 'Codex';
  readonly binaryName = 'codex';

  async detect(): Promise<ToolAdapterDetectResult> {
    const path = resolveWhich('codex');
    if (!path) {
      return { available: false, installHint: 'npm install -g @openai/codex' };
    }

    let version: string | undefined;
    const verResult = execSafeSync(path, ['--version'], { timeout: 5000 });
    if (verResult.exitCode === 0 && verResult.stdout) version = verResult.stdout;

    const authenticated = !!process.env.OPENAI_API_KEY;

    return {
      available: true,
      version,
      path,
      authenticated,
      authHint: authenticated ? undefined : 'Set OPENAI_API_KEY environment variable',
    };
  }

  async listModels(): Promise<ToolAdapterModelsResult> {
    if (_codexModelsCache && Date.now() < _codexModelsCache.expiresAt) {
      return { models: _codexModelsCache.models, source: 'cli' };
    }
    const bin = resolveWhich('codex');
    if (!bin) return { models: [], source: 'cli' };
    const { stdout, exitCode } = execSafeSync(bin, ['debug', 'models', '--json'], { timeout: 3000 });
    if (exitCode !== 0 || !stdout) return { models: [], source: 'cli' };

    try {
      const data = JSON.parse(stdout);
      const items = Array.isArray(data) ? data : (data.models ?? []);
      const models: ToolAdapterModel[] = items
        .filter((m: Record<string, unknown>) => m.id || m.model_id || m.name)
        .map((m: Record<string, unknown>) => ({
          id: String(m.id ?? m.model_id ?? m.name),
          name: String(m.display_name ?? m.name ?? m.id ?? m.model_id),
          isDefault: m.default === true || undefined,
        }));
      _codexModelsCache = { models, expiresAt: Date.now() + MODEL_CACHE_TTL_MS };
      return { models, source: 'cli' };
    } catch {
      return { models: [], source: 'cli' };
    }
  }

  buildArgs(opts: ToolAdapterBuildOpts): ToolAdapterBuildArgsResult {
    const args = ['exec', '--full-auto', '--json', '--skip-git-repo-check'];

    const effectiveModel = opts.model || opts.config?.defaultModel;
    if (effectiveModel) args.push('-m', effectiveModel);

    if (opts.config?.defaultArgs) args.push(...opts.config.defaultArgs);
    args.push(opts.prompt);

    const env: Record<string, string> = { ...opts.config?.env };
    if (opts.effort) env.CODEX_REASONING_EFFORT = opts.effort;
    return { args, env };
  }

  parseOutput(line: string): CodingToolEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    const timestamp = new Date().toISOString();

    try {
      const event = JSON.parse(trimmed);
      if (event.type === 'message' && event.content) {
        return { type: 'progress', content: event.content, timestamp };
      }
      return null;
    } catch {
      return { type: 'progress', content: trimmed, timestamp };
    }
  }

  extractCost(_output: string): ToolCostReport | null {
    return null;
  }
}
