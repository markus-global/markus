#!/usr/bin/env node
/**
 * Security guard — cheap, deterministic checks that catch the shapes we have
 * actually gotten wrong before. Runs as part of `pnpm quality`.
 *
 * Checks
 *  1. No dynamic code generation (`new Function` / `eval`) in shipped source,
 *     except an explicit allowlist of dynamic-import shims that take a literal.
 *  2. Every entry in `PUBLIC_API_PREFIXES` carries an inline reason — an entry
 *     without one is an unreviewed hole in the deny-by-default gate.
 *  3. The sensitive route groups are classified in `ROLE_RULES` as owner/admin.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const failures = [];

/** Dynamic-import shims: the argument is always a literal module id. */
const CODE_GEN_ALLOWLIST = new Set([
  'packages/core/src/tools/web-search.ts',
  'packages/core/src/llm/proxy-fetch.ts',
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Drop comments so prose about `eval` does not trip the scanner. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ── 1. dynamic code generation ────────────────────────────────────────────
const packagesDir = join(root, 'packages');
const offenders = [];

if (statSync(packagesDir, { throwIfNoEntry: false })?.isDirectory()) {
  for (const pkg of readdirSync(packagesDir)) {
    // The browser extension legitimately drives page-side evaluation through CDP;
    // it does not run in the Markus process, so it is out of scope here.
    if (pkg === 'chrome-extension') continue;
    const srcDir = join(packagesDir, pkg, 'src');
    if (!statSync(srcDir, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const file of walk(srcDir)) {
      const text = stripComments(readFileSync(file, 'utf-8'));
      if (!/\bnew Function\s*\(|\beval\s*\(/.test(text)) continue;
      const rel = relative(root, file);
      if (CODE_GEN_ALLOWLIST.has(rel)) continue;
      offenders.push(rel);
    }
  }
}

if (offenders.length > 0) {
  failures.push(
    `Dynamic code generation found in shipped source:\n    ${offenders.join('\n    ')}\n` +
    '  If a site is a dynamic-import shim taking a literal, add it to CODE_GEN_ALLOWLIST.',
  );
}

// ── 2 & 3. API gate invariants ────────────────────────────────────────────
const apiServerPath = join(root, 'packages/org-manager/src/api-server.ts');
const apiServer = readFileSync(apiServerPath, 'utf-8');

const publicBlock = /const PUBLIC_API_PREFIXES = \[([\s\S]*?)\n\];/.exec(apiServer);
if (!publicBlock) {
  failures.push('Could not locate PUBLIC_API_PREFIXES in api-server.ts');
} else {
  for (const line of publicBlock[1].split('\n')) {
    const entry = line.match(/^\s*'([^']+)',?\s*(.*)$/);
    if (!entry) continue;
    const [, path, rest] = entry;
    const hasReason = /\/\/\s*\S/.test(rest);
    if (!hasReason) {
      failures.push(`PUBLIC_API_PREFIXES entry "${path}" has no inline reason comment.`);
    }
  }
}

const roleRulesBlock = /const ROLE_RULES: RoleRule\[\] = \[([\s\S]*?)\n\];/.exec(apiServer);
if (!roleRulesBlock) {
  failures.push('Could not locate ROLE_RULES in api-server.ts');
} else {
  const sensitiveOwner = ['/api/settings/remote', '/api/files/write'];
  const sensitiveAdmin = ['/api/agents', '/api/teams', '/api/external-agents'];
  for (const prefix of sensitiveOwner) {
    if (!new RegExp(`'${prefix}'[^\\n]*minRole: 'owner'`).test(roleRulesBlock[1])) {
      failures.push(`Sensitive prefix ${prefix} is not classified as owner in ROLE_RULES.`);
    }
  }
  for (const prefix of sensitiveAdmin) {
    if (!roleRulesBlock[1].includes(`'${prefix}'`)) {
      failures.push(`Sensitive prefix ${prefix} is not classified in ROLE_RULES.`);
    }
  }
}

if (failures.length > 0) {
  console.error('\nSecurity guard failed:\n');
  for (const failure of failures) console.error(`  • ${failure}`);
  console.error('');
  process.exit(1);
}

console.log('Security guard: ok (no dynamic codegen, API gate invariants hold).');
