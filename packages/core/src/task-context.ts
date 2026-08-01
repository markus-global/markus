/**
 * task_context package attached on assign — STATE-MACHINES Spec
 */
export interface TaskContextPackage {
  requirementSummary?: string;
  deliverableRefs?: Array<{ id: string; title: string; version?: number }>;
  predecessorSummary?: string;
  projectKnowledgePointer?: string;
}

const TASK_CONTEXT_MAX_CHARS = 2_500;

export function formatTaskContextForPrompt(ctx: TaskContextPackage): string {
  const lines: string[] = ['\n## Task Context'];
  if (ctx.requirementSummary) {
    lines.push('### Requirement');
    lines.push(ctx.requirementSummary.slice(0, 800));
  }
  if (ctx.deliverableRefs?.length) {
    lines.push('### Related deliverables');
    for (const d of ctx.deliverableRefs.slice(0, 8)) {
      lines.push(`- ${d.title} (\`${d.id}\`${d.version != null ? ` v${d.version}` : ''})`);
    }
  }
  if (ctx.predecessorSummary) {
    lines.push('### Predecessor outputs');
    lines.push(ctx.predecessorSummary.slice(0, 600));
  }
  if (ctx.projectKnowledgePointer) {
    lines.push(`### Project knowledge: ${ctx.projectKnowledgePointer}`);
  }
  const text = lines.join('\n');
  return text.length > TASK_CONTEXT_MAX_CHARS
    ? `${text.slice(0, TASK_CONTEXT_MAX_CHARS)}\n_[task_context truncated]_`
    : text;
}

export function buildTaskContextPackage(opts: {
  requirement?: { title?: string; description?: string };
  deliverables?: Array<{ id: string; title: string; version?: number }>;
  predecessors?: Array<{ title: string; resultSummary?: string }>;
  projectId?: string;
}): TaskContextPackage {
  return {
    requirementSummary: opts.requirement
      ? `${opts.requirement.title ?? ''}: ${opts.requirement.description ?? ''}`.trim()
      : undefined,
    deliverableRefs: opts.deliverables,
    predecessorSummary: opts.predecessors?.length
      ? opts.predecessors
          .map((p) => `- ${p.title}: ${p.resultSummary ?? '(no summary)'}`.slice(0, 200))
          .join('\n')
      : undefined,
    projectKnowledgePointer: opts.projectId ? `project:${opts.projectId}` : undefined,
  };
}
