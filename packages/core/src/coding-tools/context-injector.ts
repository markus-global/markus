import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CodingToolName, TaskContextResponse } from '@markus/shared';

export interface ContextInjectionOptions {
  workdir: string;
  tool: CodingToolName;
  taskContext: TaskContextResponse;
  skills?: Array<{ name: string; content: string }>;
  markusCli?: string;
  serverUrl?: string;
}

export interface ContextInjectionResult {
  filesCreated: string[];
  envVars: Record<string, string>;
}

export function injectContext(options: ContextInjectionOptions): ContextInjectionResult {
  const { workdir, tool, taskContext, skills, markusCli, serverUrl } = options;
  const filesCreated: string[] = [];
  const envVars: Record<string, string> = {};

  const contextContent = buildContextContent(taskContext, markusCli, serverUrl);
  const skillContent = skills?.map((s) => `## Skill: ${s.name}\n\n${s.content}`).join('\n\n---\n\n') || '';
  const fullContent = skillContent
    ? `${contextContent}\n\n---\n\n# Relevant Skills\n\n${skillContent}`
    : contextContent;

  if (tool === 'claude-code') {
    const claudeFile = join(workdir, 'CLAUDE.md');
    writeFileSync(claudeFile, fullContent, 'utf-8');
    filesCreated.push(claudeFile);
  } else if (tool === 'cursor-agent') {
    const agentsFile = join(workdir, '.cursor/rules/markus-task.mdc');
    mkdirSync(join(workdir, '.cursor', 'rules'), { recursive: true });
    writeFileSync(agentsFile, fullContent, 'utf-8');
    filesCreated.push(agentsFile);
  } else {
    const contextDir = join(workdir, '.agent_context');
    mkdirSync(contextDir, { recursive: true });
    const contextFile = join(contextDir, 'task_context.md');
    writeFileSync(contextFile, fullContent, 'utf-8');
    filesCreated.push(contextFile);
  }

  if (serverUrl) envVars['MARKUS_API_URL'] = serverUrl;
  if (taskContext.task.id) envVars['MARKUS_TASK_ID'] = taskContext.task.id;
  if (markusCli) envVars['MARKUS_CLI'] = markusCli;

  return { filesCreated, envVars };
}

function buildContextContent(ctx: TaskContextResponse, markusCli?: string, _serverUrl?: string): string {
  const lines: string[] = [];

  lines.push(`# Task: ${ctx.task.title}`);
  lines.push('');
  lines.push(`**ID:** ${ctx.task.id}`);
  lines.push(`**Status:** ${ctx.task.status}`);
  lines.push(`**Priority:** ${ctx.task.priority}`);
  lines.push(`**Execution Round:** ${ctx.task.executionRound}`);
  lines.push('');
  lines.push('## Description');
  lines.push('');
  lines.push(ctx.task.description);
  lines.push('');

  if (ctx.task.subtasks?.length) {
    lines.push('## Subtasks');
    lines.push('');
    for (const st of ctx.task.subtasks) {
      const check = st.status === 'completed' ? '[x]' : '[ ]';
      lines.push(`- ${check} ${st.title} (${st.status})`);
    }
    lines.push('');
  }

  if (ctx.task.notes?.length) {
    lines.push('## Notes');
    lines.push('');
    for (const note of ctx.task.notes) {
      lines.push(`- ${note}`);
    }
    lines.push('');
  }

  if (ctx.requirement) {
    lines.push('## Requirement');
    lines.push('');
    lines.push(`**${ctx.requirement.title}** (${ctx.requirement.status})`);
    lines.push('');
    lines.push(ctx.requirement.description);
    lines.push('');
  }

  if (ctx.project) {
    lines.push('## Project');
    lines.push('');
    lines.push(`**${ctx.project.name}**`);
    lines.push('');
    lines.push(ctx.project.description);
    lines.push('');
    if (ctx.project.repositories?.length) {
      lines.push('### Repositories');
      for (const repo of ctx.project.repositories) {
        lines.push(`- ${repo.localPath || repo.url} (${repo.role})`);
      }
      lines.push('');
    }
  }

  if (ctx.upstream?.length) {
    lines.push('## Upstream Dependencies (this task is blocked by)');
    lines.push('');
    for (const dep of ctx.upstream) {
      lines.push(`### ${dep.title} (${dep.status})`);
      if (dep.completionSummary) lines.push(`Summary: ${dep.completionSummary}`);
      if (dep.deliverables?.length) {
        lines.push('Deliverables:');
        for (const d of dep.deliverables) lines.push(`  - ${d.summary} (${d.reference})`);
      }
      lines.push('');
    }
  }

  if (ctx.downstream?.length) {
    lines.push('## Downstream Dependents (tasks blocked by this task)');
    lines.push('');
    for (const dep of ctx.downstream) {
      lines.push(`- ${dep.title} (${dep.status})`);
    }
    lines.push('');
  }

  if (markusCli) {
    lines.push('## Reporting Progress');
    lines.push('');
    lines.push('Use the Markus CLI to report progress:');
    lines.push('```bash');
    lines.push(`${markusCli} task progress ${ctx.task.id} -t "your progress update"`);
    lines.push(`${markusCli} task note ${ctx.task.id} -t "your note"`);
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

export { buildContextContent };
