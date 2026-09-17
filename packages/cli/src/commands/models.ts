import type { Command } from 'commander';
import { PROVIDERS, type ProviderModel } from '@markus/shared';
import { detail, fail } from '../output.js';
import { listProviderModels, listProviderModelsBatch, resolveApiKey } from '../lib/provider-models.js';

const C = { GREEN: '\x1b[32m', CYAN: '\x1b[36m', DIM: '\x1b[2m', YELLOW: '\x1b[33m', RESET: '\x1b[0m', BOLD: '\x1b[1m' };

/** Providers whose model listing needs no credential. */
const KEYLESS_PROVIDERS = new Set(['ollama', 'markus']);

interface ListedModels {
  provider: ProviderModel;
  models: string[];
  source: 'live' | 'bootstrap';
  error?: string;
}

/**
 * Model ids are always asked from the provider itself. We only skip the network
 * call when the provider needs a credential we do not have — a keyless listing
 * would just 401, and the bootstrap model from the registry is more useful than
 * an error.
 */
async function listFor(pdef: ProviderModel, offline: boolean): Promise<ListedModels> {
  if (offline) {
    return {
      provider: pdef,
      models: pdef.defaultModel ? [pdef.defaultModel] : [],
      source: 'bootstrap',
    };
  }
  if (!KEYLESS_PROVIDERS.has(pdef.id) && !resolveApiKey(pdef)) {
    return {
      provider: pdef,
      models: pdef.defaultModel ? [pdef.defaultModel] : [],
      source: 'bootstrap',
      error: 'no API key configured',
    };
  }
  return listProviderModels(pdef);
}

export function registerModelsCommand(program: Command) {
  program
    .command('models [provider]')
    .description('List a provider\'s models (asked from the provider itself)')
    .option('--offline', 'skip the provider call and show only the configured/default model')
    .action(async (provider: string | undefined, opts: { offline?: boolean }) => {
      const json = program.optsWithGlobals().json;
      const offline = !!opts.offline || !!program.optsWithGlobals().offline;

      if (provider) {
        const pdef = PROVIDERS.find(p => p.id === provider);
        if (!pdef) {
          fail(
            `Unknown provider: ${provider}. Available: ${PROVIDERS.map(p => p.id).join(', ')}`,
          );
          return;
        }
        const listed = await listFor(pdef, offline);
        if (json) {
          detail({ [pdef.id]: listed.models });
          return;
        }
        const tag = listed.source === 'live'
          ? `${C.GREEN}live${C.RESET}`
          : `${C.YELLOW}bootstrap${C.RESET}`;
        console.log(`\n${C.BOLD}${pdef.label} Models${C.RESET} ${C.DIM}(${tag}${C.DIM})${C.RESET}\n`);
        listed.models.forEach((m, i) => {
          const rec = m === pdef.defaultModel ? ` ${C.GREEN}(default)${C.RESET}` : '';
          console.log(`  ${i + 1}. ${m}${rec}`);
        });
        if (listed.source === 'bootstrap' && listed.error) {
          console.log(`\n  ${C.DIM}Live listing unavailable: ${listed.error}${C.RESET}`);
          console.log(`  ${C.DIM}Set ${pdef.envKey} to query the provider's model list.${C.RESET}`);
        }
        console.log(`\n  ${C.DIM}Env: ${pdef.envKey}${pdef.baseUrl ? ` | BaseURL: ${pdef.baseUrl}` : ''}${C.RESET}\n`);
        return;
      }

      const listable = PROVIDERS.filter(p => offline || KEYLESS_PROVIDERS.has(p.id) || resolveApiKey(p));
      const rest = PROVIDERS.filter(p => !listable.includes(p));
      const live = offline ? [] : await listProviderModelsBatch(listable);
      const results: ListedModels[] = [
        ...live,
        ...rest.map(p => ({
          provider: p,
          models: p.defaultModel ? [p.defaultModel] : [],
          source: 'bootstrap' as const,
        })),
      ];
      // Preserve registry order in the output.
      const byId = new Map(results.map(r => [r.provider.id, r]));
      const ordered = PROVIDERS.map(p => byId.get(p.id)!).filter(Boolean);

      if (json) {
        detail(Object.fromEntries(ordered.map(r => [r.provider.id, r.models])));
        return;
      }

      console.log(`\n${C.BOLD}╔══════════════════════════════════════════════════════════════╗
║                   Markus Model Directory                 ║
╚══════════════════════════════════════════════════════════════╝${C.RESET}\n`);
      for (const r of ordered) {
        const p = r.provider;
        const head = r.models[0] ?? `${C.DIM}—${C.RESET}`;
        const more = r.models.length > 1 ? ` +${r.models.length - 1} more` : '';
        const mark = r.source === 'live' ? `${C.GREEN}●${C.RESET}` : `${C.DIM}○${C.RESET}`;
        console.log(`  ${mark} ${C.BOLD}${p.label.padEnd(14)}${C.RESET} ${C.CYAN}${p.id.padEnd(12)}${C.RESET} ${head}${C.DIM}${more}${C.RESET}`);
      }
      console.log(`\n  ${C.DIM}● live (asked from the provider)  ○ bootstrap (no key / offline)${C.RESET}`);
      console.log(`  ${C.DIM}Run: markus models <provider>${C.RESET}\n`);
    });
}
