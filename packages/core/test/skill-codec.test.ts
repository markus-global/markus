import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectSkillPackageFormat,
  importSkillPackage,
  exportSkillPackage,
  parseSkillPackage,
  renderSkill,
  mapAllowedToolsToPermissions,
  json5ToJson,
  SUPPORTED_EXTERNAL_FORMATS,
  type NormalizedSkill,
} from '../src/skills/codec/index.js';
import { readSkillInstructions } from '../src/skills/loader.js';

let roots: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'markus-codec-'));
  roots.push(dir);
  return dir;
}

function write(dir: string, rel: string, content: string): void {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content, 'utf-8');
}

const CLAUDE_SKILL = `---
name: pdf-tables
description: Extract tables from PDF documents
author: test-author
license: MIT
allowed-tools: file_read, shell_execute
tags: pdf, data
---
# PDF Tables

Extract tables from PDF files using python.
`;

afterEach(() => {
  for (const r of roots) {
    try { rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  roots = [];
});

describe('detectSkillPackageFormat', () => {
  it('detects Markus native (skill.json)', () => {
    const dir = tmpRoot();
    write(dir, 'skill.json', JSON.stringify({ type: 'skill', name: 'x' }));
    expect(detectSkillPackageFormat(dir)).toBe('markus');
  });

  it('detects Claude Code / skills.sh SKILL.md', () => {
    const dir = tmpRoot();
    write(dir, 'SKILL.md', CLAUDE_SKILL);
    expect(detectSkillPackageFormat(dir)).toBe('claude');
  });

  it('detects a bare SKILL.md markdown file as claude', () => {
    const file = join(tmpRoot(), 'standalone.md');
    writeFileSync(file, '# Skill\n', 'utf-8');
    expect(detectSkillPackageFormat(file)).toBe('claude');
  });

  it('detects OpenClaw config.json5', () => {
    const dir = tmpRoot();
    write(dir, 'config.json5', '{ agents: { defaults: {} } }');
    expect(detectSkillPackageFormat(dir)).toBe('openclaw');
  });

  it('detects SOUL.md soul pack', () => {
    const dir = tmpRoot();
    write(dir, 'SOUL.md', '# Soul\n');
    expect(detectSkillPackageFormat(dir)).toBe('soul');
  });

  it('detects generic MCP-server skill (mcp.json)', () => {
    const dir = tmpRoot();
    write(dir, 'mcp.json', JSON.stringify({ mcpServers: { fetch: { command: 'npx' } } }));
    expect(detectSkillPackageFormat(dir)).toBe('mcp-server');
  });

  it('detects SkillHub multi-skill packet (skills/ subdir)', () => {
    const dir = tmpRoot();
    write(dir, 'skills/a/SKILL.md', CLAUDE_SKILL);
    expect(detectSkillPackageFormat(dir)).toBe('skillhub');
  });

  it('detects AgentScope tool-script skill', () => {
    const dir = tmpRoot();
    write(dir, 'README.md', '# Weather Tools\n');
    write(dir, 'weather.py', '@tool\ndef get_weather(city: str) -> str:\n    return city\n');
    expect(detectSkillPackageFormat(dir)).toBe('agentscope');
  });
});

describe('mapAllowedToolsToPermissions', () => {
  it('maps claude allowed-tools to Markus permission groups', () => {
    expect(mapAllowedToolsToPermissions(['Read', 'Write', 'shell_execute', 'WebFetch', 'browser_navigate']))
      .toEqual(expect.arrayContaining(['file', 'shell', 'network', 'browser']));
  });

  it('returns empty for unknown / empty lists', () => {
    expect(mapAllowedToolsToPermissions([])).toEqual([]);
    expect(mapAllowedToolsToPermissions(['foo'])).toEqual([]);
  });
});

describe('json5ToJson', () => {
  it('strips comments and trailing commas', () => {
    const json = json5ToJson(`{
      // comment
      mcpServers: {
        alpha: { command: "npx", args: ["-y", "alpha"], },
      }, /* block */
    }`);
    const parsed = JSON.parse(json) as { mcpServers: { alpha: { command: string } } };
    expect(parsed.mcpServers.alpha.command).toBe('npx');
  });
});

describe('importSkillPackage — 导入归一化', () => {
  it('imports a claude SKILL.md with frontmatter into skill.json + SKILL.md', () => {
    const root = tmpRoot();
    const src = join(root, 'src');
    write(src, 'SKILL.md', CLAUDE_SKILL);
    write(src, 'helper.py', 'print(1)\n');
    const target = join(root, 'out');
    const result = importSkillPackage(src, { name: 'pdf-tools', targetDir: target });

    expect(result.format).toBe('claude');
    expect(result.name).toBe('pdf-tools');
    expect(existsSync(join(target, 'skill.json'))).toBe(true);
    expect(existsSync(join(target, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(target, 'helper.py'))).toBe(true);

    const mf = JSON.parse(readFileSync(join(target, 'skill.json'), 'utf-8')) as {
      name: string; version: string; license: string; description: string;
      skill: { requiredPermissions?: string[] };
      source: { type: string };
    };
    expect(mf.name).toBe('pdf-tools');
    expect(mf.license).toBe('MIT');
    expect(mf.version).toBe('1.0.0');
    expect(mf.description).toMatch(/extract tables/i);
    expect(mf.skill.requiredPermissions).toEqual(expect.arrayContaining(['file', 'shell']));
    expect(mf.source.type).toBe('claude');

    // SKILL.md body is readable by the loader as instructions
    const instructions = readSkillInstructions(target);
    expect(instructions).toContain('# PDF Tables');
  });

  it('imports an openclaw skill with config.json5 MCP servers', () => {
    const src = tmpRoot();
    write(src, 'config.json5', `{
      mcpServers: {
        memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], },
      },
    }`);
    write(src, 'SKILL.md', '---\nname: memory-skill\ndescription: memory mcp\n---\n# Memory\n');
    const target = join(src, 'out');
    const result = importSkillPackage(src, { targetDir: target });
    expect(result.format).toBe('openclaw');
    const mf = JSON.parse(readFileSync(join(target, 'skill.json'), 'utf-8')) as {
      skill: { mcpServers?: Record<string, { command: string; args?: string[] }> };
    };
    expect(mf.skill.mcpServers?.memory.command).toBe('npx');
    expect(mf.skill.mcpServers?.memory.args).toEqual(['-y', '@modelcontextprotocol/server-memory']);
  });

  it('imports a SOUL.md pack keeping the body as instructions', () => {
    const src = tmpRoot();
    write(src, 'SOUL.md', '---\nname: wise-soul\ndescription: A wise persona\n---\n\n# Wise Soul\n\nSpeak wisely.\n');
    const target = join(src, 'out');
    const result = importSkillPackage(src, { targetDir: target });
    expect(result.format).toBe('soul');
    const instructions = readSkillInstructions(target);
    expect(instructions).toContain('Wise Soul');
  });

  it('imports a generic MCP-server skill mapping mcpServers + shell permission', () => {
    const src = tmpRoot();
    write(src, 'mcp.json', JSON.stringify({ mcpServers: { fetch: { command: 'uvx', args: ['mcp-server-fetch'] } } }));
    const target = join(src, 'out');
    const result = importSkillPackage(src, { name: 'fetch-mcp', targetDir: target });
    expect(result.format).toBe('mcp-server');
    const mf = JSON.parse(readFileSync(join(target, 'skill.json'), 'utf-8')) as {
      skill: { requiredPermissions?: string[]; mcpServers?: Record<string, unknown> };
    };
    expect(mf.skill.mcpServers?.fetch).toBeDefined();
    expect(mf.skill.requiredPermissions).toContain('shell');
  });

  it('imports agent-scope tool-script skill carrying .py files', () => {
    const src = tmpRoot();
    write(src, 'README.md', '# Weather tools\nReturn current weather.\n');
    write(src, 'weather.py', 'from agentscope.tools import tool\n\n@tool\ndef get_weather(city: str) -> str:\n    return city\n');
    const target = join(src, 'out');
    const result = importSkillPackage(src, { name: 'weather-scope', targetDir: target });
    expect(result.format).toBe('agentscope');
    expect(existsSync(join(target, 'weather.py'))).toBe(true);
    const instructions = readSkillInstructions(target);
    expect(instructions).toContain('get_weather');
  });

  it('imports a skillhub multi-skill packet picking the inner skill', () => {
    const src = tmpRoot();
    write(src, 'skills/alpha/SKILL.md', CLAUDE_SKILL);
    write(src, 'skills/beta/SKILL.md', '---\nname: beta\ndescription: B\n---\n# Beta\n');
    const target = join(src, 'out');
    const result = importSkillPackage(src, { targetDir: target });
    expect(result.format).toBe('skillhub');
    expect(readFileSync(join(target, 'skill.json'), 'utf-8')).toContain('pdf-tables');
  });

  it('throws when target exists without force, and succeeds with force', () => {
    const src = tmpRoot();
    write(src, 'SKILL.md', CLAUDE_SKILL);
    const target = join(src, 'out');
    importSkillPackage(src, { targetDir: target });
    expect(() => importSkillPackage(src, { targetDir: target })).toThrow(/已存在/);
    expect(() => importSkillPackage(src, { targetDir: target, force: true })).not.toThrow();
  });
});

describe('exportSkillPackage — 导出渲染', () => {
  function markusSkill(): string {
    const src = tmpRoot();
    write(src, 'skill.json', JSON.stringify({
      type: 'skill',
      name: 'export-me',
      displayName: 'Export Me',
      version: '1.2.0',
      description: 'A skill for export testing',
      author: 'markus',
      category: 'development',
      tags: ['test'],
      license: 'Apache-2.0',
      skill: {
        skillFile: 'SKILL.md',
        requiredPermissions: ['shell', 'file'],
        mcpServers: {
          memory: { command: 'npx', args: ['-y', 'mcp-memory'] },
        },
      },
    }));
    write(src, 'SKILL.md', '---\nname: export-me\ndescription: A skill for export testing\n---\n# Export Me\n\nBody instructions.\n');
    return src;
  }

  it('exports to claude SKILL.md with frontmatter round-trippable', () => {
    const src = markusSkill();
    const out = join(src, 'claude-out');
    const result = exportSkillPackage(src, 'claude', { outDir: out });
    expect(result.filesWritten).toContain('SKILL.md');
    const md = readFileSync(join(out, 'SKILL.md'), 'utf-8');
    expect(md).toContain('name: export-me');
    expect(md).toContain('license: Apache-2.0');
    expect(md).toContain('allowed-tools: shell_execute, file_read, file_write, file_edit');
    expect(md).toContain('Body instructions.');

    // round-trip: re-import the exported claude package
    const re = importSkillPackage(join(out), { name: 'export-me', targetDir: join(src, 'reimport') });
    expect(re.name).toBe('export-me');
  });

  it('exports MCP skill to mcp.json + SKILL.md', () => {
    const src = markusSkill();
    const out = join(src, 'mcp-out');
    const result = exportSkillPackage(src, 'mcp-server', { outDir: out });
    expect(result.filesWritten).toContain('mcp.json');
    const mcp = JSON.parse(readFileSync(join(out, 'mcp.json'), 'utf-8')) as { mcpServers: Record<string, unknown> };
    expect(mcp.mcpServers.memory).toBeDefined();
  });

  it('exports openclaw config.json5 fragment with mcp servers', () => {
    const src = markusSkill();
    const out = join(src, 'openclaw-out');
    const result = exportSkillPackage(src, 'openclaw', { outDir: out });
    expect(result.filesWritten).toContain('config.json5');
    expect(readFileSync(join(out, 'config.json5'), 'utf-8')).toContain('mcpServers');
  });

  it('exports soul SOUL.md', () => {
    const src = markusSkill();
    const out = join(src, 'soul-out');
    const result = exportSkillPackage(src, 'soul', { outDir: out });
    expect(result.filesWritten).toContain('SOUL.md');
    expect(readFileSync(join(out, 'SOUL.md'), 'utf-8')).toContain('Export Me');
  });

  it('exports agentscope README.md + SKILL.md (+ tool stub when MCP present)', () => {
    const src = markusSkill();
    const out = join(src, 'scope-out');
    const result = exportSkillPackage(src, 'agentscope', { outDir: out });
    expect(result.filesWritten).toContain('README.md');
    expect(result.filesWritten).toContain('SKILL.md');
    expect(result.filesWritten).toContain('tool_stub.py');
  });

  it('renders all supported formats without throwing', () => {
    const skill: NormalizedSkill = {
      name: 'universal',
      version: '1.0.0',
      description: 'Universal skill',
      category: 'custom',
      source: 'markus',
      instructions: '# Universal\n',
      mcpServers: { s: { command: 'npx' } },
    };
    for (const fmt of SUPPORTED_EXTERNAL_FORMATS) {
      const files = renderSkill(skill, fmt);
      expect(files.length).toBeGreaterThan(0);
      expect(files[0]!.path).toBeTruthy();
    }
  });
});

describe('parseSkillPackage (fn)', () => {
  it('re-reads a Markus manifest preserving license/i18n/mcp', () => {
    const dir = tmpRoot();
    write(dir, 'skill.json', JSON.stringify({
      type: 'skill',
      name: 'native-skill',
      displayName: 'Native Skill',
      version: '2.0.0',
      description: 'Native description',
      category: 'development',
      license: 'MIT',
      i18n: { 'zh-CN': { displayName: '原生技能', description: '原生描述' } },
      skill: { skillFile: 'SKILL.md', requiredPermissions: ['network'], mcpServers: { s: { command: 'npx' } } },
    }));
    write(dir, 'SKILL.md', '---\nname: native-skill\ndescription: Native description\n---\n# Native\n');
    const n = parseSkillPackage(dir, {}, 'markus');
    expect(n.name).toBe('native-skill');
    expect(n.version).toBe('2.0.0'); // manifest version preserved
    expect(n.license).toBe('MIT');
    expect(n.mcpServers?.s).toBeDefined();
    expect(n.i18n?.['zh-CN']?.displayName).toBe('原生技能');
    expect(n.requiredPermissions).toContain('network');
  });
});