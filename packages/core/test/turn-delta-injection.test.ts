import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Agent } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import { TURN_DELTA_HEADER_PREFIX } from '../src/turn-delta.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RoleTemplate, AttentionDecision } from '@markus/shared';

/**
 * C8-B — behavioural tests on the REAL agent loop.
 *
 * Why not a unit test around `injectTurnDelta`: criterion 2 of the card is
 * *ordering* ("injection before the LLM call"). A unit test can only prove that
 * a function we call ourselves runs when we call it. Here the fake LLM records
 * its own calls, so the trace is produced by the production loop, not by the
 * test harness.
 */

let tempDir: string;

const MOCK_ROLE: RoleTemplate = {
  id: 'delta-role',
  name: 'Delta Role',
  description: 'Tests in-turn delta injection',
  category: 'engineering',
  systemPrompt: 'You are a test agent.',
  defaultSkills: [],
  heartbeatChecklist: '',
  defaultPolicies: [],
  builtIn: false,
};

const WU = 'task_tsk_delta_r1';
const TASK_ID = 'tsk_delta';

interface TraceRecorder {
  trace: string[];
  captured: Array<Array<{ role: string; content: string }>>;
  llmCalls: () => number;
}

function makeRouter(rec: TraceRecorder): LLMRouter {
  let calls = 0;
  const call = async (req: { messages: Array<{ role: string; content: string }> }) => {
    calls += 1;
    rec.trace.push(`llm#${calls}`);
    rec.captured.push(req.messages.map(m => ({ role: m.role, content: String(m.content ?? '') })));
    if (calls === 1) {
      return {
        content: 'Working on it.',
        finishReason: 'tool_use',
        toolCalls: [{ id: 'tc_delta', name: 'delta_trigger', arguments: {} }],
        usage: { inputTokens: 50, outputTokens: 20 },
      };
    }
    return {
      content: 'Done.',
      finishReason: 'end_turn',
      usage: { inputTokens: 50, outputTokens: 20 },
    };
  };
  return {
    chat: call,
    chatStream: call,
    getActiveModelContextWindow: () => 200000,
    getActiveModelName: () => 'test-model',
    getActiveModelMaxOutput: () => 8000,
    getModelContextWindow: () => 200000,
    getModelMaxOutput: () => 8000,
    getModelCost: () => undefined,
    isCompactionSupported: () => true,
    modelSupportsVision: () => false,
    listProviders: () => ['test'],
    getProvider: () => undefined,
    getDefaultProvider: () => 'test',
    defaultProviderName: 'test',
    resolveModalityCandidates: () => [],
  } as unknown as LLMRouter;
}

/**
 * A router that keeps asking for tools for `toolRounds` rounds before ending.
 *
 * Needed to observe what a *second* yield point in the same turn sees: one fact
 * must be reported once, not once per round (criterion 4 — the segment has to
 * describe the delta, and repeating it would make context grow with no new
 * information).
 */
function makeMultiRoundRouter(rec: TraceRecorder, toolRounds: number): LLMRouter {
  let calls = 0;
  const call = async (req: { messages: Array<{ role: string; content: string }> }) => {
    calls += 1;
    rec.trace.push(`llm#${calls}`);
    rec.captured.push(req.messages.map(m => ({ role: m.role, content: String(m.content ?? '') })));
    if (calls <= toolRounds) {
      return {
        content: 'Working on it.',
        finishReason: 'tool_use',
        toolCalls: [{ id: `tc_delta_${calls}`, name: 'delta_trigger', arguments: {} }],
        usage: { inputTokens: 50, outputTokens: 20 },
      };
    }
    return {
      content: 'Done.',
      finishReason: 'end_turn',
      usage: { inputTokens: 50, outputTokens: 20 },
    };
  };
  const base = makeRouter(rec) as unknown as Record<string, unknown>;
  return { ...base, chat: call, chatStream: call } as unknown as LLMRouter;
}

