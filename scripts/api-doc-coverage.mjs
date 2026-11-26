#!/usr/bin/env node
/**
 * API reference drift check + coverage ratchet.
 *
 * Why this exists (issue #283): the HTTP surface is hand-dispatched in
 * `packages/org-manager/src/api-server.ts` (+ `src/routes/*.ts`) as
 * `if (path === '/api/x' && req.method === 'GET')` chains — there is no route
 * table object to enumerate, and no declaration that a route exists at all.
 * `docs/api/api.md` is the only human-readable list, so it silently drifts: it
 * documented 68 paths while the server grew to 155, and three months of "write
 * the docs" produced nothing because the gap was invisible.
 *
 * This script makes the gap visible on every PR and turns documentation
 * coverage into an executable invariant:
 *
 *   node scripts/api-doc-coverage.mjs                 # human report
 *   node scripts/api-doc-coverage.mjs --check         # CI: ratchet + no dead docs
 *   node scripts/api-doc-coverage.mjs --write-inventory  # regenerate the inventory
 *
 * Two failure modes matter and are treated differently:
 *   - `missing` — a real route with no doc entry. Allowed to exist during the
 *     migration, but the count may never go UP (baseline ratchet).
 *   - `extra`   — a documented path the server no longer serves. This is worse
 *     than missing: it teaches clients to call a dead endpoint. It fails --check
 *     immediately, with no baseline allowance.
 *
 * Extraction limits, stated so nobody trusts it further than it goes: routes
 * dispatched by a pattern we cannot read statically (computed path tables,
 * regex-only matches) are surfaced as `unresolved` and never silently dropped —
 * a checker that quietly under-reports is the very failure it exists to catch.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const REPO = join(import.meta.dirname, '..');
const SERVER_DIR = join(REPO, 'packages/org-manager/src');
const DOCS_FILE = join(REPO, 'docs/api/api.md');
const INVENTORY_FILE = join(REPO, 'docs/api/routes.generated.md');
const BASELINE_FILE = join(REPO, 'scripts/api-doc-coverage.baseline.json');

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** Source files that can dispatch an /api/ route. */
function sourceFiles() {
  const files = [join(SERVER_DIR, 'api-server.ts')];
  const routesDir = join(SERVER_DIR, 'routes');
  if (existsSync(routesDir)) {
    for (const f of readdirSync(routesDir)) {
      if (f.endsWith('.ts') && !f.endsWith('.test.ts')) files.push(join(routesDir, f));
    }
  }
  return files;
}

function stringLiteralOf(node) {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

/**
 * Flatten one `if` condition into the `/api/…` path references it compares and
 * the `req.method` literals it tests. Both are collected from the same
 * conjunction because a path without its method is not a route.
 */
function readCondition(node, acc) {
  if (!node) return acc;
  if (ts.isParenthesizedExpression(node)) return readCondition(node.expression, acc);
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.getText();
    if (op === '&&' || op === '||') {
      readCondition(node.left, acc);
      readCondition(node.right, acc);
      return acc;
    }
    if (['===', '==', '!==', '!='].includes(op)) {
      const left = node.left.getText();
      const right = node.right.getText();
      const lv = stringLiteralOf(node.left);
      const rv = stringLiteralOf(node.right);
      if (left === 'path' && rv !== undefined) acc.refs.push({ path: rv, kind: 'exact' });
      else if (right === 'path' && lv !== undefined) acc.refs.push({ path: lv, kind: 'exact' });
      if (left === 'req.method' && rv !== undefined) acc.methods.push(rv);
      else if (right === 'req.method' && lv !== undefined) acc.methods.push(lv);
    }
    return acc;
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression.getText();
    if (callee === 'path.startsWith' || callee === 'path.match') {
      const arg = stringLiteralOf(node.arguments[0]);
      if (arg !== undefined) {
        acc.refs.push({ path: arg, kind: callee === 'path.match' ? 'pattern' : 'prefix' });
      }
    }
  }
  return acc;
}

