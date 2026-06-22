import type { Command } from 'commander';
import { PROVIDERS } from '@markus/shared';
import { detail, fail } from '../output.js';

const C = { GREEN: '\x1b[32m', CYAN: '\x1b[36m', DIM: '\x1b[2m', RESET: '\x1b[0m', BOLD: '\x1b[1m' };

export function registerModelsCommand(program: Command) {
  program
    .command('models [provider]')
    .description('List available models for providers')
    .action(async (provider: string | undefined) => {
      const json = program.optsWithGlobals().json;

      if (provider) {
        const pdef = PROVIDERS.find(p => p.id === provider);
        if (!pdef) {
          fail(
            `Unknown provider: ${provider}. Available: ${PROVIDERS.map(p => p.id).join(', ')}`,
          );
          return;
        }
        if (json) {
          detail({ [pdef.id]: pdef.models });
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
        detail(Object.fromEntries(PROVIDERS.map(p => [p.id, p.models])));
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