function createAgent(input: {
  router: LLMRouter;
  rec: TraceRecorder;
  turnDeltaInjection?: boolean;
  /** Called from inside the tool, i.e. mid-turn. */
  onTool: (agent: Agent) => void;
}): Agent {
  const agent = new Agent({
    config: {
      id: 'delta-agent',
      name: 'Delta Agent',
      roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(),
      // Serial: one item at a time, so "a same-entity fact that arrived
      // mid-turn is still queued" is the real situation, not a race.
      concurrent: { enabled: false },
    } as never,
    role: MOCK_ROLE,
    llmRouter: input.router,
    dataDir: tempDir,
    ...(input.turnDeltaInjection === undefined ? {} : { turnDeltaInjection: input.turnDeltaInjection }),
  });

  agent.registerTool({
    name: 'delta_trigger',
    description: 'Enqueues the mid-turn fact',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      input.rec.trace.push('tool:delta');
      input.onTool(agent);
      return '{"status":"success"}';
    },
  });

  agent.getAttentionController().setDecisionPersistence({
    save: (decision: AttentionDecision) => {
      input.rec.trace.push(`decision:${decision.decisionType}`);
    },
  });

  return agent;
}

function processViaMailbox(agent: Agent, workUnitRef: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    agent.enqueueToMailbox(
      'human_chat',
      { summary: 'Do the work', content: 'Please do the work.' },
      { workUnitRef, runtime: { responsePromise: { resolve, reject } } },
    );
  });
}

function newRecorder(): TraceRecorder {
  const trace: string[] = [];
  const captured: TraceRecorder['captured'] = [];
  return {
    trace,
    captured,
    llmCalls: () => trace.filter(t => t.startsWith('llm#')).length,
  };
}

const messagesText = (rec: TraceRecorder, index: number) =>
  (rec.captured[index] ?? []).map(m => m.content).join('\n');

let agent: Agent | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-turn-delta-'));
});

