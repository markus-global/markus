#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const server = readFileSync(resolve(root, 'packages/org-manager/src/api-server.ts'), 'utf8');
const docs = readFileSync(resolve(root, 'docs/API.md'), 'utf8');

const routeRe = /[/]api[/][A-Za-z0-9_/:.-]+/g;
const routes = new Set(server.match(routeRe) ?? []);
const documented = new Set(docs.match(routeRe) ?? []);

const missing = [...routes].filter(r => !documented.has(r)).sort();
const extra = [...documented].filter(r => !routes.has(r)).sort();

if (missing.length === 0 && extra.length === 0) {
  console.log(`API docs cover all ${routes.size} routes.`);
  process.exit(0);
}

if (missing.length > 0) {
  console.error(`Routes missing from docs/API.md (${missing.length}):`);
  for (const r of missing) console.error(`  ${r}`);
}
if (extra.length > 0) {
  console.error(`Routes in docs/API.md but not in the route table (${extra.length}):`);
  for (const r of extra) console.error(`  ${r}`);
}
process.exit(1);
