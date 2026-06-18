/**
 * Mac App Store sandbox gating.
 *
 * When MARKUS_MAS=true, certain capabilities are disabled because
 * the MAS sandbox doesn't allow spawning processes or arbitrary filesystem access.
 */

const MAS_DISABLED_TOOLS = new Set([
  'shell_execute',
  'background_execute',
  'process_manager',
]);

const MAS_RESTRICTED_TOOLS = new Set([
  'file_write',
  'file_edit',
  'file_read',
  'list_directory',
  'grep',
  'glob',
]);

export function isMASBuild(): boolean {
  return process.env['MARKUS_MAS'] === 'true';
}

export function isToolDisabledInMAS(toolName: string): boolean {
  if (!isMASBuild()) return false;
  return MAS_DISABLED_TOOLS.has(toolName);
}

export function isToolRestrictedInMAS(toolName: string): boolean {
  if (!isMASBuild()) return false;
  return MAS_RESTRICTED_TOOLS.has(toolName);
}

export function getMASToolBlockedMessage(toolName: string): string {
  return `This action (${toolName}) requires the full version of Markus. ` +
    `The App Store version cannot execute shell commands or access arbitrary files due to macOS sandbox restrictions. ` +
    `Download the full version at https://markus.global/download for unrestricted access.`;
}
