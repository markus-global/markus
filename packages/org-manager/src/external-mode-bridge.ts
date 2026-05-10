/**
 * Bridge between core Agent system and @markus/external's ExternalService.
 *
 * Reads the real Agent's persona (ROLE.md systemPrompt), memory (MEMORY.md + entries),
 * identity context, and tools — so the external service inherits the agent's full identity.
 */
import { createLogger, type LLMMessage, type IdentityContext } from '@markus/shared';
import type { LLMRouter, AgentManager, Agent, IMemoryStore } from '@markus/core';
import { WebSearchTool, WebFetchTool } from '@markus/core';
import {
  ExternalService,
  type ExternalServiceDeps,
  type LLMRouterLike,
  type ContextEngineLike,
  type ToolHandler,
  type SnapshotProvider,
  type PersonaSnapshot,
} from '@markus/external';
import type { StorageBridge } from './storage-bridge.js';

const log = createLogger('external-mode-bridge');

export function createLLMRouterAdapter(router: LLMRouter): LLMRouterLike {
  return {
    async chat(request, provider?) {
      const resp = await router.chat(request as any, provider);
      return {
        content: resp.content,
        finishReason: resp.finishReason,
        toolCalls: resp.toolCalls,
        tokensUsed: { input: resp.usage.inputTokens, output: resp.usage.outputTokens },
      };
    },
    async chatStream(request, onEvent, provider?) {
      const resp = await router.chatStream(request as any, onEvent, provider);
      return {
        content: resp.content,
        finishReason: resp.finishReason,
        toolCalls: resp.toolCalls,
        tokensUsed: { input: resp.usage.inputTokens, output: resp.usage.outputTokens },
      };
    },
    getModelContextWindow(provider?) {
      return router.getModelContextWindow(provider);
    },
  };
}

export function createContextEngine(): ContextEngineLike {
  return {
    shrinkMessages(messages: LLMMessage[], contextWindow: number): LLMMessage[] {
      const estimatedTokensPerMsg = 200;
      const maxMessages = Math.floor(contextWindow / estimatedTokensPerMsg);
      if (messages.length <= maxMessages) return messages;

      const system = messages[0]?.role === 'system' ? [messages[0]] : [];
      const rest = messages[0]?.role === 'system' ? messages.slice(1) : messages;
      const keep = Math.max(1, maxMessages - system.length);
      return [...system, ...rest.slice(-keep)];
    },
  };
}

/**
 * Build a concise identity summary from the agent's IdentityContext.
 */
function buildIdentitySummary(ctx: IdentityContext): string {
  const lines: string[] = [];
  lines.push(`- Name: ${ctx.self.name}`);
  lines.push(`- Role: ${ctx.self.role}`);
  if (ctx.organization) {
    lines.push(`- Organization: ${ctx.organization.name}`);
  }
  if (ctx.team) {
    lines.push(`- Team: ${ctx.team.name}${ctx.team.description ? ` — ${ctx.team.description}` : ''}`);
  }
  if (ctx.colleagues?.length) {
    const names = ctx.colleagues.map(c => `${c.name} (${c.role})`).join(', ');
    lines.push(`- Colleagues: ${names}`);
  }
  return lines.join('\n');
}

/**
 * Create a SnapshotProvider that reads from real Agent instances via AgentManager.
 *
 * - getPersona: returns the agent's name, role name, full ROLE.md systemPrompt, and identity summary
 * - getKnowledgeContext: returns the agent's MEMORY.md (long-term curated knowledge)
 * - getCustomInstructions: returns service-level custom instructions from config
 */
export function createSnapshotProvider(agentManager: AgentManager): SnapshotProvider {
  function getAgentSafe(agentId: string): Agent | undefined {
    try {
      if (!agentManager.hasAgent(agentId)) return undefined;
      return agentManager.getAgent(agentId);
    } catch {
      return undefined;
    }
  }

  return {
    getPersona(agentId: string, _snapshotId: string): PersonaSnapshot | undefined {
      const agent = getAgentSafe(agentId);
      if (!agent) return undefined;

      const role = agent.role;
      const identity = agent.getIdentityContext();
      const identitySummary = identity ? buildIdentitySummary(identity) : undefined;

      return {
        name: agent.config.name,
        role: role.name,
        roleSystemPrompt: role.systemPrompt,
        personality: role.description,
        identitySummary,
      };
    },

    getKnowledgeContext(agentId: string, _snapshotId: string): string | undefined {
      const agent = getAgentSafe(agentId);
      if (!agent) return undefined;

      const memory = agent.getMemory();
      const longTerm = memory.getLongTermMemory();
      if (!longTerm || longTerm.trim().length === 0) return undefined;
      return longTerm;
    },

    getCustomInstructions(_agentId: string, _snapshotId: string): string | undefined {
      return undefined;
    },
  };
}

