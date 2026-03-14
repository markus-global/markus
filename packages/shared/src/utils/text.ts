const thinkRegex = /<think>([\s\S]*?)<\/think>/g;

/**
 * Extract <think> blocks from text, returning both the thinking content
 * and the cleaned text with <think> blocks removed.
 */
export function extractThinkBlocks(text: string): { thinking: string[]; clean: string } {
  const thinking: string[] = [];
  const clean = text.replace(thinkRegex, (_match, inner: string) => {
    const trimmed = inner.trim();
    if (trimmed) thinking.push(trimmed);
    return '';
  });
  return { thinking, clean: clean.trim() };
}

/**
 * Strip all internal process blocks (<think>, etc.) from text.
 * Used to sanitize agent output before exposing to other agents.
 */
export function stripInternalBlocks(text: string): string {
  return text.replace(thinkRegex, '').trim();
}
