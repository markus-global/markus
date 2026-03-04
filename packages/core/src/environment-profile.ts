import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform, arch, release, homedir, cpus, totalmem } from 'node:os';
import { createLogger } from '@markus/shared';

const log = createLogger('environment-profile');

export interface ToolInfo {
  name: string;
  version: string;
  path: string;
}

export interface BrowserInfo {
  name: string;
  path: string;
}

export interface RuntimeInfo {
  name: string;
  version: string;
}

export interface EnvironmentProfile {
  os: { platform: string; arch: string; release: string };
  shell: string;
  homedir: string;
  workdir: string;
  tools: ToolInfo[];
  browsers: BrowserInfo[];
  runtimes: RuntimeInfo[];
  packageManagers: string[];
  resources: {
    cpuCores: number;
    memoryMB: number;
    diskFreeMB: number;
  };
  detectedAt: string;
}

function tryExec(cmd: string, timeoutMs = 5000): string | null {
  try {
    return execSync(cmd, { timeout: timeoutMs, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function extractVersion(output: string | null): string {
  if (!output) return '';
  const match = output.match(/(\d+\.\d+[\w.-]*)/);
  return match ? match[1]! : output.slice(0, 30);
}

function whichCmd(name: string): string | null {
  return tryExec(platform() === 'win32' ? `where ${name}` : `which ${name}`);
}

function detectShell(): string {
  return process.env['SHELL'] ?? process.env['ComSpec'] ?? '/bin/sh';
}

function detectTools(): ToolInfo[] {
  const checks: Array<{ name: string; cmd: string }> = [
    { name: 'git', cmd: 'git --version' },
    { name: 'docker', cmd: 'docker --version' },
    { name: 'kubectl', cmd: 'kubectl version --client --short 2>/dev/null || kubectl version --client 2>&1' },
    { name: 'curl', cmd: 'curl --version' },
    { name: 'wget', cmd: 'wget --version' },
    { name: 'make', cmd: 'make --version' },
    { name: 'gcc', cmd: 'gcc --version' },
    { name: 'rustc', cmd: 'rustc --version' },
    { name: 'go', cmd: 'go version' },
  ];

  const tools: ToolInfo[] = [];
  for (const { name, cmd } of checks) {
    const output = tryExec(cmd, 3000);
    if (output) {
      const toolPath = whichCmd(name) ?? '';
      tools.push({ name, version: extractVersion(output), path: toolPath });
    }
  }
  return tools;
}

function detectRuntimes(): RuntimeInfo[] {
  const checks: Array<{ name: string; cmd: string }> = [
    { name: 'node', cmd: 'node --version' },
    { name: 'python3', cmd: 'python3 --version 2>&1' },
    { name: 'python', cmd: 'python --version 2>&1' },
    { name: 'java', cmd: 'java -version 2>&1' },
    { name: 'ruby', cmd: 'ruby --version' },
    { name: 'php', cmd: 'php --version' },
    { name: 'deno', cmd: 'deno --version' },
    { name: 'bun', cmd: 'bun --version' },
  ];

  const runtimes: RuntimeInfo[] = [];
  const seen = new Set<string>();
  for (const { name, cmd } of checks) {
    if (name === 'python' && seen.has('python3')) continue;
    const output = tryExec(cmd, 3000);
    if (output) {
      runtimes.push({ name, version: extractVersion(output) });
      seen.add(name);
    }
  }
  return runtimes;
}

function detectPackageManagers(): string[] {
  const managers = ['npm', 'pnpm', 'yarn', 'pip', 'pip3', 'brew', 'apt', 'cargo', 'gem'];
  return managers.filter(m => whichCmd(m) !== null);
}

function detectBrowsers(): BrowserInfo[] {
  const browsers: BrowserInfo[] = [];
  const p = platform();

  if (p === 'darwin') {
    const macBrowsers: Array<{ name: string; path: string }> = [
      { name: 'chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { name: 'firefox', path: '/Applications/Firefox.app/Contents/MacOS/firefox' },
      { name: 'safari', path: '/Applications/Safari.app/Contents/MacOS/Safari' },
      { name: 'edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    ];
    for (const b of macBrowsers) {
      if (existsSync(b.path)) browsers.push(b);
    }
  } else if (p === 'linux') {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'firefox']) {
      const path = whichCmd(name);
      if (path) {
        browsers.push({ name: name.replace(/-stable$/, '').replace(/-browser$/, ''), path });
        break;
      }
    }
  } else if (p === 'win32') {
    const winPaths: Array<{ name: string; path: string }> = [
      { name: 'chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
      { name: 'edge', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
    ];
    for (const b of winPaths) {
      if (existsSync(b.path)) browsers.push(b);
    }
  }

  return browsers;
}

function detectDiskFree(): number {
  try {
    const p = platform();
    if (p === 'win32') {
      const output = tryExec('wmic logicaldisk get freespace /format:value');
      if (output) {
        const match = output.match(/FreeSpace=(\d+)/);
        return match ? Math.floor(parseInt(match[1]!, 10) / (1024 * 1024)) : 0;
      }
    } else {
      const output = tryExec("df -m / | tail -1 | awk '{print $4}'");
      return output ? parseInt(output, 10) || 0 : 0;
    }
  } catch { /* ignore */ }
  return 0;
}

let cachedProfile: EnvironmentProfile | null = null;

export async function detectEnvironment(workdir?: string): Promise<EnvironmentProfile> {
  if (cachedProfile && Date.now() - new Date(cachedProfile.detectedAt).getTime() < 300_000) {
    return cachedProfile;
  }

  log.info('Detecting runtime environment...');
  const start = Date.now();

  const profile: EnvironmentProfile = {
    os: { platform: platform(), arch: arch(), release: release() },
    shell: detectShell(),
    homedir: homedir(),
    workdir: workdir ?? process.cwd(),
    tools: detectTools(),
    browsers: detectBrowsers(),
    runtimes: detectRuntimes(),
    packageManagers: detectPackageManagers(),
    resources: {
      cpuCores: cpus().length,
      memoryMB: Math.floor(totalmem() / (1024 * 1024)),
      diskFreeMB: detectDiskFree(),
    },
    detectedAt: new Date().toISOString(),
  };

  cachedProfile = profile;
  const elapsed = Date.now() - start;
  log.info('Environment detection complete', {
    os: `${profile.os.platform} ${profile.os.arch}`,
    tools: profile.tools.length,
    runtimes: profile.runtimes.length,
    browsers: profile.browsers.length,
    elapsedMs: elapsed,
  });

  return profile;
}

export function clearEnvironmentCache(): void {
  cachedProfile = null;
}
