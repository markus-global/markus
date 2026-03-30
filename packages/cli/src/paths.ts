import { resolve, join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve a templates sub-directory (e.g. 'roles', 'skills').
 *
 * Search order:
 *   1. ~/.markus/templates/<sub>       — user-local overrides
 *   2. <cwd>/templates/<sub>           — source-dev / monorepo mode
 *   3. <pkg>/templates/<sub>           — npm global-install (shipped with the package)
 */
export function resolveTemplatesDir(sub: string): string {
  const userDir = join(homedir(), '.markus', 'templates', sub);
  if (existsSync(userDir)) return userDir;

  const cwdDir = resolve(process.cwd(), 'templates', sub);
  if (existsSync(cwdDir)) return cwdDir;

  // In the bundled npm package, templates/ sits next to dist/
  const pkgDir = resolve(__dirname, '..', 'templates', sub);
  if (existsSync(pkgDir)) return pkgDir;

  // Fallback to cwd (will be created by init if needed)
  return cwdDir;
}

/**
 * Return all candidate template directories (existing ones only) so
 * role / skill loaders can scan multiple locations.
 */
export function allTemplateDirs(sub: string): string[] {
  const dirs: string[] = [];

  const userDir = join(homedir(), '.markus', 'templates', sub);
  if (existsSync(userDir)) dirs.push(userDir);

  const cwdDir = resolve(process.cwd(), 'templates', sub);
  if (existsSync(cwdDir)) dirs.push(cwdDir);

  const pkgDir = resolve(__dirname, '..', 'templates', sub);
  if (existsSync(pkgDir) && !dirs.includes(pkgDir)) dirs.push(pkgDir);

  return dirs;
}

/**
 * Resolve the Web UI static assets directory.
 * Returns undefined if no pre-built Web UI is found.
 */
export function resolveWebUiDir(): string | undefined {
  // npm-installed: dist/web-ui/ sits next to the bundled CLI
  const pkgDir = resolve(__dirname, 'web-ui');
  if (existsSync(pkgDir)) return pkgDir;

  // monorepo dev: packages/web-ui/dist/
  const devDir = resolve(__dirname, '../../web-ui/dist');
  if (existsSync(devDir)) return devDir;

  return undefined;
}