afterEach(async () => {
  if (agent) await agent.stop();
  agent = undefined;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('C8-B — in-turn delta injection (real loop)', () => {
  it('injects an authoritative fact before the next LLM call, inside the same turn', async () => {
    const rec = newRecorder();
    agent = createAgent({
      router: makeRouter(rec),
      rec,
      onTool: a => {
        a.enqueueToMailbox(
          'requirement_update',
          { summary: 'Scope changed — take action', content: 'Requirement was updated.', requirementId: 'req_delta' },
          { workUnitRef: WU, intent: 'action_required' },
        );
      },
    });
    await agent.start();

    await processViaMailbox(agent, WU);

    // Criterion 2: the injection happened after the tool and BEFORE the next
    // LLM call — proven by one ordered trace produced by production code.
    const toolAt = rec.trace.indexOf('tool:delta');
    const injectAt = rec.trace.indexOf('llm#2');
    expect(toolAt).toBeGreaterThanOrEqual(0);
    expect(injectAt).toBeGreaterThan(toolAt);

    // The fact reached the model inside this turn.
    const secondCall = messagesText(rec, 1);
    expect(secondCall).toContain(TURN_DELTA_HEADER_PREFIX);
    expect(secondCall).toContain('authoritative/requirement_update');
    expect(secondCall).toContain('Scope changed');

    // …and it did not cancel (an authoritative fact is an instruction, not a reversal).
    expect(rec.trace).not.toContain('decision:cancel');
  });

  it('records a cancel decision for a contradicting fact and stops the turn', async () => {
    const rec = newRecorder();
    let deltaItemId = '';
    agent = createAgent({
      router: makeRouter(rec),
      rec,
      onTool: a => {
        const item = a.enqueueToMailbox(
          'task_status_update',
          { summary: 'Task cancelled by owner', content: 'Task was cancelled.', taskId: TASK_ID },
          { workUnitRef: WU, invalidatesPremise: true, metadata: { taskId: TASK_ID } },
        );
        deltaItemId = item.id;
      },
    });
    await agent.start();

    const reply = await processViaMailbox(agent, WU);

    // Criterion 1: a `cancel` row lands in `agent_decisions` inside this turn.
    expect(rec.trace).toContain('decision:cancel');
    const saved = agent.getAttentionController().getRecentDecisions()
      .filter(d => d.decisionType === 'cancel');
    expect(saved).toHaveLength(1);
    expect(saved[0]!.mailboxItemId).toBe(deltaItemId);

    // Criterion 2: the decision exists *before* any later LLM call, so it
    // cannot be an after-the-fact note.
    const cancelAt = rec.trace.indexOf('decision:cancel');
    const nextLlmAt = rec.trace.indexOf('llm#2');
    if (nextLlmAt !== -1) expect(cancelAt).toBeLessThan(nextLlmAt);

    // The turn itself was aborted rather than finished on a dead premise.
    expect(reply).toBe('[cancelled]');
  });

  it('injects nothing when a fact belongs to a different WorkUnit', async () => {
    const rec = newRecorder();
    agent = createAgent({
      router: makeRouter(rec),
      rec,
      onTool: a => {
        a.enqueueToMailbox(
          'task_status_update',
          { summary: 'Other task cancelled', content: 'Some other task was cancelled.', taskId: 'tsk_other' },
          { workUnitRef: 'task_tsk_other_r1', invalidatesPremise: true, metadata: { taskId: 'tsk_other' } },
        );
      },
    });
    await agent.start();

    await processViaMailbox(agent, WU);

    const secondCall = messagesText(rec, 1);
    expect(secondCall).not.toContain('Other task cancelled');
    expect(rec.trace).not.toContain('decision:cancel');
  });

  it('reports one fact once — a second yield point in the same turn must not re-inject it', async () => {
    const rec = newRecorder();
    // The tool runs once per tool round; the fact must arrive exactly once, so the
    // second round exercises "the queue still holds the fact, but it was reported".
    let enqueued = false;
    agent = createAgent({
      // Three LLM calls: two tool rounds, then end_turn.
      router: makeMultiRoundRouter(rec, 2),
      rec,
      onTool: a => {
        if (enqueued) return;
        enqueued = true;
        a.enqueueToMailbox(
          'requirement_update',
          { summary: 'Scope changed — take action', content: 'Requirement was updated.', requirementId: 'req_delta' },
          { workUnitRef: WU, intent: 'action_required' },
        );
      },
    });
    await agent.start();

    await processViaMailbox(agent, WU);

    const occurrences = (text: string) => text.split(TURN_DELTA_HEADER_PREFIX).length - 1;
    const factLines = (text: string) => text.split('authoritative/requirement_update').length - 1;

    // The fact is printed exactly once…
    expect(factLines(messagesText(rec, 2))).toBe(1);
    // …while the later yield point still emits the segment, as an empty delta
    // (never omitted — criterion 4), so the model sees the watermark advance.
    expect(occurrences(messagesText(rec, 2))).toBe(2);
    expect(messagesText(rec, 2).split('count: 0').length - 1).toBe(1);
  });

  it('with the switch off, the turn behaves exactly like the queue semantics', async () => {
    const rec = newRecorder();
    agent = createAgent({
      router: makeRouter(rec),
      rec,
      turnDeltaInjection: false,
      onTool: a => {
        a.enqueueToMailbox(
          'task_status_update',
          { summary: 'Task cancelled by owner', content: 'Task was cancelled.', taskId: TASK_ID },
          { workUnitRef: WU, invalidatesPremise: true, metadata: { taskId: TASK_ID } },
        );
      },
    });
    await agent.start();

    await processViaMailbox(agent, WU);

    // Off = no injected segment and no decision row; the turn keeps going.
    expect(messagesText(rec, 1)).not.toContain(TURN_DELTA_HEADER_PREFIX);
    expect(rec.trace).not.toContain('decision:cancel');
    expect(rec.llmCalls()).toBeGreaterThanOrEqual(2);
  });
});
