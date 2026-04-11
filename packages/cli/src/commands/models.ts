import type { Command } from 'commander';
import { PROVIDERS } from '@markus/shared';

const C = { GREEN: '\x1b[32m', CYAN: '\x1b[36m', DIM: '\x1b[2m', RESET: '\x1b[0m', BOLD: '\x1b[1m' };

export function registerModelsCommand(program: Command) {
  program
    .command('models [provider]')
    .description('List available models for providers')
    .option('--json', 'Output as JSON')
    .action(async (provider, opts) => {
      const { json } = opts as { json?: boolean };

      if (provider) {
        const pdef = PROVIDERS.find(p => p.id === provider);
        if (!pdef) {
          console.log(`Unknown provider: ${provider}`);
          console.log(`Available: ${PROVIDERS.map(p => p.id).join(', ')}`);
          return;
        }
        if (json) {
          console.log(JSON.stringify({ [pdef.id]: pdef.models }, null, 2));
          return;
        }
        console.log(`\n${C.BOLD}${pdef.label} Models${C.RESET}\n`);
        pdef.models.forEach((m, i) => {
          const rec = m === pdef.defaultModel ? ` ${C.GREEN}(default)${C.RESET}` : '';
          console.log(`  ${i + 1}. ${m}${rec}`);
        });
        console.log(`\n  ${C.DIM}Env: ${pdef.envKey}${pdef.baseUrl ? ` | BaseURL: ${pdef.baseUrl}` : ''}${C.RESET}\n`);
        return;
      }

      if (json) {
        console.log(JSON.stringify(Object.fromEntries(PROVIDERS.map(p => [p.id, p.models])), null, 2));
        return;
      }

      console.log(`\n${C.BOLD}╔══════════════════════════════════════════════════════════════╗
║                   Markus Model Directory                 ║
╚══════════════════════════════════════════════════════════════╝${C.RESET}\n`);
      for (const p of PROVIDERS) {
        const models = p.models.length > 1 ? ` +${p.models.length - 1} more` : '';
        console.log(`  ${C.BOLD}${p.label.padEnd(14)}${C.RESET} ${C.CYAN}${p.id.padEnd(12)}${C.RESET} ${p.models[0]}${C.DIM}${models}${C.RESET}`);
      }
      console.log(`\n  ${C.DIM}Run: markus models <provider>${C.RESET}\n`);
    });
}
