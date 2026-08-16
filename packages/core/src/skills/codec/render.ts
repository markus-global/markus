/**
 * Render a normalized skill into external ecosystem formats.
 * All renderers are pure — they return in-memory file lists (path → content);
 * the caller decides where to write them.
 */
import type {
  ExternalSkillFormat,
  NormalizedSkill,
  RenderedFile,
} from './types.js';
import { renderFrontmatter } from './frontmatter.js';

function bodyOr(skill: NormalizedSkill, fallback: string): string {
  return skill.instructions?.trim() || fallback;
}

const DEFAULT_BODY = (name: string) => `# ${name}

Activate with \`discover_tools({ name: ["${name}"] })\` and follow the instructions below to use this skill.
`;

/** Common SKILL.md for claude/skillhub/openclaw — frontmatter + instruction body. */
function renderSkillMd(skill: NormalizedSkill): string {
  const allowedTools = (skill.requiredPermissions ?? []).map(p => {
    switch (p) {
      case 'shell': return 'shell_execute';
      case 'file': return 'file_read, file_write, file_edit';
      case 'network': return 'web_search, web_fetch';
      case 'browser': return 'browser_navigate, browser_snapshot, browser_click';
    }
  });
  const fm = renderFrontmatter({
    name: skill.name,
    description: skill.description,
    version: skill.version,
    license: skill.license,
    author: skill.author,
    tags: skill.tags,
    allowedTools: allowedTools.length > 0 ? allowedTools.flatMap(a => a.split(', ')) : undefined,
  });
  return `${fm}\n${bodyOr(skill, DEFAULT_BODY(skill.name))}\n`;
}

/** Render as Claude Code / skills.sh compatible package. */
export function renderClaude(skill: NormalizedSkill): RenderedFile[] {
  return [{ path: 'SKILL.md', content: renderSkillMd(skill) }];
}

/** Render as OpenClaw package: SKILL.md + optional MCP config.json5. */
export function renderOpenClaw(skill: NormalizedSkill): RenderedFile[] {
  const files: RenderedFile[] = [{ path: 'SKILL.md', content: renderSkillMd(skill) }];
  if (skill.mcpServers && Object.keys(skill.mcpServers).length > 0) {
    const servers = Object.entries(skill.mcpServers).map(([name, cfg]) => {
      const lines = [`      ${name}: {`, `        command: "${cfg.command}"`];
      if (cfg.args && cfg.args.length > 0) {
        lines.push(`        args: [${cfg.args.map(a => `"${a}"`).join(', ')}]`);
      }
      if (cfg.env) {
        const envLines = Object.entries(cfg.env).map(([k, v]) => `          ${k}: "${v}"`);
        lines.push(`        env: {\n${envLines.join('\n')}\n        }`);
      }
      lines.push('      }');
      return lines.join('\n');
    });
    files.push({
      path: 'config.json5',
      content: `// MCP servers for ${skill.name} (OpenClaw config fragment — merge into your OpenClaw config)\n{\n  mcpServers: {\n${servers.join(',\n')},\n  },\n}\n`,
    });
  }
  return files;
}

/** Render as OpenClaw SOUL.md soul pack. */
export function renderSoul(skill: NormalizedSkill): RenderedFile[] {
  const body = bodyOr(skill, DEFAULT_BODY(skill.name));
  const fm = renderFrontmatter({
    name: skill.name,
    description: skill.description,
    version: skill.version,
    license: skill.license,
    author: skill.author,
    tags: skill.tags,
  });
  const content = [
    fm,
    `# ${skill.name}`,
    '',
    `This soul embeds the "${skill.name}" skill for OpenClaw agents.`,
    '',
    '## Skills',
    '',
    `### ${skill.name}${skill.description ? ` — ${skill.description}` : ''}`,
    '',
    body,
    '',
  ].join('\n');
  return [{ path: 'SOUL.md', content }];
}

/** Render as AgentScope-style tool-script skill (doc + optional python stub). */
export function renderAgentScope(skill: NormalizedSkill): RenderedFile[] {
  const body = bodyOr(skill, DEFAULT_BODY(skill.name));
  const files: RenderedFile[] = [
    {
      path: 'README.md',
      content: [
        `# ${skill.name}`,
        '',
        skill.description,
        '',
        '| 字段 | 值 |',
        '| --- | --- |',
        `| 名称 | ${skill.name} |`,
        `| 版本 | ${skill.version} |`,
        skill.author ? `| 作者 | ${skill.author} |` : '',
        skill.license ? `| License | ${skill.license} |` : '',
        (skill.requiredPermissions?.length ?? 0) > 0 ? `| 所需权限 | ${skill.requiredPermissions!.join(', ')} |` : '',
        '',
      ].filter(Boolean).join('\n'),
    },
    { path: 'SKILL.md', content: renderSkillMd(skill) },
  ];

  if (skill.mcpServers && Object.keys(skill.mcpServers).length > 0) {
    const server = Object.entries(skill.mcpServers)[0]!;
    const cfg = server[1];
    const argLiteral = (cfg.args ?? []).map(a => JSON.stringify(a)).join(', ');
    files.push({
      path: 'tool_stub.py',
      content: [
        `# AgentScope tool stub for "${skill.name}" (MCP: ${server[0]}).`,
        '# 在 AgentScope 环境中将下面的 @tool 函数注册为工具。',
        '',
        'from agentscope.tools import tool',
        '',
        '@tool',
        `def ${skill.name.replace(/[^a-zA-Z0-9_]/g, '_')}(input: str) -> str:`,
        '    """' + skill.description + '"""',
        `    # MCP server: ${server[0]} — command: ${cfg.command}${argLiteral ? ` args: ${argLiteral}` : ''}.`,
        '    # 在此实现对你的 MCP server 的调用（stdin/stdout JSON-RPC）。',
        '    raise NotImplementedError("implement MCP client call here")',
        '',
      ].join('\n'),
    });
  }

  void body;
  return files;
}

/** Render as generic MCP-server skill: mcp.json + SKILL.md. */
export function renderMcpServer(skill: NormalizedSkill): RenderedFile[] {
  const files: RenderedFile[] = [];
  if (skill.mcpServers && Object.keys(skill.mcpServers).length > 0) {
    const mcpJson: Record<string, unknown> = { mcpServers: skill.mcpServers };
    files.push({ path: 'mcp.json', content: JSON.stringify(mcpJson, null, 2) + '\n' });
  }
  files.push({ path: 'SKILL.md', content: renderSkillMd(skill) });
  return files;
}

const RENDERERS: Record<Exclude<ExternalSkillFormat, 'markus'>, (skill: NormalizedSkill) => RenderedFile[]> = {
  claude: renderClaude,
  skillhub: renderClaude,   // SkillHub/ClawHub packets use the same SKILL.md layout
  openclaw: renderOpenClaw,
  soul: renderSoul,
  agentscope: renderAgentScope,
  'mcp-server': renderMcpServer,
};

/** Render a normalized skill to the requested target format. */
export function renderSkill(
  skill: NormalizedSkill,
  format: Exclude<ExternalSkillFormat, 'markus'>,
): RenderedFile[] {
  const renderer = RENDERERS[format];
  return renderer(skill);
}