/**
 * Create a tools factory that provides real memory tools (read-only)
 * from the agent's IMemoryStore.
 *
 * The external tool profile allows: memory_search, memory_list, group:web.
 * We provide memory_search and memory_list backed by the agent's real memory.
 */
export function createToolsFactory(agentManager: AgentManager): (serviceConfig: any) => Map<string, ToolHandler> {
  return (serviceConfig) => {
    const tools = new Map<string, ToolHandler>();

    let agent: Agent | undefined;
    try {
      if (agentManager.hasAgent(serviceConfig.agentId)) {
        agent = agentManager.getAgent(serviceConfig.agentId);
      }
    } catch {
      log.warn('Could not get agent for tools factory', { agentId: serviceConfig.agentId });
    }

    if (!agent) return tools;

    const memory: IMemoryStore = agent.getMemory();

    tools.set('memory_search', {
      name: 'memory_search',
      description:
        'Search your memories for information relevant to a query. ' +
        'Returns matching memory entries ordered by relevance.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query — keywords or natural language description of what you want to recall.',
          },
          type: {
            type: 'string',
            enum: ['fact', 'note', 'task_result', 'conversation'],
            description: 'Optional: filter by memory type.',
          },
          limit: {
            type: 'number',
            description: 'Maximum results to return (default: 10).',
          },
        },
        required: ['query'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const query = args['query'] as string;
        const type = args['type'] as string | undefined;
        const limit = (args['limit'] as number) ?? 10;

        let results = memory.search(query);
        if (type) results = results.filter(e => e.type === type);
        results = results.slice(0, limit);

        return JSON.stringify({
          results: results.map(e => ({
            id: e.id,
            type: e.type,
            content: e.content,
            timestamp: e.timestamp,
          })),
          count: results.length,
        });
      },
    });

    tools.set('memory_list', {
      name: 'memory_list',
      description:
        'List your recent memories, optionally filtered by type. ' +
        'Useful for reviewing what you have remembered.',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['fact', 'note', 'task_result', 'conversation'],
            description: 'Optional: filter by memory type.',
          },
          limit: {
            type: 'number',
            description: 'Maximum entries to return (default: 15).',
          },
        },
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const type = args['type'] as string | undefined;
        const limit = (args['limit'] as number) ?? 15;

        const entries = memory.getEntries(type as any ?? undefined, limit);
        return JSON.stringify({
          entries: entries.map(e => ({
            id: e.id,
            type: e.type,
            content: e.content,
            timestamp: e.timestamp,
          })),
          count: entries.length,
        });
      },
    });

    tools.set('web_search', {
      name: WebSearchTool.name,
      description: WebSearchTool.description,
      inputSchema: WebSearchTool.inputSchema,
      execute: (args) => WebSearchTool.execute(args),
    });

    tools.set('web_fetch', {
      name: WebFetchTool.name,
      description: WebFetchTool.description,
      inputSchema: WebFetchTool.inputSchema,
      execute: (args) => WebFetchTool.execute(args),
    });

    return tools;
  };
}

export function initExternalService(
  storage: StorageBridge,
  llmRouter: LLMRouter,
  agentManager: AgentManager,
): ExternalService | undefined {
  if (!storage.externalServiceRepo || !storage.externalSessionRepo || !storage.externalMessageRepo) {
    log.warn('External mode storage repos not available, skipping ExternalService init');
    return undefined;
  }

  const deps: ExternalServiceDeps = {
    serviceStore: storage.externalServiceRepo,
    sessionStore: storage.externalSessionRepo,
    messageStore: storage.externalMessageRepo,
    llmRouter: createLLMRouterAdapter(llmRouter),
    contextEngine: createContextEngine(),
    toolsFactory: createToolsFactory(agentManager),
    snapshotProvider: createSnapshotProvider(agentManager),
    migrateShareTokens: storage.shareTokenRepo
      ? (oldId, newId) => storage.shareTokenRepo!.migrateToService(oldId, newId)
      : undefined,
  };

  const service = new ExternalService(deps);
  log.info('ExternalService initialized with real agent data bridge');
  return service;
}
