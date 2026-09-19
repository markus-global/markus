/**
 * Global test setup — isolates ALL tests from the real environment.
 *
 * Two isolation jobs, both about making `pnpm test` mean the same thing on
 * every machine:
 *
 * ## 1. Filesystem — never touch the real `~/.markus`
 *
 * Runs before each test file is loaded.  Sets process.env.HOME to a per-worker
 * temp directory so that os.homedir() never returns the real home, even for
 * code that captures homedir() at module scope.
 *
 * Tests that manage their own HOME (via mkdtempSync + process.env.HOME) are
 * unaffected — they overwrite and restore HOME themselves.  The important
 * thing is that if a test does NOT manage HOME, it still won't touch the real
 * ~/.markus directory.
 *
 * ## 2. Credentials — never inherit the developer's `MARKUS_*` shell vars
 *
 * `resolveHubBase()` / `resolveHubToken()` in `core/src/llm/markus-provider.ts`
 * fall back to `process.env.MARKUS_MODELS_URL` / `MARKUS_HUB_TOKEN` when the
 * provider is constructed without explicit URLs.  A developer (or QA) who has
 * those exported in their shell therefore runs a *different* code path than CI:
 * the Hub credit sync guard `if (!base || !token) return null` stops applying,
 * the mocked `fetch` gets consumed by the credit probe instead of the chat
 * call, and `llm-markus-provider.test.ts` fails deterministically on their
 * machine while staying green in CI.
 *
 * That class of "false red" is worse than no test: it teaches people to ignore
 * red, and it makes release verification non-reproducible.  So we delete the
 * whole `MARKUS_*` credential surface up front.  Tests that specifically want
 * to exercise env fallback set the variable themselves and restore it in
 * `afterEach` (see `packages/core/test/web-search-tool.test.ts`).
 *
 * We deliberately do NOT delete non-credential vars such as
 * `MARKUS_TEMPLATES_DIR` — product code needs those to locate bundled assets.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── 1. filesystem isolation ──────────────────────────────────────────────────
const realHome = process.env.HOME;
const testHome = mkdtempSync(join(tmpdir(), 'markus-test-home-'));
mkdirSync(join(testHome, '.markus', 'logs'), { recursive: true });

process.env.HOME = testHome;

// ── 2. credential isolation ──────────────────────────────────────────────────
/**
 * Every env var that can redirect a provider at a *real* remote service or
 * inject a *real* credential.  Kept in sync with the fallbacks in
 * `core/src/llm/markus-provider.ts` and `core/src/tools/web-search.ts`.
 */
export const MARKUS_ENV_BLOCKLIST = [
  'MARKUS_HUB_TOKEN',
  'MARKUS_HUB_URL',
  'MARKUS_MODELS_URL',
  'MARKUS_OPENROUTER_KEY',
  'MARKUS_OPENROUTER_BASE',
  'MARKUS_CU_REMAINING',
  'MARKUS_SEARCH_URL',
  'OPENROUTER_API_KEY',
] as const;

const strippedEnv: Record<string, string | undefined> = {};
for (const key of MARKUS_ENV_BLOCKLIST) {
  strippedEnv[key] = process.env[key];
  delete process.env[key];
}

process.on('exit', () => {
  process.env.HOME = realHome;
  for (const [key, value] of Object.entries(strippedEnv)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    rmSync(testHome, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});