/** Extract every route the source *declares*, with the line that declares it. */
function extractRoutes() {
  const routes = [];
  const unresolved = [];
  for (const file of sourceFiles()) {
    const rel = relative(REPO, file);
    const sf = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node) => {
      if (ts.isIfStatement(node)) {
        const acc = { refs: [], methods: [] };
        readCondition(node.expression, acc);
        const apiRefs = acc.refs.filter((r) => r.path.startsWith('/api/'));
        const methods = [...new Set(acc.methods.filter((m) => HTTP_METHODS.includes(m)))];
        if (apiRefs.length > 0) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          const patterns = apiRefs.filter((r) => r.kind === 'pattern');
          if (patterns.length > 0) {
            unresolved.push({
              file: rel,
              line,
              reason: 'regex path match — cannot be compared to a doc path',
              raw: patterns.map((p) => p.path).join(' | '),
            });
          }
          const usable = apiRefs.filter((r) => r.kind !== 'pattern');
          if (usable.length > 0 && methods.length === 0) {
            // A path test with no method test in the same condition: the method
            // is decided inside the body. Record it so the report cannot pretend
            // the surface is smaller than it is.
            unresolved.push({
              file: rel,
              line,
              reason: 'method decided inside the handler body',
              raw: usable.map((u) => u.path).join(' | '),
            });
          }
          for (const ref of usable) {
            for (const method of methods) {
              routes.push({ method, path: ref.path, kind: ref.kind, file: rel, line });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { routes, unresolved };
}

/** `GET /api/agents` and `POST /api/agents/:id/command` as documented. */
function extractDocumentedPaths() {
  const text = readFileSync(DOCS_FILE, 'utf8');
  const documented = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    // table row: | GET | `/api/agents` | … |
    const row = line.match(/^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`?(\/api\/[^`|\s]+)`?\s*\|/i);
    // heading: ### POST `/api/agents/:id/command`
    const heading = line.match(/^#{2,4}\s+(GET|POST|PUT|PATCH|DELETE)\s+`?(\/api\/[^`\s]+)`?/i);
    const hit = row || heading;
    if (!hit) continue;
    const method = hit[1].toUpperCase();
    // Docs sometimes spell a query string into the path (`?token=<token>`); a
    // route is identified by its path, so the query is not part of the identity.
    const path = hit[2].split('?')[0].replace(/\/+$/, '');
    if (!documented.has(path)) documented.set(path, new Set());
    documented.get(path).add(method);
  }
  return documented;
}

/**
 * The authoritative route surface.
 *
 * `APIServer.buildRouteTable()` declares every (path, methods) pair as
 * `exact('…', …)` / `startsWith('…', …)` / `regex(/…/, …)`. That table — not
 * the `if (path === …)` dispatch chains — is what the server will answer 200 to
 * and what answers 405 for a wrong method, so it is the only honest source for
 * "what exists". Reading the dispatch branches instead under-counts every
 * parameterised route (they are `regex(...)`, matched inside a shared branch)
 * and invents "documented but not served" for routes that are very much served.
 */
function extractRouteTable() {
  const file = join(SERVER_DIR, 'api-server.ts');
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const routes = [];
  const unresolved = [];

  let tableArray;
  const findTable = (node) => {
    if (
      tableArray === undefined &&
      ts.isMethodDeclaration(node) &&
      node.name &&
      node.name.getText() === 'buildRouteTable'
    ) {
      const walk = (n) => {
        if (tableArray === undefined && ts.isReturnStatement(n) && n.expression && ts.isArrayLiteralExpression(n.expression)) {
          tableArray = n.expression;
        }
        ts.forEachChild(n, walk);
      };
      walk(node);
    }
    if (tableArray === undefined) ts.forEachChild(node, findTable);
  };
  findTable(sf);

  if (tableArray === undefined) {
    unresolved.push({
      file: relative(REPO, file),
      line: 0,
      reason: 'buildRouteTable() return array not found — extraction is blind, refusing to report coverage',
      raw: '',
    });
    return { routes, unresolved, blind: true };
  }

  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  /** `/^\/api\/teams\/[^/]+\/(start|stop)$/` → `/api/teams/:id/start`, `…/stop`. */
  function regexToTemplates(node) {
    const raw = node.getText();
    let body = raw.slice(1, raw.lastIndexOf('/'));
    body = body.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/');

    // Expand alternation groups (shallow, bounded): `(a|b|c)` → three variants.
    let variants = [body];
    for (let guard = 0; guard < 4; guard += 1) {
      const next = [];
      let expanded = false;
      for (const v of variants) {
        const m = v.match(/\(([^()]*)\)/);
        if (m && m[1].includes('|')) {
          for (const alt of m[1].split('|')) {
            next.push(v.slice(0, m.index) + alt + v.slice(m.index + m[0].length));
          }
          expanded = true;
        } else {
          next.push(v);
        }
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

  for (const el of tableArray.elements) {
    if (!ts.isCallExpression(el)) {
      unresolved.push({
        file: relative(REPO, file),
        line: lineOf(el),
        reason: 'table entry is not an exact/startsWith/regex call',
        raw: el.getText().slice(0, 120),
      });
      continue;
    }
    const kindName = el.expression.getText();
    const methods = el.arguments
      .slice(1)
      .map((a) => stringLiteralOf(a))
      .filter((m) => m !== undefined && HTTP_METHODS.includes(m));
    const line = lineOf(el);

    if (kindName === 'exact' || kindName === 'startsWith') {
      const path = stringLiteralOf(el.arguments[0]);
      if (path === undefined) {
        unresolved.push({
          file: relative(REPO, file),
          line,
          reason: 'path argument is not a literal',
          raw: el.getText().slice(0, 120),
        });
        continue;
      }
      for (const m of methods) {
        routes.push({
          method: m,
          path,
          kind: kindName === 'exact' ? 'exact' : 'prefix',
          file: relative(REPO, file),
          line,
        });
      }
      continue;
    }

    if (kindName === 'regex') {
      const arg = el.arguments[0];
      if (!arg || !ts.isRegularExpressionLiteral(arg)) {
        unresolved.push({
          file: relative(REPO, file),
          line,
          reason: 'regex argument is not a literal',
          raw: el.getText().slice(0, 120),
        });
        continue;
      }
      for (const tpl of regexToTemplates(arg)) {
        if (!tpl.startsWith('/api/')) {
          unresolved.push({
            file: relative(REPO, file),
            line,
            reason: 'regex does not reduce to an /api/ template',
            raw: arg.getText(),
          });
          continue;
        }
        for (const m of methods) {
          routes.push({ method: m, path: tpl, kind: 'template', file: relative(REPO, file), line });
        }
      }
      continue;
    }

    unresolved.push({
      file: relative(REPO, file),
      line,
      reason: `unknown table helper \`${kindName}\``,
      raw: el.getText().slice(0, 120),
    });
  }

  return { routes, unresolved, blind: false };
}

/**
 * Path identity ignores parameter *names*: `/api/channels/:channel/messages` and
 * `/api/channels/:id/messages` are the same route, and treating them as different
 * would report a live endpoint as a dead doc entry — the most expensive kind of
 * false positive this checker can produce, because it invites deleting correct docs.
 */
const normalizePath = (p) => p.replace(/:[^/]+/g, ':p');

/** Does a documented path line up with a declared route? */
function docCoversRoute(docPath, route) {
  const doc = normalizePath(docPath);
  const target = normalizePath(route.path);
  if (route.kind === 'prefix') return doc === target || doc.startsWith(target);
  // An exact comparison serves that one path; sub-paths are dispatched by other
  // entries, so a doc for `/api/agents/:id` does not document `/api/agents`.
  return doc === target;
}

function buildReport() {
  const { routes, unresolved, blind } = extractRouteTable();
  if (blind) {
    throw new Error(
      `route table could not be read (${unresolved[0]?.reason ?? 'unknown'}) — refusing to report a coverage number that would be fiction`,
    );
  }
  const documented = extractDocumentedPaths();

  // De-duplicate: the same (method, path) can appear in several branches
  // (e.g. a GET and its streaming variant), and counting it twice would inflate
  // "coverage" without documenting anything more.
  const unique = new Map();
  for (const r of routes) unique.set(`${r.method} ${r.path}`, r);
  const routeList = [...unique.values()].sort((a, b) =>
    a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path),
  );

  const docPaths = [...documented.keys()].sort();

  const missing = routeList.filter((r) => !docPaths.some((d) => docCoversRoute(d, r)));
  const documentedRoutes = routeList.filter((r) => docPaths.some((d) => docCoversRoute(d, r)));
  const extra = docPaths.filter((d) => !routeList.some((r) => docCoversRoute(d, r)));

  // Method-level gaps on routes that *are* documented — reported, not fatal: a
  // wrong method in the docs is a real defect but it does not hide a route.
  const methodGaps = [];
  for (const d of docPaths) {
    const cov = routeList.filter((r) => docCoversRoute(d, r));
    const docs = documented.get(d);
    for (const m of docs) {
      if (!cov.some((r) => r.method === m)) methodGaps.push({ path: d, method: m });
    }
  }

  return {
    routeList,
    docPaths,
    documentedRoutes,
    missing,
    extra,
    methodGaps,
    unresolved,
  };
}

function pct(part, whole) {
  if (whole === 0) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}

function formatReport(rep) {
  const lines = [];
  lines.push('API reference coverage');
  lines.push('──────────────────────');
  lines.push(`  declared routes      ${rep.routeList.length}`);
  lines.push(`  documented routes    ${rep.documentedRoutes.length}  (${pct(rep.documentedRoutes.length, rep.routeList.length)})`);
  lines.push(`  missing from docs    ${rep.missing.length}`);
  lines.push(`  documented, no route ${rep.extra.length}   ← dead docs, worse than missing`);
  lines.push(`  method mismatches    ${rep.methodGaps.length}`);
  lines.push(`  unresolved (static)  ${rep.unresolved.length}`);

  if (rep.extra.length > 0) {
    lines.push('');
    lines.push('Dead doc entries (the server does not serve these):');
    for (const p of rep.extra) lines.push(`  ${p}`);
  }
  if (rep.methodGaps.length > 0) {
    lines.push('');
    lines.push('Documented method does not exist on that route:');
    for (const g of rep.methodGaps) lines.push(`  ${g.method} ${g.path}`);
  }
  if (rep.unresolved.length > 0) {
    lines.push('');
    lines.push('Not statically resolvable (inventory may under-count; never silently dropped):');
    for (const u of rep.unresolved) lines.push(`  ${u.file}:${u.line} — ${u.reason}: ${u.raw}`);
  }
  if (rep.missing.length > 0) {
    lines.push('');
    lines.push('Missing from docs (first 40):');
    for (const r of rep.missing.slice(0, 40)) lines.push(`  ${r.method.padEnd(6)} ${r.path}  (${r.file}:${r.line})`);
    if (rep.missing.length > 40) lines.push(`  … ${rep.missing.length - 40} more (see the generated inventory)`);
  }
  return lines.join('\n');
}

function writeInventory(rep) {
  const now = new Date().toISOString().slice(0, 10);
  const lines = [];
  lines.push('# API route inventory (generated)');
  lines.push('');
  lines.push('> **Do not edit by hand.** Regenerate with `pnpm api:doc-coverage --write-inventory`.');
  lines.push('> Source of truth for *what exists* is the dispatch code; this file only reflects it.');
  lines.push('');
  lines.push(`Generated: ${now}`);
  lines.push('');
  lines.push(`- declared routes: **${rep.routeList.length}**`);
  lines.push(`- documented in [\`api.md\`](./api.md): **${rep.documentedRoutes.length}** (${pct(rep.documentedRoutes.length, rep.routeList.length)})`);
  lines.push(`- missing from docs: **${rep.missing.length}**`);
  lines.push(`- documented but not served: **${rep.extra.length}**`);
  lines.push(`- not statically resolvable: **${rep.unresolved.length}**`);
  lines.push('');
  lines.push('## Routes');
  lines.push('');
  lines.push('| Documented | Method | Path | Declared at |');
  lines.push('|---|---|---|---|');
  for (const r of rep.routeList) {
    const isDoc = rep.documentedRoutes.includes(r);
    lines.push(`| ${isDoc ? '✓' : '—'} | ${r.method} | \`${r.path}\`${r.kind === 'prefix' ? ' *(prefix)*' : ''} | ${r.file}:${r.line} |`);
  }
  if (rep.extra.length > 0) {
    lines.push('');
    lines.push('## Documented but not served');
    lines.push('');
    for (const p of rep.extra) lines.push(`- \`${p}\``);
  }
  if (rep.unresolved.length > 0) {
    lines.push('');
    lines.push('## Not statically resolvable');
    lines.push('');
    for (const u of rep.unresolved) lines.push(`- ${u.file}:${u.line} — ${u.reason}: \`${u.raw}\``);
  }
  lines.push('');
  writeFileSync(INVENTORY_FILE, lines.join('\n'), 'utf8');
  return INVENTORY_FILE;
}

function readBaseline() {
  if (!existsSync(BASELINE_FILE)) return null;
  return JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
}

/**
 * The ratchet. Two invariants, deliberately asymmetric:
 *   - coverage may only grow: `documented` >= baseline, `missing` <= baseline;
 *   - dead docs are never allowed, baseline or not.
 */
function checkRatchet(rep) {
  const failures = [];
  const baseline = readBaseline();

  if (rep.extra.length > 0) {
    failures.push(
      `${rep.extra.length} documented path(s) are not served by the server — delete or fix them in docs/api/api.md:\n` +
        rep.extra.map((p) => `    ${p}`).join('\n'),
    );
  }

  if (!baseline) {
    failures.push(
      `no baseline at ${relative(REPO, BASELINE_FILE)} — commit one with ` +
        `\`node scripts/api-doc-coverage.mjs --write-baseline\` after reviewing the report`,
    );
    return failures;
  }

  if (rep.documentedRoutes.length < baseline.documented) {
    failures.push(
      `documentation coverage went DOWN: ${rep.documentedRoutes.length} documented route(s), baseline is ${baseline.documented}.\n` +
        `    Either document the routes you changed, or lower the baseline in the same PR and say why.`,
    );
  }
  if (rep.routeList.length > baseline.routes) {
    const delta = rep.routeList.length - baseline.routes;
    failures.push(
      `route surface grew by ${delta} (${baseline.routes} → ${rep.routeList.length}) without the baseline moving.\n` +
        `    A new endpoint needs a doc entry — or, if it is internal, mark it in the inventory — ` +
        `then raise the baseline with \`--write-baseline\`.`,
    );
  }
  return failures;
}

function writeBaseline(rep) {
  const data = {
    // Counts, not path lists: the point is the ratchet, and a path list would
    // have to be rewritten on every rename while telling us nothing new.
    documented: rep.documentedRoutes.length,
    routes: rep.routeList.length,
    dead: rep.extra.length,
    note:
      'Coverage ratchet for docs/api/api.md. documented/routes may only grow/vanish together with docs. ' +
      'Regenerate with: node scripts/api-doc-coverage.mjs --write-baseline',
    updatedAt: new Date().toISOString().slice(0, 10),
  };
  writeFileSync(BASELINE_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return BASELINE_FILE;
}

const args = process.argv.slice(2);
const rep = buildReport();

if (args.includes('--write-inventory')) {
  const out = writeInventory(rep);
  console.log(`wrote ${relative(REPO, out)}`);
}
if (args.includes('--write-baseline')) {
  const out = writeBaseline(rep);
  console.log(`wrote ${relative(REPO, out)}: ${rep.documentedRoutes.length}/${rep.routeList.length} documented`);
}
if (args.includes('--check')) {
  const failures = checkRatchet(rep);
  if (failures.length > 0) {
    console.error(`\n${formatReport(rep)}\n`);
    for (const f of failures) console.error(`✗ ${f}`);
    console.error('');
    process.exit(1);
  }
  console.log(formatReport(rep));
  console.log('\n✓ api doc coverage ratchet holds');
} else if (!args.includes('--write-inventory') && !args.includes('--write-baseline')) {
  console.log(formatReport(rep));
}
