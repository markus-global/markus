#!/usr/bin/env node
/**
 * 一次性修复：给历史工作流任务补回「步骤身份」。
 *
 * 背景（2026-10-28）：`CreateTaskRequest.notes` 是 `string` 而 `Task.notes` 是
 * `string[]`，所以 runner 当年写的 `"[Workflow] … step: <id>"` **在创建时就被
 * 静默丢弃**。于是历史运行的任务没有 `workflow_step_id`，而运行期已不再从文本
 * 推断结构（W2 起的规则）→ 那些运行的每个步骤都显示「未匹配（历史运行）」。
 *
 * 这个脚本是**迁移式修复**（不是运行期推断）：只在标题能无歧义对应到模板步骤时
 * 写入结构列，其余一律跳过并报告。默认 dry-run，加 `--apply` 才写库。
 *
 * 判定规则（保守）：
 *   1. 任务标题形如 `[<displayName>] <step.name>`（runner 的固定格式）；
 *   2. 该 step.name 在当期模板里**恰好出现一次** → 写入；
 *      出现 0 次（模板已改/步骤改名）或多次（重名步骤）→ 跳过，计入报告；
 *   3. 已经有 `workflow_step_id` 的任务不碰（幂等）。
 *
 * 用法：
 *   node scripts/relink-workflow-task-identity.mjs            # dry-run，只报告
 *   node scripts/relink-workflow-task-identity.mjs --apply    # 真正写入
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APPLY = process.argv.includes('--apply');
const MARKUS_HOME = join(homedir(), '.markus');
const DB_PATH = join(MARKUS_HOME, 'data.db');

function parseSteps(yamlText) {
  // 只用 yaml 包解析 steps[].id/name；解析失败则回退到极简正则（够用于本修复）
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { parse } = require('yaml');
    const doc = parse(yamlText) ?? {};
    return Array.isArray(doc.steps) ? doc.steps.map((s) => ({ id: s.id, name: s.name })) : null;
  } catch {
    const steps = [];
    const block = yamlText.split(/^steps:/m)[1];
    if (!block) return null;
    let cur = null;
    for (const line of block.split('\n')) {
      const id = /^\s*-\s+id:\s*(.+)$/.exec(line) ?? /^\s+id:\s*(.+)$/.exec(line);
      const name = /^\s+name:\s*(.+)$/.exec(line);
      if (id) { cur = { id: id[1].trim().replace(/^["']|["']$/g, ''), name: null }; steps.push(cur); }
      else if (name && cur) cur.name = name[1].trim().replace(/^["']|["']$/g, '');
    }
    return steps.filter((s) => s.id);
  }
}

function loadTemplate(teamId, workflowName) {
  const dir = join(MARKUS_HOME, 'teams', teamId, 'workflows');
  if (!existsSync(dir)) return null;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    const text = readFileSync(join(dir, file), 'utf8');
    const nameMatch = /^name:\s*(.+)$/m.exec(text);
    const name = nameMatch?.[1]?.trim().replace(/^["']|["']$/g, '');
    if (name === workflowName || file.replace(/\.ya?ml$/, '') === workflowName) {
      return parseSteps(text);
    }
  }
  return null;
}

const db = new DatabaseSync(DB_PATH);
const runs = db.prepare('SELECT id, team_id, workflow_name, task_ids FROM workflow_runs ORDER BY run_number').all();

const stats = { runs: 0, tasks: 0, linked: 0, alreadyLinked: 0, noTemplate: 0, noTitleMatch: 0, ambiguous: 0, apply: APPLY };
const skipped = [];

for (const run of runs) {
  stats.runs += 1;
  const steps = loadTemplate(run.team_id, run.workflow_name);
  const taskIds = JSON.parse(run.task_ids || '[]');
  if (!steps) { stats.noTemplate += taskIds.length; skipped.push(`run ${run.id}: 模板缺失 (${run.team_id}/${run.workflow_name})`); continue; }

  for (const taskId of taskIds) {
    stats.tasks += 1;
    const task = db.prepare('SELECT id, title, workflow_step_id FROM tasks WHERE id = ?').get(taskId);
    if (!task) { skipped.push(`${taskId}: 任务不存在`); continue; }
    if (task.workflow_step_id) { stats.alreadyLinked += 1; continue; }

    // runner 的标题格式：`[<displayName>] <step.name>`
    const title = String(task.title ?? '');
    const stepName = title.includes('] ') ? title.slice(title.indexOf('] ') + 2).trim() : title.trim();
    const matches = steps.filter((s) => s.name === stepName);

    if (matches.length === 1) {
      stats.linked += 1;
      if (APPLY) {
        db.prepare('UPDATE tasks SET workflow_run_id = COALESCE(workflow_run_id, ?), workflow_step_id = COALESCE(workflow_step_id, ?) WHERE id = ?')
          .run(run.id, matches[0].id, taskId);
      }
    } else if (matches.length === 0) {
      stats.noTitleMatch += 1;
      skipped.push(`${taskId}: 标题「${title}」在模板里找不到步骤「${stepName}」`);
    } else {
      stats.ambiguous += 1;
      skipped.push(`${taskId}: 步骤名「${stepName}」在模板里出现 ${matches.length} 次，跳过`);
    }
  }
}

console.log(`[relink] ${APPLY ? 'APPLY' : 'DRY-RUN'}  db=${DB_PATH}`);
console.log(`[relink] runs=${stats.runs} tasks=${stats.tasks} 可回填=${stats.linked} 已有身份=${stats.alreadyLinked} 无模板=${stats.noTemplate} 标题无匹配=${stats.noTitleMatch} 歧义=${stats.ambiguous}`);
if (skipped.length > 0) {
  console.log(`[relink] 跳过明细（前 20 条）：`);
  for (const line of skipped.slice(0, 20)) console.log('  - ' + line);
}
if (!APPLY) console.log('[relink] 这是 dry-run；确认无误后加 --apply 才写入。');
