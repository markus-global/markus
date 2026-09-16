/**
 * Scenario × tool-face consistency — 提示词声明必须与实际可选工具一致。
 *
 * 缺陷背景：`comment_response` / `requirement_action` / `workflow_action` 都是
 * `converse` pack，走的是「关键词选择」；而它们的提示词里有**硬性指令**
 * （"你 MUST 调用 `requirement_get`"、"必须调用至少一个动作工具" 并列出
 * `requirement_update_status`、"用 `workflow_status`/`workflow_cancel`"）。
 * 这些名字既不在 BASE_TOOL_NAMES 也不在 TOOL_DEF_CORE_KEEP，也没有对应的工具组
 * —— 于是模型被要求调用一个**根本不在自己 schema 里**的工具。
 *
 * 修法：与 `HEARTBEAT_ALLOWED_TOOLS` / `DELIBERATION_ALLOWED_TOOLS` 同一契约 ——
 * 每个动作场景有一份**权威 allowedTools**，由 `agent.ts` 并集进 schema。
 * 本文件锁住「提示词提到 ⇒ 工具面必须有」这条不变量。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContextEngine } from '../src/context-engine.js';
import { MemoryStore } from '../src/memory/store.js';
import type { AgentScenario } from '../src/session-workspace.js';
import type { RoleTemplate } from '@markus/shared';
import {
  COMMENT_RESPONSE_ALLOWED_TOOLS,
  REQUIREMENT_ACTION_ALLOWED_TOOLS,
  WORKFLOW_ACTION_ALLOWED_TOOLS,
  SCENARIO_ALLOWED_TOOLS,
  TASK_EXECUTION_EXTRA_TOOLS,
  TOOL_DEF_CORE_KEEP,
} from '../src/capability-packs.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-toolface-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const MOCK_ROLE = {
  id: 'test-role',
  name: 'Test Role',
  description: 'Tool face test role',
  category: 'engineering',
  systemPrompt: 'You are a test agent.',
  defaultSkills: [],
  heartbeatChecklist: '- Check inbox',
  defaultPolicies: [],
  builtIn: false,
} as RoleTemplate;

async function buildPrompt(scenario: AgentScenario): Promise<string> {
  const memory = new MemoryStore(tempDir);
  const engine = new ContextEngine({ memorySearchTopK: 3 });
  const { text } = await engine.buildSystemPrompt({
    agentId: 'agt_toolface',
    agentName: 'Test Agent',
    role: MOCK_ROLE,
    memory,
    scenario,
  });
  return text;
}

describe('场景 × 工具面一致性（提示词声明 ⊆ 权威 allowedTools）', () => {
  it('comment_response：提示词要求的工具都在 allowedTools 里', async () => {
    const text = await buildPrompt('comment_response');
    const mandated = ['task_get', 'requirement_get', 'task_comment', 'requirement_comment', 'notify_user'];
    for (const t of mandated) {
      expect(text, `提示词应提到 ${t}`).toContain(t);
      expect(COMMENT_RESPONSE_ALLOWED_TOOLS, `${t} 必须在 comment_response allowedTools`).toContain(t);
    }
  });

  it('requirement_action：MANDATORY 的 requirement_get / requirement_update_status 必须可达', async () => {
    const text = await buildPrompt('requirement_action');
    // 提示词原文包含 "**MANDATORY**: Before deciding, call `requirement_get`"
    // 与 "**Update requirement status**: `requirement_update_status`"
    for (const t of ['requirement_get', 'requirement_update_status', 'task_create', 'requirement_comment', 'notify_user']) {
      expect(text, `提示词应提到 ${t}`).toContain(t);
      expect(REQUIREMENT_ACTION_ALLOWED_TOOLS, `${t} 必须在 requirement_action allowedTools`).toContain(t);
    }
    // 这两个名字**不在**默认可选集合（也没有 requirement 工具组）—— 说明这条
    // allowedTools 是**承重**的：否则模型被要求调用一个 schema 里没有的工具。
    for (const loadBearing of ['requirement_get', 'requirement_update_status']) {
      expect(TOOL_DEF_CORE_KEEP.has(loadBearing), `${loadBearing} 不应已在 always-on 集合`).toBe(false);
    }
  });

  it('workflow_action：workflow_status / workflow_cancel 必须可达（无 workflow 工具组）', async () => {
    const text = await buildPrompt('workflow_action');
    for (const t of ['workflow_status', 'workflow_cancel', 'task_get', 'notify_user']) {
      expect(text, `提示词应提到 ${t}`).toContain(t);
      expect(WORKFLOW_ACTION_ALLOWED_TOOLS, `${t} 必须在 workflow_action allowedTools`).toContain(t);
    }
    expect(TOOL_DEF_CORE_KEEP.has('workflow_status')).toBe(false);
    expect(TOOL_DEF_CORE_KEEP.has('workflow_cancel')).toBe(false);
  });

  it('task_execution 提示词要求的 background_exec / deliverable_create 必须被显式补进选择', async () => {
    const text = await buildPrompt('task_execution');
    for (const t of ['background_exec', 'deliverable_create']) {
      expect(text, `提示词应提到 ${t}`).toContain(t);
      expect(TASK_EXECUTION_EXTRA_TOOLS, `${t} 必须在 TASK_EXECUTION_EXTRA_TOOLS`).toContain(t);
      // 两者都不在 always-on 集合，也没有工具组能带出 background_exec
      expect(TOOL_DEF_CORE_KEEP.has(t), `${t} 不应已在 always-on 集合`).toBe(false);
    }
  });

  it('SCENARIO_ALLOWED_TOOLS 覆盖三个动作场景，且集合互不串味', () => {
    expect(Object.keys(SCENARIO_ALLOWED_TOOLS).sort())
      .toEqual(['comment_response', 'requirement_action', 'workflow_action']);
    // workflow 工具不得出现在 comment_response 里（避免能力面外溢）
    for (const t of ['workflow_run', 'workflow_cancel', 'workflow_delete']) {
      expect(COMMENT_RESPONSE_ALLOWED_TOOLS, `${t} 不应出现在 comment_response`).not.toContain(t);
    }
    // requirement 状态机写不得出现在 comment_response（收尾动作不在评论场景）
    expect(COMMENT_RESPONSE_ALLOWED_TOOLS).not.toContain('requirement_resubmit');
  });

  it('动作场景的 allowedTools 不得包含危险/越界工具', () => {
    const forbidden = ['package_install', 'hub_install', 'shell_execute', 'apply_patch'];
    for (const [scenario, tools] of Object.entries(SCENARIO_ALLOWED_TOOLS)) {
      for (const t of forbidden) {
        expect(tools, `${scenario} 不应授权 ${t}`).not.toContain(t);
      }
    }
  });
});
