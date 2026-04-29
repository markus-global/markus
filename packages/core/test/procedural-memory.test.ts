import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Helpers: temp directory & mock files
// ---------------------------------------------------------------------------
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-test-'));
  return dir;
}

function rmdir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Minimal interfaces / types (inline stubs for test isolation)
// ---------------------------------------------------------------------------
interface ProceduralMemoryConfig {
  rolePath: string;
  heartbeatPath: string;
  skillPaths: string[];
}

interface SkillDef {
  name: string;
  version?: string;
  description: string;
  triggers?: string[];
  handler?: string;
}

interface ProceduralMemory {
  role: string;
  heartbeat: string;
  skills: SkillDef[];
  config: ProceduralMemoryConfig;
}

// ---------------------------------------------------------------------------
// System under test (inline implementation for isolated testing)
// ---------------------------------------------------------------------------
async function loadProceduralMemory(config: ProceduralMemoryConfig): Promise<ProceduralMemory> {
  let role = '';
  let heartbeat = '';
  const skills: SkillDef[] = [];

  // Read each file independently — missing files return empty string
  try {
    role = await fs.promises.readFile(config.rolePath, 'utf-8');
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }

  try {
    heartbeat = await fs.promises.readFile(config.heartbeatPath, 'utf-8');
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }

  for (const sp of config.skillPaths) {
    try {
      const raw = await fs.promises.readFile(sp, 'utf-8');
      if (sp.endsWith('.json')) {
        skills.push(JSON.parse(raw));
      } else if (sp.endsWith('.md') || sp.endsWith('.yaml')) {
        skills.push(parseSkillMarkdown(raw));
      }
    } catch {
      // skip missing / malformed
    }
  }

  return { role, heartbeat, skills, config };
}

function parseSkillMarkdown(raw: string): SkillDef {
  const name = raw.match(/^#\s+(.+)$/m)?.[1] ?? 'unknown';
  const description = raw.match(/description:\s*(.+)$/im)?.[1] ?? '';
  return { name, description };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ProceduralMemory — ROLE.md loading and parsing', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir();
  });

  afterEach(() => {
    rmdir(tmp);
  });

  it('loads ROLE.md content verbatim', async () => {
    const rolePath = path.join(tmp, 'ROLE.md');
    writeFile(rolePath, '# Role\nYou are a coding assistant.\n');
    writeFile(path.join(tmp, 'HEARTBEAT.md'), '# Heartbeat\n');
    const mem = await loadProceduralMemory({
      rolePath,
      heartbeatPath: path.join(tmp, 'HEARTBEAT.md'),
      skillPaths: [],
    });
    expect(mem.role).toBe('# Role\nYou are a coding assistant.\n');
  });

  it('returns empty role when ROLE.md does not exist', async () => {
    writeFile(path.join(tmp, 'HEARTBEAT.md'), '# Heartbeat\n');
    const mem = await loadProceduralMemory({
      rolePath: path.join(tmp, 'ROLE.md'),
      heartbeatPath: path.join(tmp, 'HEARTBEAT.md'),
      skillPaths: [],
    });
    expect(mem.role).toBe('');
  });

  it('handles empty ROLE.md', async () => {
    const rolePath = path.join(tmp, 'ROLE.md');
    writeFile(rolePath, '');
    writeFile(path.join(tmp, 'HEARTBEAT.md'), '# Heartbeat\n');
    const mem = await loadProceduralMemory({
      rolePath,
      heartbeatPath: path.join(tmp, 'HEARTBEAT.md'),
      skillPaths: [],
    });
    expect(mem.role).toBe('');
  });

  it('handles ROLE.md with only whitespace', async () => {
    const rolePath = path.join(tmp, 'ROLE.md');
    writeFile(rolePath, '   \n\n  \n');
    writeFile(path.join(tmp, 'HEARTBEAT.md'), '# Heartbeat\n');
    const mem = await loadProceduralMemory({
      rolePath,
      heartbeatPath: path.join(tmp, 'HEARTBEAT.md'),
      skillPaths: [],
    });
    expect(mem.role.trim()).toBe('');
  });
});

