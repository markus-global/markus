/**
 * Skill ecosystem codec — public API.
 *
 * Bridges Markus skill packages with external skill ecosystems
 * (skills.sh 80k+ community skills, SkillHub/ClawHub, OpenClaw/SOUL.md,
 * AgentScope, generic MCP-server skills).
 */
export type {
  ExternalSkillFormat,
  SkillFrontmatter,
  NormalizedSkill,
  SkillImportOptions,
  SkillImportResult,
  SkillExportOptions,
  SkillExportResult,
  RenderedFile,
} from './types.js';
export { SUPPORTED_EXTERNAL_FORMATS } from './types.js';
export {
  detectSkillPackageFormat,
  formatLabel,
  defaultNameFromPath,
  nodeDetectFs,
  readSkillMd,
  type DetectFs,
} from './detect.js';
export {
  parseSkillPackage,
  mapAllowedToolsToPermissions,
  json5ToJson,
  parseJson5File,
} from './parse.js';
export { renderSkill } from './render.js';
export {
  importSkillPackage,
  exportSkillPackage,
  renderMarkdown,
} from './import-export.js';