import type { Command } from 'commander';
import { loadConfig } from '@markus/shared';

const C = { GREEN: '\x1b[32m', YELLOW: '\x1b[33m', CYAN: '\x1b[36m', DIM: '\x1b[2m', RESET: '\x1b[0m', BOLD: '\x1b[1m' };
const ok = (t: string, d = '') => console.log(`  ${C.GREEN}✓${C.RESET} ${t}${d ? ` ${C.DIM}${d}${C.RESET}` : ''}`);
const warn = (t: string, d = '') => console.log(`  ${C.YELLOW}⚠${C.RESET} ${t}${d ? ` ${C.DIM}${d}${C.RESET}` : ''}`);
const info = (t: string) => console.log(`    ${C.CYAN}→${C.RESET} ${t}`);

export function registerGatewayCommand(program: Command) {
  const gateway = program
    .command('gateway')
    .description('Gateway service management (status, config, logs)');

  gateway
    .command('status')
    .description('Show gateway service status')
    .action(async () => {
      const config = loadConfig(undefined);
      const secret = config.security?.gatewaySecret ?? '';
      const secretMasked = secret.length > 8 ? secret.slice(0, 4) + '****' + secret.slice(-3) : '****';

      console.log(`\n${C.BOLD}╔══════════════════════════════════════════════════════════════╗
║                  ${C.CYAN}Markus Gateway Status${C.RESET}${C.BOLD}                      ║
╚══════════════════════════════════════════════════════════════╝${C.RESET}\n`);

      const port = config.server?.apiPort ?? 8056;
      try {
        const res = await fetch(`http://localhost:${port}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          ok('Gateway API', `running on port ${port}`);
        }
      } catch {
        warn('Gateway API', `not reachable on port ${port}`);
        info('Start with: markus start');
      }

      console.log(`\n  ${C.BOLD}Configuration:${C.RESET}`);
      info(`API Port: ${config.server?.apiPort ?? 8056}`);
      info(`Web Port: ${config.server?.webPort ?? 8057}`);
      info(`Gateway Secret: ${secretMasked}`);

      const integrations = config.integrations as Record<string, any> ?? {};
      const channels = Object.keys(integrations).filter(k => !!(integrations[k] as any));
      if (channels.length > 0) {
        console.log(`\n  ${C.BOLD}Active Channels:${C.RESET}`);
        for (const ch of channels) {
          info(ch);
        }
      }
      console.log('');
    });

  gateway
    .command('logs')
    .description('Show recent gateway logs')
    .option('--lines <n>', 'Number of lines', '50')
    .action(async (opts) => {
      const lines = parseInt(opts.lines ?? '50', 10);
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      const fs = await import('node:fs');
      const logPath = join(homedir(), '.markus', 'logs', 'markus.log');

      if (!fs.existsSync(logPath)) {
        warn('No log file found', logPath);
        return;
      }

      try {
        const content = fs.readFileSync(logPath, 'utf8');
        const allLines = content.split('\n');
        const recent = allLines.slice(-lines);
        for (const line of recent) {
          console.log(line);
        }
      } catch (e) {
        warn(`Could not read log file: ${e}`);
      }
    });

  gateway
    .command('config')
    .description('Show current gateway configuration (masked)')
    .action(async () => {
      const config = loadConfig(undefined);
      const safe = JSON.stringify(config, (key, value) => {
        if (
          typeof value === 'string' &&
          (key.toLowerCase().includes('secret') ||
            key.toLowerCase().includes('key') ||
            key.toLowerCase().includes('token')) &&
          value.length > 8
        ) {
          return value.slice(0, 4) + '****' + value.slice(-3);
        }
        return value;
      }, 2);
      console.log(safe);
    });
}