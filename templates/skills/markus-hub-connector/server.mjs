#!/usr/bin/env node

// Self-contained MCP server for Markus Hub operations.
// Reads hub URL from ~/.markus/markus.json, token from ~/.markus/hub-token.
// Protocol: JSON-RPC 2.0 over stdio (MCP 2024-11-05).

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

const MARKUS_DIR = join(homedir(), '.markus');
const CONFIG_PATH = join(MARKUS_DIR, 'markus.json');
const TOKEN_PATH = join(MARKUS_DIR, 'hub-token');
const ARTIFACTS_DIR = join(MARKUS_DIR, 'builder-artifacts');
const DEFAULT_HUB_URL = 'https://markus.global';

function getHubUrl() {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    return cfg?.hub?.url || DEFAULT_HUB_URL;
  } catch {
    return DEFAULT_HUB_URL;
  }
}

function getHubToken() {
  try {
    return readFileSync(TOKEN_PATH, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

async function hubFetch(path, opts = {}) {
  const hubUrl = getHubUrl();
  const token = getHubToken();
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const url = `${hubUrl}/api${path}`;
  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Hub API ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

// --------------- Tool implementations ---------------

async function hubSearch(args) {
  const params = new URLSearchParams();
  if (args.query) params.set('q', args.query);
  if (args.type) params.set('type', args.type);
  if (args.category) params.set('category', args.category);
  if (args.sort) params.set('sort', args.sort);
  if (args.page) params.set('page', String(args.page));
  if (args.limit) params.set('limit', String(args.limit || 20));
  const qs = params.toString();
  const data = await hubFetch(`/items${qs ? `?${qs}` : ''}`);
  const items = (data.items || []).map(i => ({
    id: i.id, name: i.name, type: i.itemType,
    description: i.description, author: i.author?.username,
    downloads: i.downloadCount, version: i.version,
  }));
  return JSON.stringify({ total: data.total, items }, null, 2);
}

async function hubDownload(args) {
  const token = getHubToken();
  if (!token) return JSON.stringify({ error: 'Not authenticated. User must login to Markus Hub first (via the web UI).' });

  const data = await hubFetch(`/items/${args.id}/download`, { method: 'POST' });
  const itemType = data.itemType || 'skill';
  const name = data.name || args.id;
  const typeDir = `${itemType}s`;
  const targetDir = join(ARTIFACTS_DIR, typeDir, name);
  mkdirSync(targetDir, { recursive: true });

  if (data.config) {
    writeFileSync(join(targetDir, `${itemType}.json`), JSON.stringify(data.config, null, 2), 'utf-8');
  }
  if (data.files) {
    for (const [filename, content] of Object.entries(data.files)) {
      const filePath = join(targetDir, filename);
      mkdirSync(join(filePath, '..'), { recursive: true });
      writeFileSync(filePath, content, 'utf-8');
    }
  }

  const fileList = [];
  try {
    const walk = (dir, prefix = '') => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`);
        else fileList.push(`${prefix}${e.name}`);
      }
    };
    walk(targetDir);
  } catch { /* ignore */ }

  return JSON.stringify({
    downloaded: name,
    type: itemType,
    path: targetDir,
    files: fileList,
    note: 'Downloaded to builder-artifacts. User can install it from the Builder page.',
  }, null, 2);
}

async function hubPublish(args) {
  const token = getHubToken();
  if (!token) return JSON.stringify({ error: 'Not authenticated. User must login to Markus Hub first (via the web UI).' });

  let payload;
  if (args.directory) {
    payload = buildPayloadFromDir(args.directory);
    if (payload.error) return JSON.stringify(payload);
  } else {
    payload = {
      itemType: args.type || 'skill',
      name: args.name,
      description: args.description,
      category: args.category,
      tags: args.tags,
      config: args.config,
      files: args.files,
      readme: args.readme,
    };
  }

  const data = await hubFetch('/items', { method: 'POST', body: JSON.stringify(payload) });
  return JSON.stringify({
    id: data.id, name: data.name, slug: data.slug,
    updated: data.updated || false,
    url: `${getHubUrl()}/packages/${data.slug || data.id}`,
  }, null, 2);
}

function buildPayloadFromDir(dir) {
  const resolved = dir.startsWith('~') ? join(homedir(), dir.slice(1)) : dir;
  if (!existsSync(resolved)) return { error: `Directory not found: ${resolved}` };

  const manifestNames = ['skill.json', 'agent.json', 'team.json'];
  let manifestFile = null;
  let itemType = 'skill';
  for (const mf of manifestNames) {
    if (existsSync(join(resolved, mf))) {
      manifestFile = mf;
      itemType = mf.replace('.json', '');
      break;
    }
  }
  if (!manifestFile) return { error: `No manifest (skill.json/agent.json/team.json) found in ${resolved}` };

  let config;
  try { config = JSON.parse(readFileSync(join(resolved, manifestFile), 'utf-8')); }
  catch { return { error: `Invalid JSON in ${manifestFile}` }; }

  const files = {};
  const walk = (d, prefix = '') => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const rel = `${prefix}${e.name}`;
      if (e.name === manifestFile && !prefix) continue;
      if (e.name === 'node_modules' || e.name === '.git') continue;
      if (e.isDirectory()) walk(join(d, e.name), `${rel}/`);
      else {
        try { files[rel] = readFileSync(join(d, e.name), 'utf-8'); }
        catch { /* skip binary files */ }
      }
    }
  };
  walk(resolved);

  let readme;
  if (files['README.md']) { readme = files['README.md']; delete files['README.md']; }

  return {
    itemType, name: config.name, description: config.description,
    category: config.category, tags: config.tags, config, files, readme,
  };
}

async function hubMyItems() {
  const token = getHubToken();
  if (!token) return JSON.stringify({ error: 'Not authenticated. User must login to Markus Hub first (via the web UI).' });

  const data = await hubFetch('/items/mine');
  const items = (data.items || []).map(i => ({
    id: i.id, name: i.name, type: i.itemType,
    description: i.description, version: i.version,
    updatedAt: i.updatedAt,
  }));
  return JSON.stringify({ count: items.length, items }, null, 2);
}

// --------------- MCP protocol ---------------

const TOOLS = [
  {
    name: 'hub_search',
    description: 'Search Markus Hub for agents, teams, or skills by keyword, type, or category',
    inputSchema: {
      type: 'object',
      properties: {
        query:    { type: 'string', description: 'Search keyword' },
        type:     { type: 'string', enum: ['agent', 'team', 'skill'], description: 'Filter by package type' },
        category: { type: 'string', description: 'Filter by category' },
        sort:     { type: 'string', enum: ['downloads', 'recent', 'name'], description: 'Sort order' },
        page:     { type: 'number', description: 'Page number (1-based)' },
        limit:    { type: 'number', description: 'Results per page (default 20)' },
      },
    },
  },
  {
    name: 'hub_download',
    description: 'Download a package from Markus Hub to local builder-artifacts directory. Requires Hub login.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Hub item ID (from search results)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'hub_publish',
    description: 'Publish a local builder artifact to Markus Hub. Requires Hub login. Provide either a directory path or explicit fields.',
    inputSchema: {
      type: 'object',
      properties: {
        directory:   { type: 'string', description: 'Path to artifact directory (reads manifest + files automatically)' },
        type:        { type: 'string', enum: ['agent', 'team', 'skill'], description: 'Package type (when not using directory)' },
        name:        { type: 'string', description: 'Package name (when not using directory)' },
        description: { type: 'string', description: 'Package description (when not using directory)' },
        category:    { type: 'string' },
        tags:        { type: 'array', items: { type: 'string' } },
        config:      { type: 'object', description: 'Manifest JSON (when not using directory)' },
        files:       { type: 'object', description: 'Map of filename→content (when not using directory)' },
        readme:      { type: 'string', description: 'README content (when not using directory)' },
      },
    },
  },
  {
    name: 'hub_my_items',
    description: 'List all items the current user has published on Markus Hub. Requires Hub login.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

const TOOL_MAP = {
  hub_search: hubSearch,
  hub_download: hubDownload,
  hub_publish: hubPublish,
  hub_my_items: hubMyItems,
};

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }

  const { id, method, params } = msg;

  if (!method) return; // response to something we sent — ignore

  // Notifications (no id) — just acknowledge silently
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'markus-hub', version: '1.0.0' },
      });
      break;

    case 'tools/list':
      respond(id, { tools: TOOLS });
      break;

    case 'tools/call': {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      const handler = TOOL_MAP[toolName];
      if (!handler) {
        respondError(id, -32601, `Unknown tool: ${toolName}`);
        break;
      }
      try {
        const text = await handler(toolArgs);
        respond(id, { content: [{ type: 'text', text }] });
      } catch (err) {
        respond(id, { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
      break;
    }

    default:
      respondError(id, -32601, `Method not found: ${method}`);
  }
});

// Keep process alive
process.stdin.resume();