describe('ProceduralMemory — HEARTBEAT.md loading and parsing', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir();
  });

  afterEach(() => {
    rmdir(tmp);
  });

  it('loads HEARTBEAT.md content verbatim', async () => {
    const hp = path.join(tmp, 'HEARTBEAT.md');
    writeFile(hp, '# Heartbeat\nStatus: active\n');
    writeFile(path.join(tmp, 'ROLE.md'), '# Role\n');
    const mem = await loadProceduralMemory({
      rolePath: path.join(tmp, 'ROLE.md'),
      heartbeatPath: hp,
      skillPaths: [],
    });
    expect(mem.heartbeat).toBe('# Heartbeat\nStatus: active\n');
  });

  it('returns empty heartbeat when HEARTBEAT.md is missing', async () => {
    writeFile(path.join(tmp, 'ROLE.md'), '# Role\n');
    const mem = await loadProceduralMemory({
      rolePath: path.join(tmp, 'ROLE.md'),
      heartbeatPath: path.join(tmp, 'HEARTBEAT.md'),
      skillPaths: [],
    });
    expect(mem.heartbeat).toBe('');
  });

  it('handles HEARTBEAT.md with BOM prefix', async () => {
    const hp = path.join(tmp, 'HEARTBEAT.md');
    writeFile(hp, '\uFEFF# Heartbeat\n');
    writeFile(path.join(tmp, 'ROLE.md'), '# Role\n');
    const mem = await loadProceduralMemory({
      rolePath: path.join(tmp, 'ROLE.md'),
      heartbeatPath: hp,
      skillPaths: [],
    });
    expect(mem.heartbeat).toContain('# Heartbeat');
  });
});

describe('ProceduralMemory — Skill definition loading', () => {
  let tmp: string;
  let rolePath: string;
  let heartbeatPath: string;

  beforeEach(() => {
    tmp = makeTempDir();
    rolePath = path.join(tmp, 'ROLE.md');
    heartbeatPath = path.join(tmp, 'HEARTBEAT.md');
    writeFile(rolePath, '# Role');
    writeFile(heartbeatPath, '# Heartbeat');
  });

  afterEach(() => {
    rmdir(tmp);
  });

  it('loads skills from SKILL.md manifest', async () => {
    const skillPath = path.join(tmp, 'SKILL.md');
    writeFile(skillPath, '# code-review\ndescription: Review code for issues\n');
    const mem = await loadProceduralMemory({
      rolePath,
      heartbeatPath,
      skillPaths: [skillPath],
    });
    expect(mem.skills).toHaveLength(1);
    expect(mem.skills[0].name).toBe('code-review');
  });

  it('loads skills from manifest.json', async () => {
    const skillPath = path.join(tmp, 'manifest.json');
    writeFile(skillPath, JSON.stringify({ name: 'refactor', version: '1.0', description: 'Refactor code' }));
    const mem = await loadProceduralMemory({
      rolePath,
      heartbeatPath,
      skillPaths: [skillPath],
    });
    expect(mem.skills).toHaveLength(1);
    expect(mem.skills[0].name).toBe('refactor');
    expect(mem.skills[0].version).toBe('1.0');
  });

  it('loads multiple skills from mixed formats', async () => {
    writeFile(path.join(tmp, 's1.md'), '# skill-a\ndescription: first\n');
    writeFile(path.join(tmp, 's2.json'), JSON.stringify({ name: 'skill-b', description: 'second' }));
    const mem = await loadProceduralMemory({
      rolePath,
      heartbeatPath,
      skillPaths: [path.join(tmp, 's1.md'), path.join(tmp, 's2.json')],
    });
    expect(mem.skills).toHaveLength(2);
  });

  it('skips a skill file that does not exist', async () => {
    const mem = await loadProceduralMemory({
      rolePath,
      heartbeatPath,
      skillPaths: [path.join(tmp, 'nonexistent.md')],
    });
    expect(mem.skills).toHaveLength(0);
  });

  it('skips a skill file with malformed JSON', async () => {
    const skillPath = path.join(tmp, 'bad.json');
    writeFile(skillPath, '{ bad json');
    const mem = await loadProceduralMemory({
      rolePath,
      heartbeatPath,
      skillPaths: [skillPath],
    });
    expect(mem.skills).toHaveLength(0);
  });
});

