import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Command } from 'commander';
import {
  importSkillPackage,
  exportSkillPackage,
  detectSkillPackageFormat,
  formatLabel,
  SUPPORTED_EXTERNAL_FORMATS,
  createDefaultSkillRegistry,
  type ExternalSkillFormat,
  type SkillImportResult,
  type SkillExportResult,
} from '@markus/core';
import { setGlobalJson, table, detail, success, fail } from '../output.js';

const MARKUS_SKILLS_DIR = join(homedir(), '.markus', 'skills');

function resolveSkillDir(name: string): string | undefined {
  const candidates = [
    join(MARKUS_SKILLS_DIR, name),
    join(process.cwd(), 'templates', 'skills', name),
    process.env['MARKUS_TEMPLATES_DIR'] ? join(process.env['MARKUS_TEMPLATES_DIR'], 'skills', name) : '',
  ].filter(Boolean);
  return candidates.find(c => existsSync(c));
}

export function registerSkillCommands(program: Command): void {
  const skill = program
    .command('skill')
    .description('技能生态管理 — 列出现有技能、导入外部技能包、导出到外部生态');

  // ── list ─────────────────────────────────────────────────────────────────
  skill
    .command('list')
    .description('列出已安装技能')
    .option('--json', 'JSON 输出')
    .action(async (opts: { json?: boolean }) => {
      setGlobalJson(!!opts.json);
      try {
        const registry = await createDefaultSkillRegistry();
        const rows = registry.list().map(s => ({
          name: s.name,
          version: s.version,
          category: s.category,
          builtIn: s.builtIn ? 'yes' : '',
          mcp: s.mcpServers && Object.keys(s.mcpServers).length > 0 ? 'yes' : '',
          description: (s.description ?? '').slice(0, 60),
        }));
        if (rows.length === 0) {
          success('未找到已安装的技能。可使用 `markus skill import <path>` 导入。', []);
          return;
        }
        table(rows, [
          { key: 'name', header: '名称', width: 24 },
          { key: 'version', header: '版本' },
          { key: 'category', header: '分类' },
          { key: 'builtIn', header: '内置' },
          { key: 'mcp', header: 'MCP' },
          { key: 'description', header: '描述' },
        ], { title: `已安装技能（${rows.length}）` });
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });

  // ── import ────────────────────────────────────────────────────────────────
  skill
    .command('import')
    .description('导入外部技能包并归一化为 Markus 格式（skill.json + SKILL.md）')
    .argument('<path>', '外部技能包目录或 SKILL.md 文件路径')
    .option('--name <name>', '覆盖技能名（kebab-case）')
    .option('--to <dir>', '目标目录（默认 ~/.markus/skills/<name>）')
    .option('--force', '覆盖已存在的目标目录')
    .option('--json', 'JSON 输出')
    .action((path: string, opts: { name?: string; to?: string; force?: boolean; json?: boolean }) => {
      setGlobalJson(!!opts.json);
      try {
        const format = detectSkillPackageFormat(path);
        const result: SkillImportResult = importSkillPackage(path, {
          name: opts.name,
          targetDir: opts.to,
          force: opts.force,
        });
        if (!opts.json) {
          success(`✓ 导入成功（${formatLabel(format)}）→ ${result.name}@${result.version} @ ${result.path}`);
          if (result.warnings.length > 0) {
            for (const w of result.warnings) console.log(`  ⚠ ${w}`);
          }
          console.log(`  写入文件: ${result.filesWritten.join(', ')}`);
          console.log('  现在可在 Agent 对话中用 discover_tools({ name: ["' + result.name + '"] }) 激活，或用 markus skill list 查看。');
        } else {
          detail(result as unknown as Record<string, unknown>);
        }
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });

  // ── export ────────────────────────────────────────────────────────────────
  skill
    .command('export')
    .description('将技能渲染为外部生态格式（skills.sh / SkillHub / OpenClaw / SOUL.md / AgentScope / MCP）')
    .argument('<name>', '技能名（在 ~/.markus/skills 或 templates/skills 中查找）')
    .option('--from <dir>', '直接指定技能目录，跳过按名称查找')
    .option('--format <format>', `目标格式: ${SUPPORTED_EXTERNAL_FORMATS.join(' | ')}`, 'claude')
    .option('--out <dir>', '输出目录（默认当前目录）')
    .option('--overwrite', '覆盖已存在的输出文件')
    .option('--json', 'JSON 输出')
    .action((name: string, opts: { from?: string; format?: string; out?: string; overwrite?: boolean; json?: boolean }) => {
      setGlobalJson(!!opts.json);
      const format = (opts.format ?? 'claude') as ExternalSkillFormat;
      if (format !== 'claude' && !(SUPPORTED_EXTERNAL_FORMATS as string[]).includes(format)) {
        fail(`不支持的导出格式: ${opts.format}。可用: ${SUPPORTED_EXTERNAL_FORMATS.join(', ')}`);
        return;
      }
      const sourceDir = opts.from ?? resolveSkillDir(name);
      if (!sourceDir) {
        fail(`找不到技能 "${name}"（查找 ~/.markus/skills 与 templates/skills）。可用 --from <dir> 直接指定目录。`);
        return;
      }
      try {
        const result: SkillExportResult = exportSkillPackage(sourceDir, format as Exclude<ExternalSkillFormat, 'markus'>, {
          outDir: opts.out,
          overwrite: opts.overwrite,
        });
        if (!opts.json) {
          success(`✓ 已导出为 ${formatLabel(format)}`);
          console.log(`  技能: ${result.name}`);
          console.log(`  输出: ${result.path}`);
          console.log(`  文件: ${result.filesWritten.join(', ')}`);
        } else {
          detail(result as unknown as Record<string, unknown>);
        }
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });

  // ── formats ───────────────────────────────────────────────────────────────
  skill
    .command('formats')
    .description('列出支持的技能生态格式与检测规则')
    .action(() => {
      console.log('支持的技能生态格式（导入自动检测，导出需 --format）:');
      for (const f of SUPPORTED_EXTERNAL_FORMATS) {
        console.log(`  ${f.padEnd(12)} ${formatLabel(f)}`);
      }
      console.log('\n导入检测优先级（目录内特征）:');
      console.log('  skill.json            → Markus 原生');
      console.log('  mcp.json/.mcp.json    → 通用 MCP-server 技能');
      console.log('  SOUL.md               → OpenClaw SOUL.md');
      console.log('  config.json5/AGENTS.md/skills/ → OpenClaw');
      console.log('  SKILL.md (frontmatter) → Claude Code / skills.sh / SkillHub');
      console.log('  skills/ 子目录        → SkillHub 多技能包');
      console.log('  @tool 脚本 + README    → AgentScope 工具脚本技能');
    });
}