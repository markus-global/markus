/**
 * Background completion → IN-TURN delivery (real agent loop, real processes).
 *
 * Contract (Owner 2026-11-22, first principles): the result of a background
 * command BELONGS to the turn that launched it. There is no `background_wait`
 * tool. When the completion's callback row is queued under the launching turn's
 * WorkUnit, `injectTurnDelta` delivers the FULL result content into that turn
 * before its next LLM call and consumes the row — so no separate continuation
 * turn fires. C8-B's ≤600-char label teaser cannot carry kilobytes of stdout,
 * hence the full-content tail append at the same injection point.
 *
 * Why the real loop (not a unit call around injectTurnDelta): the criterion is
 * ORDERING — the result reaches the model inside the same turn, produced by the
 * production loop's own trace, and the row is consumed so the attention loop
 * never re-enters. Real processes: no fixture can lie about exit timing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Agent } from '../src/agent.js';
import type { LLMRouter } from '../src/llm/router.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RoleTemplate } from '@markus/shared';
import { startSettled } from './helpers/agent-start.js';
import {
  createBackgroundExecTool,
  createProcessTool,
  wasBackgroundResultConsumed,
} from '../src/tools/process-manager.js';
import { pendingCallbackRegistry } from '../src/pending-callback.js';

const WU = 'task_tsk_bg_r1';
const exec = createBackgroundExecTool();
const proc = createProcessTool();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const MOCK_ROLE: RoleTemplate = {
  id: 'bg-role', name: 'BG Role', description: 'Tests in-turn background delivery',
  category: 'engineering', systemPrompt: 'You are a test agent.', defaultSkills: [],
  heartbeatChecklist: '', defaultPolicies: [], builtIn: false,
};

interface Rec {
  trace: string[];
  captured: Array<Array<{ role: string; content: string }>>;
  armed: boolean;
  bgId: string;
}
const newRec = (): Rec => ({ trace: [], captured: [], armed: false, bgId: '' });

/** Round 1 asks for `bg_launch`; round 2 ends. The injection must land before call 2. */
function makeRouter(rec: Rec): LLMRouter {
  let calls = 0;
  const call = async (req: { messages: Array<{ role: string; content: string }> }) => {
    if (!rec.armed) return { content: 'Startup.', finishReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } };
    calls += 1;
    rec.trace.push(`llm#${calls}`);
    rec.captured.push(req.messages.map(m => ({ role: m.role, content: String(m.content ?? '') })));
    if (calls === 1) {
      return {
        content: 'Launching.', finishReason: 'tool_use',
        toolCalls: [{ id: 'tc_bg', name: 'bg_launch', arguments: {} }],
        usage: { inputTokens: 50, outputTokens: 20 },
      };
    }
    return { content: 'Done.', finishReason: 'end_turn', usage: { inputTokens: 50, outputTokens: 20 } };
  };
  return {
    chat: call, chatStream: call,
    getActiveModelContextWindow: () => 200000, getActiveModelName: () => 'test-model',
    getActiveModelMaxOutput: () => 8000, getModelContextWindow: () => 200000,
    getModelMaxOutput: () => 8000, getModelCost: () => undefined,
    isCompactionSupported: () => true, modelSupportsVision: () => false,
    listProviders: () => ['test'], getProvider: () => undefined,
    getDefaultProvider: () => 'test', defaultProviderName: 'test',
    resolveModalityCandidates: () => [],
  } as unknown as LLMRouter;
}

/** Keeps asking for `bg_launch` for `toolRounds` rounds, then ends — exercises a
 *  second yield point in the SAME turn (the result must be delivered once). */
function makeMultiRoundRouter(rec: Rec, toolRounds: number): LLMRouter {
  let calls = 0;
  const call = async (req: { messages: Array<{ role: string; content: string }> }) => {
    if (!rec.armed) return { content: 'Startup.', finishReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } };
    calls += 1;
    rec.trace.push(`llm#${calls}`);
    rec.captured.push(req.messages.map(m => ({ role: m.role, content: String(m.content ?? '') })));
    if (calls <= toolRounds) {
      return {
        content: 'Launching.', finishReason: 'tool_use',
        toolCalls: [{ id: `tc_bg_${calls}`, name: 'bg_launch', arguments: {} }],
        usage: { inputTokens: 50, outputTokens: 20 },
      };
    }
    return { content: 'Done.', finishReason: 'end_turn', usage: { inputTokens: 50, outputTokens: 20 } };
  };
  const base = makeRouter(rec) as unknown as Record<string, unknown>;
  return { ...base, chat: call, chatStream: call } as unknown as LLMRouter;
}

/**
 * The tool launches a REAL background process, registers lineage exactly as the
 * production seam does (registerBackgroundSession captures the turn's WorkUnit),
 * then awaits the REAL completion bus delivery (the bus resolves the registry
 * entry when it enqueues the callback row). The small sleep guarantees the
 * process exits AFTER registration, so the bus — not a fixture — produces the row.
 */
