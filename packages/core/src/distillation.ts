/**
 * Post-task distillation prompt builder — docs/architecture/learning-loop.md §2
 *
 * Only for completed tasks. Failed tasks wait for completion / Remember.
 * No structured JSON outcome — Learning Habits tools are enough.
 */

export type DistillationPromptKind = 'success' | 'revision';

export interface DistillationPromptInput {
  taskId: string;
  title: string;
  kind: DistillationPromptKind;
  executionRound?: number;
  traceSection: string;
}

/** Build the user-message seed for scenario: distillation. */
export function buildDistillationPrompt(input: DistillationPromptInput): string {
  // round 只有一个所有者：派发侧（`task.executionRound ?? 1` 在 TaskService）。
  // 这里看不到权威轮次时**不冒充**第 1 轮 —— 模型被告知「未上报」比被告知
  // 一个编造的数字更安全：它下一句就会写「这是首次完成」这样的错误归因。
  const round = input.executionRound;
  const roundKnown = typeof round === 'number' && Number.isInteger(round) && round >= 1;
  const header =
    input.kind === 'revision'
      ? `[DISTILLATION — Post-Task Reflection (Revision)]\n\nTask "${input.title}" (ID: ${input.taskId}) completed after ${roundKnown ? `${round} execution rounds` : 'an unreported number of execution rounds'}.`
      : `[DISTILLATION — Post-Task Reflection (Success)]\n\nTask "${input.title}" (ID: ${input.taskId}) completed successfully.`;

  const focus =
    input.kind === 'revision'
      ? [
          'Reviewer/user feedback drove a revision — that feedback is the signal.',
          '1. What was wrong earlier? What feedback corrected it?',
          '2. What changed in the successful round?',
          '3. Durable lesson: personal memory, or a shareable skill for other agents?',
        ].join('\n')
      : [
          'First-pass completion. Reflect only if something is worth keeping:',
          '1. Tools, patterns, or approaches that proved especially effective?',
          '2. Reusable technique for similar future tasks?',
          '3. Would this benefit other agents as an executable skill?',
        ].join('\n');

  return [
    header,
    '',
    '## Execution Trace',
    input.traceSection,
    '',
    focus,
    '',
    'Follow **Learning Habits** (me-vs-others / encode / skill impact).',
    'Personal lesson → `memory_save` / `memory_update*`.',
    'Shared playbook → `builder-artifacts/skills/` then `package_install`',
    '(impact low → install; high/omitted → `request_user_input` first).',
    'ROLE/HEARTBEAT only when warranted. If nothing noteworthy → stop (no tools needed).',
  ].join('\n');
}
