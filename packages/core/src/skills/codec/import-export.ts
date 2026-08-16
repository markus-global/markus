/**
 * High-level skill package import/export.
 *
 * importSkillPackage  — normalize any supported external skill directory into
 *                       ~/.markus/skills/<name>/ (or a custom target) with a
 *                       generated skill.json (type: skill) + SKILL.md + extras.
 * exportSkillPackage  — render a Markus skill directory to an external format.
 */
import { join, resolve, dirname } from 'node:path';
import {
  existsSync, mkdirSync, writeFileSync, copyFileSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { buildManifest, kebab } from '@markus/shared';
import type { ExternalSkillFormat, NormalizedSkill, SkillImportOptions, SkillImportResult, SkillExportOptions, SkillExportResult, RenderedFile } from './types.js';
import { detectSkillPackageFormat } from './detect.js';
import { parseSkillPackage } from './parse.js';
import { renderSkill } from './render.js';

const MARKUS_SKILLS_DIR = join(homedir(), '.markus', 'skills');

function sanitizeName(name: string): string {
  return kebab(name) || 'skill';
}

function safeTarget(target: string, force?: boolean): { ok: boolean; error?: string } {
  if (existsSync(target) && !force) {
    return { ok: false, error: `目标目录已存在: ${target}（使用 --force 覆盖）` };
  }
  return { ok: true };
}

function copyExtraFiles(srcDir: string, targetDir: string, extras?: NormalizedSkill['extraFiles']): string[] {
  const written: string[] = [];
  mkdirSync(targetDir, { recursive: true });
  for (const f of extras ?? []) {
    const from = join(srcDir, f.from);
    const to = join(targetDir, f.to);
    try {
      if (!statSync(from).isFile()) continue;
      mkdirSync(join(targetDir, dirname(f.to)), { recursive: true });
      copyFileSync(from, to);
      written.push(f.to);
    } catch { /* skip unreadable extras */ }
  }
  return written;
}

function writeRendered(targetDir: string, files: RenderedFile[], overwrite: boolean): string[] {
  const written: string[] = [];
  for (const f of files) {
    const out = join(targetDir, f.path);
    if (existsSync(out) && !overwrite) continue;
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(out, f.content, 'utf-8');
    written.push(f.path);
  }
  return written;
}

/**
 * Import an external skill package directory into Markus format.
 */
export function importSkillPackage(
  srcDir: string,
  opts: SkillImportOptions = {},
): SkillImportResult {
  const format = detectSkillPackageFormat(srcDir);
  const normalized = parseSkillPackage(srcDir, opts, format);

  const name = sanitizeName(opts.name ?? normalized.name);
  const targetDir = resolve(opts.targetDir ?? join(MARKUS_SKILLS_DIR, name));
  const guard = safeTarget(targetDir, opts.force);
  if (!guard.ok) throw new Error(guard.error);

  mkdirSync(targetDir, { recursive: true });

  // skill.json — build a Markus manifest, then preserve license/i18n passthrough.
  const manifest = buildManifest('skill', {
    name,
    displayName: normalized.displayName,
    version: normalized.version,
    description: normalized.description,
    author: normalized.author ?? 'community',
    category: normalized.category,
    tags: normalized.tags ?? [],
    skill: {
      skillFile: 'SKILL.md',
      requiredPermissions: normalized.requiredPermissions,
      mcpServers: normalized.mcpServers,
      isolation: normalized.isolation,
    },
  });
  const manifestWithExtras: Record<string, unknown> = {
    ...(manifest as unknown as Record<string, unknown>),
    source: {
      type: normalized.source,
      url: opts.sourceUrl ?? normalized.sourceUrl ?? '',
    },
  };
  if (normalized.license) manifestWithExtras.license = normalized.license;
  if (normalized.i18n && Object.keys(normalized.i18n).length > 0) {
    manifestWithExtras.i18n = normalized.i18n;
  }

  const written: string[] = [];
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'skill.json'), JSON.stringify(manifestWithExtras, null, 2) + '\n', 'utf-8');
  written.push('skill.json');

  // SKILL.md — same layout as claude format so it stays discoverable everywhere.
  const skillMd = renderSkill(normalized, 'claude')[0]!.content;
  writeFileSync(join(targetDir, 'SKILL.md'), skillMd, 'utf-8');
  written.push('SKILL.md');

  const copyWarnings: string[] = [];
  const extras = (normalized.extraFiles ?? []).slice(0, 100);
  const copied = copyExtraFiles(srcDir, targetDir, extras);
  written.push(...copied.map(c => `extras/${c}`));
  if (extras.length > copied.length) copyWarnings.push(`${extras.length - copied.length} 个附加文件因不可读被跳过`);

  return { format, name, version: normalized.version, path: targetDir, filesWritten: written, warnings: copyWarnings };
}

/**
 * Export a Markus skill directory to an external ecosystem format.
 */
export function exportSkillPackage(
  sourceDir: string,
  format: Exclude<ExternalSkillFormat, 'markus'>,
  opts: SkillExportOptions = {},
): SkillExportResult {
  const fmt = detectSkillPackageFormat(sourceDir);
  if (fmt !== 'markus') {
    // Allow exporting any parseable skill dir (normalizes implicitly).
    // parseSkillPackage handles non-markus too.
  }
  const normalized = parseSkillPackage(sourceDir, {}, fmt);

  const name = sanitizeName(normalized.name);
  const outDir = resolve(opts.outDir ?? join(process.cwd(), `${name}-${format}`));
  mkdirSync(outDir, { recursive: true });

  const files = renderSkill(normalized, format);
  const written = writeRendered(outDir, files, opts.overwrite ?? false);

  return { format, name, path: outDir, filesWritten: written };
}

/** Build SKILL.md for a normalized skill (markus layout == claude layout). */
export function renderMarkdown(normalized: NormalizedSkill): string {
  return renderSkill(normalized, 'claude')[0]!.content;
}