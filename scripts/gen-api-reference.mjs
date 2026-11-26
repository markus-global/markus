#!/usr/bin/env node
/**
 * Generate the HTTP API reference from the code that serves it.
 *
 * The rule this enforces: **the reference is a build artifact, not a document
 * anyone maintains.** `APIServer.buildRouteTable()` is the single source of
 * truth for what exists (the server 405s from that table and 404s outside it),
 * `ROLE_RULES` is the single source of truth for who may call what, and the
 * description of a route lives in a comment directly above its declaration —
 * Rust-doc style, where the prose sits next to the thing it describes and moves
 * with it in review.
 *
 * Never edit `docs/api/reference.md` by hand. If a route is missing or wrong,
 * the fix belongs in the route table; then run:
 *
 *   pnpm api:docs            # regenerate
 *   pnpm api:docs --check    # CI: fail when the committed artifact is stale
 *
 * Prose that the code cannot express — flow, trade-offs, "which of these do I
 * want" — belongs in `docs/api/guides/`, which stays hand-written on purpose.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const REPO = join(import.meta.dirname, '..');
const SERVER = join(REPO, 'packages/org-manager/src/api-server.ts');
const OUT = join(REPO, 'docs/api/reference.md');

const lit = (n) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined);

function loadServer() {
  const src = readFileSync(SERVER, 'utf8');
  const sf = ts.createSourceFile(SERVER, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return { src, sf };
}

function findMethod(sf, name) {
  let found;
  const visit = (n) => {
    if (found === undefined && ts.isMethodDeclaration(n) && n.name && n.name.getText() === name) found = n;
    if (found === undefined) ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** `/^\/api\/teams\/[^/]+\/(start|stop)$/` → ['/api/teams/:id/start', '/api/teams/:id/stop'] */
function regexToTemplates(node) {
  const raw = node.getText();
  let body = raw.slice(1, raw.lastIndexOf('/'));
  body = body.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/');
  let variants = [body];
  for (let guard = 0; guard < 4; guard += 1) {
    const next = [];
    let expanded = false;
    for (const v of variants) {
      const m = v.match(/\(([^()]*)\)/);
      if (m && m[1].includes('|')) {
        for (const alt of m[1].split('|')) next.push(v.slice(0, m.index) + alt + v.slice(m.index + m[0].length));
        expanded = true;
      } else next.push(v);
    }
    variants = next;
    if (!expanded) break;
  }
  return variants.map((v) =>
    v
      .replace(/\[\^\/\]\+/g, ':id')
      .replace(/\[\^\/\]\*/g, ':id?')
      .replace(/\\d\+/g, ':n')
      .replace(/\[[^\]]+\][+*]/g, ':seg'),
  );
}

