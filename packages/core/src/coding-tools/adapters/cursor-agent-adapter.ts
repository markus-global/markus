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
import { execFile } from 'node:child_process';
import { request as httpsRequest } from 'node:https';

let _cursorModelsCache: { result: ToolAdapterModelsResult; expiresAt: number } | null = null;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const CURSOR_API_BASE = 'https://api.cursor.com';

function execFileAsync(cmd: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { encoding: 'utf-8', timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ stdout: (stdout ?? '').trim(), stderr: (stderr ?? '').trim(), exitCode: (err as any).code === 'ETIMEDOUT' ? -1 : ((err as any).status ?? 1) });
      } else {
        resolve({ stdout: (stdout ?? '').trim(), stderr: (stderr ?? '').trim(), exitCode: 0 });
      }
    });
    child.on('error', () => resolve({ stdout: '', stderr: 'spawn error', exitCode: 1 }));
  });
}

function fetchJson(url: string, apiKey: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = httpsRequest(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        timeout: 10_000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); }
            catch { reject(new Error(`Invalid JSON from ${url}`)); }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}

export class CursorAgentAdapter implements ToolAdapter {
  readonly name = 'cursor-agent' as const;
  readonly displayName = 'Cursor Agent';
  readonly binaryName = 'cursor';

  async detect(): Promise<ToolAdapterDetectResult> {
    const path = resolveWhich('cursor');
    if (!path) {
      return { available: false, installHint: 'Install Cursor from https://cursor.com/downloads then run: cursor agent install-shell-integration' };
    }

    let version: string | undefined;
    try {
      const { stdout } = execSafeSync(path, ['--version'], { timeout: 5000 });
      if (stdout) version = stdout;
    } catch { /* optional */ }

    let authenticated = false;
    let authUser: string | undefined;
    const { stdout: statusOut } = execSafeSync(path, ['agent', 'status'], { timeout: 5000 });
    if (statusOut) {
      authenticated = !statusOut.toLowerCase().includes('not logged in');
      if (authenticated) authUser = statusOut;
    }

    return {
      available: true,
      version,
      path,
      authenticated,
      authHint: authenticated ? undefined : 'Run `cursor agent login` or set CURSOR_API_KEY environment variable',
      authUser,
    };
  }

  async listModels(): Promise<ToolAdapterModelsResult> {
    if (_cursorModelsCache && Date.now() < _cursorModelsCache.expiresAt) {
      return _cursorModelsCache.result;
    }

    // Always use CLI models since execution goes through `cursor agent` CLI.
    // The Cloud API (/v1/models) returns models for the REST API which are
    // NOT compatible with the CLI's --model flag.
    const cliResult = await this.listModelsViaCli();
    if (cliResult.models.length > 0) {
      _cursorModelsCache = { result: cliResult, expiresAt: Date.now() + MODEL_CACHE_TTL_MS };
    }
    return cliResult;
  }

  private async listModelsViaApi(apiKey: string): Promise<ToolAdapterModelsResult> {
    const body = await fetchJson(`${CURSOR_API_BASE}/v1/models`, apiKey);
    const items = (body.items ?? []) as Array<Record<string, unknown>>;
    const models: ToolAdapterModel[] = [];

    for (const item of items) {
      const id = String(item.id ?? '');
      const displayName = String(item.displayName ?? id);
      if (!id) continue;

      const variants = item.variants as Array<Record<string, unknown>> | undefined;
      if (variants && variants.length > 1) {
        for (const v of variants) {
          const vName = String(v.displayName ?? displayName);
          const params = v.params as Array<{ id: string; value: string }> | undefined;
          const paramSuffix = params?.length
            ? `[${params.map(p => `${p.id}=${p.value}`).join(',')}]`
            : '';
          models.push({
            id: paramSuffix ? `${id}${paramSuffix}` : id,
            name: vName,
            isDefault: v.isDefault === true || undefined,
          });
        }
      } else {
        const isDefault = variants?.[0]?.isDefault === true;
        models.push({ id, name: displayName, isDefault: isDefault || undefined });
      }
    }

    return { models, source: 'api' };
  }

  private async listModelsViaCli(): Promise<ToolAdapterModelsResult> {
    const bin = resolveWhich('cursor');
    if (!bin) return { models: [], source: 'cli' };
    const { stdout, stderr, exitCode } = await execFileAsync(bin, ['agent', '--list-models'], 15_000);
    if (exitCode !== 0 || !stdout) {
      if (stderr || exitCode !== 0) {
        console.error(`[cursor-adapter] listModels CLI failed: exit=${exitCode} stderr=${stderr.slice(0, 200)}`);
      }
      return { models: [], source: 'cli' };
    }

    const models: ToolAdapterModel[] = [];
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^(\S+)\s+-\s+(.+)$/);
      if (!match) continue;
      const id = match[1];
      const rest = match[2];
      const isDefault = /\(default\)/.test(rest) || /\(current,\s*default\)/.test(rest);
      const isCurrent = /\(current\)/.test(rest) || /\(current,/.test(rest);
      const name = rest.replace(/\s*\([^)]*\)\s*/g, '').trim();
      models.push({ id, name, isDefault: (isDefault || isCurrent) || undefined });
    }

    return { models, source: 'cli' };
  }

  buildArgs(opts: ToolAdapterBuildOpts): ToolAdapterBuildArgsResult {
    const args = [
      'agent',
      '--print',
      '--output-format', 'stream-json',
      '--workspace', opts.workdir,
      '--trust',
      '--force',
    ];

    const effectiveModel = opts.model || opts.config?.defaultModel;
    if (effectiveModel) args.push('--model', effectiveModel);

    if (opts.mode) args.push('--mode', opts.mode);

    if (opts.config?.defaultArgs) args.push(...opts.config.defaultArgs);

    args.push(opts.prompt);

    const env: Record<string, string> = { ...opts.config?.env };
    return { args, env };
  }

  parseOutput(line: string): CodingToolEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    const timestamp = new Date().toISOString();

    try {
      const event = JSON.parse(trimmed);

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

      if (event.type === 'text') {
        return { type: 'progress', content: event.content ?? event.text ?? trimmed, timestamp };
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
        return { type: 'progress', content: trimmed, timestamp };
      }
      return null;
    }
  }

  extractCost(output: string): ToolCostReport | null {
    for (const line of output.split('\n')) {
      try {
        const event = JSON.parse(line.trim());
        if (event.type === 'result' && (event.cost_usd !== null && event.cost_usd !== undefined || event.input_tokens !== null && event.input_tokens !== undefined)) {
          return {
            inputTokens: event.input_tokens,
            outputTokens: event.output_tokens,
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
