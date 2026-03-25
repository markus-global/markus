import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const configPath = join(homedir(), '.markus', 'markus.json');
let port = 8056;
try {
  if (existsSync(configPath)) {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (cfg.server?.apiPort) port = cfg.server.apiPort;
  }
} catch { /* use default */ }

console.log(`Waiting for API on port ${port}...`);
execSync(`npx wait-on tcp:${port}`, { stdio: 'inherit' });
