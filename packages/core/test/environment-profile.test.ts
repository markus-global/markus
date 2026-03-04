import { describe, it, expect, afterEach } from 'vitest';
import { detectEnvironment, clearEnvironmentCache, type EnvironmentProfile } from '../src/environment-profile.js';

describe('EnvironmentProfile', () => {
  afterEach(() => {
    clearEnvironmentCache();
  });

  it('should detect the current OS', async () => {
    const profile = await detectEnvironment();
    expect(profile.os.platform).toBeTruthy();
    expect(['darwin', 'linux', 'win32']).toContain(profile.os.platform);
    expect(profile.os.arch).toBeTruthy();
    expect(profile.os.release).toBeTruthy();
  });

  it('should detect the shell', async () => {
    const profile = await detectEnvironment();
    expect(profile.shell).toBeTruthy();
  });

  it('should detect at least node runtime', async () => {
    const profile = await detectEnvironment();
    const nodeRuntime = profile.runtimes.find(r => r.name === 'node');
    expect(nodeRuntime).toBeDefined();
    expect(nodeRuntime!.version).toBeTruthy();
  });

  it('should report CPU and memory resources', async () => {
    const profile = await detectEnvironment();
    expect(profile.resources.cpuCores).toBeGreaterThan(0);
    expect(profile.resources.memoryMB).toBeGreaterThan(0);
  });

  it('should accept a custom working directory', async () => {
    const profile = await detectEnvironment('/tmp');
    expect(profile.workdir).toBe('/tmp');
  });

  it('should cache results for 5 minutes', async () => {
    const profile1 = await detectEnvironment();
    const profile2 = await detectEnvironment();
    expect(profile1).toBe(profile2);
  });

  it('should clear cache', async () => {
    const profile1 = await detectEnvironment();
    clearEnvironmentCache();
    const profile2 = await detectEnvironment();
    expect(profile1).not.toBe(profile2);
    expect(profile2.os.platform).toBe(profile1.os.platform);
  });

  it('should have a valid detectedAt timestamp', async () => {
    const profile = await detectEnvironment();
    const ts = new Date(profile.detectedAt).getTime();
    expect(ts).toBeLessThanOrEqual(Date.now());
    expect(ts).toBeGreaterThan(Date.now() - 30000);
  });

  it('should detect git as a tool', async () => {
    const profile = await detectEnvironment();
    const git = profile.tools.find(t => t.name === 'git');
    expect(git).toBeDefined();
    expect(git!.version).toBeTruthy();
  });

  it('should detect package managers', async () => {
    const profile = await detectEnvironment();
    expect(profile.packageManagers.length).toBeGreaterThan(0);
    expect(profile.packageManagers).toContain('npm');
  });
});