function createAgent(rec: Rec, marker: string, toolRounds = 1): Agent {
  const agent = new Agent({
    config: {
      id: 'bg-agent', name: 'BG Agent', roleId: 'worker',
      llmConfig: { modelMode: 'custom', primary: 'anthropic' },
      createdAt: new Date().toISOString(), concurrent: { enabled: false },
    } as never,
    role: MOCK_ROLE,
    llmRouter: toolRounds > 1 ? makeMultiRoundRouter(rec, toolRounds) : makeRouter(rec),
    dataDir: tempDir,
  });
  agent.registerTool({
    name: 'bg_launch', description: 'Launch a real background command',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      rec.trace.push('tool:bg_launch');
      // Launch once; later tool rounds are no-ops so a second yield point sees
      // "the result was already delivered", not a fresh process.
      if (rec.bgId) return '{"status":"success"}';
      const command = `sleep 0.15; echo ${marker}`;
      const r = JSON.parse(await exec.execute({ command, timeout_seconds: 30 }));
      const id = r.sessionId as string;
      rec.bgId = id;
      agent.registerBackgroundSession(id, agent.getMemorySessionId()!, command, 60000, 'chat');
      const deadline = Date.now() + 4000;
      while (pendingCallbackRegistry.get(id) && Date.now() < deadline) await sleep(20);
      return '{"status":"success"}';
    },
  });
  return agent;
}

function processViaMailbox(agent: Agent): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    agent.enqueueToMailbox('human_chat',
      { summary: 'Do the work', content: 'Please do the work.' },
      { workUnitRef: WU, runtime: { responsePromise: { resolve, reject } } });
  });
}

const messagesText = (rec: Rec, i: number) => (rec.captured[i] ?? []).map(m => m.content).join('\n');

let tempDir: string;
let agent: Agent | undefined;
beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'markus-bg-inturn-')); });
afterEach(async () => {
  if (agent) await agent.stop();
  agent = undefined;
  const list = JSON.parse(await proc.execute({ action: 'list' }));
  for (const s of list.sessions ?? []) if (s.running) await proc.execute({ action: 'kill', sessionId: s.id });
  await sleep(100);
  await proc.execute({ action: 'clear' });
  rmSync(tempDir, { recursive: true, force: true });
});

describe('background completion — in-turn full-result delivery (real loop)', () => {
  it('delivers the FULL result into the launching turn before its next LLM call, and consumes the row', async () => {
    const rec = newRec();
    const marker = 'BG-RESULT-MARKER-7f3a';
    agent = createAgent(rec, marker);
    await startSettled(agent);
    rec.trace.length = 0; rec.captured.length = 0; rec.armed = true;

    await processViaMailbox(agent);

    // Ordering: the tool ran, then the result reached the model in the SAME turn.
    const toolAt = rec.trace.indexOf('tool:bg_launch');
    expect(toolAt).toBeGreaterThanOrEqual(0);
    expect(rec.trace.indexOf('llm#2')).toBeGreaterThan(toolAt);

    // The FULL stdout reached the model inside this turn (not a 120-char teaser).
    expect(messagesText(rec, 1)).toContain(marker);

    // Consumed in-turn: the completion is marked read, so no continuation re-derives it.
    expect(wasBackgroundResultConsumed(rec.bgId)).toBe(true);

    // The callback row left the queue — the attention loop cannot fire a second turn.
    const mailbox = (agent as unknown as { mailbox: { getQueuedItems: () => Array<{ sourceType: string; workUnitRef?: string }> } }).mailbox;
    const leftover = mailbox.getQueuedItems().filter(i => i.sourceType === 'callback_result' && i.workUnitRef === WU);
    expect(leftover.length).toBe(0);
  });

  it('a second yield point in the same turn does not re-deliver the consumed result', async () => {
    const rec = newRec();
    const marker = 'BG-ONCE-MARKER-9b1c';
    agent = createAgent(rec, marker, 2); // two tool rounds → two post-tool yield points
    // Count actual full-result deliveries (appendMessage calls carrying the
    // result), not string occurrences — the command echo + stdout may both
    // contain the marker within ONE delivered message.
    const memory = (agent as unknown as { memory: { appendMessage: (s: string, m: { content: unknown }) => void } }).memory;
    let deliveries = 0;
    const orig = memory.appendMessage.bind(memory);
    vi.spyOn(memory, 'appendMessage').mockImplementation((s, m) => {
      if (String(m.content ?? '').includes(marker)) deliveries += 1;
      orig(s, m);
    });
    await startSettled(agent);
    rec.trace.length = 0; rec.captured.length = 0; rec.armed = true;
    await processViaMailbox(agent);
    // Delivered exactly once across both yield points; consumption holds.
    expect(deliveries).toBe(1);
    expect(wasBackgroundResultConsumed(rec.bgId)).toBe(true);
  });
});