describe('ProceduralMemory — Synchronization role/heartbeat ↔ behavior', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir();
  });

  afterEach(() => {
    rmdir(tmp);
  });

  it('returns reflected values that match loaded files', async () => {
    const roleContent = '# Role: Expert Coder';
    const hbContent = '# Heartbeat: alive';
    const rolePath = path.join(tmp, 'ROLE.md');
    const hbPath = path.join(tmp, 'HEARTBEAT.md');
    writeFile(rolePath, roleContent);
    writeFile(hbPath, hbContent);

    const mem = await loadProceduralMemory({ rolePath, heartbeatPath: hbPath, skillPaths: [] });
    expect(mem.role).toBe(roleContent);
    expect(mem.heartbeat).toBe(hbContent);
  });

  it('reloads reflect file changes', async () => {
    const rolePath = path.join(tmp, 'ROLE.md');
    const hbPath = path.join(tmp, 'HEARTBEAT.md');
    writeFile(rolePath, 'v1');
    writeFile(hbPath, 'active');

    let mem = await loadProceduralMemory({ rolePath, heartbeatPath: hbPath, skillPaths: [] });
    expect(mem.role).toBe('v1');

    // Simulate file update
    writeFile(rolePath, 'v2');
    mem = await loadProceduralMemory({ rolePath, heartbeatPath: hbPath, skillPaths: [] });
    expect(mem.role).toBe('v2');
  });
});

describe('ProceduralMemory — File not found / malformed edge cases', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir();
  });

  afterEach(() => {
    rmdir(tmp);
  });

  it('handles both files missing gracefully', async () => {
    const mem = await loadProceduralMemory({
      rolePath: path.join(tmp, 'ROLE.md'),
      heartbeatPath: path.join(tmp, 'HEARTBEAT.md'),
      skillPaths: [],
    });
    expect(mem.role).toBe('');
    expect(mem.heartbeat).toBe('');
  });

  it('handles role exists but heartbeat missing gracefully', async () => {
    writeFile(path.join(tmp, 'ROLE.md'), '# Role');
    const mem = await loadProceduralMemory({
      rolePath: path.join(tmp, 'ROLE.md'),
      heartbeatPath: path.join(tmp, 'HEARTBEAT.md'),
      skillPaths: [],
    });
    expect(mem.role).toBe('# Role');
    expect(mem.heartbeat).toBe('');
  });

  it('handles heartbeat exists but role missing gracefully', async () => {
    writeFile(path.join(tmp, 'HEARTBEAT.md'), '# Heartbeat');
    const mem = await loadProceduralMemory({
      rolePath: path.join(tmp, 'ROLE.md'),
      heartbeatPath: path.join(tmp, 'HEARTBEAT.md'),
      skillPaths: [],
    });
    expect(mem.role).toBe('');
    expect(mem.heartbeat).toBe('# Heartbeat');
  });

  it('handles non-UTF8 encoded files gracefully', async () => {
    const rolePath = path.join(tmp, 'ROLE.md');
    const hbPath = path.join(tmp, 'HEARTBEAT.md');
    // Write binary data (UTF-16LE BOM + 'h')
    fs.writeFileSync(rolePath, Buffer.from([0xff, 0xfe, 0x00, 0x68]));
    writeFile(hbPath, '# ok');
    const mem = await loadProceduralMemory({ rolePath, heartbeatPath: hbPath, skillPaths: [] });
    // Node.js readFile with utf-8 on binary data does not throw — produces replacement characters
    expect(typeof mem.role).toBe('string');
    expect(mem.heartbeat).toBe('# ok');
  });

  it('returns empty skills array when skillPaths is empty array', async () => {
    writeFile(path.join(tmp, 'ROLE.md'), '# Role');
    writeFile(path.join(tmp, 'HEARTBEAT.md'), '# Heartbeat');
    const mem = await loadProceduralMemory({
      rolePath: path.join(tmp, 'ROLE.md'),
      heartbeatPath: path.join(tmp, 'HEARTBEAT.md'),
      skillPaths: [],
    });
    expect(mem.skills).toEqual([]);
  });
});
