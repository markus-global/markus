/**
 * Reusable backend startup for both CLI and Electron desktop app.
 * Provides a clean programmatic API to start the Markus server.
 */

import { existsSync } from 'node:fs';
import {
  loadConfig,
  getDefaultConfigPath,
} from '@markus/shared';
import type { APIServer } from '@markus/org-manager';

export interface BackendInstance {
  apiServer: APIServer;
  port: number;
  url: string;
  shutdown(): Promise<void>;
}

export interface StartBackendOptions {
  /** Path to markus.json config file */
  configPath?: string;
  /** Override API port (defaults to config.server.apiPort) */
  port?: number;
  /** Called when the server is ready and listening */
  onReady?: (instance: BackendInstance) => void;
  /** Called with progress messages during startup */
  onProgress?: (step: string, message: string) => void;
  /** If true, auto-run quickInit when no config exists (default: true) */
  autoInit?: boolean;
}

/**
 * Start the Markus backend server programmatically.
 * This is the entry point used by both the CLI `markus start` command
 * and the Electron desktop app.
 *
 * Unlike the CLI's startServer(), this function:
 * - Does NOT show animated progress in terminal
 * - Does NOT open a browser
 * - Does NOT block forever (returns a BackendInstance handle)
 * - Does NOT register SIGINT handlers (caller manages lifecycle)
 */
export async function startBackend(options: StartBackendOptions = {}): Promise<BackendInstance> {
  const configPath = options.configPath ?? getDefaultConfigPath();

  // Auto-init if no config exists
  if ((options.autoInit !== false) && !existsSync(configPath)) {
    const { quickInit } = await import('./commands/init.js');
    await quickInit({ nonInteractive: true });
  }

  const config = loadConfig(options.configPath);

  // Suppress browser auto-open
  process.env['NO_BROWSER'] = '1';

  // Import and call the server startup (reuses full wiring from start.ts)
  const { startServerHeadless } = await import('./commands/start.js');
  const instance = await startServerHeadless(config, {
    port: options.port,
    config: options.configPath,
    onProgress: options.onProgress,
  });

  if (options.onReady) {
    options.onReady(instance);
  }

  return instance;
}