/** Description = the JSDoc/line comment immediately above the declaration. */
function leadingDescription(src, node, sf) {
  const trivia = src.slice(node.getFullStart(), node.getStart(sf));
  const jsdoc = [...trivia.matchAll(/\/\*\*([\s\S]*?)\*\//g)].pop();
  if (jsdoc) {
    return jsdoc[1]
      .split('\n')
      .map((l) => l.replace(/^\s*\*?\s?/, '').trim())
      .filter(Boolean)
      .join(' ');
  }
  const line = [...trivia.matchAll(/^\s*\/\/\s*(.+)$/gm)].pop();
  if (line && !/^──/.test(line[1]) && !/^[─-]+$/.test(line[1].trim())) return line[1].trim();
  return '';
}

const SECTION_RE = /\/\/\s*──\s*(.+?)\s*─+/;

/** Nearest `// ── Group ──` banner above this offset. */
function sectionAt(src, offset) {
  const before = src.slice(0, offset);
  let last = '';
  for (const m of before.matchAll(new RegExp(SECTION_RE, 'g'))) last = m[1].trim();
  return last || 'Other';
}

function extractRoutes() {
  const { src, sf } = loadServer();
  const method = findMethod(sf, 'buildRouteTable');
  if (!method) throw new Error('buildRouteTable() not found in api-server.ts — refusing to generate a reference that would be fiction');

  let table;
  const walk = (n) => {
    if (table === undefined && ts.isReturnStatement(n) && n.expression && ts.isArrayLiteralExpression(n.expression)) table = n.expression;
    ts.forEachChild(n, walk);
  };
  walk(method);
  if (!table) throw new Error('buildRouteTable() has no return array literal');

  const routes = [];
  const unresolved = [];
  for (const el of table.elements) {
    if (!ts.isCallExpression(el)) {
      unresolved.push({ line: sf.getLineAndCharacterOfPosition(el.getStart(sf)).line + 1, why: 'non-call entry', raw: el.getText().slice(0, 80) });
      continue;
    }
    const kind = el.expression.getText();
    const methods = el.arguments.slice(1).map(lit).filter(Boolean);
    const section = sectionAt(src, el.getStart(sf));
    const description = leadingDescription(src, el, sf);
    const line = sf.getLineAndCharacterOfPosition(el.getStart(sf)).line + 1;

    if (kind === 'exact' || kind === 'startsWith') {
      const path = lit(el.arguments[0]);
      if (!path) {
        unresolved.push({ line, why: 'non-literal path', raw: el.getText().slice(0, 80) });
        continue;
      }
      for (const m of methods) routes.push({ method: m, path, kind, section, description, line });
      continue;
    }
    if (kind === 'regex') {
      const arg = el.arguments[0];
      if (!arg || !ts.isRegularExpressionLiteral(arg)) {
        unresolved.push({ line, why: 'non-literal regex', raw: el.getText().slice(0, 80) });
        continue;
      }
      for (const tpl of regexToTemplates(arg)) {
        for (const m of methods) routes.push({ method: m, path: tpl, kind: 'template', section, description, line });
      }
      continue;
    }
    unresolved.push({ line, why: `unknown helper ${kind}`, raw: el.getText().slice(0, 80) });
  }
  return { routes, unresolved };
}

/** ROLE_RULES → first-match-wins role lookup, mirroring the server's own logic. */
function extractRoleRules() {
  const { sf } = loadServer();
  const arr = findMethod(sf, 'checkRoleAllowed') ?? null;
  void arr;
  // The rules live in a module-level const; find any array of object literals
  // whose properties are underPrefix/anyOf + minRole.
  const rules = [];
  const visit = (node) => {
    if (ts.isArrayLiteralExpression(node)) {
      const looksLikeRules = node.elements.some(
        (el) => ts.isObjectLiteralExpression(el) && el.properties.some((p) => ts.isPropertyAssignment(p) && p.name.getText() === 'minRole'),
      );
      if (looksLikeRules) {
        for (const el of node.elements) {
          if (!ts.isObjectLiteralExpression(el)) continue;
          let prefixes = [];
          const anyOfPrefixes = [];
          let methods = [];
          let minRole = 'member';
          for (const p of el.properties) {
            if (!ts.isPropertyAssignment(p)) continue;
            const name = p.name.getText();
            if (name === 'minRole') minRole = lit(p.initializer) ?? minRole;
            else if (name === 'methods' && ts.isArrayLiteralExpression(p.initializer)) {
              methods = p.initializer.elements.map(lit).filter(Boolean);
            } else if (name === 'path') {
              const call = p.initializer;
              if (ts.isCallExpression(call)) {
                const kind = call.expression.getText();
                const args = call.arguments.map(lit).filter(Boolean);
                if (kind === 'underPrefix' || kind === 'exact') prefixes = args;
                else if (kind === 'anyOf') anyOfPrefixes.push(...args);
              }
            }
          }
          prefixes = [...prefixes, ...anyOfPrefixes];
          if (prefixes.length > 0) rules.push({ prefixes, methods, minRole });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return rules;
}

function roleFor(rules, route) {
  for (const rule of rules) {
    const hit = rule.prefixes.some((p) => route.path === p || route.path.startsWith(p));
    if (!hit) continue;
    if (rule.methods.length > 0 && !rule.methods.includes(route.method)) continue;
    return rule.minRole;
  }
  return 'member';
}

function render(routes, unresolved, rules) {
  // De-duplicate the same (method, path) declared by more than one entry, and
  // order by group in the order the groups appear in the source.
  const seen = new Set();
  const unique = [];
  for (const r of routes) {
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...r, role: roleFor(rules, r) });
  }

  const sections = [];
  for (const r of unique) {
    let s = sections.find((x) => x.name === r.section);
    if (!s) {
      s = { name: r.section, rows: [] };
      sections.push(s);
    }
    s.rows.push(r);
  }

  const described = unique.filter((r) => r.description).length;
  const out = [];
  out.push('# Markus HTTP API reference');
  out.push('');
  out.push('> **Generated — do not edit.** Produced from `APIServer.buildRouteTable()` and');
  out.push('> `ROLE_RULES` by `scripts/gen-api-reference.mjs`. To change a line here, change');
  out.push('> the route declaration (or the comment above it) and run `pnpm api:docs`.');
  out.push('>');
  out.push('> Flow, trade-offs and "which of these do I want" live in `docs/api/guides/`,');
  out.push('> which is hand-written on purpose — the code cannot answer those questions.');
  out.push('');
  out.push(`Routes: **${unique.length}** · with a description: **${described}** · ` +
    `groups: **${sections.length}**` + (unresolved.length ? ` · unreadable declarations: **${unresolved.length}**` : ''));
  out.push('');
  out.push('Base URL: `http://localhost:8056`. Authentication: JWT cookie `markus_token`, or `Authorization: Bearer <token>`.');
  out.push('`min role` is the lowest org role that may call the route (`member` < `admin` < `owner`).');
  out.push('');
  out.push('## Contents');
  out.push('');
  for (const s of sections) {
    out.push(`- [${s.name}](#${s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}) — ${s.rows.length}`);
  }
  out.push('');

  for (const s of sections) {
    out.push(`## ${s.name}`);
    out.push('');
    out.push('| Method | Path | Min role | Description |');
    out.push('|---|---|---|---|');
    for (const r of s.rows) {
      const path = r.kind === 'prefix' ? `\`${r.path}*\`` : `\`${r.path}\``;
      const desc = r.description.replace(/\|/g, '\\|');
      out.push(`| ${r.method} | ${path} | ${r.role} | ${desc} |`);
    }
    out.push('');
  }

  if (unresolved.length > 0) {
    out.push('## Unreadable declarations');
    out.push('');
    out.push('These entries could not be reduced to a method + path. They are listed rather than');
    out.push('dropped: a reference that silently omits endpoints is the failure this file exists to prevent.');
    out.push('');
    for (const u of unresolved) out.push(`- api-server.ts:${u.line} — ${u.why}: \`${u.raw}\``);
    out.push('');
  }

  return out.join('\n');
}

const args = process.argv.slice(2);
const { routes, unresolved } = extractRoutes();
const rules = extractRoleRules();
const markdown = render(routes, unresolved, rules);

if (args.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== markdown) {
    console.error(
      '✗ docs/api/reference.md is stale — the route table changed but the artifact was not regenerated.\n' +
        '    Run: pnpm api:docs\n' +
        '    (This is the whole point: the reference cannot drift from the code, because it is the code.)',
    );
    process.exit(1);
  }
  const count = markdown.split('\n').filter((l) => /^\| (GET|POST|PUT|PATCH|DELETE) /.test(l)).length;
  console.log(`✓ docs/api/reference.md is current (${count} rows, ${unresolved.length} unreadable)`);
} else {
  mkdirSync(join(REPO, 'docs/api'), { recursive: true });
  writeFileSync(OUT, markdown, 'utf8');
  const count = markdown.split('\n').filter((l) => /^\| (GET|POST|PUT|PATCH|DELETE) /.test(l)).length;
  console.log(`wrote ${relative(REPO, OUT)}: ${count} routes, ${unresolved.length} unreadable`);
}
