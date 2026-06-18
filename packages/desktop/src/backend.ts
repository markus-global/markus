import type { BackendInstance, StartBackendOptions } from '@markus-global/cli/backend';

let instance: BackendInstance | null = null;

export async function startMarkusBackend(options?: Partial<StartBackendOptions>): Promise<BackendInstance> {
  // Dynamic import to avoid bundling issues with workspace packages
  const { startBackend } = await import('@markus-global/cli/backend');

  instance = await startBackend({
    autoInit: true,
    ...options,
  });

  return instance;
}

export async function shutdownBackend(): Promise<void> {
  if (instance) {
    await instance.shutdown();
    instance = null;
  }
}

export function getBackendInstance(): BackendInstance | null {
  return instance;
}
