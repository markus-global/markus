import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, resolve, dirname } from 'node:path';
import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { createLogger, generateId, userId as genUserId, kebab, saveConfig, getTextContent, stripInternalBlocks, extractThinkBlocks, APP_VERSION, checkForUpdate, buildManifest, manifestFilename, CHANNEL_CONTEXT_MESSAGES, type TaskStatus, type TaskPriority, type TaskSortField, type SortOrder, type PackageType, type RequirementStatus, type IntegrationConfig } from '@markus/shared';
import {
  GatewayError,
  WorkflowEngine,
  createDefaultTeamTemplates,
  createDefaultTemplateRegistry,
  generateHandbook,
  GatewaySyncHandler,
  type TeamTemplateRegistry,
  type AgentToolHandler,
  type ExternalAgentGateway,
  type LLMRouter,
  type ReviewService,
  type SkillRegistry,
  type TemplateRegistry,
  type WorkflowExecutor,
  type WorkflowDefinition,
  type SyncRequest,
  type HandbookColleague,
  type HandbookProject,
  discoverSkillsInDir,
  WELL_KNOWN_SKILL_DIRS,
  type AgentManager,
  ModelCatalogService,
  estimateQualityScore,
  tierFromQualityScore,
  costTierFromPrice,
} from '@markus/core';
import type { ChannelMsg } from '@markus/storage';
import type { OrganizationService } from './org-service.js';
import { BuilderService } from './builder-service.js';
import type { TaskService } from './task-service.js';
import type { HITLService } from './hitl-service.js';
import { FeishuNotifier, type FeishuNotifierConfig } from './feishu-notifier.js';
import type { BillingService } from './billing-service.js';
import type { AuditService, AuditEventType } from './audit-service.js';
import type { LicenseService } from './license-service.js';
import type { TelemetryService } from './telemetry-service.js';
import type { StorageBridge } from './storage-bridge.js';
import type { ProjectService } from './project-service.js';
import type { ReportService } from './report-service.js';
import type { KnowledgeService } from './knowledge-service.js';
import type { DeliverableService } from './deliverable-service.js';
import type { RequirementService } from './requirement-service.js';
import type { WorkflowService } from './workflow-service.js';
import type { WorkflowRunner } from './workflow-runner.js';
import { WSBroadcaster } from './ws-server.js';
import { SSEHandler } from './sse-handler.js';
import { installSkill } from './skill-service.js';
import type { LocalFileStorageProvider } from './file-storage-provider.js';
import {
  signToken,
  verifyToken,
  hashPassword,
  verifyPassword,
  generateInviteToken,
  parseCookies,
} from './middleware/auth.js';
import { handleTasksRoutes } from './routes/tasks.js';
import { handleAgentsDeepRoutes } from './routes/agents-deep.js';
import { handleGatewayRoutes } from './routes/gateway.js';
import { handleSkillsRoutes } from './routes/skills.js';
import { handleLlmSettingsRoutes } from './routes/settings/llm.js';
import { handleGovernanceRoutes } from './routes/governance.js';

const log = createLogger('api-server');

export class APIServer {
  static readonly ROUTING_CACHE_TTL_MS = 5 * 60 * 1000;
  private server?: ReturnType<typeof createServer>;
  public ws: WSBroadcaster;
  public skillRegistry?: SkillRegistry;
  private hitlService?: HITLService;
  private feishuNotifier?: FeishuNotifier;
  public billingService?: BillingService;
  public auditService?: AuditService;
  public licenseService?: LicenseService;
  private telemetryService?: TelemetryService;
  public storage?: StorageBridge;
  public llmRouter?: LLMRouter;
  public markusConfigPath?: string;
  private hubUrl = 'https://markus.global';
  private webUiDir?: string;
  public gateway?: ExternalAgentGateway;
  public gatewaySecret?: string;
  public syncHandler?: GatewaySyncHandler;
  public gatewayMessageQueue = new Map<string, Array<{ id: string; from: string; fromName: string; content: string; timestamp: string }>>();
  public reviewService?: ReviewService;
  public registryCache?: Map<string, { data: unknown; ts: number }>;
  private templateRegistry?: TemplateRegistry;
  private builderService?: BuilderService;
  private workflowEngine?: WorkflowEngine;
  private workflowService?: WorkflowService;
  private workflowRunner?: WorkflowRunner;
  private teamTemplateRegistry: TeamTemplateRegistry;
  private fileStorage?: LocalFileStorageProvider;
  private remoteAgent?: { getStatus(): unknown; start(): Promise<void>; stop(): Promise<void>; onStatus(cb: (s: unknown) => void): () => void };
  private remoteAgentFactory?: () => Promise<{ getStatus(): unknown; start(): Promise<void>; stop(): Promise<void>; onStatus(cb: (s: unknown) => void): () => void } | null>;
  public modelCatalog?: ModelCatalogService;
  public routingCandidatesCache: { data: unknown; expireAt: number } | null = null;
  invalidateRoutingCache(): void { this.routingCandidatesCache = null; }
  private feishuRegisterSessions = new Map<string, { url: string; expireIn: number; status: string; createdAt: number }>();
  /** Aggregate today's tool calls from all agents' persisted metrics (the single source of truth) */
  private getToolCallsTodayFromAgents(): number {
    try {
      const agentManager = this.orgService.getAgentManager();
      const allAgents = agentManager.listAgents();
      let total = 0;
      for (const a of allAgents) {
        try {
          const agent = agentManager.getAgent(a.id);
          total += agent.getUsageStats().toolCallsToday;
        } catch { /* agent not loaded */ }
      }
      return total;
    } catch { return 0; }
  }

  /** Enrich raw license data with local usage stats and user info (no Hub calls). */
  private async buildLicenseResponse(raw: object, req: IncomingMessage): Promise<Record<string, unknown>> {
    const info: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    const authUser = await this.getAuthUser(req);
    if (authUser && this.storage) {
      const userRow = this.storage.userRepo.findById(authUser.userId) as Record<string, unknown> | null;
      if (userRow) {
        if (userRow.hubUserId) info.hubUserId = userRow.hubUserId;
        info.username = (userRow.hubUsername as string) || (userRow.name as string) || undefined;
      }
    }
    try {
      const defaultOrg = this.orgService.getDefaultOrganization();
      const orgId = defaultOrg?.id ?? 'default';
      const teams = this.orgService.listTeams(orgId);
      const humans = this.orgService.listHumanUsers(orgId);
      const todayToolCalls = this.getToolCallsTodayFromAgents();
      info.usage = { teams: teams.length, toolCallsToday: todayToolCalls, users: humans.length };
    } catch { /* non-critical */ }
    return info;
  }

  /** fetch that follows redirects while preserving the Authorization header */
  private async hubFetch(url: string, init?: RequestInit): Promise<Response> {
    let currentUrl = url;
    for (let i = 0; i < 3; i++) {
      const res = await fetch(currentUrl, { ...init, redirect: 'manual' });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) return res;
        currentUrl = new URL(location, currentUrl).href;
        continue;
      }
      return res;
    }
    return fetch(currentUrl, init);
  }

  constructor(
    public orgService: OrganizationService,
    public taskService: TaskService,
    public port: number = 8056
  ) {
    this.ws = new WSBroadcaster();
    this.teamTemplateRegistry = createDefaultTeamTemplates();
    this.templateRegistry = createDefaultTemplateRegistry();
    // Propagate template registry to AgentManager so createAgentFromTemplate works
    const am = this.orgService.getAgentManager();
    if (this.templateRegistry && !am.getTemplateRegistry()) {
      am.setTemplateRegistry(this.templateRegistry);
    }

    // Wire up group chat handlers for agent communication tools
    am.setGroupChatHandlers({
      sendGroupMessage: async (
        channelKey: string,
        message: string,
        senderId: string,
        senderName: string,
        replyToId?: string
      ) => {
        let cleanText = stripInternalBlocks(message);

        // Reject NO_RESPONSE variants — agent should simply not call this tool.
        const NO_RESPONSE_RE = /\[NO[_\s-]?RESPONSE[^\]]*\]/i;
        const NO_RESPONSE_CREATIVE_RE = /^\[(?:context check|no response|silent|listening|observing|monitoring|watching|noting|acknowledged?)[^\]]*\]$/i;
        if (NO_RESPONSE_RE.test(cleanText.trim()) || NO_RESPONSE_CREATIVE_RE.test(cleanText.trim())) {
          throw new Error(
            'Message blocked: you sent a [NO_RESPONSE] variant via agent_send_group_message. ' +
            'If you have nothing to say, simply do NOT call this tool. ' +
            '[NO_RESPONSE] is only valid as a direct reply, not as a tool call argument.'
          );
        }

        // Reject raw tool commands and slash commands — agent should use the actual tool.
        const TOOL_CMD_RE = /^\s*\/?(?:recall_context|memory_search|memory_save|task_get|task_list|task_comment|requirement_get|requirement_comment|file_read|agent_send_message|agent_send_group_message|check_mailbox|update_working_memory|clear_working_memory|defer_mailbox_item|drop_mailbox_item|prioritize_mailbox_item|notify_user|recall_activity)\b/i;
        const SLASH_CMD_RE = /^\s*\/(?:history|help|status|list|search|get|set|info|ping|who|whois|me|join|leave|invite|kick|ban|mute|unmute|clear|purge|poll|remind|note|todo|roll|flip|ask)\b/i;
        const blockedLines = cleanText.split('\n').filter(line => TOOL_CMD_RE.test(line) || SLASH_CMD_RE.test(line));
        if (blockedLines.length > 0) {
          cleanText = cleanText.split('\n')
            .filter(line => !TOOL_CMD_RE.test(line) && !SLASH_CMD_RE.test(line))
            .join('\n').trim();
          if (!cleanText) {
            throw new Error(
              `Message blocked: "${blockedLines[0].trim()}" is not a valid chat message. ` +
              'Slash commands like /history do not exist. ' +
              'To fetch channel history, use the recall_context tool with scope="channel". ' +
              'To interact with tasks, use task_get/task_list. ' +
              'Do NOT send tool names or slash commands as chat messages.'
            );
          }
        }

        const orgId = 'default';

        // Persist agent message
        let persistedMsgId: string | undefined;
        if (this.storage) {
          const saved = await this.storage.channelMessageRepo.append({
            orgId,
            channel: channelKey,
            senderId,
            senderType: 'agent',
            senderName,
            text: cleanText,
            replyToId,
          });
          persistedMsgId = saved.id;
          this.ws.broadcastUnreadUpdate(`channel:${channelKey}`, saved.id);
        }

        // Send to frontend via WebSocket (scoped to channel members)
        const channelEvent = {
          type: 'chat:message' as const,
          payload: {
            channel: channelKey,
            senderId,
            senderType: 'agent',
            senderName,
            text: cleanText,
          },
          timestamp: new Date().toISOString(),
        };
        if (channelKey.startsWith('dm:') || channelKey.startsWith('notes:')) {
          const participants = channelKey.startsWith('notes:')
            ? [channelKey.slice(6)]
            : channelKey.slice(3).split(':');
          this.ws.sendToUsers(participants, channelEvent);
        } else {
          const humanIds = this.resolveChannelHumanIds(channelKey);
          if (humanIds.length > 0) this.ws.sendToUsers(humanIds, channelEvent);
          else this.ws.broadcast(channelEvent);
        }

        // Resolve all agent members in this group channel
        let allAgentIds: string[] = [];
        if (channelKey.startsWith('group:custom:') && this.storage?.groupChatRepo) {
          allAgentIds = this.storage.groupChatRepo.getAgentMemberIds(channelKey);
        } else if (channelKey.startsWith('group:')) {
          const teamId = channelKey.replace(/^group:/, '');
          const team = this.orgService.getTeam(teamId);
          allAgentIds = team?.memberAgentIds ?? [];
        }

        // Notify peer agents in the group
        const peerAgentIds = allAgentIds.filter(id => id !== senderId);
        if (peerAgentIds.length > 0) {
          const agentManager = this.orgService.getAgentManager();
          const nameMap = this.buildAgentNameMap(allAgentIds, agentManager);
          const mentionedNames = this.parseAgentMentions(cleanText, [...nameMap.keys()]);
          const filteredMentions = mentionedNames.filter(n => {
            const id = nameMap.get(n);
            return id && id !== senderId;
          });

          if (filteredMentions.length > 0) {
            // Targeted: trigger A2A chain for @mentioned agents
            let channelContext: Array<{ role: string; content: string }> = [];
            if (this.storage) {
              try {
                const recent = await this.storage.channelMessageRepo.getMessages(channelKey, CHANNEL_CONTEXT_MESSAGES);
                channelContext = (recent.messages ?? []).map((m: ChannelMsg) => ({
                  role: m.senderType === 'agent' ? 'assistant' : 'user',
                  content: m.senderType === 'agent' ? stripInternalBlocks(m.text) : `[${m.senderName}]: ${m.text}`,
                }));
              } catch { /* best-effort */ }
            }
            const roundId = `round_${Date.now()}`;
            const respondedAgents = new Set<string>([senderId]);
            void this.triggerAgentToAgentChain(
              filteredMentions, nameMap, senderName, senderId, cleanText, persistedMsgId,
              channelKey, orgId, agentManager, allAgentIds.length,
              { roundId, depth: 1, respondedAgents, allAgentIds },
            );
          } else {
            // No @mentions: deliver as mailbox notification so peers are aware
            for (const peerId of peerAgentIds) {
              try {
                agentManager.getAgent(peerId).enqueueToMailbox('a2a_message', {
                  summary: `Group chat message from ${senderName}`,
                  content: `[Group chat message from ${senderName}]:\n${cleanText}`,
                  extra: { senderId, senderName, channelKey, waitForReply: false },
                }, {
                  metadata: { senderId, senderName, senderRole: 'agent' },
                });
              } catch { /* agent may not exist */ }
            }
          }
        }

        return 'Message sent to group chat';
      },
      createGroupChat: async (
        name: string,
        creatorId: string,
        creatorName: string,
        memberIds: string[]
      ) => {
        if (this.storage?.groupChatRepo) {
          const members = memberIds.map(id => {
            try {
              const agentInfo = this.orgService.getAgentManager().getAgent(id);
              return { id, type: 'agent' as const, name: agentInfo?.config?.name ?? id };
            } catch { return { id, type: 'agent' as const, name: id }; }
          });
          if (creatorId && !members.some(m => m.id === creatorId)) {
            members.unshift({ id: creatorId, type: 'agent' as const, name: creatorName });
          }
          const gc = this.storage.groupChatRepo.create({
            orgId: 'default', name, creatorId, creatorName, members,
          });
          this.ws.broadcast({
            type: 'chat:group_created',
            payload: { chatId: gc.channelKey, name, creatorId, creatorName },
            timestamp: new Date().toISOString(),
          });
          return { id: gc.channelKey, name };
        }
        return { id: `group:custom:${Date.now().toString(36)}`, name };
      },
      listGroupChats: async () => {
        const teams = this.orgService.listTeamsWithMembers('default');
        const teamChats = teams.map(t => ({
          id: `group:${t.id}`,
          name: t.name,
          type: 'team',
          channelKey: `group:${t.id}`,
        }));
        const customChats = this.storage?.groupChatRepo
          ? this.storage.groupChatRepo.list('default').map((c: any) => ({
              id: c.channelKey,
              name: c.name,
              type: 'custom',
              channelKey: c.channelKey,
            }))
          : [];
        return [...teamChats, ...customChats];
      },
      getChannelMessages: async (channelKey: string, limit: number, before?: string) => {
        if (!this.storage) return { messages: [], hasMore: false };
        const result = this.storage.channelMessageRepo.getMessages(channelKey, limit, before);
        return {
          messages: result.messages.map((m: ChannelMsg) => ({
            id: m.id,
            senderName: m.senderName,
            senderType: m.senderType,
            text: stripInternalBlocks(m.text),
            replyToId: m.replyToId,
            replyToSender: m.replyToSender,
            replyToText: m.replyToText,
            createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdAt),
          })),
          hasMore: result.hasMore,
        };
      },
    });

  }

  setSkillRegistry(registry: SkillRegistry): void {
    this.skillRegistry = registry;
    this.builderService = new BuilderService(
      this.orgService,
      registry,
      (msg) => this.ws?.broadcast(msg as Parameters<WSBroadcaster['broadcast']>[0]),
    );
    this.builderService.setTaskService(this.taskService);
  }

  getBuilderService(): BuilderService | undefined {
    return this.builderService;
  }

  /**
   * Returns a hub client that agents can use to search and install from Markus Hub.
   * Reads the hub token from ~/.markus/hub-token on each call.
   */
  getHubClient(): {
    search: (opts?: { type?: string; query?: string }) => Promise<Array<{ id: string; name: string; type: string; description: string; author: string; version?: string; downloads?: number }>>;
    downloadAndInstall: (itemId: string) => Promise<{ type: string; installed: unknown }>;
  } | undefined {
    if (!this.builderService) return undefined;
    const self = this;
    return {
      search: async (opts) => {
        const hubUrl = self.hubUrl;
        const token = self.readHubToken();
        const params = new URLSearchParams();
        if (opts?.type) params.set('type', opts.type);
        if (opts?.query) params.set('q', opts.query);
        const qs = params.toString();
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const res = await self.hubFetch(`${hubUrl}/api/items${qs ? `?${qs}` : ''}`, { headers });
        if (!res.ok) throw new Error(`Hub search failed: ${res.status}`);
        const data = await res.json() as { items?: Array<Record<string, unknown>> };
        return (data.items ?? []).map((item: Record<string, unknown>) => ({
          id: item.id as string,
          name: item.name as string,
          type: (item.itemType ?? item.type ?? 'agent') as string,
          description: (item.description ?? '') as string,
          author: ((item.author as Record<string, unknown>)?.displayName ?? (item.author as Record<string, unknown>)?.username ?? '') as string,
          version: item.version as string | undefined,
          downloads: item.downloadCount as number | undefined,
        }));
      },
      downloadAndInstall: async (itemId) => {
        const hubUrl = self.hubUrl;
        const token = self.readHubToken();
        if (!token) throw new Error('Hub token not configured. Please login to Markus Hub first.');
        const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
        const res = await self.hubFetch(`${hubUrl}/api/items/${itemId}/download`, { method: 'POST', headers });
        if (!res.ok) throw new Error(`Hub download failed: ${res.status}`);
        const data = await res.json() as { name: string; itemType: string; files?: Record<string, string>; config?: unknown; description?: string };
        const name = data.name;
        const slug = kebab(name, 'hub-pkg');
        const mode = (data.itemType === 'team' ? 'team' : data.itemType === 'skill' ? 'skill' : 'agent') as 'agent' | 'team' | 'skill';
        const typeDir = mode === 'agent' ? 'agents' : mode === 'team' ? 'teams' : 'skills';
        const artDir = join(homedir(), '.markus', 'builder-artifacts', typeDir, slug);
        mkdirSync(artDir, { recursive: true });
        if (data.files && Object.keys(data.files).length > 0) {
          for (const [fname, content] of Object.entries(data.files)) {
            const filePath = join(artDir, fname);
            mkdirSync(dirname(filePath), { recursive: true });
            writeFileSync(filePath, content, 'utf-8');
          }
        } else if (data.config) {
          writeFileSync(join(artDir, manifestFilename(mode as PackageType)), JSON.stringify(data.config, null, 2), 'utf-8');
        }
        return self.builderService!.installArtifact(mode, slug);
      },
    };
  }

  private readHubToken(): string | undefined {
    try {
      const tokenPath = join(homedir(), '.markus', 'hub-token');
      return existsSync(tokenPath) ? readFileSync(tokenPath, 'utf-8').trim() : undefined;
    } catch {
      return undefined;
    }
  }

  setBillingService(service: BillingService): void {
    this.billingService = service;
  }

  setLicenseService(service: LicenseService): void {
    this.licenseService = service;
  }

  setTelemetryService(service: TelemetryService): void {
    this.telemetryService = service;
  }

  setAuditService(service: AuditService): void {
    this.auditService = service;
  }

  setHITLService(service: HITLService): void {
    this.hitlService = service;
    service.onNotification(n => {
      const event = {
        type: 'notification',
        payload: { notification: n },
        timestamp: new Date().toISOString(),
      };
      this.ws.sendToUser(n.targetUserId, event);
    });
    this.tryInitFeishuNotifier();
  }

  /** Update the Feishu notifier config at runtime (called when integration settings are saved). */
  updateFeishuConfig(config: FeishuNotifierConfig): void {
    if (!this.feishuNotifier) {
      return;
    }
    this.feishuNotifier.updateConfig(config);
  }

  setStorage(storage: StorageBridge): void {
    this.storage = storage;
    this.tryInitFeishuNotifier();
  }

  setRemoteAgent(agent: { getStatus(): unknown; start(): Promise<void>; stop(): Promise<void>; onStatus(cb: (s: unknown) => void): () => void }): void {
    this.remoteAgent = agent;
    agent.onStatus((status) => {
      this.ws.broadcast({ type: 'remote:status', payload: status, timestamp: new Date().toISOString() });
    });
  }

  setRemoteAgentFactory(factory: () => Promise<{ getStatus(): unknown; start(): Promise<void>; stop(): Promise<void>; onStatus(cb: (s: unknown) => void): () => void } | null>): void {
    this.remoteAgentFactory = factory;
  }

  setGateway(gateway: ExternalAgentGateway, secret?: string): void {
    this.gateway = gateway;
    this.gatewaySecret = secret;
    this.initSyncHandler();
  }

  private initSyncHandler(): void {
    const self = this;
    this.syncHandler = new GatewaySyncHandler(
      {
        getTasksByAgent(agentId: string) {
          return self.taskService.getTasksByAgent(agentId).map(t => ({
            id: t.id, title: t.title, description: t.description,
            priority: t.priority, status: t.status,
            requirementId: t.requirementId,
            projectId: t.projectId,
          }));
        },
        updateTaskStatus(taskId: string, status: string, updatedBy?: string) {
          self.taskService.updateTaskStatus(taskId, status as TaskStatus, updatedBy);
        },
        createTask(req) {
          return self.taskService.createTask({
            title: req.title, description: req.description,
            priority: req.priority as TaskPriority,
            orgId: req.orgId,
            assignedAgentId: req.assignedAgentId,
            reviewerId: req.reviewerId,
            createdBy: req.createdBy,
          });
        },
      },
      {
        drainInbox(markusAgentId: string) {
          const queue = self.gatewayMessageQueue.get(markusAgentId) ?? [];
          self.gatewayMessageQueue.set(markusAgentId, []);
          return queue;
        },
        deliver(fromAgentId: string, toAgentId: string, content: string) {
          const fromAgent = self.orgService.getAgentManager().getAgent(fromAgentId);
          const queue = self.gatewayMessageQueue.get(toAgentId) ?? [];
          queue.push({
            id: `gwmsg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            from: fromAgentId,
            fromName: fromAgent?.config?.name ?? fromAgentId,
            content,
            timestamp: new Date().toISOString(),
          });
          self.gatewayMessageQueue.set(toAgentId, queue);
        },
      },
      {
        updateStatus(_agentId: string, _status: 'idle' | 'working' | 'error') {},
        updateHeartbeat(_agentId: string) {},
      },
    );

    this.syncHandler.setTeamBridge({
      getColleagues(agentId: string, _orgId: string) {
        return self.orgService.getAgentManager().listAgents()
          .filter(a => a.id !== agentId)
          .map(a => ({ id: a.id, name: a.name, role: a.role, status: a.status }));
      },
      getManager(agentId: string, _orgId: string) {
        const agents = self.orgService.getAgentManager().listAgents();
        const mgr = agents.find(a => a.agentRole === 'manager' && a.id !== agentId);
        return mgr ? { id: mgr.id, name: mgr.name } : undefined;
      },
    });

    this.syncHandler.setProjectBridge({
      getProjects(orgId: string) {
        if (!self.projectService) return [];
        return self.projectService.listProjects(orgId).map(p => ({
          id: p.id,
          name: p.name,
        }));
      },
      getActiveRequirements(orgId: string) {
        if (!self.requirementService) return [];
        return self.requirementService.listRequirements({ orgId })
          .filter(r => r.status === 'in_progress')
          .map(r => ({
            id: r.id,
            title: r.title,
            status: r.status,
            priority: r.priority,
            projectId: r.projectId,
          }));
      },
    });
  }

  setReviewService(svc: ReviewService): void {
    this.reviewService = svc;
  }

  setTemplateRegistry(registry: TemplateRegistry): void {
    this.templateRegistry = registry;
  }

  setLLMRouter(router: LLMRouter): void {
    this.llmRouter = router;
  }

  setModelCatalog(catalog: ModelCatalogService): void {
    this.modelCatalog = catalog;
  }

  setConfigPath(configPath: string): void {
    this.markusConfigPath = configPath;
  }

  setHubUrl(url: string): void {
    this.hubUrl = url;
  }

  setWebUiDir(dir: string): void {
    this.webUiDir = dir;
  }

  setFileStorage(provider: LocalFileStorageProvider): void {
    this.fileStorage = provider;
  }

  initWorkflowEngine(): WorkflowEngine {
    const agentManager = this.orgService.getAgentManager();
    const executor: WorkflowExecutor = {
      executeStep: async (
        agentId: string,
        taskDescription: string,
        input: Record<string, unknown>
      ) => {
        const agent = agentManager.getAgent(agentId);
        const reply = await agent.sendMessage(
          taskDescription,
          'workflow-engine',
          { name: 'workflow', role: 'system' },
          {
            sourceType: 'system_event',
            sessionId: `sys_${agentId}_${Date.now()}`,
          }
        );
        return { reply, input };
      },
      findAgent: (skills: string[]) => {
        const agents = agentManager.listAgents();
        const found = agents.find(a =>
          skills.some(
            s =>
              a.role?.toLowerCase().includes(s.toLowerCase()) ||
              a.agentRole?.toLowerCase().includes(s.toLowerCase())
          )
        );
        return found?.id;
      },
    };
    this.workflowEngine = new WorkflowEngine(executor);
    return this.workflowEngine;
  }

  getTeamTemplateRegistry(): TeamTemplateRegistry {
    return this.teamTemplateRegistry;
  }

  /** Ensure at least one admin/owner user exists; called once after storage init.
   *  Migrates legacy 'default' user rows to a real auto-generated ID.
   *  Returns the owner's user ID (existing/migrated or newly created). */
  async ensureAdminUser(orgId: string): Promise<string> {
    if (!this.storage) return genUserId();
    const allUsers = await this.storage.userRepo.listByOrg(orgId);

    // Check for existing owner with a password
    const existingOwner = allUsers.find((u: any) => u.role === 'owner' && u.passwordHash);
    if (existingOwner) {
      // Migrate legacy 'default' ID to a proper auto-generated ID
      if (existingOwner.id === 'default') {
        const newId = genUserId();
        this.storage.userRepo.migrateDefaultId(newId);
        log.info("Migrated legacy owner id='default'", { newId });
        return newId;
      }
      return existingOwner.id as string;
    }

    // No owner found — create fresh
    const adminPassword = process.env['ADMIN_PASSWORD'] ?? 'markus123';
    const hash = await hashPassword(adminPassword);
    const ownerId = genUserId();
    await this.storage.userRepo.upsert({
      id: ownerId,
      orgId,
      name: 'Admin',
      email: 'admin@markus.local',
      role: 'owner',
      passwordHash: hash,
    });
    log.info('Created admin user (admin@markus.local)', { userId: ownerId });
    return ownerId;
  }

  private get jwtSecret(): string {
    return process.env['JWT_SECRET'] ?? 'markus-dev-secret-change-in-prod';
  }

  private get authEnabled(): boolean {
    return process.env['AUTH_ENABLED'] !== 'false';
  }

  /** Returns user payload from JWT cookie, or null if not authenticated */
  private async getAuthUser(
    req: IncomingMessage
  ): Promise<{ userId: string; orgId: string; role: string } | null> {
    if (!this.authEnabled) return { userId: 'anonymous', orgId: 'default', role: 'owner' };
    const cookies = parseCookies(req.headers['cookie']);
    const token = cookies['markus_token'];
    if (!token) return null;
    const payload = await verifyToken(token, this.jwtSecret);
    if (!payload) return null;
    return payload as { userId: string; orgId: string; role: string };
  }

  /** Returns user or sends 401 and returns null */
  private async requireAuth(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<{ userId: string; orgId: string; role: string } | null> {
    const user = await this.getAuthUser(req);
    if (!user) {
      this.json(res, 401, { error: 'Unauthorized' });
      return null;
    }
    return user;
  }

  /** Persist a chat turn (user + assistant) to DB if storage is available */
  private async persistChatTurn(
    agentId: string,
    userMessage: string,
    reply: string,
    senderId?: string,
    tokensUsed = 0,
    metadata?: unknown
  ): Promise<void> {
    if (!this.storage) return;
    try {
      const sessions = await this.storage.chatSessionRepo.getSessionsByAgent(agentId, 1, senderId);
      let session = sessions[0];
      if (!session) {
        session = await this.storage.chatSessionRepo.createSession(agentId, senderId);
      }
      const title = !session.title ? userMessage.slice(0, 60) : undefined;
      await this.storage.chatSessionRepo.appendMessage(session.id, agentId, 'user', userMessage, 0);
      await this.storage.chatSessionRepo.appendMessage(
        session.id,
        agentId,
        'assistant',
        reply,
        tokensUsed,
        metadata
      );
      await this.storage.chatSessionRepo.updateLastMessage(session.id, title);
    } catch (err) {
      log.warn('Failed to persist chat turn', { error: String(err) });
    }
  }

  // ── Agent-to-agent reply storm prevention ───────────────────────────────────
  private static readonly A2A_MAX_DEPTH = 3;
  private static readonly A2A_COOLDOWN_MS = 30_000;
  /** Per-channel cooldown tracker: channel → agentId → last reply timestamp */
  private a2aCooldowns = new Map<string, Map<string, number>>();

  private cleanStaleCooldowns(): void {
    const now = Date.now();
    for (const [channel, agentMap] of this.a2aCooldowns) {
      for (const [agentId, lastReply] of agentMap) {
        if (now - lastReply > APIServer.A2A_COOLDOWN_MS * 2) {
          agentMap.delete(agentId);
        }
      }
      if (agentMap.size === 0) {
        this.a2aCooldowns.delete(channel);
      }
    }
  }

  /** Extract @mentions from agent reply text. Returns agent names found.
   *  Handles multi-word names (e.g. "Ryan 莱恩") by checking known names after each @ sign.
   *  Also matches partial names: "@Sofia" matches "Sofia 索菲亚" if "Sofia" is a token in the name. */
  private parseAgentMentions(text: string, knownAgentNames: string[]): string[] {
    const mentioned = new Set<string>();

    // Build lookup: full names sorted longest-first, plus individual tokens → full name
    const sorted = [...knownAgentNames].sort((a, b) => b.length - a.length);
    const tokenToName = new Map<string, string>();
    for (const name of sorted) {
      // Each whitespace-separated token maps back to the full name
      for (const token of name.split(/\s+/)) {
        if (token.length >= 2) {
          const key = token.toLowerCase();
          if (!tokenToName.has(key)) tokenToName.set(key, name);
        }
      }
    }

    let idx = 0;
    while (idx < text.length) {
      const atPos = text.indexOf('@', idx);
      if (atPos < 0) break;

      // Check @[Name With Spaces] bracket syntax first
      if (text[atPos + 1] === '[') {
        const close = text.indexOf(']', atPos + 2);
        if (close > atPos + 2) {
          const bracketed = text.slice(atPos + 2, close);
          const match = sorted.find(n => n.toLowerCase() === bracketed.toLowerCase());
          if (match) mentioned.add(match);
          idx = close + 1;
          continue;
        }
      }

      const after = text.slice(atPos + 1);
      const afterLower = after.toLowerCase();

      // Try 1: full name prefix match (e.g. "@Ryan 莱恩" matches "Ryan 莱恩")
      const fullMatch = sorted.find(n => afterLower.startsWith(n.toLowerCase()));
      if (fullMatch) {
        mentioned.add(fullMatch);
        idx = atPos + 1 + fullMatch.length;
        continue;
      }

      // Try 2: single-token match (e.g. "@Sofia" matches "Sofia 索菲亚" via token "Sofia")
      // Extract the word right after @ (up to next space, punctuation, or CJK boundary)
      const tokenMatch = after.match(/^(\S+)/);
      if (tokenMatch) {
        const token = tokenMatch[1]!.toLowerCase()
          .replace(/[,，。！？!?;；:：、()（）[\]【】]+$/, ''); // strip trailing punctuation
        const resolved = tokenToName.get(token);
        if (resolved) {
          mentioned.add(resolved);
          idx = atPos + 1 + tokenMatch[1]!.length;
          continue;
        }
      }

      idx = atPos + 1;
    }
    return [...mentioned];
  }

  /** Resolve display name for a group channel */
  private resolveChannelName(channelKey: string): string {
    if (channelKey.startsWith('group:custom:') && this.storage?.groupChatRepo) {
      const gc = this.storage.groupChatRepo.getByChannelKey(channelKey);
      if (gc) return gc.name;
    }
    if (channelKey.startsWith('group:')) {
      const teamId = channelKey.replace(/^group:/, '');
      const team = this.orgService.getTeam(teamId);
      if (team) return team.name;
    }
    return channelKey;
  }

  /** Resolve human member IDs for a group channel (custom or team-based) */
  private resolveChannelHumanIds(channelKey: string): string[] {
    if (channelKey.startsWith('group:custom:') && this.storage?.groupChatRepo) {
      return this.storage.groupChatRepo.getHumanMemberIds(channelKey);
    }
    if (channelKey.startsWith('group:')) {
      const teamId = channelKey.replace(/^group:/, '');
      const team = this.orgService.getTeam(teamId);
      return team?.humanMemberIds ?? [];
    }
    return [];
  }

  /** Build name→id lookup for agents in a channel */
  private buildAgentNameMap(agentIds: string[], agentManager: AgentManager): Map<string, string> {
    const map = new Map<string, string>();
    for (const id of agentIds) {
      try { map.set(agentManager.getAgent(id).config.name, id); } catch { /* skip */ }
    }
    return map;
  }

  /**
   * Process a single agent's reply in a group chat broadcast.
   * Each agent decides independently whether to respond.
   * Replies are persisted and broadcast via WebSocket.
   * If the agent @mentions other agents, a chain reply is triggered (with storm prevention).
   */
  private async processGroupChatReply(
    agentId: string,
    userMessage: string,
    senderId: string,
    senderInfo: { name: string; role: string } | undefined,
    channel: string,
    orgId: string,
    channelContext: Array<{ role: string; content: string }>,
    agentManager: AgentManager,
    teamSize: number,
    opts?: { mentionedNames?: string[]; replyToAgentName?: string; replyToText?: string; replyToMsgId?: string },
    chainCtx?: { roundId: string; depth: number; respondedAgents: Set<string>; allAgentIds: string[] },
  ): Promise<void> {
    try {
      const agent = agentManager.getAgent(agentId);
      const agentName = agent.config.name;

      const isA2A = !!chainCtx && chainCtx.depth > 0;
      const hasReplyTarget = !!opts?.replyToAgentName;
      const hasMentions = !!opts?.mentionedNames?.length;
      const isTargeted = hasReplyTarget || hasMentions;

      const targetNames = new Set<string>();
      if (opts?.replyToAgentName) targetNames.add(opts.replyToAgentName);
      if (opts?.mentionedNames) opts.mentionedNames.forEach(n => targetNames.add(n));
      const thisAgentIsTarget = targetNames.has(agentName);

      const prefixLines = [
        `[GROUP CHAT — ${teamSize} team members | You are: ${agentName}]`,
        `[CHANNEL] channel_key="${channel}" — You already have the most recent ~${CHANNEL_CONTEXT_MESSAGES} messages in your context.`,
        '',
      ];

      if (isA2A) {
        prefixLines.push(`[AGENT COLLABORATION] This message is from a fellow agent (${opts?.replyToAgentName ?? 'teammate'}), not from the user.`);
        prefixLines.push('You were @mentioned because your expertise is needed. Respond concisely to the specific request.');
        prefixLines.push('You may @mention another agent if (and ONLY if) you genuinely need their specific expertise to answer.');
        prefixLines.push('Do NOT @mention agents just to be polite or to pass the conversation along.');
        prefixLines.push('');
      }

      if (isTargeted && !isA2A) {
        if (hasReplyTarget) {
          prefixLines.push(`[REPLY] The user is replying to ${opts!.replyToAgentName}'s message: "${(opts!.replyToText ?? '').slice(0, 200)}"`);
        }
        if (hasMentions) {
          prefixLines.push(`[MENTIONED] The user @mentioned: ${opts!.mentionedNames!.join(', ')}`);
        }
        prefixLines.push('');
        if (thisAgentIsTarget) {
          prefixLines.push('>>> You are the target of this message. You SHOULD respond. <<<');
        } else {
          prefixLines.push('>>> STOP. This message is NOT for you. The user is talking to ' + [...targetNames].join(', ') + ', not you.');
          prefixLines.push('You MUST respond with exactly: [NO_RESPONSE]');
          prefixLines.push('The ONLY exception: you are directly contradicted by a factual error. Offering opinions, agreement, "me too", or generic help does NOT count. <<<');
        }
      } else if (!isA2A) {
        prefixLines.push('This is an open group message (no specific @mention or reply target).');
      }

      // Static group chat rules (silence-by-default, @mention routing, processing
      // checklist) are now in the system prompt via scenario='group_chat'.
      // Only per-message variable parts remain here.
      if (chainCtx?.allAgentIds) {
        prefixLines.push('');
        const rosterLines = ['TEAM MEMBERS (use exact format for @mentions):'];
        for (const aid of chainCtx.allAgentIds) {
          try {
            const a = agentManager.getAgent(aid);
            const name = a.config.name;
            const fmt = name.includes(' ') ? `@[${name}]` : `@${name}`;
            rosterLines.push(`  ${fmt}${aid === agentId ? ' (you)' : ''}`);
          } catch { /* skip */ }
        }
        prefixLines.push(rosterLines.join('\n'));
      }
      if (isTargeted && !thisAgentIsTarget && !isA2A) {
        prefixLines.push('');
        prefixLines.push('REMINDER: This message is directed at ' + [...targetNames].join(', ') + '. You are ' + agentName + '. Respond ONLY with [NO_RESPONSE].');
      }

      prefixLines.push('---', '');
      const groupChatPrefix = prefixLines.join('\n');

      const toolEvents: Array<{ tool: string; status: 'done' | 'error'; arguments?: unknown; result?: string; durationMs?: number }> = [];
      const reply = await agent.sendMessage(
        groupChatPrefix + userMessage,
        senderId,
        senderInfo,
        {
          sourceType: isA2A ? 'a2a_message' : 'human_chat',
          scenario: isA2A ? 'a2a' : 'group_chat',
          channelContext,
          channelKey: channel,
          directMention: thisAgentIsTarget,
          toolEventCollector: toolEvents,
        }
      );

      const emitNoResponse = () => {
        const evt = {
          type: 'chat:agent_no_response' as const,
          payload: { channel, agentId },
          timestamp: new Date().toISOString(),
        };
        if (channel.startsWith('dm:') || channel.startsWith('notes:')) {
          const parts = channel.startsWith('notes:')
            ? [channel.slice(6)]
            : channel.slice(3).split(':');
          this.ws.sendToUsers(parts, evt);
        } else {
          const humanIds = this.resolveChannelHumanIds(channel);
          if (humanIds.length > 0) this.ws.sendToUsers(humanIds, evt);
          else this.ws.broadcast(evt);
        }
      };

      if (!reply || !reply.trim() || /\[NO_RESPONSE\b/i.test(reply)) {
        emitNoResponse();
        return;
      }

      const { thinking, clean: rawClean } = extractThinkBlocks(reply);
      // Strip [NO_RESPONSE] and its variants: [NO_RESPONSE — ...], [NO_RESPONSE: ...], etc.
      const noResponseStripped = rawClean.replace(/\[NO_RESPONSE[^\]]*\]/gi, '').trim();
      // If the entire message was a NO_RESPONSE block (even without closing bracket), suppress
      if (/^\[NO_RESPONSE\b/i.test(rawClean.trim())) {
        emitNoResponse();
        return;
      }
      // Catch creative "no response" phrasings the LLM invents instead of [NO_RESPONSE]:
      // e.g. "[context check — no response needed]", "[no response necessary]", "[silent]"
      const NO_RESPONSE_CREATIVE_RE = /^\[(?:context check|no response|silent|listening|observing|monitoring|watching|noting|acknowledged?)[^\]]*\]$/i;
      if (NO_RESPONSE_CREATIVE_RE.test(rawClean.trim())) {
        log.info('Suppressed creative no-response variant', { agentId, original: rawClean.trim().slice(0, 100) });
        emitNoResponse();
        return;
      }
      // Strip lines that look like raw tool invocations leaked into the reply.
      // Two patterns:
      //   1. Known Markus tool names — slash is optional (agent may write "recall_context" or "/recall_context")
      //   2. Generic slash commands from other platforms — slash is REQUIRED to avoid false positives
      //      (e.g. "/history 30" is a command, but "List the points" is normal text)
      const KNOWN_TOOL_RE = /^\s*\/?(?:recall_context|memory_search|memory_save|task_get|task_list|task_comment|requirement_get|requirement_comment|file_read|agent_send_message|agent_send_group_message|check_mailbox|update_working_memory|clear_working_memory|defer_mailbox_item|drop_mailbox_item|prioritize_mailbox_item|notify_user|recall_activity)\b/i;
      const SLASH_CMD_RE = /^\s*\/(?:history|help|status|list|search|get|set|info|ping|who|whois|me|join|leave|invite|kick|ban|mute|unmute|clear|purge|poll|remind|note|todo|roll|flip|ask)\b/i;
      const cleanReply = noResponseStripped.split('\n')
        .filter(line => !KNOWN_TOOL_RE.test(line) && !SLASH_CMD_RE.test(line))
        .join('\n').trim();
      if (!cleanReply) {
        log.warn('Suppressed raw tool command leak', { agentId, original: noResponseStripped.slice(0, 200) });
        emitNoResponse();
        return;
      }

      const metadata: Record<string, unknown> = {};
      if (thinking.length > 0) metadata['thinking'] = thinking;
      if (toolEvents.length > 0) metadata['toolCalls'] = toolEvents;
      if (isA2A && opts?.replyToAgentName) {
        metadata['replyToAgent'] = opts.replyToAgentName;
      }

      // Persist agent reply
      let persistedMsgId: string | undefined;
      if (this.storage) {
        const saved = await this.storage.channelMessageRepo.append({
          orgId,
          channel,
          senderId: agentId,
          senderType: 'agent',
          senderName: agentName,
          text: cleanReply,
          mentions: [],
          metadata: Object.keys(metadata).length > 0 ? metadata as any : undefined,
          replyToId: isA2A ? opts?.replyToMsgId : undefined,
        });
        persistedMsgId = saved.id;
      }

      // Send via WebSocket (scoped for DM/notes channels)
      const replyEvent = {
        type: 'chat:message' as const,
        payload: {
          channel,
          senderId: agentId,
          senderType: 'agent',
          senderName: agentName,
          text: cleanReply,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
          ...(isA2A ? {
            replyToId: opts?.replyToMsgId,
            replyToSender: opts?.replyToAgentName,
            replyToText: (opts?.replyToText ?? '').slice(0, 120),
          } : {}),
        },
        timestamp: new Date().toISOString(),
      };
      if (channel.startsWith('dm:') || channel.startsWith('notes:')) {
        const participants = channel.startsWith('notes:')
          ? [channel.slice(6)]
          : channel.slice(3).split(':');
        this.ws.sendToUsers(participants, replyEvent);
      } else {
        const humanIds = this.resolveChannelHumanIds(channel);
        if (humanIds.length > 0) this.ws.sendToUsers(humanIds, replyEvent);
        else this.ws.broadcast(replyEvent);
      }

      // ── Agent-to-agent chain: parse @mentions in the reply ──
      const allAgentIds = chainCtx?.allAgentIds ?? [];
      if (allAgentIds.length > 0) {
        const nameMap = this.buildAgentNameMap(allAgentIds, agentManager);
        const mentionedNames = this.parseAgentMentions(cleanReply, [...nameMap.keys()]);
        const filteredMentions = mentionedNames.filter(n => n !== agentName);
        log.info('A2A mention scan', { agentName, mentionedNames, filteredMentions, depth: chainCtx?.depth ?? 0 });

        if (filteredMentions.length > 0) {
          const depth = (chainCtx?.depth ?? 0) + 1;
          const roundId = chainCtx?.roundId ?? `round_${Date.now()}`;
          const responded = chainCtx?.respondedAgents ?? new Set<string>();
          responded.add(agentId);

          void this.triggerAgentToAgentChain(
            filteredMentions, nameMap, agentName, agentId, cleanReply, persistedMsgId,
            channel, orgId, agentManager, teamSize,
            { roundId, depth, respondedAgents: responded, allAgentIds },
          );
        }
      }
    } catch (err) {
      log.warn('Group chat agent reply failed', { agentId, error: String(err) });

      if (this.storage) {
        try {
          const errDetail = String(err).slice(0, 500);
          await this.storage.channelMessageRepo.append({
            orgId,
            channel,
            senderId: agentId,
            senderType: 'system',
            senderName: 'System',
            text: `⚠ AI service error: ${errDetail}`,
            mentions: [],
          });
        } catch { /* best-effort */ }
      }
    }
  }

  /**
   * Trigger agent-to-agent chain replies with 3-layer storm prevention:
   * 1. Depth limit (max 3 hops)
   * 2. Per-round dedup (each agent responds at most once per conversation round)
   * 3. Cooldown window (same agent won't be triggered twice within 30s on same channel)
   */
  private async triggerAgentToAgentChain(
    mentionedNames: string[],
    nameMap: Map<string, string>,
    fromAgentName: string,
    fromAgentId: string,
    fromText: string,
    fromMsgId: string | undefined,
    channel: string,
    orgId: string,
    agentManager: AgentManager,
    teamSize: number,
    chainCtx: { roundId: string; depth: number; respondedAgents: Set<string>; allAgentIds: string[] },
  ): Promise<void> {
    this.cleanStaleCooldowns();

    // Layer 1: depth limit — deliver to mailbox without chain capability
    if (chainCtx.depth > APIServer.A2A_MAX_DEPTH) {
      log.info('A2A chain depth limit — delivering to mailbox without chain', { channel, depth: chainCtx.depth, roundId: chainCtx.roundId });
      for (const targetName of mentionedNames) {
        const targetId = nameMap.get(targetName);
        if (!targetId) continue;
        try {
          agentManager.getAgent(targetId).enqueueToMailbox('a2a_message', {
            summary: `@mention from ${fromAgentName} (chain depth limit)`,
            content: `[From @${fromAgentName}]: ${fromText}`,
            extra: { senderId: fromAgentId, senderName: fromAgentName, channelKey: channel, directMention: true, throttled: true },
          }, { metadata: { senderId: fromAgentId, senderName: fromAgentName, senderRole: 'agent' } });
        } catch { /* agent may not exist */ }
      }
      return;
    }

    const now = Date.now();
    if (!this.a2aCooldowns.has(channel)) {
      this.a2aCooldowns.set(channel, new Map());
    }
    const channelCooldowns = this.a2aCooldowns.get(channel)!;

    // Build fresh channel context — provide ample history for informed replies
    let channelContext: Array<{ role: string; content: string }> = [];
    if (this.storage) {
      try {
        const recent = await this.storage.channelMessageRepo.getMessages(channel, CHANNEL_CONTEXT_MESSAGES);
        channelContext = (recent.messages ?? []).map((m: ChannelMsg) => ({
          role: m.senderType === 'agent' ? 'assistant' : 'user',
          content: m.senderType === 'agent'
            ? stripInternalBlocks(m.text)
            : `[${m.senderName}]: ${m.text}`,
        }));
      } catch { /* best-effort */ }
    }

    for (const targetName of mentionedNames) {
      const targetId = nameMap.get(targetName);
      if (!targetId) continue;

      // Layer 2: per-round dedup — deliver to mailbox without chain capability
      if (chainCtx.respondedAgents.has(targetId)) {
        log.info('A2A throttled (already responded) — delivering to mailbox', { targetName, roundId: chainCtx.roundId });
        try {
          agentManager.getAgent(targetId).enqueueToMailbox('a2a_message', {
            summary: `@mention from ${fromAgentName} (round dedup)`,
            content: `[From @${fromAgentName}]: ${fromText}`,
            extra: { senderId: fromAgentId, senderName: fromAgentName, channelKey: channel, directMention: true, throttled: true },
          }, { metadata: { senderId: fromAgentId, senderName: fromAgentName, senderRole: 'agent' } });
        } catch { /* agent may not exist */ }
        continue;
      }

      // Layer 3: cooldown window — deliver to mailbox without chain capability
      const lastReply = channelCooldowns.get(targetId) ?? 0;
      if (now - lastReply < APIServer.A2A_COOLDOWN_MS) {
        log.info('A2A throttled (cooldown) — delivering to mailbox', { targetName, channel, cooldownRemaining: APIServer.A2A_COOLDOWN_MS - (now - lastReply) });
        try {
          agentManager.getAgent(targetId).enqueueToMailbox('a2a_message', {
            summary: `@mention from ${fromAgentName} (cooldown)`,
            content: `[From @${fromAgentName}]: ${fromText}`,
            extra: { senderId: fromAgentId, senderName: fromAgentName, channelKey: channel, directMention: true, throttled: true },
          }, { metadata: { senderId: fromAgentId, senderName: fromAgentName, senderRole: 'agent' } });
        } catch { /* agent may not exist */ }
        continue;
      }
      channelCooldowns.set(targetId, now);

      const a2aMessage = `[From @${fromAgentName}]: ${fromText}`;

      void this.processGroupChatReply(
        targetId,
        a2aMessage,
        fromAgentId,
        { name: fromAgentName, role: 'agent' },
        channel,
        orgId,
        channelContext,
        agentManager,
        teamSize,
        {
          mentionedNames: [targetName],
          replyToAgentName: fromAgentName,
          replyToText: fromText.slice(0, 200),
          replyToMsgId: fromMsgId,
        },
        chainCtx,
      );
    }
  }

  /** Persist the user message first (before LLM), returns session id for subsequent assistant persistence.
   *  When sessionId is provided, appends to that session; when null/undefined, creates a new session. */
  private async persistUserMessage(
    agentId: string,
    userMessage: string,
    senderId?: string,
    images?: string[],
    sessionId?: string | null,
  ): Promise<string | null> {
    if (!this.storage) return null;
    try {
      let session: { id: string; title: string | null } | undefined;
      if (sessionId) {
        session = await this.storage.chatSessionRepo.getSession(sessionId) ?? undefined;
      }
      if (!session) {
        session = await this.storage.chatSessionRepo.createSession(agentId, senderId);
      }
      const title = !session!.title ? userMessage.slice(0, 60) : undefined;
      const meta = images?.length ? { images } : undefined;
      await this.storage.chatSessionRepo.appendMessage(session!.id, agentId, 'user', userMessage, 0, meta);
      if (title) await this.storage.chatSessionRepo.updateLastMessage(session!.id, title);
      return session!.id;
    } catch (err) {
      log.warn('Failed to persist user message', { error: String(err) });
      return null;
    }
  }

  /** Persist the assistant reply after LLM completes */
  private async persistAssistantMessage(
    sessionId: string | null,
    agentId: string,
    reply: string,
    tokensUsed = 0,
    metadata?: unknown
  ): Promise<void> {
    if (!this.storage || !sessionId) return;
    try {
      const msg = await this.storage.chatSessionRepo.appendMessage(
        sessionId,
        agentId,
        'assistant',
        reply,
        tokensUsed,
        metadata
      );
      await this.storage.chatSessionRepo.updateLastMessage(sessionId);
      if (msg?.id) {
        this.ws.broadcastUnreadUpdate(`session:${sessionId}`, msg.id);
      }
    } catch (err) {
      log.warn('Failed to persist assistant message', { error: String(err) });
    }
  }

  private triggerSecretaryWelcome(userId: string, userName: string, userRole: string): void {
    try {
      const mgr = this.orgService.getAgentManager();
      const agentList = mgr.listAgents();
      const secretaryInfo = agentList.find(a =>
        a.agentRole === 'secretary' || a.role?.toLowerCase() === 'secretary'
      );
      if (!secretaryInfo) return;
      const secretary = mgr.getAgent(secretaryInfo.id);
      const welcomeMsg = `[SYSTEM] A new team member just joined: "${userName}" (role: ${userRole}, id: ${userId}). They have completed their account setup. As their Secretary, proactively guide them through the system capabilities. Send them a welcome message using notify_user (target the new user by their id: ${userId}) explaining what they can do in Markus — projects, tasks, deliverables, team collaboration, and how to work with AI agents. Help them get started with their first steps.`;
      secretary.sendMessage(welcomeMsg, userId, {
        name: userName,
        role: userRole,
        isFirstConversation: true,
      }, { sourceType: 'human_chat', scenario: 'chat' });
    } catch (err) {
      log.warn('Failed to trigger secretary welcome for new user', { userId, error: String(err) });
    }
  }

  start(): void {
    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.ws.attach(this.server);
    this.server.listen(this.port, '0.0.0.0', () => {
      log.info(`API server listening on 0.0.0.0:${this.port} (HTTP + WebSocket)`);
    });
    this.tryInitFeishuNotifier();
  }

  stop(): void {
    this.server?.close();
    this.feishuNotifier?.stop();
  }

  /** Initialize FeishuNotifier once all dependencies are available. */
  private async tryInitFeishuNotifier(): Promise<void> {
    if (this.feishuNotifier) return;
    if (!this.hitlService) return;
    if (!this.storage) return;
    try {
      const agentManager = this.orgService.getAgentManager();
      const eventBus = agentManager.getEventBus();

      // Bridge critical EventBus events to WS broadcasts (for desktop notifications)
      const lifecycleEvents = [
        'task:completed',
      ];
      for (const evt of lifecycleEvents) {
        eventBus.on(evt, (...args: unknown[]) => {
          const payload = args[0] as Record<string, unknown> | undefined;
          this.ws.broadcast({ type: evt, payload: payload ?? {}, timestamp: new Date().toISOString() });
        });
      }
      // Bridge HITL notifications to WS broadcast for desktop
      this.hitlService.onNotification(n => {
        if (n.type === 'approval_request') {
          this.ws.broadcast({
            type: 'approval:requested',
            payload: { title: n.title, body: n.body, priority: n.priority, approvalId: n.metadata?.approvalId },
            timestamp: new Date().toISOString(),
          });
        }
      });

      // Credentials from markus.json (single source of truth)
      const { loadConfig: loadCfg } = await import('@markus/shared');
      const markusCfg = loadCfg(this.markusConfigPath);
      const appId = markusCfg.integrations?.feishu?.appId;
      const appSecret = markusCfg.integrations?.feishu?.appSecret;

      // Runtime prefs from SQLite
      const rows = this.storage.integrationRepo.listByPlatform('default', 'feishu') as Array<Record<string, unknown>>;
      const row = rows[0];
      const cfgConfig = row?.['config'] as Record<string, unknown> | undefined;
      const forwardRules = row?.['forwardRules'] as Array<Record<string, unknown>> | undefined;

      let initialConfig: FeishuNotifierConfig | undefined;
      if (appId && appSecret) {
        initialConfig = {
          appId,
          appSecret,
          domain: cfgConfig?.domain as string | undefined,
          locale: (cfgConfig?.locale as 'zh' | 'en' | undefined) ?? 'zh',
          notifyChatId: cfgConfig?.notifyChatId as string | undefined,
          notifyOpenId: cfgConfig?.notifyOpenId as string | undefined,
          notifyOnApproval: (cfgConfig?.notifyOnApproval ?? true) as boolean,
          notifyOnNotification: (cfgConfig?.notifyOnNotification ?? false) as boolean,
          notifyPriority: (cfgConfig?.notifyPriority ?? ['high', 'urgent']) as string[],
          forwardRules: (forwardRules ?? []) as unknown as FeishuNotifierConfig['forwardRules'],
        };
      }

      this.feishuNotifier = new FeishuNotifier({
        eventBus,
        hitlService: this.hitlService,
        orgId: 'default',
        agentManager: {
          getAgentName: (id: string) => {
            try { return agentManager.getAgent(id)?.config?.name ?? id; } catch { return id; }
          },
        },
        config: initialConfig,
      });
      this.feishuNotifier.start();
      log.info('FeishuNotifier initialized');

      // Route Feishu user messages to the Secretary agent
      eventBus.on('feishu:message_received', (...args: unknown[]) => {
        const payload = args[0] as Record<string, unknown>;
        this.handleFeishuUserMessage(payload).catch((err) => {
          log.error('Failed to handle Feishu user message', { error: String(err) });
        });
      });
    } catch (err) {
      log.warn('Failed to initialize FeishuNotifier', { error: String(err) });
    }
  }

  /** Handle an incoming Feishu user message by routing it to the Secretary agent. */
  private async handleFeishuUserMessage(payload: Record<string, unknown>): Promise<void> {
    const chatId = payload['chatId'] as string | undefined;
    const senderId = payload['senderId'] as string | undefined;
    const rawContent = payload['content'] as string | undefined;
    const messageType = payload['messageType'] as string | undefined;
    if (!chatId || !rawContent) return;

    // Extract text from Feishu message content JSON (e.g. {"text":"hello"})
    let text: string | undefined;
    if (messageType === 'text') {
      try {
        const parsed = JSON.parse(rawContent);
        text = parsed.text;
      } catch { text = rawContent; }
    } else {
      text = `[${messageType ?? 'unknown'}] ${rawContent}`;
    }
    if (!text) return;

    const agentManager = this.orgService.getAgentManager();
    const agentList = agentManager.listAgents();
    const secretaryInfo = agentList.find(a =>
      a.agentRole === 'secretary' || a.role?.toLowerCase() === 'secretary'
    );
    if (!secretaryInfo) {
      log.warn('No Secretary agent found to handle Feishu message');
      await this.feishuNotifier?.sendTextToChat(chatId, '暂无可用的秘书 Agent 处理此消息');
      return;
    }

    const secretary = agentManager.getAgent(secretaryInfo.id);
    const senderName = payload['senderName'] as string ?? senderId ?? 'feishu_user';
    try {
      const reply = await secretary.sendMessage(
        text,
        senderId ?? 'feishu_user',
        { name: senderName, role: 'user' },
        { sourceType: 'human_chat' },
      );
      if (reply && this.feishuNotifier) {
        await this.feishuNotifier.sendTextToChat(chatId, reply);
      }
    } catch (err) {
      log.error('Secretary agent failed to respond to Feishu message', { error: String(err) });
      await this.feishuNotifier?.sendTextToChat(chatId, `处理消息时出错: ${String(err).slice(0, 200)}`);
    }
  }

  getWSBroadcaster(): WSBroadcaster {
    return this.ws;
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // BUG-005: Validate Content-Type for POST/PUT/PATCH before routing (before auth)
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
      const isJson = contentType.includes('application/json');
      const isMultipart = contentType.includes('multipart/form-data');
      if (!isJson && !isMultipart) {
        this.json(res, 415, { error: 'Content-Type must be application/json or multipart/form-data' });
        return;
      }
    }

    const url = new URL(req.url ?? '/', `http://localhost:${this.port}`);
    const path = url.pathname;

    this.route(req, res, path, url).catch(error => {
      const msg = error instanceof Error ? error.message : String(error);
      log.error('Request handler error', { error: msg, path });
      if (res.headersSent) {
        // SSE or chunked stream already started — send an error event and close gracefully
        try {
          res.write(`data: ${JSON.stringify({ type: 'error', message: msg })}\n\n`);
        } catch {
          /* ignore if write also fails */
        }
        res.end();
      } else {
        if (msg.startsWith('CONTENT_TYPE_ERROR:')) {
          this.json(res, 415, { error: 'Content-Type must be application/json' });
        } else if (msg.startsWith('BODY_PARSE_ERROR:')) {
          this.json(res, 400, { error: 'Invalid request body' });
        } else {
          this.json(res, 500, { error: 'Internal server error' });
        }
      }
    });
  }

  private async route(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    url: URL
  ): Promise<void> {
    // BUG-003: Pre-read and validate body for POST/PUT/PATCH at route level.
    // This ensures body validation happens before any route-specific logic,
    // so invalid bodies (null/array) are caught even for routes without readBody.
    // Skip for multipart/form-data (image uploads handle body parsing themselves).
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      const ct = String(req.headers['content-type'] ?? '').toLowerCase();
      if (!ct.includes('multipart/form-data')) {
        await this.readBody(req);
      }
    }

    // ── Auth endpoints (no auth required) ──────────────────────────────────

    // System initialization status — tells frontend whether to show Login or InitialSetup
    if (path === '/api/auth/status' && req.method === 'GET') {
      if (!this.storage || !this.authEnabled) {
        this.json(res, 200, { initialized: true, hasOwner: true, hasMultipleUsers: false });
        return;
      }
      const allUsers = await this.storage.userRepo.listByOrg('default');
      const realUsers = allUsers.filter((u: any) =>
        (u.passwordHash || u.hubUserId) && u.email !== 'admin@markus.local'
      );
      const hasOwner = realUsers.some((u: any) => u.role === 'owner');
      const hasMultipleUsers = realUsers.length > 1;
      this.json(res, 200, {
        initialized: realUsers.length > 0,
        hasOwner,
        hasMultipleUsers,
      });
      return;
    }

    // First-time system initialization — creates admin user (only works when no real users exist)
    if (path === '/api/auth/init' && req.method === 'POST') {
      if (!this.storage) {
        this.json(res, 503, { error: 'Storage not available' });
        return;
      }
      // Only allow when system is not yet initialized
      const allUsers = await this.storage.userRepo.listByOrg('default');
      const hasRealUsers = allUsers.some((u: any) => u.passwordHash && u.email !== 'admin@markus.local');
      if (hasRealUsers) {
        this.json(res, 403, { error: 'System already initialized' });
        return;
      }
      const body = await this.readBody(req);
      const name = ((body['name'] as string) ?? '').trim();
      const email = ((body['email'] as string) ?? '').trim().toLowerCase();
      const password = (body['password'] as string) ?? '';
      if (!name || !email || !password) {
        this.json(res, 400, { error: 'name, email and password are required' });
        return;
      }
      if (password.length < 6) {
        this.json(res, 400, { error: 'Password must be at least 6 characters' });
        return;
      }
      const hash = await hashPassword(password);
      // Check if there's an unclaimed placeholder admin to adopt
      const placeholder = allUsers.find((u: any) => u.role === 'owner' && u.email === 'admin@markus.local');
      let userId: string;
      if (placeholder) {
        userId = placeholder.id as string;
        this.storage.userRepo.updateProfile(userId, { name, email });
        await this.storage.userRepo.updatePassword(userId, hash);
      } else {
        userId = genUserId();
        await this.storage.userRepo.upsert({
          id: userId, orgId: 'default', name, email, role: 'owner', passwordHash: hash,
        });
      }
      // Sync in-memory identity so agents see the real name immediately
      // (DB was already updated above — this only touches the in-memory map)
      this.orgService.syncHumanIdentity(userId, 'default', name, 'owner', email);
      await this.storage.userRepo.updateLastLogin(userId);
      const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
      const token = await signToken(
        { userId, orgId: 'default', role: 'owner', exp },
        this.jwtSecret
      );
      res.setHeader(
        'Set-Cookie',
        `markus_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}`
      );
      this.json(res, 200, {
        user: { id: userId, name, email, role: 'owner', orgId: 'default' },
        needsOnboarding: true,
      });
      return;
    }

    if (path === '/api/auth/login' && req.method === 'POST') {
      const body = await this.readBody(req);
      const email = ((body['email'] as string) ?? '').trim().toLowerCase();
      const password = (body['password'] as string) ?? '';

      if (!this.authEnabled) {
        this.json(res, 200, { user: { id: 'anonymous', name: 'Admin', role: 'owner' } });
        return;
      }

      let userRow = this.storage ? await this.storage.userRepo.findByEmail(email) : null;

      // First-time login: if the email isn't found, check if there's an unclaimed
      // admin user (still using the placeholder email). If the password matches,
      // adopt that admin user with the provided email.
      if (!userRow && this.storage) {
        const allUsers = await this.storage.userRepo.listByOrg('default');
        const unclaimedOwner = allUsers.find((u: any) =>
          u.role === 'owner' && !u.lastLoginAt && u.email === 'admin@markus.local'
        );
        if (unclaimedOwner && unclaimedOwner.passwordHash) {
          const ownerPasswordValid = await verifyPassword(password, unclaimedOwner.passwordHash);
          if (ownerPasswordValid) {
            this.storage.userRepo.updateProfile(unclaimedOwner.id, { email });
            userRow = { ...unclaimedOwner, email } as typeof userRow;
          }
        }
      }

      if (!userRow || !userRow.passwordHash) {
        this.json(res, 401, { error: 'Invalid email or password' });
        return;
      }
      const valid = await verifyPassword(password, userRow.passwordHash);
      if (!valid) {
        this.json(res, 401, { error: 'Invalid email or password' });
        return;
      }
      const isFirstLogin = !userRow.lastLoginAt;
      await this.storage!.userRepo.updateLastLogin(userRow.id);
      const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
      const token = await signToken(
        { userId: userRow.id, orgId: userRow.orgId, role: userRow.role, exp },
        this.jwtSecret
      );
      res.setHeader(
        'Set-Cookie',
        `markus_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}`
      );
      this.json(res, 200, {
        user: {
          id: userRow.id,
          name: userRow.name,
          email: userRow.email,
          role: userRow.role,
          orgId: userRow.orgId,
          avatarUrl: userRow.avatarUrl ?? undefined,
        },
        needsOnboarding: isFirstLogin,
      });
      return;
    }

    // Hub OAuth login — authenticate via Markus Hub token, auto-create local user
    if (path === '/api/auth/hub-login' && req.method === 'POST') {
      if (!this.storage) {
        this.json(res, 503, { error: 'Storage not available' });
        return;
      }
      const body = await this.readBody(req);
      const hubToken = body['hubToken'] as string;
      const hubUser = body['hubUser'] as { id: string; username: string; email?: string; displayName?: string; avatarUrl?: string } | undefined;
      if (!hubToken || !hubUser?.id) {
        this.json(res, 400, { error: 'hubToken and hubUser are required' });
        return;
      }

      // Verify Hub token against Hub API and use the response as authoritative source
      let verifiedUser: { id: string; username?: string; email?: string; displayName?: string; avatarUrl?: string } | null = null;
      try {
        const verifyRes = await this.hubFetch(`${this.hubUrl}/api/auth/me`, {
          headers: { 'Authorization': `Bearer ${hubToken}` },
        });
        if (verifyRes.ok) {
          const verifyData = await verifyRes.json() as { user?: { id: string; username?: string; email?: string; displayName?: string; avatarUrl?: string } };
          if (verifyData.user && verifyData.user.id === hubUser.id) {
            verifiedUser = verifyData.user;
          } else {
            log.warn('Hub token user mismatch', { expected: hubUser.id, got: verifyData.user?.id });
          }
        } else {
          log.warn('Hub /api/auth/me returned non-OK', { status: verifyRes.status, hubUrl: this.hubUrl });
        }
      } catch (e) {
        log.warn('Hub token verification failed, proceeding with client-supplied data', { error: (e as Error).message, hubUrl: this.hubUrl });
      }
      // If Hub verification failed, trust the client-supplied hubUser data
      // (the token was already obtained via the Hub connect flow)
      if (!verifiedUser) {
        verifiedUser = { id: hubUser.id, username: hubUser.username, email: hubUser.email, displayName: hubUser.displayName, avatarUrl: hubUser.avatarUrl };
      }

      // Prefer authoritative Hub /api/auth/me data, fall back to client-supplied hubUser
      const rawEmail = (verifiedUser.email ?? hubUser.email ?? '').trim().toLowerCase();
      const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ? rawEmail : '';
      const name = verifiedUser.displayName || verifiedUser.username || hubUser.displayName || hubUser.username || (email && email.split('@')[0]) || 'User';
      const avatarUrl = verifiedUser.avatarUrl ?? hubUser.avatarUrl ?? null;

      // Look up existing local user: first by hub_user_id, then by email
      let userRow = this.storage.userRepo.findByHubUserId(hubUser.id);
      let isFirstLogin = false;

      if (!userRow && email) {
        userRow = this.storage.userRepo.findByEmail(email);
        if (userRow) {
          // Existing user found by email — bind Hub ID & username
          this.storage.userRepo.updateHubUserId(userRow.id, hubUser.id, hubUser.username);
          if (avatarUrl && !userRow.avatarUrl) {
            this.storage.userRepo.updateAvatarUrl(userRow.id, avatarUrl);
          }
        }
      }

      if (!userRow) {
        // Check if there's an unclaimed placeholder admin to adopt
        const allUsers = await this.storage.userRepo.listByOrg('default');
        const placeholder = allUsers.find((u: any) => u.role === 'owner' && u.email === 'admin@markus.local');
        const hasRealOwner = allUsers.some((u: any) =>
          u.role === 'owner' && (u.passwordHash || u.hubUserId) && u.email !== 'admin@markus.local'
        );

        if (placeholder && !hasRealOwner) {
          // Adopt placeholder admin
          this.storage.userRepo.updateProfile(placeholder.id, { name, email: email || undefined, avatarUrl });
          this.storage.userRepo.updateHubUserId(placeholder.id, hubUser.id, hubUser.username);
          userRow = this.storage.userRepo.findById(placeholder.id);
          isFirstLogin = true;
        } else if (!hasRealOwner) {
          // Create new owner
          const userId = genUserId();
          this.storage.userRepo.create({
            id: userId, orgId: 'default', name, email: email || undefined,
            role: 'owner', hubUserId: hubUser.id, avatarUrl: avatarUrl ?? undefined,
          });
          this.storage.userRepo.updateHubUserId(userId, hubUser.id, hubUser.username);
          userRow = this.storage.userRepo.findById(userId);
          isFirstLogin = true;
        } else {
          // There's already an owner — try to adopt if single-user instance
          const realOwners = allUsers.filter((u: any) =>
            u.role === 'owner' && (u.passwordHash || u.hubUserId) && u.email !== 'admin@markus.local'
          );
          if (realOwners.length === 1 && !realOwners[0].hubUserId) {
            // Single-user instance with one owner that has no Hub binding — adopt them
            const existingOwner = realOwners[0];
            this.storage.userRepo.updateProfile(existingOwner.id, { name: existingOwner.name, email: email || existingOwner.email, avatarUrl: avatarUrl ?? existingOwner.avatarUrl });
            this.storage.userRepo.updateHubUserId(existingOwner.id, hubUser.id, hubUser.username);
            userRow = this.storage.userRepo.findById(existingOwner.id);
            log.info('Hub login: adopted existing owner', { ownerId: existingOwner.id, hubUserId: hubUser.id });
          } else {
            this.json(res, 403, { error: 'This instance already has an owner. Multi-user requires Enterprise license.' });
            return;
          }
        }
      }

      if (!userRow) {
        this.json(res, 500, { error: 'Failed to create user' });
        return;
      }

      // Sync all Hub profile fields on every login
      const hubUsername = verifiedUser.username || hubUser.username;
      if (hubUsername) {
        this.storage.userRepo.updateHubUserId(userRow.id, hubUser.id, hubUsername);
      }
      const profileUpdates: { name?: string; email?: string; avatarUrl?: string | null } = {};
      if (name && name !== userRow.name) profileUpdates.name = name;
      if (email && email !== userRow.email) profileUpdates.email = email;
      if (avatarUrl && avatarUrl !== userRow.avatarUrl) profileUpdates.avatarUrl = avatarUrl;
      if (Object.keys(profileUpdates).length > 0) {
        this.storage.userRepo.updateProfile(userRow.id, profileUpdates);
        userRow = this.storage.userRepo.findById(userRow.id);
      }

      // Sync in-memory identity
      this.orgService.syncHumanIdentity(userRow!.id, 'default', userRow!.name, userRow!.role, userRow!.email ?? undefined);

      // Persist Hub token to ~/.markus/hub-token
      try {
        const tokenPath = join(homedir(), '.markus', 'hub-token');
        mkdirSync(dirname(tokenPath), { recursive: true });
        writeFileSync(tokenPath, hubToken, 'utf-8');
      } catch { /* non-critical */ }

      const finalUser = userRow!;
      await this.storage.userRepo.updateLastLogin(finalUser.id);
      const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
      const token = await signToken(
        { userId: finalUser.id, orgId: 'default', role: finalUser.role, exp },
        this.jwtSecret
      );
      res.setHeader(
        'Set-Cookie',
        `markus_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}`
      );
      this.json(res, 200, {
        user: {
          id: finalUser.id,
          name: finalUser.name,
          email: finalUser.email,
          role: finalUser.role,
          orgId: finalUser.orgId,
          avatarUrl: finalUser.avatarUrl ?? undefined,
        },
        needsOnboarding: isFirstLogin,
      });
      return;
    }

    if (path === '/api/auth/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', 'markus_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      this.json(res, 200, { ok: true });
      return;
    }

    if (path === '/api/auth/me' && req.method === 'GET') {
      const authUser = await this.getAuthUser(req);
      if (!authUser) {
        this.json(res, 401, { error: 'Unauthorized' });
        return;
      }
      if (!this.authEnabled) {
        this.json(res, 200, {
          user: { id: 'anonymous', name: 'Admin', role: 'owner', orgId: 'default' },
        });
        return;
      }
      const userRow = this.storage ? await this.storage.userRepo.findById(authUser.userId) : null;
      if (!userRow) {
        this.json(res, 401, { error: 'User not found' });
        return;
      }
      this.json(res, 200, {
        user: {
          id: userRow.id,
          name: userRow.name,
          email: userRow.email,
          role: userRow.role,
          orgId: userRow.orgId,
          avatarUrl: userRow.avatarUrl ?? undefined,
        },
      });
      return;
    }

    if (path === '/api/auth/change-password' && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (!this.storage) {
        this.json(res, 503, { error: 'Storage not available' });
        return;
      }
      const body = await this.readBody(req);
      const currentPassword = (body['currentPassword'] as string) ?? '';
      const newPassword = (body['newPassword'] as string) ?? '';
      if (!newPassword || newPassword.length < 6) {
        this.json(res, 400, { error: 'New password must be at least 6 characters' });
        return;
      }
      const userRow = await this.storage.userRepo.findById(authUser.userId);
      if (!userRow) {
        this.json(res, 404, { error: 'User not found' });
        return;
      }
      // If they already have a password, verify current one (skip for first-time setup where hash is null/empty)
      if (userRow.passwordHash && currentPassword) {
        const valid = await verifyPassword(currentPassword, userRow.passwordHash);
        if (!valid) {
          this.json(res, 401, { error: 'Current password is incorrect' });
          return;
        }
      }
      const newHash = await hashPassword(newPassword);
      await this.storage.userRepo.updatePassword(authUser.userId, newHash);
      // Re-issue token so session stays valid
      const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
      const token = await signToken(
        { userId: userRow.id, orgId: userRow.orgId, role: userRow.role, exp },
        this.jwtSecret
      );
      res.setHeader(
        'Set-Cookie',
        `markus_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}`
      );
      this.json(res, 200, { ok: true });
      return;
    }

    if (path === '/api/auth/setup' && req.method === 'POST') {
      if (!this.storage) {
        this.json(res, 503, { error: 'Storage not available' });
        return;
      }
      const body = await this.readBody(req);
      const token = (body['token'] as string) ?? '';
      const password = (body['password'] as string) ?? '';
      if (!token || !password) {
        this.json(res, 400, { error: 'Token and password are required' });
        return;
      }
      if (password.length < 6) {
        this.json(res, 400, { error: 'Password must be at least 6 characters' });
        return;
      }
      const userRow = this.storage.userRepo.findByInviteToken(token);
      if (!userRow) {
        this.json(res, 400, { error: 'Invalid or expired invite link' });
        return;
      }
      if (userRow.inviteExpiresAt && new Date(userRow.inviteExpiresAt) < new Date()) {
        this.json(res, 400, { error: 'Invite link has expired' });
        return;
      }
      const hash = await hashPassword(password);
      await this.storage.userRepo.updatePassword(userRow.id as string, hash);
      this.storage.userRepo.clearInviteToken(userRow.id as string);
      await this.storage.userRepo.updateLastLogin(userRow.id as string);
      const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
      const jwtToken = await signToken(
        { userId: userRow.id, orgId: userRow.orgId, role: userRow.role, exp },
        this.jwtSecret
      );
      res.setHeader(
        'Set-Cookie',
        `markus_token=${jwtToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}`
      );

      this.json(res, 200, { ok: true, email: userRow.email });
      return;
    }

    if (path === '/api/auth/invite-info' && req.method === 'GET') {
      if (!this.storage) {
        this.json(res, 503, { error: 'Storage not available' });
        return;
      }
      const token = url.searchParams.get('token') ?? '';
      if (!token) {
        this.json(res, 400, { error: 'Token is required' });
        return;
      }
      const userRow = this.storage.userRepo.findByInviteToken(token);
      if (!userRow) {
        this.json(res, 400, { error: 'Invalid or expired invite link' });
        return;
      }
      if (userRow.inviteExpiresAt && new Date(userRow.inviteExpiresAt) < new Date()) {
        this.json(res, 400, { error: 'Invite link has expired' });
        return;
      }
      this.json(res, 200, { name: userRow.name, email: userRow.email });
      return;
    }

    if (path === '/api/auth/profile' && req.method === 'PUT') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (!this.storage) {
        this.json(res, 503, { error: 'Storage not available' });
        return;
      }
      const body = await this.readBody(req);
      const name = (body['name'] as string)?.trim();
      const email = (body['email'] as string)?.trim().toLowerCase();
      if (!name) {
        this.json(res, 400, { error: 'Name is required' });
        return;
      }
      if (email) {
        const existing = this.storage.userRepo.findByEmail(email);
        if (existing && existing.id !== authUser.userId) {
          this.json(res, 409, { error: 'Email already in use' });
          return;
        }
      }
      const updated = this.storage.userRepo.updateProfile(authUser.userId, {
        name,
        ...(email ? { email } : {}),
      });
      if (!updated) {
        this.json(res, 404, { error: 'User not found' });
        return;
      }
      // Update in-memory human user as well
      const human = this.orgService.getHumanUser(authUser.userId);
      if (human) {
        human.name = name;
        if (email) human.email = email;
      }
      // Re-issue token with updated info
      const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
      const token = await signToken(
        { userId: updated.id, orgId: updated.orgId, role: updated.role, exp },
        this.jwtSecret
      );
      res.setHeader(
        'Set-Cookie',
        `markus_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}`
      );
      this.json(res, 200, {
        user: {
          id: updated.id,
          name: updated.name,
          email: updated.email,
          role: updated.role,
          orgId: updated.orgId,
          avatarUrl: updated.avatarUrl ?? undefined,
        },
      });
      return;
    }

    // ── Avatar upload / serve ────────────────────────────────────────────
    if (path === '/api/avatars/upload' && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const body = await this.readBody(req);
      const targetType = (body['type'] as string) ?? 'user';
      const targetId = (body['id'] as string) ?? authUser.userId;
      const imageData = body['image'] as string;
      if (!imageData) {
        this.json(res, 400, { error: 'image is required (base64 data URL)' });
        return;
      }
      const match = imageData.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/);
      if (!match) {
        this.json(res, 400, { error: 'Invalid image format. Must be a base64 data URL (png/jpeg/webp/gif)' });
        return;
      }
      const ext = match[1] === 'jpeg' ? 'jpg' : match[1]!;
      const buf = Buffer.from(match[2]!, 'base64');
      if (buf.length > 2 * 1024 * 1024) {
        this.json(res, 400, { error: 'Image too large (max 2MB)' });
        return;
      }
      const avatarDir = join(homedir(), '.markus', 'avatars');
      mkdirSync(avatarDir, { recursive: true });
      const filename = `${targetType}_${targetId}.${ext}`;
      writeFileSync(join(avatarDir, filename), buf);
      const avatarUrl = `/api/avatars/${filename}`;
      if (targetType === 'user' && this.storage) {
        this.storage.userRepo.updateAvatarUrl(targetId, avatarUrl);
        const human = this.orgService.getHumanUser(targetId);
        if (human) (human as any).avatarUrl = avatarUrl;
      } else if (targetType === 'agent' && this.storage) {
        this.storage.agentRepo.updateAvatarUrl(targetId, avatarUrl);
      }
      this.json(res, 200, { avatarUrl });
      return;
    }

    if (path.startsWith('/api/avatars/') && req.method === 'GET') {
      const filename = decodeURIComponent(path.split('/')[3] ?? '');
      if (!filename || filename.includes('..')) {
        this.json(res, 400, { error: 'Invalid filename' });
        return;
      }
      const filePath = join(homedir(), '.markus', 'avatars', filename);
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        this.serveStaticFile(res, filePath);
      } else {
        this.json(res, 404, { error: 'Avatar not found' });
      }
      return;
    }

    // ── File uploads (generic storage) ────────────────────────────────────
    if (path === '/api/uploads' && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (!this.fileStorage) {
        this.json(res, 503, { error: 'File storage not configured' });
        return;
      }
      const body = await this.readBody(req);
      const files = body['files'] as Array<{ dataUrl: string; name: string }> | undefined;
      if (!Array.isArray(files) || files.length === 0) {
        this.json(res, 400, { error: 'files[] is required (array of { dataUrl, name })' });
        return;
      }
      if (files.length > 10) {
        this.json(res, 400, { error: 'Too many files (max 10 per request)' });
        return;
      }
      const prefix = typeof body['prefix'] === 'string' ? body['prefix'] : undefined;
      const results: Array<{ url: string; key: string; name: string }> = [];
      for (const file of files) {
        if (!file.dataUrl || typeof file.dataUrl !== 'string') continue;
        const m = file.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!m) continue;
        const contentType = m[1]!;
        const buf = Buffer.from(m[2]!, 'base64');
        if (buf.length > 10 * 1024 * 1024) continue;
        const result = await this.fileStorage.upload(buf, {
          name: file.name || 'file',
          contentType,
          prefix,
        });
        results.push({ ...result, name: file.name });
      }
      this.json(res, 200, { files: results });
      return;
    }

    if (path.startsWith('/api/uploads/') && req.method === 'GET') {
      if (!this.fileStorage) {
        this.json(res, 404, { error: 'File storage not configured' });
        return;
      }
      const key = decodeURIComponent(path.slice('/api/uploads/'.length));
      if (!key || key.includes('..')) {
        this.json(res, 400, { error: 'Invalid key' });
        return;
      }
      const filePath = this.fileStorage.resolve(key);
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        this.serveStaticFile(res, filePath);
      } else {
        this.json(res, 404, { error: 'File not found' });
      }
      return;
    }

    // ── Chat sessions ──────────────────────────────────────────────────────
    if (path === '/api/sessions/has-any' && req.method === 'GET') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (!this.storage) {
        this.json(res, 200, { hasAny: false });
        return;
      }
      const hasAny = this.storage.chatSessionRepo.hasAnySessions(authUser.userId);
      this.json(res, 200, { hasAny });
      return;
    }

    if (path.match(/^\/api\/agents\/[^/]+\/sessions$/) && req.method === 'GET') {
      const authUser = await this.getAuthUser(req);
      const agentId = path.split('/')[3]!;
      if (!this.storage) {
        this.json(res, 200, { sessions: [] });
        return;
      }
      const limit = parseInt(url.searchParams.get('limit') ?? '20');
      const sessions = await this.storage.chatSessionRepo.getSessionsByAgent(agentId, limit, authUser?.userId);
      this.json(res, 200, { sessions });
      return;
    }

    if (path.match(/^\/api\/sessions\/[^/]+\/messages$/) && req.method === 'GET') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const sessionId = path.split('/')[3]!;
      if (!this.storage) {
        this.json(res, 200, { messages: [], hasMore: false });
        return;
      }
      const session = this.storage.chatSessionRepo.getSession(sessionId);
      if (session && session.userId && session.userId !== authUser.userId) {
        const isAdminOrOwner = authUser.role === 'owner' || authUser.role === 'admin';
        if (!isAdminOrOwner) {
          this.json(res, 403, { error: 'Access denied: this session belongs to another user' });
          return;
        }
      }
      const limit = parseInt(url.searchParams.get('limit') ?? '50');
      const before = url.searchParams.get('before') ?? undefined;
      const result = await this.storage.chatSessionRepo.getMessages(sessionId, limit, before);
      this.json(res, 200, result);
      return;
    }

    if (path.match(/^\/api\/sessions\/[^/]+$/) && req.method === 'DELETE') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const sessionId = path.split('/')[3]!;
      if (this.storage) await this.storage.chatSessionRepo.deleteSession(sessionId);
      this.json(res, 204, {});
      return;
    }

    // ── Channel messages ───────────────────────────────────────────────────
    if (path.match(/^\/api\/channels\/[^/]+\/messages$/) && req.method === 'GET') {
      const channel = decodeURIComponent(path.split('/')[3]!);
      if (!this.storage) {
        this.json(res, 200, { messages: [], hasMore: false });
        return;
      }
      const limit = parseInt(url.searchParams.get('limit') ?? '50');
      const before = url.searchParams.get('before') ?? undefined;
      const result = await this.storage.channelMessageRepo.getMessages(channel, limit, before);
      this.json(res, 200, result);
      return;
    }

    if (path.match(/^\/api\/channels\/[^/]+\/messages$/) && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const channel = decodeURIComponent(path.split('/')[3]!);
      const body = await this.readBody(req);
      const text = body['text'] as string;
      const resolvedIdentity = this.orgService.resolveHumanIdentity(authUser.userId);
      const senderId = authUser.userId;
      const senderName = resolvedIdentity?.name ?? (body['senderName'] as string) ?? 'You';
      const mentions = (body['mentions'] as string[]) ?? [];
      const targetAgentId = body['targetAgentId'] as string | undefined;
      const replyToId = body['replyToId'] as string | undefined;
      const orgId = (body['orgId'] as string) ?? 'default';

      // Persist user message
      let userMsg: ChannelMsg | undefined;
      if (this.storage) {
        userMsg = await this.storage.channelMessageRepo.append({
          orgId,
          channel,
          senderId,
          senderType: 'human',
          senderName,
          text,
          mentions,
          replyToId,
        });
      }

      // Broadcast unread update for channel message
      if (userMsg) {
        this.ws.broadcastUnreadUpdate(`channel:${channel}`, userMsg.id);
      }

      // DM / personal-notepad channels never route to agents
      const humanOnly = (body['humanOnly'] as boolean) === true;
      const isHumanChannel = humanOnly || channel.startsWith('notes:') || channel.startsWith('dm:');

      // Build channel context — give agents enough history to understand the full discussion
      const buildChannelContext = async (): Promise<Array<{ role: string; content: string }>> => {
        if (!this.storage) return [];
        try {
          const recent = await this.storage.channelMessageRepo.getMessages(channel, CHANNEL_CONTEXT_MESSAGES);
          return (recent.messages ?? []).map((m: ChannelMsg) => ({
            role: m.senderType === 'agent' ? 'assistant' : 'user',
            content: m.senderType === 'agent'
              ? stripInternalBlocks(m.text)
              : `[${m.senderName}]: ${m.text}`,
          }));
        } catch {
          return [];
        }
      };

      // Resolve reply context if the user is replying to a specific message
      let replyToAgentName: string | undefined;
      let replyToText: string | undefined;
      if (replyToId && this.storage) {
        try {
          const original = this.storage.channelMessageRepo.getMessageById(replyToId);
          if (original) {
            replyToAgentName = original.senderName;
            replyToText = original.text.slice(0, 200);
          }
        } catch { /* best-effort */ }
      }

      // Enrich userMsg with denormalized reply fields for the frontend
      const enrichedUserMsg = userMsg ? {
        ...userMsg,
        ...(replyToAgentName ? { replyToSender: replyToAgentName, replyToText } : {}),
      } : null;

      // Broadcast user message to other members so they see it in real time
      if (enrichedUserMsg) {
        let targetIds: string[] = [];
        if (channel.startsWith('group:')) {
          targetIds = this.resolveChannelHumanIds(channel).filter(id => id !== senderId);
        } else if (channel.startsWith('dm:')) {
          targetIds = channel.slice(3).split(':').filter(id => id !== senderId);
        }
        if (targetIds.length > 0) {
          this.ws.sendToUsers(targetIds, {
            type: 'chat:message',
            payload: {
              channel,
              senderId,
              senderType: 'human',
              senderName,
              text,
              id: enrichedUserMsg.id,
            },
            timestamp: new Date().toISOString(),
          });

          // Create notification bell entry for each recipient
          if (this.hitlService) {
            const preview = text.length > 80 ? text.slice(0, 80) + '…' : text;
            if (channel.startsWith('dm:')) {
              for (const tid of targetIds) {
                this.hitlService.notify({
                  targetUserId: tid,
                  type: 'direct_message',
                  title: senderName,
                  body: preview,
                  priority: 'normal',
                  actionType: 'navigate',
                  actionTarget: JSON.stringify({ path: `/team?dm=${senderId}` }),
                  metadata: { senderId, senderName, channel },
                });
              }
            } else if (channel.startsWith('group:')) {
              const gcName = this.resolveChannelName(channel);
              for (const tid of targetIds) {
                this.hitlService.notify({
                  targetUserId: tid,
                  type: 'group_message',
                  title: `${senderName} in ${gcName}`,
                  body: preview,
                  priority: 'low',
                  actionType: 'navigate',
                  actionTarget: JSON.stringify({ path: `/team?channel=${encodeURIComponent(channel)}` }),
                  metadata: { senderId, senderName, channel, groupName: gcName },
                });
              }
            }
          }
        }
      }

      // ── Group chat broadcast: all team members respond independently ──
      if (!isHumanChannel && channel.startsWith('group:')) {
        let allAgentIds: string[];
        if (channel.startsWith('group:custom:')) {
          allAgentIds = this.storage?.groupChatRepo?.getAgentMemberIds(channel) ?? [];
        } else {
          const teamId = channel.replace(/^group:/, '');
          const team = this.orgService.getTeam(teamId);
          allAgentIds = team?.memberAgentIds ?? [];
        }

        if (allAgentIds.length === 0) {
          this.json(res, 200, { userMessage: enrichedUserMsg, agentMessage: null });
          return;
        }

        const channelContext = await buildChannelContext();
        const senderInfo = this.orgService.resolveHumanIdentity(senderId);
        const agentManager = this.orgService.getAgentManager();

        const broadcastOpts = {
          mentionedNames: mentions.length > 0 ? mentions : undefined,
          replyToAgentName,
          replyToText,
        };

        // Prepare chain context so agent replies can trigger agent-to-agent chains
        const roundId = `round_${Date.now()}`;
        const respondedAgents = new Set<string>();
        const chainCtx = { roundId, depth: 0, respondedAgents, allAgentIds };

        // Fire-and-forget: each agent processes the message independently
        for (const agentId of allAgentIds) {
          void this.processGroupChatReply(
            agentId, text, senderId, senderInfo, channel, orgId, channelContext, agentManager, allAgentIds.length, broadcastOpts, chainCtx,
          );
        }

        // Return immediately with only the user message
        this.json(res, 200, { userMessage: enrichedUserMsg, agentMessage: null });
        return;
      }

      // ── Single-agent routing (@mention, non-group, or fallback) ──
      let routedAgentId: string | null | undefined = null;
      if (!isHumanChannel) {
        if (targetAgentId) {
          routedAgentId = targetAgentId;
        } else if (channel.startsWith('group:')) {
          // @mention already handled above; this is a fallback for custom group chats
          routedAgentId = this.orgService.routeMessage(orgId, { text });
        } else {
          routedAgentId = this.orgService.routeMessage(orgId, { text });
        }
      }
      if (!routedAgentId) {
        this.json(res, 200, { userMessage: enrichedUserMsg, agentMessage: null });
        return;
      }
      const agent = this.orgService.getAgentManager().getAgent(routedAgentId);
      const senderInfo = this.orgService.resolveHumanIdentity(senderId);

      const channelContext = await buildChannelContext();

      let reply: string;
      const toolEvents: Array<{ tool: string; status: 'done' | 'error'; arguments?: unknown; result?: string; durationMs?: number }> = [];
      try {
        reply = await agent.sendMessage(text, senderId, senderInfo, {
          sourceType: 'human_chat',
          channelContext,
          toolEventCollector: toolEvents,
        });
      } catch (err) {
        const raw = String(err);
        let detail = raw;
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]) as {
              error?: { message?: string };
              message?: string;
            };
            detail = parsed.error?.message ?? parsed.message ?? raw;
          } catch {
            /* keep raw */
          }
        }

        // Persist error as a channel message so it survives page reloads
        let errorMsg: ChannelMsg | undefined;
        if (this.storage) {
          try {
            errorMsg = await this.storage.channelMessageRepo.append({
              orgId,
              channel,
              senderId: routedAgentId,
              senderType: 'system',
              senderName: 'System',
              text: `⚠ AI service error: ${detail.slice(0, 500)}`,
              mentions: [],
            });
          } catch (e) {
            log.warn('Failed to persist channel error message', { error: String(e) });
          }
        }

        const statusCode = raw.includes('402')
          ? 402
          : raw.includes('401')
            ? 401
            : raw.includes('429')
              ? 429
              : 502;
        this.json(res, statusCode, {
          userMessage: enrichedUserMsg,
          agentMessage: errorMsg ?? null,
          error: detail,
        });
        return;
      }

      // Separate clean text from internal process data
      const { thinking, clean: cleanReply } = extractThinkBlocks(reply);
      const metadata: Record<string, unknown> = {};
      if (thinking.length > 0) metadata['thinking'] = thinking;
      if (toolEvents.length > 0) metadata['toolCalls'] = toolEvents;

      // Persist agent reply
      let agentMsg: ChannelMsg | undefined;
      if (this.storage) {
        agentMsg = await this.storage.channelMessageRepo.append({
          orgId,
          channel,
          senderId: routedAgentId,
          senderType: 'agent',
          senderName: agent.config.name,
          text: cleanReply,
          mentions: [],
          metadata: Object.keys(metadata).length > 0 ? metadata as any : undefined,
        });
        void this.persistChatTurn(routedAgentId, text, reply, senderId);
      }

      // No WS broadcast here — the HTTP response delivers the agentMessage directly
      // to the requesting client. WS broadcast is only needed for group chat async replies.
      this.json(res, 200, {
        userMessage: enrichedUserMsg,
        agentMessage: agentMsg ?? {
          id: `tmp_${Date.now()}`,
          channel,
          senderId: routedAgentId,
          senderType: 'agent',
          senderName: agent.config.name,
          text: cleanReply,
          mentions: [],
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
          createdAt: new Date(),
        },
      });
      return;
    }

    // Agents
    if (path === '/api/agents' && req.method === 'GET') {
      let agents = this.orgService.getAgentManager().listAgents() as Array<Record<string, unknown>>;
      // Merge avatarUrl from storage
      if (this.storage) {
        const dbAgents = this.storage.agentRepo.listAll();
        const avatarMap = new Map(dbAgents.filter((a: any) => a.avatarUrl).map((a: any) => [a.id, a.avatarUrl]));
        if (avatarMap.size > 0) {
          agents = agents.map(a => {
            const av = avatarMap.get(a.id as string);
            return av ? { ...a, avatarUrl: av } : a;
          });
        }
      }
      if (this.gateway) {
        const extRegs = this.gateway.listRegistrations();
        const disconnectedIds = new Set(
          extRegs.filter(r => !r.connected && r.markusAgentId).map(r => r.markusAgentId!)
        );
        agents = agents.map(a =>
          disconnectedIds.has(a.id as string) ? { ...a, status: 'offline' } : a
        );
        this.json(res, 200, { agents });
      } else {
        this.json(res, 200, { agents });
      }
      return;
    }

    if (path === '/api/agents' && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const body = await this.readBody(req);
      const agentName = body['name'] as string;
      const roleName = body['roleName'] as string;
      if (!agentName?.trim()) {
        this.json(res, 400, { error: 'name is required' });
        return;
      }
      if (agentName.length > 100) {
        this.json(res, 400, { error: 'name must be 100 characters or fewer' });
        return;
      }
      const orgId = (body['orgId'] as string) ?? 'default';

      // Sanitize: strip HTML tags from name to prevent XSS
      const sanitizedName = stripHtmlTags(agentName);
      if (sanitizedName !== agentName) {
        log.warn('XSS sanitization applied to agent name', { original: agentName, sanitized: sanitizedName });
      }

      const agent = await this.orgService.hireAgent({
        name: sanitizedName,
        roleName: roleName?.trim() || undefined,
        orgId,
        teamId: body['teamId'] as string | undefined,
        skills: body['skills'] as string[] | undefined,
        agentRole: body['agentRole'] as 'manager' | 'worker' | undefined,
        tools: body['tools'] as AgentToolHandler[] | undefined,
      });
      this.auditService?.record({
        orgId,
        type: 'agent_hire',
        action: 'hire_agent',
        detail: `Agent "${agent.config.name}" hired`,
        userId: authUser?.userId,
        agentId: agent.id,
        success: true,
        metadata: { roleName: agent.role.name, teamId: body['teamId'] },
      });
      this.json(res, 201, {
        agent: {
          id: agent.id,
          name: agent.config.name,
          role: agent.role.name,
          agentRole: agent.config.agentRole,
          status: agent.getState().status,
          skills: agent.config.skills ?? [],
        },
      });
      return;
    }

    if (path.match(/^\/api\/agents\/[^/]+\/(start|stop|pause|resume|cancel-processing|daily-report|a2a|message)$/) && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const parts = path.split('/');
      const agentId = parts[3];
      const action = parts[4];

      if (action === 'start') {
        await this.orgService.getAgentManager().startAgent(agentId!);
        this.ws.broadcastAgentUpdate(agentId!, 'idle');
        this.json(res, 200, { status: 'started' });
        return;
      }
      if (action === 'stop') {
        await this.orgService.getAgentManager().stopAgent(agentId!);
        this.ws.broadcastAgentUpdate(agentId!, 'offline');
        this.json(res, 200, { status: 'stopped' });
        return;
      }
      if (action === 'pause') {
        // Unified: pause is now an alias for stop
        await this.orgService.getAgentManager().stopAgent(agentId!);
        this.ws.broadcastAgentUpdate(agentId!, 'offline');
        this.json(res, 200, { status: 'stopped' });
        return;
      }
      if (action === 'resume') {
        // Unified: resume is now an alias for start
        await this.orgService.getAgentManager().startAgent(agentId!);
        this.ws.broadcastAgentUpdate(agentId!, 'idle');
        this.json(res, 200, { status: 'started' });
        return;
      }
      if (action === 'cancel-processing') {
        const agent = this.orgService.getAgentManager().getAgent(agentId!);
        agent.cancelActiveStream();
        this.json(res, 200, { status: 'cancelled' });
        return;
      }
      if (action === 'daily-report') {
        const agent = this.orgService.getAgentManager().getAgent(agentId!);
        const report = await agent.generateDailyReport();
        this.json(res, 200, { agentId: agentId!, report });
        return;
      }
      if (action === 'a2a') {
        const body = await this.readBody(req);
        const fromAgentId = body['fromAgentId'] as string;
        const messageText = body['message'] as string;
        const targetAgent = this.orgService.getAgentManager().getAgent(agentId!);
        const fromAgent = this.orgService.getAgentManager().getAgent(fromAgentId);
        const reply = await targetAgent.sendMessage(messageText, fromAgentId, {
          name: fromAgent.config.name,
          role: fromAgent.config.agentRole ?? 'worker',
        }, { sourceType: 'a2a_message', waitForReply: true });
        this.json(res, 200, { from: fromAgentId, to: agentId, reply });
        return;
      }
      if (action === 'message') {
        const body = await this.readBody(req);
        const stream = body['stream'] as boolean | undefined;
        const senderId = authUser.userId;
        const sessionId = body['sessionId'] as string | undefined ?? undefined;
        const images = (body['images'] as string[] | undefined)?.filter(Boolean);
        const fileNames = (body['fileNames'] as string[] | undefined)?.filter(Boolean);
        const isRetry = body['isRetry'] as boolean | undefined;
        const isResume = body['isResume'] as boolean | undefined;
        const baseSenderInfo = this.orgService.resolveHumanIdentity(senderId);
        const isFirstConversation = this.storage
          ? !this.storage.chatSessionRepo.hasAnySessions(senderId)
          : false;
        const senderInfo = baseSenderInfo
          ? { ...baseSenderInfo, isFirstConversation }
          : undefined;
        const agent = this.orgService.getAgentManager().getAgent(agentId!);
        this.ws.broadcastAgentUpdate(agentId!, 'working');

        if (!sessionId) {
          agent.startNewSession();
        } else if (this.storage) {
          // Restore agent memory context from DB session history so the agent
          // has full conversation context when replying to an existing chat.
          try {
            if (isRetry) {
              this.storage.chatSessionRepo.deleteLastExchange(sessionId);
            }
            // Resume: keep the existing assistant message in DB and memory so
            // the LLM can see its previous partial response and continue.
            const histResult = await this.storage.chatSessionRepo.getMessages(sessionId, 200);
            agent.restoreSessionFromHistory(
              sessionId,
              histResult.messages.map((m: { role: string; content: string }) => ({ role: m.role, content: m.content })),
              { isRetry: !!isRetry },
            );
          } catch (err) {
            log.warn('Failed to restore session history, starting fresh', { sessionId, error: String(err) });
            agent.startNewSession();
          }
        }

        const userText = body['text'] as string;
        const inject = body['inject'] as boolean | undefined;

        if (inject) {
          if (this.storage && sessionId) {
            await this.persistUserMessage(agentId!, userText, senderId, images, sessionId);
          }
          agent.injectFollowUp(userText, senderId, senderInfo, images);
          this.json(res, 200, { injected: true });
          return;
        }

        // Wrap persistUserMessage to bind DB session → memory session on first message
        const bindingPersist = async (
          aId: string, text: string, sId?: string, imgs?: string[], sessId?: string,
        ): Promise<string | null> => {
          const dbSessId = await this.persistUserMessage(aId, text, sId, imgs, sessId);
          if (dbSessId && !sessId) {
            agent.bindDbSession(dbSessId);
          }
          return dbSessId;
        };

        if (stream) {
          const sseHandler = new SSEHandler({
            agentId: agentId!,
            agent,
            userText,
            images,
            fileNames,
            senderId,
            senderInfo,
            sessionId,
            wsBroadcaster: this.ws,
            persistUserMessage: bindingPersist,
            persistAssistantMessage: this.persistAssistantMessage.bind(this),
            executionStreamRepo: this.storage?.executionStreamRepo,
            isResume,
          });

          await sseHandler.handle(res);
        } else {
          const userMsgPersisted = await bindingPersist(agentId!, userText, senderId, images, sessionId);
          const toolEvents: Array<{ tool: string; status: 'done' | 'error'; arguments?: unknown; result?: string; durationMs?: number }> = [];
          let reply: string;
          try {
            reply = await agent.sendMessage(userText, senderId, senderInfo, { images, fileNames, toolEventCollector: toolEvents });
          } catch (err) {
            const errText = `⚠ AI service error: ${String(err).slice(0, 500)}`;
            void this.persistAssistantMessage(
              userMsgPersisted, agentId!, errText, 0, { isError: true },
            );
            throw err;
          }
          this.json(res, 200, { reply, sessionId: userMsgPersisted });
          const { thinking, clean: cleanReply } = extractThinkBlocks(reply);
          const segments: Array<Record<string, unknown>> = [];
          if (thinking.length > 0) segments.push({ type: 'text', content: '', thinking: thinking.join('\n\n') });
          for (const te of toolEvents) {
            segments.push({ type: 'tool', tool: te.tool, status: te.status, arguments: te.arguments, result: te.result, durationMs: te.durationMs });
          }
          if (segments.length > 0) segments.push({ type: 'text', content: cleanReply });
          const meta = segments.length > 0 ? { segments } : undefined;
          void this.persistAssistantMessage(
            userMsgPersisted,
            agentId!,
            reply,
            agent.getState().tokensUsedToday,
            meta
          );
        }

        const _st = agent.getState();
        this.ws.broadcastAgentUpdate(agentId!, _st.status, { lastError: _st.lastError, lastErrorAt: _st.lastErrorAt, currentActivity: _st.currentActivity });
        return;
      }
    }

    if (path.match(/^\/api\/agents\/[^/]+$/) && req.method === 'DELETE') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const agentId = path.split('/')[3]!;

      // Validate agent exists before deletion
      try {
        this.orgService.getAgentManager().getAgent(agentId);
      } catch {
        this.json(res, 404, { error: 'Agent not found' });
        return;
      }

      if (this.orgService.isProtectedAgent(agentId)) {
        this.json(res, 403, { error: 'The Secretary agent is a protected system agent and cannot be deleted.' });
        return;
      }
      const agentExists = this.orgService.getAgentManager().listAgents().some(a => a.id === agentId);
      if (!agentExists) {
        this.json(res, 404, { error: 'Agent not found' });
        return;
      }
      if (this.gateway) {
        const extReg = this.gateway.listRegistrations().find(r => r.markusAgentId === agentId);
        if (extReg) {
          await this.gateway.unregister(extReg.externalAgentId, extReg.orgId);
        }
      }
      const purgeFiles = url.searchParams.get('purgeFiles') === 'true';
      await this.orgService.fireAgent(agentId, { purgeFiles });
      this.auditService?.record({
        orgId: 'default',
        type: 'agent_fire',
        action: 'fire_agent',
        detail: `Agent ${agentId} removed`,
        userId: authUser?.userId,
        agentId,
        success: true,
        metadata: { purgeFiles },
      });
      this.json(res, 200, { deleted: true, purgedFiles: purgeFiles });
      return;
    }

    // ── Group Chats ──────────────────────────────────────────────────────────────
    if (path === '/api/group-chats' && req.method === 'GET') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const orgId = url.searchParams.get('orgId') ?? 'default';
      const userId = authUser.userId;
      const isAdmin = authUser.role === 'owner' || authUser.role === 'admin';
      const teams = this.orgService.listTeamsWithMembers(orgId);
      const teamChats = teams.map(t => ({
        id: `group:${t.id}`,
        name: t.name,
        type: 'team' as const,
        teamId: t.id,
        memberCount: t.members.length,
        channelKey: `group:${t.id}`,
      }));
      const customChats = this.storage?.groupChatRepo
        ? (isAdmin
            ? this.storage.groupChatRepo.list(orgId)
            : this.storage.groupChatRepo.listByMember(orgId, userId)
          ).map((c: any) => ({
            id: c.id,
            name: c.name,
            type: 'custom' as const,
            creatorId: c.creatorId,
            creatorName: c.creatorName,
            memberCount: c.memberCount,
            channelKey: c.channelKey,
          }))
        : [];
      this.json(res, 200, { chats: [...teamChats, ...customChats] });
      return;
    }

    if (path === '/api/group-chats' && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const body = await this.readBody(req);
      const name = body['name'] as string;
      const orgId = (body['orgId'] as string) ?? 'default';
      const creatorId = body['creatorId'] as string;
      const creatorName = body['creatorName'] as string;
      const memberIds = body['memberIds'] as string[] | undefined;
      const memberTypes = body['memberTypes'] as Record<string, string> | undefined;
      const memberNames = body['memberNames'] as Record<string, string> | undefined;
      if (!name) {
        this.json(res, 400, { error: 'name is required' });
        return;
      }
      if (!this.storage?.groupChatRepo) {
        this.json(res, 500, { error: 'Storage not initialized' });
        return;
      }
      const members = (memberIds ?? []).map(id => {
        const mType = (memberTypes?.[id] ?? 'agent') as 'human' | 'agent';
        let mName = memberNames?.[id] ?? id;
        if (mType === 'agent') {
          try { mName = this.orgService.getAgentManager().getAgent(id)?.config?.name ?? mName; } catch { /* */ }
        }
        return { id, type: mType, name: mName };
      });
      // Auto-add creator as a human member if not already included
      if (creatorId && !members.some(m => m.id === creatorId)) {
        members.unshift({ id: creatorId, type: 'human', name: creatorName ?? 'Unknown' });
      }
      const gc = this.storage.groupChatRepo.create({ orgId, name, creatorId, creatorName, members });
      this.ws?.broadcast({
        type: 'chat:group_created',
        payload: { chatId: gc.channelKey, name, creatorId, creatorName },
        timestamp: new Date().toISOString(),
      });
      this.json(res, 201, {
        chat: {
          id: gc.id, name: gc.name, type: 'custom', creatorId: gc.creatorId,
          creatorName: gc.creatorName, channelKey: gc.channelKey, memberCount: gc.members.length,
          members: gc.members.map((m: { memberId: string; memberName: string; memberType: string }) => ({ id: m.memberId, name: m.memberName, type: m.memberType })),
        },
      });
      return;
    }

    // GET /api/group-chats/:id — get group chat details
    if (path.match(/^\/api\/group-chats\/[^/]+$/) && req.method === 'GET') {
      const gcId = path.split('/').pop()!;
      if (!this.storage?.groupChatRepo) { this.json(res, 500, { error: 'Storage not initialized' }); return; }
      const gc = this.storage.groupChatRepo.getById(gcId);
      if (!gc) { this.json(res, 404, { error: 'Group chat not found' }); return; }
      this.json(res, 200, {
        chat: {
          id: gc.id, name: gc.name, type: 'custom', channelKey: gc.channelKey,
          creatorId: gc.creatorId, creatorName: gc.creatorName,
          members: gc.members.map((m: any) => ({ id: m.memberId, name: m.memberName, type: m.memberType })),
        },
      });
      return;
    }

    // PATCH /api/group-chats/:id — update group chat name
    if (path.match(/^\/api\/group-chats\/[^/]+$/) && req.method === 'PATCH') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const gcId = path.split('/').pop()!;
      if (!this.storage?.groupChatRepo) { this.json(res, 500, { error: 'Storage not initialized' }); return; }
      const body = await this.readBody(req);
      const newName = body['name'] as string;
      if (newName) this.storage.groupChatRepo.updateName(gcId, newName);
      this.json(res, 200, { ok: true });
      return;
    }

    // DELETE /api/group-chats/:id — delete group chat
    if (path.match(/^\/api\/group-chats\/[^/]+$/) && req.method === 'DELETE') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const gcId = path.split('/').pop()!;
      if (!this.storage?.groupChatRepo) { this.json(res, 500, { error: 'Storage not initialized' }); return; }
      this.storage.groupChatRepo.delete(gcId);
      this.ws?.broadcast({ type: 'chat:group_deleted', payload: { chatId: gcId }, timestamp: new Date().toISOString() });
      this.json(res, 200, { ok: true });
      return;
    }

    // POST /api/group-chats/:id/members — add member
    if (path.match(/^\/api\/group-chats\/[^/]+\/members$/) && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const gcId = path.split('/')[3]!;
      if (!this.storage?.groupChatRepo) { this.json(res, 500, { error: 'Storage not initialized' }); return; }
      const body = await this.readBody(req);
      const memberId = body['memberId'] as string;
      const memberType = (body['memberType'] as 'human' | 'agent') ?? 'agent';
      let memberName = body['memberName'] as string ?? memberId;
      if (memberType === 'agent') {
        try { memberName = this.orgService.getAgentManager().getAgent(memberId)?.config?.name ?? memberName; } catch { /* */ }
      }
      this.storage.groupChatRepo.addMember(gcId, memberId, memberType, memberName);
      this.ws?.broadcast({ type: 'chat:group_updated', payload: { chatId: gcId }, timestamp: new Date().toISOString() });
      this.json(res, 200, { ok: true });
      return;
    }

    // DELETE /api/group-chats/:id/members/:memberId — remove member
    if (path.match(/^\/api\/group-chats\/[^/]+\/members\/[^/]+$/) && req.method === 'DELETE') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const parts = path.split('/');
      const gcId = parts[3]!;
      const memberId = parts[5]!;
      if (!this.storage?.groupChatRepo) { this.json(res, 500, { error: 'Storage not initialized' }); return; }
      this.storage.groupChatRepo.removeMember(gcId, memberId);
      this.ws?.broadcast({ type: 'chat:group_updated', payload: { chatId: gcId }, timestamp: new Date().toISOString() });
      this.json(res, 200, { ok: true });
      return;
    }

    // Teams
    if (path === '/api/teams' && req.method === 'GET') {
      const orgId = url.searchParams.get('orgId') ?? 'default';
      const teams = this.orgService.listTeamsWithMembers(orgId);
      const ungrouped = this.orgService.listUngroupedMembers(orgId);
      const allMembers = [
        ...teams.flatMap(t => (t.members as unknown as Record<string, unknown>[])),
        ...(ungrouped as unknown as Record<string, unknown>[]),
      ];
      const agentIds = [...new Set(allMembers.filter(m => m.type === 'agent').map(m => m.id as string))];
      const userIds = [...new Set(allMembers.filter(m => m.type !== 'agent').map(m => m.id as string))];

      const avatarMap = new Map<string, string>();
      if (this.storage?.agentRepo) {
        for (const id of agentIds) {
          const a = this.storage.agentRepo.findById(id);
          if (a?.avatarUrl) avatarMap.set(id, a.avatarUrl);
        }
      }
      if (this.storage?.userRepo) {
        for (const id of userIds) {
          const u = this.storage.userRepo.findById(id);
          if (u?.avatarUrl) avatarMap.set(id, u.avatarUrl);
        }
      }

      const enrichMember = (m: Record<string, unknown>) => {
        const av = avatarMap.get(m.id as string);
        return av ? { ...m, avatarUrl: av } : m;
      };
      const enrichedTeams = teams.map(t => ({ ...t, members: (t.members as unknown as Record<string, unknown>[]).map(enrichMember) }));
      const enrichedUngrouped = (ungrouped as unknown as Record<string, unknown>[]).map(enrichMember);
      this.json(res, 200, { teams: enrichedTeams, ungrouped: enrichedUngrouped });
      return;
    }

    if (path === '/api/teams' && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (authUser.role !== 'owner' && authUser.role !== 'admin') {
        this.json(res, 403, { error: 'Insufficient permissions' });
        return;
      }
      const body = await this.readBody(req);
      const orgId = (body['orgId'] as string) ?? authUser.orgId ?? 'default';
      const name = body['name'] as string;
      if (!name) {
        this.json(res, 400, { error: 'name is required' });
        return;
      }
      // Feature gating: check team limit
      if (this.licenseService) {
        const limits = this.licenseService.getLimits();
        if (limits.maxTeams > 0) {
          const existingTeams = await this.orgService.listTeams(orgId);
          if (existingTeams.length >= limits.maxTeams) {
            this.json(res, 403, { error: `Team limit reached (${limits.maxTeams}). Upgrade to Enterprise for unlimited teams.` });
            return;
          }
        }
      }
      const team = await this.orgService.createTeam(
        orgId,
        name,
        body['description'] as string | undefined
      );
      // Notify Chat page so the new team appears as a group chat
      this.ws?.broadcast({
        type: 'chat:group_created',
        payload: {
          chatId: `group:${team.id}`,
          name: team.name,
          creatorId: authUser.userId,
          creatorName: '',
        },
        timestamp: new Date().toISOString(),
      });
      this.json(res, 201, { team });
      return;
    }

    if (path.match(/^\/api\/teams\/[^/]+$/) && req.method === 'PATCH') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (authUser.role !== 'owner' && authUser.role !== 'admin') {
        this.json(res, 403, { error: 'Insufficient permissions' });
        return;
      }
      const teamId = path.split('/')[3]!;
      const body = await this.readBody(req);
      const team = await this.orgService.updateTeam(teamId, {
        name: body['name'] as string | undefined,
        description: body['description'] as string | undefined,
        managerId: body['managerId'] as string | undefined,
        managerType: body['managerType'] as 'human' | 'agent' | undefined,
      });
      this.json(res, 200, { team });
      return;
    }

    if (path.match(/^\/api\/teams\/[^/]+$/) && req.method === 'DELETE') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (authUser.role !== 'owner' && authUser.role !== 'admin') {
        this.json(res, 403, { error: 'Insufficient permissions' });
        return;
      }
      const teamId = path.split('/')[3]!;
      const deleteMembers = url.searchParams.get('deleteMembers') === 'true';
      const purgeFiles = url.searchParams.get('purgeFiles') === 'true';
      await this.orgService.deleteTeam(teamId, deleteMembers, { purgeFiles });
      this.json(res, 200, { deleted: true, purgedFiles: purgeFiles });
      return;
    }

    if (path.match(/^\/api\/teams\/[^/]+\/members$/) && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (authUser.role !== 'owner' && authUser.role !== 'admin') {
        this.json(res, 403, { error: 'Insufficient permissions' });
        return;
      }
      const teamId = path.split('/')[3]!;
      const body = await this.readBody(req);
      const memberId = body['memberId'] as string;
      const memberType = body['memberType'] as 'human' | 'agent';
      if (!memberId || !memberType) {
        this.json(res, 400, { error: 'memberId and memberType are required' });
        return;
      }
      this.orgService.addMemberToTeam(teamId, memberId, memberType);
      this.ws.broadcastTeamUpdate(teamId, { action: 'member-added', memberId });
      this.json(res, 200, { ok: true });
      return;
    }

    if (path.match(/^\/api\/teams\/[^/]+\/members\/[^/]+$/) && req.method === 'DELETE') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (authUser.role !== 'owner' && authUser.role !== 'admin') {
        this.json(res, 403, { error: 'Insufficient permissions' });
        return;
      }
      const parts = path.split('/');
      const teamId = parts[3]!;
      const memberId = parts[5]!;
      this.orgService.removeMemberFromTeam(teamId, memberId);
      this.ws.broadcastTeamUpdate(teamId, { action: 'member-removed', memberId });
      this.json(res, 200, { ok: true });
      return;
    }

    // Team batch start
    if (path.match(/^\/api\/teams\/[^/]+\/start$/) && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (authUser.role !== 'owner' && authUser.role !== 'admin') {
        this.json(res, 403, { error: 'Insufficient permissions' });
        return;
      }
      const teamId = path.split('/')[3]!;
      try {
        const result = await this.orgService.startTeamAgents(teamId);
        this.json(res, 200, result);
      } catch (err) {
        this.json(res, 404, { error: String(err) });
      }
      return;
    }

    // Team batch stop
    if (path.match(/^\/api\/teams\/[^/]+\/stop$/) && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (authUser.role !== 'owner' && authUser.role !== 'admin') {
        this.json(res, 403, { error: 'Insufficient permissions' });
        return;
      }
      const teamId = path.split('/')[3]!;
      try {
        const result = await this.orgService.stopTeamAgents(teamId);
        this.json(res, 200, result);
      } catch (err) {
        this.json(res, 404, { error: String(err) });
      }
      return;
    }

    // Team batch pause (alias for stop)
    if (path.match(/^\/api\/teams\/[^/]+\/pause$/) && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (authUser.role !== 'owner' && authUser.role !== 'admin') {
        this.json(res, 403, { error: 'Insufficient permissions' });
        return;
      }
      const teamId = path.split('/')[3]!;
      try {
        const result = await this.orgService.stopTeamAgents(teamId);
        this.json(res, 200, result);
      } catch (err) {
        this.json(res, 404, { error: String(err) });
      }
      return;
    }

    // Team batch resume (alias for start)
    if (path.match(/^\/api\/teams\/[^/]+\/resume$/) && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (authUser.role !== 'owner' && authUser.role !== 'admin') {
        this.json(res, 403, { error: 'Insufficient permissions' });
        return;
      }
      const teamId = path.split('/')[3]!;
      try {
        const result = await this.orgService.startTeamAgents(teamId);
        this.json(res, 200, result);
      } catch (err) {
        this.json(res, 404, { error: String(err) });
      }
      return;
    }

    // Team agent status
    if (path.match(/^\/api\/teams\/[^/]+\/status$/) && req.method === 'GET') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const teamId = path.split('/')[3]!;
      const statuses = this.orgService.getTeamAgentStatuses(teamId);
      this.json(res, 200, { agents: statuses });
      return;
    }

    // Team files (announcements, norms, etc.)
    if (path.match(/^\/api\/teams\/[^/]+\/files$/) && req.method === 'GET') {
      const teamId = path.split('/')[3]!;
      const dir = this.orgService.getTeamDataDir(teamId);
      if (!existsSync(dir)) {
        this.json(res, 200, { files: [] });
        return;
      }
      const files = readdirSync(dir).filter(f => f.endsWith('.md'));
      this.json(res, 200, { files });
      return;
    }

    if (path.match(/^\/api\/teams\/[^/]+\/files\/[^/]+$/) && req.method === 'GET') {
      const parts = path.split('/');
      const teamId = parts[3]!;
      const filename = decodeURIComponent(parts[5]!);
      if (filename.includes('..') || filename.includes('/')) {
        this.json(res, 400, { error: 'Invalid filename' });
        return;
      }
      const filePath = join(this.orgService.getTeamDataDir(teamId), filename);
      if (!existsSync(filePath)) {
        this.json(res, 404, { error: 'File not found' });
        return;
      }
      const content = readFileSync(filePath, 'utf-8');
      this.json(res, 200, { filename, content });
      return;
    }

    if (path.match(/^\/api\/teams\/[^/]+\/files\/[^/]+$/) && req.method === 'PUT') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const parts = path.split('/');
      const teamId = parts[3]!;
      const filename = decodeURIComponent(parts[5]!);
      if (filename.includes('..') || filename.includes('/')) {
        this.json(res, 400, { error: 'Invalid filename' });
        return;
      }
      const body = await this.readBody(req);
      const content = body['content'] as string | undefined;
      const dir = this.orgService.getTeamDataDir(teamId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, filename), content ?? '', 'utf-8');
      this.json(res, 200, { ok: true });
      return;
    }

    // Roles
    if (path === '/api/roles' && req.method === 'GET') {
      const roleNames = this.orgService.listAvailableRoles();
      const roles = roleNames.map(name => {
        try {
          const details = this.orgService.getRoleDetails(name);
          return {
            id: name,
            name,
            description: details.description ?? '',
            category: details.category ?? 'custom',
          };
        } catch {
          return { id: name, name, description: '', category: 'custom' };
        }
      });
      this.json(res, 200, { roles });
      return;
    }

    if (path.startsWith('/api/roles/') && req.method === 'GET') {
      const roleName = path.split('/')[3]!;
      const role = this.orgService.getRoleDetails(roleName);
      this.json(res, 200, { role });
      return;
    }

    // Tasks
    if (await handleTasksRoutes(this, req, res, path, url)) return;
    if (path === '/api/deliverables' && req.method === 'GET') {
      if (!this.deliverableService) { this.json(res, 503, { error: 'Deliverable service not available' }); return; }
      const q = url.searchParams.get('q') ?? undefined;
      const projectId = url.searchParams.get('projectId') ?? undefined;
      const agentId = url.searchParams.get('agentId') ?? undefined;
      const taskId = url.searchParams.get('taskId') ?? undefined;
      const type = url.searchParams.get('type') as any ?? undefined;
      const status = url.searchParams.get('status') as any ?? undefined;
      const artifactType = url.searchParams.get('artifactType') as any ?? undefined;
      const offset = url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : undefined;
      const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined;
      const { results, total } = this.deliverableService.search({ query: q, projectId, agentId, taskId, type, status, artifactType, offset, limit });
      this.json(res, 200, { results, total });
      return;
    }

    if (path === '/api/deliverables/health' && req.method === 'GET') {
      if (!this.deliverableService) { this.json(res, 503, { error: 'Deliverable service not available' }); return; }
      const agentId = url.searchParams.get('agentId') ?? undefined;
      const missingIds = this.deliverableService.checkFileHealth(agentId);
      this.json(res, 200, { missingFiles: missingIds });
      return;
    }

    if (path === '/api/deliverables' && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (!this.deliverableService) { this.json(res, 503, { error: 'Deliverable service not available' }); return; }
      const body = await this.readBody(req);
      try {
        const d = await this.deliverableService.create({
          type: body['type'] as any,
          title: body['title'] as string,
          summary: body['summary'] as string,
          reference: body['reference'] as string,
          format: body['format'] as string | undefined,
          tags: body['tags'] as string[],
          taskId: body['taskId'] as string,
          agentId: body['agentId'] as string,
          projectId: body['projectId'] as string,
          requirementId: body['requirementId'] as string,
        });
        this.json(res, 201, { deliverable: d });
      } catch (err) {
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/deliverables\/[^/]+$/) && req.method === 'GET') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (!this.deliverableService) { this.json(res, 503, { error: 'Deliverable service not available' }); return; }
      const delivId = path.split('/')[3]!;
      try {
        const d = await this.deliverableService.get(delivId);
        if (!d) { this.json(res, 404, { error: 'Deliverable not found' }); return; }
        this.json(res, 200, { deliverable: d });
      } catch (err) {
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/deliverables\/[^/]+$/) && req.method === 'PUT') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (!this.deliverableService) { this.json(res, 503, { error: 'Deliverable service not available' }); return; }
      const delivId = path.split('/')[3]!;
      const body = await this.readBody(req);
      try {
        const d = await this.deliverableService.update(delivId, {
          title: body['title'] as string | undefined,
          summary: body['summary'] as string | undefined,
          reference: body['reference'] as string | undefined,
          format: body['format'] as string | undefined,
          tags: body['tags'] as string[] | undefined,
          status: body['status'] as any,
          type: body['type'] as any,
        });
        if (!d) { this.json(res, 404, { error: 'Deliverable not found' }); return; }
        this.json(res, 200, { deliverable: d });
      } catch (err) {
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/deliverables\/[^/]+$/) && req.method === 'DELETE') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (!this.deliverableService) { this.json(res, 503, { error: 'Deliverable service not available' }); return; }
      const delivId = path.split('/')[3]!;
      await this.deliverableService.remove(delivId);
      this.json(res, 200, { status: 'removed' });
      return;
    }

    if (await handleTasksRoutes(this, req, res, path, url)) return;

    // Organizations
    if (path === '/api/orgs' && req.method === 'GET') {
      const orgs = this.orgService.listOrganizations();
      this.json(res, 200, { orgs });
      return;
    }

    if (path === '/api/orgs' && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const body = await this.readBody(req);
      const org = await this.orgService.createOrganization(
        body['name'] as string,
        (body['ownerId'] as string) ?? authUser.userId
      );
      this.json(res, 201, { org });
      return;
    }

    // Team export — read all team directory files
    if (path.match(/^\/api\/teams\/[^/]+\/export$/) && req.method === 'GET') {
      const teamId = path.split('/')[3]!;
      try {
        const team = this.orgService.getTeam(teamId);
        if (!team) { this.json(res, 404, { error: 'Team not found' }); return; }
        const teamDataDir = this.orgService.getTeamDataDir(teamId);
        const files: Record<string, string> = {};
        if (teamDataDir && existsSync(teamDataDir)) {
          for (const fname of readdirSync(teamDataDir)) {
            const fpath = join(teamDataDir, fname);
            try {
              files[fname] = readFileSync(fpath, 'utf-8');
            } catch { /* skip */ }
          }
        }

        // Include member agent role files under members/{slug}/
        const agentManager = this.orgService.getAgentManager();
        const roleFileNames = ['ROLE.md', 'POLICIES.md', 'CONTEXT.md', 'HEARTBEAT.md'];
        for (const agentId of team.memberAgentIds ?? []) {
          try {
            const agent = agentManager.getAgent(agentId);
            const roleDir = this.resolveAgentRoleDir(agent);
            if (!roleDir) continue;
            const slug = kebab(agent.config.name, agentId);
            for (const fname of roleFileNames) {
              const fpath = join(roleDir, fname);
              if (existsSync(fpath)) {
                try { files[`members/${slug}/${fname}`] = readFileSync(fpath, 'utf-8'); } catch { /* skip */ }
              }
            }
          } catch { /* agent may not exist */ }
        }

        this.json(res, 200, { files, team: { id: team.id, name: team.name, description: team.description } });
      } catch {
        this.json(res, 404, { error: `Team not found: ${teamId}` });
      }
      return;
    }

    // Skill files — read all files from a skill directory
    if (path.match(/^\/api\/skills\/[^/]+\/files$/) && req.method === 'GET') {
      const skillName = decodeURIComponent(path.split('/')[3]!);
      const skillDir = join(homedir(), '.markus', 'skills', skillName);
      const files: Record<string, string> = {};
      if (existsSync(skillDir)) {
        for (const fname of readdirSync(skillDir)) {
          const fpath = join(skillDir, fname);
          try {
            files[fname] = readFileSync(fpath, 'utf-8');
          } catch { /* skip */ }
        }
      }
      if (Object.keys(files).length === 0) {
        this.json(res, 404, { error: `Skill not found: ${skillName}` });
      } else {
        this.json(res, 200, { files });
      }
      return;
    }

    // Agent mind state — current attention, focus, mailbox snapshot
    if (await handleAgentsDeepRoutes(this, req, res, path, url)) return;

    // ── Review Service ─────────────────────────────────────────────────────
    if (path === '/api/reviews' && req.method === 'POST') {
      if (!this.reviewService) {
        this.json(res, 503, { error: 'Review service not configured' });
        return;
      }
      const body = await this.readBody(req);
      const report = await this.reviewService.runReview({
        taskId: body['taskId'] as string | undefined,
        agentId: body['agentId'] as string | undefined,
        changedFiles: body['changedFiles'] as string[] | undefined,
        description: body['description'] as string | undefined,
      });
      this.json(res, 200, report);
      return;
    }

    if (path === '/api/reviews' && req.method === 'GET') {
      if (!this.reviewService) {
        this.json(res, 503, { error: 'Review service not configured' });
        return;
      }
      const taskId = url.searchParams.get('taskId');
      const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
      const reports = taskId
        ? this.reviewService.getReportsByTask(taskId)
        : this.reviewService.getRecentReports(limit);
      this.json(res, 200, { reports });
      return;
    }

    if (path.match(/^\/api\/reviews\/[^/]+$/) && req.method === 'GET') {
      if (!this.reviewService) {
        this.json(res, 503, { error: 'Review service not configured' });
        return;
      }
      const reviewId = path.split('/')[3]!;
      const report = this.reviewService.getReport(reviewId);
      if (!report) {
        this.json(res, 404, { error: 'Review not found' });
        return;
      }
      this.json(res, 200, report);
      return;
    }

    if (await handleGatewayRoutes(this, req, res, path, url)) return;

    // Human Users
    if (path === '/api/users' && req.method === 'GET') {
      const targetOrgId = url.searchParams.get('orgId') ?? 'default';
      let users = this.orgService.listHumanUsers(targetOrgId) as unknown as Array<Record<string, unknown>>;
      if (this.storage) {
        const dbUsers = await this.storage.userRepo.listByOrg(targetOrgId);
        const dbMap = new Map(dbUsers.map((u: any) => [u.id, u]));
        users = users.map(u => {
          const dbU = dbMap.get(u.id as string) as Record<string, unknown> | undefined;
          return {
            ...u,
            ...(dbU?.avatarUrl ? { avatarUrl: dbU.avatarUrl } : {}),
            hasJoined: !!dbU?.passwordHash,
          };
        });
      }
      this.json(res, 200, { users });
      return;
    }

    if (path === '/api/users' && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;

      // Feature gating: check multi-user limit
      if (this.licenseService && this.storage) {
        const limits = this.licenseService.getLimits();
        if (limits.maxUsers > 0) {
          const existingCount = this.storage.userRepo.countByOrg('default');
          if (existingCount >= limits.maxUsers) {
            this.json(res, 403, { error: `User limit reached (${limits.maxUsers}). Upgrade to Enterprise for multi-user support.` });
            return;
          }
        }
      }

      const body = await this.readBody(req);
      const orgId = (body['orgId'] as string) ?? 'default';
      const name = body['name'] as string;
      const role = (body['role'] as 'owner' | 'admin' | 'member' | 'guest') ?? 'member';
      const email = body['email'] as string | undefined;
      const password = body['password'] as string | undefined;
      const teamId = body['teamId'] as string | undefined;
      const userId = (body['id'] as string | undefined) ?? genUserId();

      // Always persist to DB for durability (not just when email/password provided)
      let inviteToken: string | undefined;
      let effectiveUserId = userId;
      if (this.storage) {
        if (password && !email) {
          this.json(res, 400, { error: 'Email is required when setting a password' });
          return;
        }

        // Check if a soft-deleted user with this email exists — reactivate instead of creating new
        const deletedUser = email ? this.storage.userRepo.findDeletedByEmail(email) : null;
        if (deletedUser) {
          effectiveUserId = deletedUser.id as string;
          this.storage.userRepo.reactivate(effectiveUserId, { name, role });
          if (password) {
            const hash = await hashPassword(password);
            await this.storage.userRepo.updatePassword(effectiveUserId, hash);
          } else {
            inviteToken = generateInviteToken();
            const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
            this.storage.userRepo.setInviteToken(effectiveUserId, inviteToken, expires);
          }
        } else {
          const passwordHash = password ? await hashPassword(password) : undefined;
          await this.storage.userRepo.create({
            id: effectiveUserId,
            orgId,
            name,
            email: email ?? undefined,
            role,
            passwordHash,
          });
          // Generate invite token for email-only users (no password set)
          if (email && !password) {
            inviteToken = generateInviteToken();
            const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
            this.storage.userRepo.setInviteToken(effectiveUserId, inviteToken, expires);
          }
        }
      }

      const user = this.orgService.addHumanUser(orgId, name, role, { id: effectiveUserId, email });

      // Add to team if specified
      let teamError: string | undefined;
      if (teamId) {
        try {
          this.orgService.addMemberToTeam(teamId, effectiveUserId, 'human');
        } catch (err) {
          teamError = String(err);
        }
      }

      this.auditService?.record({
        orgId,
        type: 'user_created',
        action: 'create_user',
        detail: `User "${name}" created`,
        userId: authUser.userId,
        success: true,
        metadata: { newUserId: effectiveUserId, role },
      });
      this.json(res, 201, { user, inviteToken, ...(teamError ? { teamError } : {}) });
      return;
    }

    if (path.match(/^\/api\/users\/[^/]+$/) && req.method === 'PATCH') {
      const authUser = await this.getAuthUser(req);
      const userId = path.split('/')[3]!;
      const body = await this.readBody(req);
      const updates: { name?: string; role?: string; email?: string } = {};
      if (body['name'] !== undefined) updates.name = body['name'] as string;
      if (body['role'] !== undefined) updates.role = body['role'] as string;
      if (body['email'] !== undefined) updates.email = body['email'] as string;
      try {
        const user = this.orgService.updateHumanUser(userId, updates as any);
        this.auditService?.record({
          orgId: user.orgId,
          type: 'user_updated',
          action: 'update_user',
          detail: `User "${user.name}" updated`,
          userId: authUser?.userId,
          success: true,
          metadata: { targetUserId: userId, updates },
        });
        this.json(res, 200, { user });
      } catch (err) {
        this.json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/users\/[^/]+\/reset-password$/) && req.method === 'POST') {
      const authUser = await this.getAuthUser(req);
      const userId = path.split('/')[3]!;
      const body = await this.readBody(req);
      const newPassword = body['password'] as string;
      if (!newPassword || newPassword.length < 6) {
        this.json(res, 400, { error: 'Password must be at least 6 characters' });
        return;
      }
      if (!this.storage) {
        this.json(res, 500, { error: 'Storage not available' });
        return;
      }
      try {
        const hash = await hashPassword(newPassword);
        await this.storage.userRepo.updatePassword(userId, hash);
        this.auditService?.record({
          orgId: 'default',
          type: 'user_updated',
          action: 'reset_password',
          detail: `Password reset for user ${userId}`,
          userId: authUser?.userId,
          success: true,
          metadata: { targetUserId: userId },
        });
        this.json(res, 200, { ok: true });
      } catch (err) {
        this.json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/users\/[^/]+\/reinvite$/) && req.method === 'POST') {
      if (!this.storage) {
        this.json(res, 503, { error: 'Storage not available' });
        return;
      }
      const userId = path.split('/')[3]!;
      const userRow = this.storage.userRepo.findById(userId);
      if (!userRow) {
        this.json(res, 404, { error: 'User not found' });
        return;
      }
      if (!userRow.email) {
        this.json(res, 400, { error: 'User has no email address' });
        return;
      }
      const inviteToken = generateInviteToken();
      const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
      this.storage.userRepo.setInviteToken(userId, inviteToken, expires);
      this.json(res, 200, { inviteToken });
      return;
    }

    if (path.startsWith('/api/users/') && req.method === 'DELETE') {
      const authUser = await this.getAuthUser(req);
      const userId = path.split('/')[3]!;
      this.orgService.removeHumanUser(userId);
      this.auditService?.record({
        orgId: 'default',
        type: 'user_deleted',
        action: 'delete_user',
        detail: `User ${userId} removed`,
        userId: authUser?.userId,
        success: true,
        metadata: { deletedUserId: userId },
      });
      this.json(res, 200, { deleted: true });
      return;
    }

    // Message routing — route to the right agent
    if (path === '/api/message' && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const body = await this.readBody(req);
      const targetOrgId = (body['orgId'] as string) ?? 'default';
      const targetAgentId = this.orgService.routeMessage(targetOrgId, {
        targetAgentId: body['targetAgentId'] as string | undefined,
        channelId: body['channelId'] as string | undefined,
        text: body['text'] as string | undefined,
      });

      if (!targetAgentId) {
        this.json(res, 404, { error: 'No agent available to handle the message' });
        return;
      }

      const senderId = authUser.userId;
      const images = (body['images'] as string[] | undefined)?.filter(Boolean);
      const senderInfo = this.orgService.resolveHumanIdentity(senderId);
      const agent = this.orgService.getAgentManager().getAgent(targetAgentId);
      this.ws.broadcastAgentUpdate(targetAgentId, 'working');

      const stream = body['stream'] as boolean | undefined;
      if (stream) {
        const userText = body['text'] as string;

        const sseHandler = new SSEHandler({
          agentId: targetAgentId,
          agent,
          userText,
          images,
          senderId,
          senderInfo,
          executionStreamRepo: this.storage?.executionStreamRepo,
          onComplete: async (reply, segments, tokensUsed) => {
            const meta = segments.length > 0 ? { segments } : undefined;
            void this.persistChatTurn(targetAgentId, userText, reply, senderId, tokensUsed, meta);
          },
        });

        await sseHandler.handle(res);
      } else {
        const userText = body['text'] as string;
        const toolEvents: Array<{ tool: string; status: 'done' | 'error'; arguments?: unknown; result?: string; durationMs?: number }> = [];
        let reply: string;
        try {
          reply = await agent.sendMessage(userText, senderId, senderInfo, { images, toolEventCollector: toolEvents });
        } catch (err) {
          throw err;
        }
        this.json(res, 200, { reply, agentId: targetAgentId });
        const { thinking, clean: cleanReply } = extractThinkBlocks(reply);
        const segments: Array<Record<string, unknown>> = [];
        if (thinking.length > 0) segments.push({ type: 'text', content: '', thinking: thinking.join('\n\n') });
        for (const te of toolEvents) {
          segments.push({ type: 'tool', tool: te.tool, status: te.status, arguments: te.arguments, result: te.result, durationMs: te.durationMs });
        }
        if (segments.length > 0) segments.push({ type: 'text', content: cleanReply });
        const meta = segments.length > 0 ? { segments } : undefined;
        void this.persistChatTurn(targetAgentId, userText, reply, senderId, agent.getState().tokensUsedToday, meta);
      }
      const _st2 = agent.getState();
      this.ws.broadcastAgentUpdate(targetAgentId, _st2.status, { lastError: _st2.lastError, lastErrorAt: _st2.lastErrorAt, currentActivity: _st2.currentActivity });
      return;
    }

    // Skills
    if (await handleSkillsRoutes(this, req, res, path, url)) return;

    // Agent Templates
    if (path === '/api/templates' && req.method === 'GET') {
      if (!this.templateRegistry) {
        this.json(res, 200, { templates: [] });
        return;
      }
      const source = url.searchParams.get('source') as
        | 'official'
        | 'community'
        | 'custom'
        | undefined;
      const category = url.searchParams.get('category') ?? undefined;
      const text = url.searchParams.get('q') ?? undefined;
      const result =
        source || category || text
          ? this.templateRegistry.search({ source: source ?? undefined, category, text })
          : { templates: this.templateRegistry.list(), total: this.templateRegistry.list().length };
      this.json(res, 200, result);
      return;
    }

    if (path.match(/^\/api\/templates\/[^/]+$/) && path !== '/api/templates/teams' && req.method === 'GET') {
      if (!this.templateRegistry) {
        this.json(res, 404, { error: 'Template registry not configured' });
        return;
      }
      const templateId = path.split('/')[3]!;
      const template = this.templateRegistry.get(templateId);
      if (!template) {
        this.json(res, 404, { error: `Template not found: ${templateId}` });
        return;
      }
      this.json(res, 200, { template });
      return;
    }

    if (path.match(/^\/api\/templates\/[^/]+\/files$/) && req.method === 'GET') {
      if (!this.templateRegistry) {
        this.json(res, 404, { error: 'Template registry not configured' });
        return;
      }
      const templateId = path.split('/')[3]!;
      const template = this.templateRegistry.get(templateId);
      if (!template) {
        this.json(res, 404, { error: `Template not found: ${templateId}` });
        return;
      }
      const { existsSync: ex, readFileSync: rf, readdirSync: rd } = await import('node:fs');
      const roleId = template.roleId;
      const envTemplates = process.env['MARKUS_TEMPLATES_DIR'];
      const candidates = envTemplates
        ? [resolve(envTemplates, 'roles', roleId)]
        : [resolve(process.cwd(), 'templates', 'roles', roleId)];
      if (!envTemplates) {
        try {
          const thisFile = (await import('node:url')).fileURLToPath(import.meta.url);
          const thisDir = (await import('node:path')).dirname(thisFile);
          candidates.unshift(resolve(thisDir, '..', 'templates', 'roles', roleId));
          candidates.push(resolve(thisDir, '..', '..', '..', '..', 'templates', 'roles', roleId));
        } catch { /* skip */ }
      }
      const roleDir = candidates.find(d => ex(d));
      const files: Record<string, string> = {};
      if (roleDir) {
        try {
          for (const entry of rd(roleDir, { withFileTypes: true })) {
            if (entry.isFile() && !entry.name.endsWith('.json')) {
              try { files[entry.name] = rf(resolve(roleDir, entry.name), 'utf-8'); } catch { /* skip */ }
            }
          }
        } catch { /* skip */ }
      }
      this.json(res, 200, { files });
      return;
    }

    if (path === '/api/templates/instantiate' && req.method === 'POST') {
      const body = await this.readBody(req);
      const templateId = body['templateId'] as string;
      const name = body['name'] as string;
      const orgId = (body['orgId'] as string) ?? 'default';
      const teamId = body['teamId'] as string | undefined;
      const agentRole = body['agentRole'] as 'manager' | 'worker' | undefined;
      if (!templateId || !name) {
        this.json(res, 400, { error: 'templateId and name are required' });
        return;
      }
      try {
        const agentManager = this.orgService.getAgentManager();

        const agent = await agentManager.createAgentFromTemplate({
              templateId,
              name,
              orgId,
              teamId,
              overrides: body['overrides'] as Record<string, unknown> | undefined,
            });
        if (agentRole) agent.config.agentRole = agentRole;
        if (teamId) {
          this.orgService.addMemberToTeam(teamId, agent.id, 'agent');
        }

        // Persist to DB so agents survive restarts
        if (this.storage) {
          try {
            await this.storage.agentRepo.create({
              id: agent.id,
              name: agent.config.name,
              orgId,
              teamId,
              roleId: agent.config.roleId,
              roleName: agent.role.name,
              agentRole: agent.config.agentRole ?? 'worker',
              skills: agent.config.skills,
              llmConfig: agent.config.llmConfig,
              heartbeatIntervalMs: agent.config.heartbeatIntervalMs,
            });
          } catch (persistErr) {
            log.warn('Failed to persist instantiated agent to DB', { error: String(persistErr) });
          }
        }

        await agentManager.startAgent(agent.id);
        this.json(res, 201, {
          agent: {
            id: agent.id,
            name: agent.config.name,
            role: agent.role.name,
            agentRole: agent.config.agentRole,
            status: agent.getState().status,
          },
        });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    // ── External Agents ─────────────────────────────────────────────────────
    if (path === '/api/external-agents' && req.method === 'GET') {
      if (!this.gateway) {
        this.json(res, 200, { agents: [] });
        return;
      }
      const orgId = url.searchParams.get('orgId') ?? 'default';
      this.json(res, 200, { agents: this.gateway.listRegistrations(orgId) });
      return;
    }

    if (path === '/api/external-agents/register' && req.method === 'POST') {
      if (!this.gateway) {
        this.json(res, 503, { error: 'External agent gateway not configured' });
        return;
      }
      const body = await this.readBody(req);
      try {
        const orgId = (body['orgId'] as string) ?? 'default';
        const reg = await this.gateway.register({
          externalAgentId: body['externalAgentId'] as string,
          agentName: body['agentName'] as string,
          orgId,
          capabilities: body['capabilities'] as string[] | undefined,
          platform: body['platform'] as string | undefined,
          platformConfig: body['platformConfig'] as string | undefined,
          agentCardUrl: body['agentCardUrl'] as string | undefined,
          openClawConfig: body['openClawConfig'] as string | undefined,
        });
        // Generate a token for the UI without marking the agent as connected.
        // authenticate() sets connected=true as a side effect, so we reset it
        // immediately — the agent should only appear online when it actually syncs.
        let token: string | undefined;
        if (reg.markusAgentId && this.gatewaySecret) {
          try {
            const authResult = this.gateway.authenticate({
              externalAgentId: reg.externalAgentId,
              orgId,
              secret: this.gatewaySecret,
            });
            token = authResult.token;
            reg.connected = false;
            reg.lastHeartbeat = undefined;
            this.gateway.resetConnectionStatus(reg.externalAgentId, orgId);
          } catch { /* auth may fail if secret isn't set; token stays undefined */ }
        }
        const host = req.headers['host'] ?? `localhost:${this.port}`;
        const proto = req.headers['x-forwarded-proto'] ?? 'http';
        const gatewayUrl = `${proto}://${host}/api/gateway`;
        this.json(res, 201, { registration: reg, token, gatewayUrl });
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode ?? 400;
        this.json(res, code, { error: String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/external-agents\/[^/]+$/) && req.method === 'DELETE') {
      if (!this.gateway) {
        this.json(res, 503, { error: 'External agent gateway not configured' });
        return;
      }
      const externalId = path.split('/')[3]!;
      const orgId = url.searchParams.get('orgId') ?? 'default';
      const reg = await this.gateway.unregister(externalId, orgId);
      if (reg?.markusAgentId) {
        try { await this.orgService.fireAgent(reg.markusAgentId); } catch { /* already gone */ }
      }
      this.json(res, reg ? 200 : 404, reg ? { deleted: true } : { error: 'Not found' });
      return;
    }

    // HITL: Approvals
    if (path === '/api/approvals' && req.method === 'GET') {
      const authUser = this.authEnabled
        ? await this.requireAuth(req, res)
        : await this.getAuthUser(req);
      if (!authUser) return;
      const status = url.searchParams.get('status') as
        | 'pending'
        | 'approved'
        | 'rejected'
        | undefined;
      let approvals = this.hitlService?.listApprovals(status ?? undefined) ?? [];
      const isPrivileged = authUser.role === 'owner' || authUser.role === 'admin';
      if (!isPrivileged) {
        approvals = approvals.filter(a => {
          if (a.approverUserIds?.length) {
            return a.approverUserIds.includes(authUser.userId);
          }
          if (a.targetUserId && a.targetUserId !== 'all') {
            return a.targetUserId === authUser.userId;
          }
          return true;
        });
      }
      this.json(res, 200, { approvals });
      return;
    }

    if (path === '/api/approvals' && req.method === 'POST') {
      if (!this.hitlService) {
        this.json(res, 503, { error: 'HITL service not available' });
        return;
      }
      const body = await this.readBody(req);
      const rawApprovers = body['approverUserIds'];
      const approverUserIds = Array.isArray(rawApprovers)
        ? rawApprovers.map((x: unknown) => String(x))
        : undefined;
      const approval = this.hitlService.requestApproval({
        agentId: body['agentId'] as string,
        agentName: (body['agentName'] as string) ?? 'Agent',
        type: (body['type'] as 'action' | 'custom') ?? 'custom',
        title: body['title'] as string,
        description: body['description'] as string,
        details: body['details'] as Record<string, unknown>,
        targetUserId: body['targetUserId'] as string,
        approverUserIds,
      });
      this.json(res, 201, { approval });
      return;
    }

    if (path.startsWith('/api/approvals/') && req.method === 'POST') {
      if (!this.hitlService) {
        this.json(res, 503, { error: 'HITL service not available' });
        return;
      }
      const authUser = this.authEnabled
        ? await this.requireAuth(req, res)
        : await this.getAuthUser(req);
      if (!authUser) return;
      const approvalId = path.split('/')[3]!;
      const pending = this.hitlService.getApproval(approvalId);
      if (!pending || pending.status !== 'pending') {
        this.json(res, 404, { error: 'Approval not found or not pending' });
        return;
      }
      const isPrivileged = authUser.role === 'owner' || authUser.role === 'admin';
      const approvers = pending.approverUserIds;
      const canRespond =
        isPrivileged ||
        !approvers ||
        approvers.length === 0 ||
        approvers.includes(authUser.userId);
      if (!canRespond) {
        this.json(res, 403, { error: 'Not authorized to respond to this approval' });
        return;
      }
      const body = await this.readBody(req);
      const approved = body['approved'] as boolean;
      const respondedBy = this.authEnabled
        ? authUser.userId
        : (body['respondedBy'] as string) ?? authUser.userId ?? 'anonymous';
      const comment = body['comment'] as string | undefined;
      const selectedOption = body['selectedOption'] as string | undefined;
      const result = this.hitlService.respondToApproval(
        approvalId, approved, respondedBy, comment, selectedOption,
      );
      if (!result) {
        this.json(res, 404, { error: 'Approval not found or not pending' });
        return;
      }

      // Directly transition task/requirement as fallback.
      // The in-memory promise callback from requestApprovalAndWait is lost on
      // server restart, so we must also drive the state change from here.
      const details = result.details as Record<string, unknown> | undefined;
      const taskId = details?.['taskId'] as string | undefined;
      const requirementId = details?.['requirementId'] as string | undefined;
      if (taskId) {
        try {
          if (approved) {
            this.taskService.approveTask(taskId, respondedBy);
          } else {
            this.taskService.rejectTask(taskId, respondedBy);
          }
        } catch { /* already transitioned by in-memory promise callback */ }
      }
      if (requirementId && this.requirementService) {
        try {
          if (approved) {
            this.requirementService.approveRequirement(requirementId, respondedBy);
          } else {
            this.requirementService.rejectRequirement(requirementId, respondedBy, comment || 'Rejected via approval');
          }
        } catch { /* already transitioned by in-memory promise callback */ }
      }

      this.auditService?.record({
        orgId: 'default',
        userId: respondedBy,
        agentId: result.agentId,
        type: 'approval_response',
        action: approved ? 'approve' : 'reject',
        detail: result.title,
        success: approved,
        metadata: { approvalId, taskId, requirementId, comment, selectedOption },
      });

      this.json(res, 200, { approval: result });
      return;
    }

    // Notifications
    if (path === '/api/notifications' && req.method === 'GET') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const userId = authUser.userId;
      const unread = url.searchParams.get('unread') === 'true';
      const type = url.searchParams.get('type') ?? undefined;
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
      const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
      const notifications = this.hitlService?.listNotifications(userId, unread, { type, limit, offset }) ?? [];
      const counts = this.hitlService?.countNotifications(userId) ?? { total: 0, unread: 0 };
      this.json(res, 200, {
        notifications,
        totalCount: counts.total,
        unreadCount: counts.unread,
      });
      return;
    }

    if (path === '/api/notifications/mark-all-read' && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const userId = authUser.userId;
      const count = this.hitlService?.markAllNotificationsRead(userId) ?? 0;
      this.json(res, 200, { success: true, count });
      return;
    }

    if (path.startsWith('/api/notifications/') && path.endsWith('/read') && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const notifId = path.split('/')[3]!;
      const read = this.hitlService?.markNotificationRead(notifId);
      this.json(res, 200, { success: read ?? false });
      return;
    }

    if (path.startsWith('/api/notifications/') && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const notifId = path.split('/')[3]!;
      const read = this.hitlService?.markNotificationRead(notifId);
      this.json(res, 200, { success: read ?? false });
      return;
    }

    // ── Unread message tracking ──────────────────────────────────────────────
    if (path === '/api/unread' && req.method === 'GET') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const repo = this.storage?.readCursorRepo;
      if (!repo) { this.json(res, 200, { counts: {}, sessionAgentMap: {} }); return; }
      const counts = repo.getUnreadCounts(authUser.userId);
      const sessionAgentMap = repo.getSessionAgentMap();
      this.json(res, 200, { counts, sessionAgentMap });
      return;
    }

    if (path === '/api/unread/mark-read' && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const body = await this.readBody(req);
      const { conversationKey, lastReadAt, lastReadId } = body as { conversationKey: string; lastReadAt: string; lastReadId?: string };
      if (!conversationKey || !lastReadAt) { this.json(res, 400, { error: 'conversationKey and lastReadAt required' }); return; }
      const repo = this.storage?.readCursorRepo;
      if (!repo) { this.json(res, 200, { success: true }); return; }
      repo.setReadCursor(authUser.userId, conversationKey, lastReadAt, lastReadId);
      this.json(res, 200, { success: true });
      return;
    }

    if (path === '/api/unread/mark-all-read' && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const repo = this.storage?.readCursorRepo;
      if (!repo) { this.json(res, 200, { success: true }); return; }
      repo.markAllRead(authUser.userId);
      this.json(res, 200, { success: true });
      return;
    }

    // ─── Message search ──────────────────────────────────────────────────────────
    if (path === '/api/messages/search' && req.method === 'GET') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const query = url.searchParams.get('q')?.trim();
      if (!query || query.length < 2) {
        this.json(res, 400, { error: 'Query must be at least 2 characters' });
        return;
      }
      const channel = url.searchParams.get('channel') ?? undefined;
      const scope = url.searchParams.get('scope') ?? 'all';
      const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '30', 10), 100);
      const results: { source: string; id: string; text: string; senderName?: string; channel?: string; sessionId?: string; agentId?: string; createdAt: string }[] = [];

      if ((scope === 'all' || scope === 'channel') && this.storage?.channelMessageRepo) {
        const channelResults = this.storage.channelMessageRepo.searchMessages(query, channel, limit);
        for (const r of channelResults) {
          results.push({
            source: 'channel',
            id: r.id,
            text: r.text,
            senderName: r.senderName,
            channel: r.channel,
            createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
          });
        }
      }
      if ((scope === 'all' || scope === 'direct') && this.storage?.chatSessionRepo) {
        const sessionResults = this.storage.chatSessionRepo.searchMessages(query, limit);
        for (const r of sessionResults) {
          results.push({
            source: 'direct',
            id: r.id as string,
            text: r.content as string,
            sessionId: r.sessionId as string,
            agentId: r.sessionAgentId,
            createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
          });
        }
      }
      results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      this.json(res, 200, { results: results.slice(0, limit) });
      return;
    }

    // Unified activity feed — merges notifications, task comments, and deliverables
    if (path === '/api/activity' && req.method === 'GET') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const userId = authUser.userId;
      const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);
      const typeFilter = url.searchParams.get('type') ?? undefined;

      interface ActivityItem {
        id: string;
        type: string;
        title: string;
        body: string;
        timestamp: string;
        source: 'notification' | 'task_comment' | 'deliverable';
        metadata?: Record<string, unknown>;
      }

      const items: ActivityItem[] = [];

      // 1. Notifications
      if (!typeFilter || typeFilter === 'notification') {
        const notifications = this.hitlService?.listNotifications(userId, false, { limit }) ?? [];
        for (const n of notifications) {
          items.push({
            id: n.id,
            type: n.type,
            title: n.title,
            body: n.body,
            timestamp: n.createdAt,
            source: 'notification',
            metadata: n.metadata as Record<string, unknown> | undefined,
          });
        }
      }

      // 2. Recent task comments
      if ((!typeFilter || typeFilter === 'task_comment') && this.storage?.taskCommentRepo) {
        try {
          const recentComments = this.storage.taskCommentRepo.listRecent?.(limit) ?? [];
          for (const c of recentComments) {
            items.push({
              id: c.id,
              type: 'task_comment',
              title: `Comment on task ${c.taskId}`,
              body: typeof c.body === 'string' ? c.body.slice(0, 300) : String(c.body ?? ''),
              timestamp: c.createdAt,
              source: 'task_comment',
              metadata: { taskId: c.taskId, authorId: c.authorId, authorName: c.authorName },
            });
          }
        } catch { /* listRecent may not exist yet */ }
      }

      // Filter out items belonging to archived tasks
      const filtered = items.filter(item => {
        const taskId = (item.metadata as Record<string, unknown> | undefined)?.taskId as string | undefined;
        if (!taskId) return true;
        const task = this.taskService.getTask(taskId);
        return !task || task.status !== 'archived';
      });

      // Sort by timestamp descending, limit
      filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      const page = filtered.slice(0, limit);

      this.json(res, 200, { items: page, totalCount: filtered.length });
      return;
    }

    // Billing: Usage — computed from persisted agent metrics for restart-safety
    if (path === '/api/usage' && req.method === 'GET') {
      const orgId = url.searchParams.get('orgId') ?? 'default';
      const plan = this.billingService?.getOrgPlan(orgId);

      const agentManager = this.orgService.getAgentManager();
      const allAgents = agentManager.listAgents();
      let llmTokens = 0;
      let toolCalls = 0;
      let messages = 0;

      for (const a of allAgents) {
        try {
          const agent = agentManager.getAgent(a.id);
          const stats = agent.getUsageStats();
          llmTokens += stats.totalTokens;
          toolCalls += stats.toolCallsToday;
          messages += stats.requestsToday;
        } catch { /* agent not loaded */ }
      }

      this.json(res, 200, {
        usage: {
          orgId,
          period: new Date().toISOString().slice(0, 7),
          llmTokens,
          toolCalls,
          messages,
          storageBytes: this.billingService?.getUsageSummary(orgId)?.storageBytes ?? 0,
        },
        plan,
      });
      return;
    }

    // Billing: Per-agent usage — computed from persisted agent metrics
    if (path === '/api/usage/agents' && req.method === 'GET') {
      const agentManager = this.orgService.getAgentManager();
      const agentList = agentManager.listAgents();

      const agentUsage = agentList.map(a => {
        try {
          const agent = agentManager.getAgent(a.id);
          const stats = agent.getUsageStats();
          return {
            agentId: a.id,
            agentName: a.name,
            role: a.role,
            status: a.status,
            tokensUsedToday: stats.tokensToday,
            totalTokens: stats.totalTokens,
            promptTokens: stats.promptTokens,
            completionTokens: stats.completionTokens,
            requestCount: stats.requestCount,
            toolCalls: stats.toolCalls,
            messages: stats.requestsToday,
            estimatedCost: stats.estimatedCost,
            costToday: stats.costToday,
            cuUsed: stats.cuUsed,
            cuUsedToday: stats.cuUsedToday,
          };
        } catch {
          return {
            agentId: a.id,
            agentName: a.name,
            role: a.role,
            status: a.status,
            tokensUsedToday: 0,
            totalTokens: 0,
            promptTokens: 0,
            completionTokens: 0,
            requestCount: 0,
            toolCalls: 0,
            messages: 0,
            estimatedCost: 0,
            costToday: 0,
            cuUsed: 0,
            cuUsedToday: 0,
          };
        }
      });

      this.json(res, 200, { agents: agentUsage });
      return;
    }

    // Billing: API Keys
    if (path === '/api/keys' && req.method === 'GET') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const orgId = url.searchParams.get('orgId') ?? 'default';
      this.json(res, 200, { keys: this.billingService?.listAPIKeys(orgId) ?? [] });
      return;
    }

    if (path === '/api/keys' && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (!this.billingService) {
        this.json(res, 503, { error: 'Billing service not available' });
        return;
      }
      const body = await this.readBody(req);
      const key = this.billingService.createAPIKey(
        (body['orgId'] as string) ?? 'default',
        (body['name'] as string) ?? 'Default Key',
        body['scopes'] as string[],
        body['expiresInDays'] as number | undefined
      );
      this.json(res, 201, { key });
      return;
    }

    if (path.startsWith('/api/keys/') && req.method === 'DELETE') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const keyId = path.split('/')[3]!;
      const revoked = this.billingService?.revokeAPIKey(keyId);
      this.json(res, 200, { revoked: revoked ?? false });
      return;
    }

    // Billing: Plan
    if (path === '/api/plan' && req.method === 'GET') {
      const orgId = url.searchParams.get('orgId') ?? 'default';
      this.json(res, 200, { plan: this.billingService?.getOrgPlan(orgId) });
      return;
    }

    if (path === '/api/plan' && req.method === 'POST') {
      if (!this.billingService) {
        this.json(res, 503, { error: 'Billing service not available' });
        return;
      }
      const body = await this.readBody(req);
      const plan = this.billingService.setOrgPlan(
        (body['orgId'] as string) ?? 'default',
        (body['tier'] as 'free' | 'enterprise') ?? 'free'
      );
      this.json(res, 200, { plan });
      return;
    }

    // Team Templates
    if (path === '/api/templates/teams' && req.method === 'GET') {
      try {
        const { readdirSync, readFileSync, existsSync: _exists } = await import('node:fs');
        const { resolve, join: _join } = await import('node:path');
        const teamsDir = resolve(process.env['MARKUS_TEMPLATES_DIR'] ?? resolve(process.cwd(), 'templates'), 'teams');
        const entries = readdirSync(teamsDir, { withFileTypes: true });
        const teams: unknown[] = [];
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const teamFile = _join(teamsDir, entry.name, 'team.json');
            if (_exists(teamFile)) {
              try { teams.push(JSON.parse(readFileSync(teamFile, 'utf-8'))); } catch { /* skip */ }
            }
          } else if (entry.name.endsWith('.json')) {
            try { teams.push(JSON.parse(readFileSync(resolve(teamsDir, entry.name), 'utf-8'))); } catch { /* skip */ }
          }
        }
        this.json(res, 200, { templates: teams });
      } catch {
        this.json(res, 200, { templates: [] });
      }
      return;
    }

    // Audit log
    if (path === '/api/audit' && req.method === 'GET') {
      if (!this.auditService) {
        this.json(res, 200, { entries: [] });
        return;
      }
      const entries = this.auditService.query({
        orgId: url.searchParams.get('orgId') ?? 'default',
        agentId: url.searchParams.get('agentId') ?? undefined,
        type: (url.searchParams.get('type') as AuditEventType) ?? undefined,
        limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50,
        since: url.searchParams.get('since') ?? undefined,
      });
      this.json(res, 200, { entries });
      return;
    }

    if (path === '/api/audit/summary' && req.method === 'GET') {
      if (!this.auditService) {
        this.json(res, 200, { summary: null });
        return;
      }
      const orgId = url.searchParams.get('orgId') ?? 'default';
      const summary = this.auditService.summary(orgId);
      this.json(res, 200, { summary });
      return;
    }

    if (path === '/api/audit/tokens' && req.method === 'GET') {
      if (!this.auditService) {
        this.json(res, 200, { usage: [] });
        return;
      }
      const usage = this.auditService.getTokenUsage(
        url.searchParams.get('orgId') ?? undefined,
        url.searchParams.get('agentId') ?? undefined
      );
      this.json(res, 200, { usage });
      return;
    }

    // ── License Management ────────────────────────────────────────────────────
    if (path === '/api/license' && req.method === 'GET') {
      const raw = this.licenseService
        ? this.licenseService.getInfo()
        : { plan: 'free', features: [], limits: { maxTeams: 5, maxToolCallsPerDay: 5000, maxUsers: 1 } };
      this.json(res, 200, await this.buildLicenseResponse(raw, req));
      return;
    }

    if (path === '/api/license/refresh' && req.method === 'POST') {
      if (!this.licenseService) {
        this.json(res, 503, { error: 'License service not available' });
        return;
      }
      const raw = await this.licenseService.revalidate();
      if (this.billingService) this.billingService.setOrgPlan('default', this.licenseService.getPlan());
      this.json(res, 200, await this.buildLicenseResponse(raw, req));
      return;
    }

    if (path === '/api/license/activate' && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (!this.licenseService) {
        this.json(res, 503, { error: 'License service not available' });
        return;
      }
      const body = await this.readBody(req);
      const licenseKey = body['licenseKey'] as string;
      if (!licenseKey) {
        this.json(res, 400, { error: 'licenseKey is required' });
        return;
      }
      const result = await this.licenseService.activateLicense(licenseKey);
      if (result.success && this.billingService) this.billingService.setOrgPlan('default', this.licenseService.getPlan());
      this.json(res, result.success ? 200 : 400, result);
      return;
    }

    if (path === '/api/license/trial' && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (!this.licenseService) {
        this.json(res, 503, { error: 'License service not available' });
        return;
      }
      const result = await this.licenseService.activateTrial();
      if (result.success && this.billingService) this.billingService.setOrgPlan('default', this.licenseService.getPlan());
      this.json(res, result.success ? 200 : 400, result);
      return;
    }

    if (path === '/api/license/import' && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (!this.licenseService) {
        this.json(res, 503, { error: 'License service not available' });
        return;
      }
      const body = await this.readBody(req);
      const fileContent = body['fileContent'] as string;
      if (!fileContent) {
        this.json(res, 400, { error: 'fileContent is required' });
        return;
      }
      const result = this.licenseService.importOfflineLicense(fileContent);
      if (result.success && this.billingService) this.billingService.setOrgPlan('default', this.licenseService.getPlan());
      this.json(res, result.success ? 200 : 400, result);
      return;
    }

    if (path === '/api/license/deactivate' && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      if (!this.licenseService) {
        this.json(res, 503, { error: 'License service not available' });
        return;
      }
      await this.licenseService.deactivate();
      if (this.billingService) this.billingService.setOrgPlan('default', this.licenseService.getPlan());
      this.json(res, 200, { ok: true });
      return;
    }

    // ── Telemetry Settings ──────────────────────────────────────────────────
    if (path === '/api/settings/telemetry' && req.method === 'POST') {
      const body = await this.readBody(req);
      const enabled = body['enabled'] as boolean;
      if (this.telemetryService && typeof enabled === 'boolean') {
        this.telemetryService.setEnabled(enabled);
      }
      this.json(res, 200, { ok: true });
      return;
    }

    if (path === '/api/settings/telemetry' && req.method === 'GET') {
      this.json(res, 200, { enabled: this.telemetryService?.isEnabled() ?? false });
      return;
    }

    // ── Hub Proxy ─────────────────────────────────────────────────────────────
    if (path === '/api/hub/publish' && req.method === 'POST') {
      const authUser = await this.requireAuth(req, res);
      if (!authUser) return;
      const body = await this.readBody(req);
      const hubUrl = (body['hubUrl'] as string) ?? this.hubUrl;
      const hubToken = body['hubToken'] as string | undefined;
      if (!hubToken) {
        this.json(res, 401, { error: 'Hub token required. Please login to Markus Hub first.' });
        return;
      }
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${hubToken}`,
        };
        let hubRes = await fetch(`${hubUrl}/api/items`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body['payload']),
          redirect: 'manual',
        });
        if (hubRes.status >= 300 && hubRes.status < 400) {
          const location = hubRes.headers.get('location');
          if (location) {
            hubRes = await fetch(location, { method: 'POST', headers, body: JSON.stringify(body['payload']), redirect: 'manual' });
          }
        }
        const hubData = await hubRes.json();
        this.json(res, hubRes.status, hubData);
      } catch (err) {
        this.json(res, 502, { error: `Hub request failed: ${String(err)}` });
      }
      return;
    }

    // Generic Hub API proxy (avoids CORS issues with cross-origin fetch to markus.global)
    if (path.startsWith('/api/hub/')) {
      const hubPath = path.slice('/api/hub'.length);
      const reqUrl = new URL(req.url!, `http://${req.headers.host}`);
      const hubTargetUrl = `${this.hubUrl}/api${hubPath}${reqUrl.search}`;

      const ct = String(req.headers['content-type'] ?? '').toLowerCase();
      const isMultipart = ct.includes('multipart/form-data');

      const proxyHeaders: Record<string, string> = {};
      if (!isMultipart) proxyHeaders['Content-Type'] = 'application/json';
      else proxyHeaders['Content-Type'] = req.headers['content-type']!;
      const authHeader = req.headers['authorization'];
      if (authHeader) {
        proxyHeaders['Authorization'] = authHeader;
      } else {
        const storedToken = this.readHubToken();
        if (storedToken) proxyHeaders['Authorization'] = `Bearer ${storedToken}`;
      }
      if (req.headers['accept-language']) {
        proxyHeaders['Accept-Language'] = req.headers['accept-language'];
      }

      try {
        let body: string | Buffer | undefined;
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
          if (isMultipart) {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            body = Buffer.concat(chunks);
          } else {
            body = JSON.stringify(await this.readBody(req));
          }
        }
        let hubRes = await fetch(hubTargetUrl, {
          method: req.method,
          headers: proxyHeaders,
          body,
          redirect: 'manual',
        });
        if (hubRes.status >= 300 && hubRes.status < 400) {
          const location = hubRes.headers.get('location');
          if (location) {
            hubRes = await fetch(location, {
              method: req.method,
              headers: proxyHeaders,
              body,
              redirect: 'manual',
            });
          }
        }
        const data = await hubRes.json();
        this.json(res, hubRes.status, data);
      } catch (err) {
        this.json(res, 502, { error: `Hub request failed: ${String(err)}` });
      }
      return;
    }

    // Settings — Hub URL (for web-ui to discover hub address)
    if (path === '/api/settings/hub' && req.method === 'GET') {
      this.json(res, 200, { hubUrl: this.hubUrl });
      return;
    }

    // Settings — Hub Token (frontend pushes token so MCP skill servers can read it)
    if (path === '/api/settings/hub-token' && req.method === 'POST') {
      const body = await this.readBody(req);
      const authUser = await this.getAuthUser(req);
      const token = body['token'] as string | null;
      const tokenPath = join(homedir(), '.markus', 'hub-token');
      try {
        if (token) {
          mkdirSync(join(homedir(), '.markus'), { recursive: true });
          writeFileSync(tokenPath, token, 'utf-8');
        } else if (existsSync(tokenPath)) {
          rmSync(tokenPath);
        }
        log.info(`Hub token ${token ? 'saved to' : 'cleared from'} ${tokenPath}`);
      } catch (err) {
        log.error('Failed to write hub token file', { error: String(err) });
      }
      this.auditService?.record({
        orgId: 'system',
        type: 'settings_changed',
        action: 'hub_token',
        detail: token ? 'Hub token saved' : 'Hub token cleared',
        userId: authUser?.userId,
        success: true,
      });
      this.json(res, 200, { ok: true });
      return;
    }

    // Settings — Remote Access
    if (path === '/api/settings/remote' && req.method === 'GET') {
      const status = this.remoteAgent?.getStatus() ?? { enabled: false, connected: false, instanceId: null, remoteUrl: null, signalUrl: null, peerCount: 0 };
      this.json(res, 200, status);
      return;
    }

    if (path === '/api/settings/remote/enable' && req.method === 'POST') {
      if (!this.remoteAgent && this.remoteAgentFactory) {
        const agent = await this.remoteAgentFactory();
        if (agent) this.setRemoteAgent(agent);
      }
      if (!this.remoteAgent) {
        this.json(res, 400, { error: 'Remote access not configured. Please sign in to Markus Hub first.' });
        return;
      }
      this.remoteAgent.start().catch(() => {});
      try { saveConfig({ remote: { enabled: true } } as any, this.markusConfigPath); } catch { /* non-critical */ }
      this.json(res, 200, { ok: true, status: this.remoteAgent.getStatus() });
      return;
    }

    if (path === '/api/settings/remote/disable' && req.method === 'POST') {
      if (this.remoteAgent) {
        await this.remoteAgent.stop();
      }
      try { saveConfig({ remote: { enabled: false } } as any, this.markusConfigPath); } catch { /* non-critical */ }
      this.json(res, 200, { ok: true });
      return;
    }

    if (await handleLlmSettingsRoutes(this, req, res, path, url)) return;

    // ─── OAuth Authentication ───

    // List available OAuth providers
    if (path === '/api/settings/oauth/providers' && req.method === 'GET') {
      if (!this.llmRouter?.oauthManager) {
        this.json(res, 200, { providers: [] });
        return;
      }
      const supportedProviders = this.llmRouter.oauthManager.getSupportedProviders().map(name => ({
        name,
        displayName: name === 'openai-codex' ? 'OpenAI Codex (ChatGPT OAuth)' : name,
        config: this.llmRouter!.oauthManager!.getProviderConfig(name),
      }));
      this.json(res, 200, { providers: supportedProviders });
      return;
    }

    // List auth profiles (with optional token validation)
    if (path === '/api/settings/oauth/profiles' && req.method === 'GET') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      if (!this.llmRouter?.profileStore) {
        this.json(res, 200, { profiles: [] });
        return;
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const provider = url.searchParams.get('provider') ?? undefined;
      const validate = url.searchParams.get('validate') === '1';

      // Proactively validate OAuth tokens if requested
      if (validate && this.llmRouter.oauthManager) {
        const profiles = this.llmRouter.profileStore.listProfiles(provider);
        const oauthProfiles = profiles.filter(p => p.oauth);
        await Promise.allSettled(
          oauthProfiles.map(p => this.llmRouter!.oauthManager!.validateProfile(p.id))
        );
      }

      this.json(res, 200, { profiles: this.llmRouter.profileStore.listProfilesSafe(provider) });
      return;
    }

    // Start OAuth login flow
    if (path === '/api/settings/oauth/login' && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      if (!this.llmRouter?.oauthManager) {
        this.json(res, 503, { error: 'OAuth not initialized' });
        return;
      }
      const body = await this.readBody(req);
      const { provider } = body as { provider?: string };
      if (!provider) {
        this.json(res, 400, { error: 'provider is required' });
        return;
      }
      try {
        const { authorizeUrl, promise } = await this.llmRouter.oauthManager.startLogin(provider);
        // Don't await the promise — it resolves when the user completes the browser flow.
        // Instead, respond with the authorizeUrl and let the frontend poll for status.
        promise.then(profile => {
          log.info(`OAuth login completed for ${provider}`, { profileId: profile.id });
          // Auto-register the new OAuth provider in the router
          if (this.llmRouter && !this.llmRouter.getProvider(provider)) {
            try {
              this.llmRouter.registerOAuthProvider(provider, profile, {
                model: provider === 'openai-codex' ? 'gpt-5.5' : undefined,
              });
            } catch (err) {
              log.warn(`Failed to auto-register OAuth provider after login`, { error: String(err) });
            }
          }
        }).catch(err => {
          log.warn(`OAuth login failed for ${provider}`, { error: String(err) });
        });
        this.json(res, 200, { authorizeUrl, provider });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    // Start Device Code OAuth login flow (headless/remote)
    if (path === '/api/settings/oauth/device-code' && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      if (!this.llmRouter?.oauthManager) {
        this.json(res, 503, { error: 'OAuth not initialized' });
        return;
      }
      const body = await this.readBody(req);
      const { provider } = body as { provider?: string };
      if (!provider) {
        this.json(res, 400, { error: 'provider is required' });
        return;
      }
      try {
        const { userCode, verificationUri, promise } = await this.llmRouter.oauthManager.startDeviceCodeLogin(provider);
        promise.then(profile => {
          log.info(`Device code OAuth login completed for ${provider}`, { profileId: profile.id });
          if (this.llmRouter && !this.llmRouter.getProvider(provider)) {
            try {
              this.llmRouter.registerOAuthProvider(provider, profile, {
                model: provider === 'openai-codex' ? 'gpt-5.5' : undefined,
              });
            } catch (err) {
              log.warn(`Failed to auto-register OAuth provider after device code login`, { error: String(err) });
            }
          }
        }).catch(err => {
          log.warn(`Device code OAuth login failed for ${provider}`, { error: String(err) });
        });
        this.json(res, 200, { userCode, verificationUri, provider });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    // Handle manual OAuth callback (paste redirect URL for headless scenarios)
    if (path === '/api/settings/oauth/callback' && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      if (!this.llmRouter?.oauthManager) {
        this.json(res, 503, { error: 'OAuth not initialized' });
        return;
      }
      const body = await this.readBody(req);
      const { callbackUrl } = body as { callbackUrl?: string };
      if (!callbackUrl) {
        this.json(res, 400, { error: 'callbackUrl is required' });
        return;
      }
      try {
        const profile = await this.llmRouter.oauthManager.handleManualCallback(callbackUrl);
        if (this.llmRouter && !this.llmRouter.getProvider(profile.provider)) {
          this.llmRouter.registerOAuthProvider(profile.provider, profile, {
            model: profile.provider === 'openai-codex' ? 'gpt-5.5' : undefined,
          });
        }
        this.json(res, 200, {
          profile: {
            id: profile.id,
            provider: profile.provider,
            authType: profile.authType,
            label: profile.label,
            oauthAccountId: profile.oauth?.accountId,
          },
        });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    // Check OAuth login status (polling endpoint)
    if (path === '/api/settings/oauth/status' && req.method === 'GET') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      if (!this.llmRouter?.oauthManager) {
        this.json(res, 200, { pending: false, profiles: [] });
        return;
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const provider = url.searchParams.get('provider') ?? undefined;
      const pending = this.llmRouter.oauthManager.hasPendingLogin(provider);
      const profiles = this.llmRouter.profileStore?.listProfilesSafe(provider) ?? [];
      this.json(res, 200, { pending, profiles });
      return;
    }

    // Delete auth profile
    if (path.match(/^\/api\/settings\/oauth\/profiles\/[^/]+$/) && req.method === 'DELETE') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      if (!this.llmRouter?.profileStore) {
        this.json(res, 404, { error: 'Profile store not available' });
        return;
      }
      const profileId = decodeURIComponent(path.split('/')[5]!);
      const deleted = this.llmRouter.profileStore.deleteProfile(profileId);
      if (deleted) {
        this.json(res, 200, { deleted: true, profileId });
      } else {
        this.json(res, 404, { error: 'Profile not found' });
      }
      return;
    }

    // Store setup token (e.g. Anthropic)
    if (path === '/api/settings/oauth/setup-token' && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      if (!this.llmRouter?.oauthManager) {
        this.json(res, 503, { error: 'OAuth not initialized' });
        return;
      }
      const body = await this.readBody(req);
      const { provider, token } = body as { provider?: string; token?: string };
      if (!provider || !token) {
        this.json(res, 400, { error: 'provider and token are required' });
        return;
      }
      const profile = this.llmRouter.oauthManager.storeSetupToken(provider, token);
      this.json(res, 200, {
        profile: {
          id: profile.id,
          provider: profile.provider,
          authType: profile.authType,
          label: profile.label,
        },
      });
      return;
    }

    // ── Settings — Integration Config (Feishu) ──────────────────────────

    /** Find feishu integration config for a given org */
    const findFeishuConfig = (orgId: string): Record<string, unknown> | undefined => {
      const repo = this.storage?.integrationRepo;
      if (!repo) return undefined;
      const rows = repo.listByPlatform(orgId, 'feishu') as Array<Record<string, unknown>>;
      return rows[0];
    };

    if (path === '/api/settings/integrations/feishu' && req.method === 'GET') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      try {
        // Credentials from markus.json (single source of truth)
        const { loadConfig: loadCfg } = await import('@markus/shared');
        const markusCfg = loadCfg(this.markusConfigPath);
        const appId = markusCfg.integrations?.feishu?.appId ?? '';
        const appSecret = markusCfg.integrations?.feishu?.appSecret ?? '';

        // Runtime prefs from SQLite
        const row = findFeishuConfig(auth.orgId);
        const cfg = (row?.['config'] as Record<string, unknown>) ?? {};
        const connected = !!(this.feishuNotifier?.connected);
        this.json(res, 200, {
          appId,
          appSecret,
          enabled: !!(row?.['enabled']),
          connected,
          notifyChatId: cfg['notifyChatId'] ?? '',
          notifyOnApproval: cfg['notifyOnApproval'] ?? true,
          notifyOnNotification: cfg['notifyOnNotification'] ?? false,
          notifyPriority: cfg['notifyPriority'] ?? ['high', 'urgent'],
        });
      } catch (e) {
        log.error('Failed to read feishu integration config', { error: String(e) });
        this.json(res, 500, { error: 'Failed to read integration config' });
      }
      return;
    }

    if (path === '/api/settings/integrations/feishu' && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      const body = await this.readBody(req);
      const appId = body['appId'] as string;
      const appSecret = body['appSecret'] as string;
      if (!appId || !appSecret) {
        this.json(res, 400, { error: 'appId and appSecret are required' });
        return;
      }
      const now = new Date().toISOString();
      const enabled = body['enabled'] !== false;
      const payload: Record<string, unknown> = {
        id: 'feishu_default',
        orgId: auth.orgId,
        platform: 'feishu',
        displayName: body['displayName'] ?? '飞书',
        enabled,
        config: {
          domain: body['domain'] ?? undefined,
          connectionMode: 'long_connection',
          notifyChatId: body['notifyChatId'] ?? undefined,
          notifyOnApproval: body['notifyOnApproval'] ?? true,
          notifyOnNotification: body['notifyOnNotification'] ?? false,
          notifyPriority: body['notifyPriority'] ?? ['high', 'urgent'],
        },
        forwardRules: [],
        lastVerifiedAt: null,
        lastError: null,
      };
      try {
        const repo = this.storage?.integrationRepo;
        if (!repo) {
          this.json(res, 503, { error: 'Storage not available' });
          return;
        }
        const existing = findFeishuConfig(auth.orgId);
        if (existing) {
          await repo.update(existing['id'] as string, payload);
        } else {
          await repo.create(payload);
        }
        // Credentials go to markus.json (single source of truth, consistent with other API keys)
        saveConfig({ integrations: { feishu: { appId, appSecret } } }, this.markusConfigPath);
        log.info('Feishu integration config saved', { orgId: auth.orgId });
        this.auditService?.record({
          orgId: auth.orgId,
          type: 'settings_changed',
          action: 'integration_feishu',
          detail: 'Feishu integration config saved',
          userId: auth.userId,
          success: true,
        });
        // Update the FeishuNotifier runtime config
        this.updateFeishuConfig({
          appId,
          appSecret: appSecret,
          domain: body['domain'] as string | undefined,
          locale: (body['locale'] as 'zh' | 'en' | undefined) ?? undefined,
          notifyChatId: body['notifyChatId'] as string | undefined,
          notifyOnApproval: (body['notifyOnApproval'] ?? true) as boolean,
          notifyOnNotification: (body['notifyOnNotification'] ?? false) as boolean,
          notifyPriority: (body['notifyPriority'] ?? ['high', 'urgent']) as string[],
          forwardRules: [],
        });
        const connected = !!(this.feishuNotifier?.connected);
        this.json(res, 200, { appId, connected, enabled });
      } catch (e) {
        log.error('Failed to save feishu integration config', { error: String(e) });
        this.json(res, 500, { error: 'Failed to save integration config' });
      }
      return;
    }

    if (path === '/api/settings/integrations/feishu' && req.method === 'DELETE') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      try {
        const row = findFeishuConfig(auth.orgId);
        if (row) {
          await this.storage?.integrationRepo?.delete(row['id'] as string);
        }
        // Clear credentials from markus.json
        saveConfig({ integrations: { feishu: {} } }, this.markusConfigPath);
        log.info('Feishu integration config deleted', { orgId: auth.orgId });
        this.auditService?.record({
          orgId: auth.orgId,
          type: 'settings_changed',
          action: 'integration_feishu_delete',
          detail: 'Feishu integration config deleted',
          userId: auth.userId,
          success: true,
        });
        this.json(res, 200, { success: true });
      } catch (e) {
        log.error('Failed to delete feishu integration config', { error: String(e) });
        this.json(res, 500, { error: 'Failed to delete integration config' });
      }
      return;
    }

    if (path === '/api/settings/integrations/feishu/test' && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      const body = await this.readBody(req);
      const appId = (body['appId'] as string) ?? '';
      const appSecret = (body['appSecret'] as string) ?? '';
      if (!appId || !appSecret) {
        this.json(res, 400, { error: 'appId and appSecret are required' });
        return;
      }
      try {
        const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        });
        const data = await resp.json() as Record<string, unknown>;
        if (resp.ok && data['tenant_access_token']) {
          this.json(res, 200, { success: true, message: 'Credentials verified successfully' });
        } else {
          this.json(res, 200, { success: false, message: String(data['msg'] ?? 'Authentication failed') });
        }
      } catch (e) {
        log.error('Feishu test connection failed', { error: String(e) });
        this.json(res, 200, { success: false, message: `Connection failed: ${String(e)}` });
      }
      return;
    }

    if (path === '/api/settings/integrations/feishu/chats' && req.method === 'GET') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      try {
        // Credentials from markus.json (single source of truth)
        const { loadConfig: loadCfg } = await import('@markus/shared');
        const markusCfg = loadCfg(this.markusConfigPath);
        const appId = markusCfg.integrations?.feishu?.appId;
        const appSecret = markusCfg.integrations?.feishu?.appSecret;
        if (!appId || !appSecret) {
          this.json(res, 400, { error: 'Feishu integration not configured' });
          return;
        }
        const { FeishuApiClient } = await import('./feishu-api-client.js');
        const client = new FeishuApiClient({ appId, appSecret });
        const chats = await client.listBotChats();
        this.json(res, 200, { chats });
      } catch (e) {
        log.error('Failed to list Feishu bot chats', { error: String(e) });
        this.json(res, 200, { chats: [], error: String(e) });
      }
      return;
    }

    if (path === '/api/settings/integrations/feishu/test-message' && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      const body = await this.readBody(req);
      const chatId = (body['chatId'] as string) ?? '';
      if (!chatId) {
        this.json(res, 400, { error: 'chatId is required' });
        return;
      }
      try {
        // Credentials from markus.json (single source of truth)
        const { loadConfig: loadCfg } = await import('@markus/shared');
        const markusCfg = loadCfg(this.markusConfigPath);
        const appId = markusCfg.integrations?.feishu?.appId;
        const appSecret = markusCfg.integrations?.feishu?.appSecret;
        if (!appId || !appSecret) {
          this.json(res, 400, { error: 'Feishu integration not configured' });
          return;
        }
        const { FeishuApiClient } = await import('./feishu-api-client.js');
        const client = new FeishuApiClient({ appId, appSecret });
        const card = {
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: '🎉 Markus 测试消息' }, template: 'blue' },
          elements: [
            { tag: 'markdown', content: '这是一条来自 **Markus** 的测试消息。\n如果你看到了这条消息，说明飞书集成配置正确！' },
            { tag: 'hr' },
            { tag: 'note', elements: [{ tag: 'plain_text', content: `发送时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` }] },
          ],
        };
        await client.sendCard(chatId, card);
        this.json(res, 200, { success: true, message: 'Test message sent' });
      } catch (e) {
        log.error('Feishu test message failed', { error: String(e) });
        this.json(res, 200, { success: false, message: `Send failed: ${String(e)}` });
      }
      return;
    }

    if (path === '/api/settings/integrations/feishu/register' && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      try {
        const Lark = await import('@larksuiteoapi/node-sdk');
        const controller = new AbortController();

        // Timeout after 10 minutes
        const timeout = setTimeout(() => controller.abort(), 600_000);

        const result = await Lark.registerApp({
          source: 'markus',
          signal: controller.signal,
          appPreset: {
            name: 'Markus 秘书',
            desc: 'Markus 智能秘书 — 消息互动、通知转发、审批处理',
          },
          onQRCodeReady: (info) => {
            // Store QR info for polling — use a simple in-memory store keyed by orgId
            this.feishuRegisterSessions.set(auth.orgId, {
              url: info.url,
              expireIn: info.expireIn,
              status: 'pending',
              createdAt: Date.now(),
            });
          },
          onStatusChange: (info) => {
            const session = this.feishuRegisterSessions.get(auth.orgId);
            if (session) session.status = info.status;
          },
        });

        clearTimeout(timeout);
        this.feishuRegisterSessions.delete(auth.orgId);

        // Auto-save the credentials
        const appId = result.client_id;
        const appSecret = result.client_secret;
        const locale = result.user_info?.tenant_brand === 'lark' ? 'en' : 'zh';
        const registeredOpenId = result.user_info?.open_id;
        const payload: Record<string, unknown> = {
          id: 'feishu_default',
          orgId: auth.orgId,
          platform: 'feishu',
          displayName: locale === 'en' ? 'Lark' : '飞书',
          enabled: true,
          config: {
            locale,
            notifyOpenId: registeredOpenId,
            connectionMode: 'long_connection',
            notifyOnApproval: true,
            notifyOnNotification: true,
            notifyPriority: ['normal', 'high', 'urgent'],
          },
          forwardRules: [],
          lastVerifiedAt: new Date().toISOString(),
          lastError: null,
        };
        const repo = this.storage?.integrationRepo;
        if (repo) {
          const existing = findFeishuConfig(auth.orgId);
          if (existing) {
            await repo.update(existing['id'] as string, payload);
          } else {
            await repo.create(payload);
          }
        }

        // Credentials go to markus.json (single source of truth)
        saveConfig({ integrations: { feishu: { appId, appSecret } } }, this.markusConfigPath);

        // Start the long connection
        this.updateFeishuConfig({
          appId,
          appSecret,
          locale: locale as 'zh' | 'en',
          notifyOpenId: registeredOpenId,
          notifyOnApproval: true,
          notifyOnNotification: true,
          notifyPriority: ['normal', 'high', 'urgent'],
          forwardRules: [],
        });

        log.info('Feishu app registered via QR scan', { orgId: auth.orgId, appId });

        // Send welcome message and pending status to the user who scanned
        const openId = result.user_info?.open_id;
        if (openId) {
          try {
            const { FeishuApiClient } = await import('./feishu-api-client.js');
            const welcomeClient = new FeishuApiClient({ appId, appSecret });

            // Gather pending status
            let statusLines = '';
            const pendingApprovals = this.hitlService?.listApprovals('pending') ?? [];
            const notifCounts = this.hitlService?.countNotifications(auth.userId, true) ?? { total: 0, unread: 0 };

            if (locale === 'en') {
              if (pendingApprovals.length > 0 || notifCounts.unread > 0) {
                statusLines += '\n\n---\n📊 **Pending items:**\n';
                if (pendingApprovals.length > 0) {
                  statusLines += `\n🔔 **${pendingApprovals.length} pending approval(s)**\n`;
                  for (const a of pendingApprovals.slice(0, 5)) {
                    statusLines += `• ${a.title} (from ${a.agentName})\n`;
                  }
                  if (pendingApprovals.length > 5) {
                    statusLines += `• ...and ${pendingApprovals.length - 5} more\n`;
                  }
                }
                if (notifCounts.unread > 0) {
                  statusLines += `\n📬 **${notifCounts.unread} unread notification(s)**\n`;
                }
                statusLines += '\nReply to handle them, e.g. type "approvals" to view details.';
              }
              const card = {
                config: { wide_screen_mode: true },
                header: { title: { tag: 'plain_text', content: '🎉 Markus Secretary is Online' }, template: 'green' },
                elements: [
                  { tag: 'markdown', content: `**Markus Secretary** has been connected to your Lark!\n\nYou can now:\n- 💬 Send me messages and I'll handle them for you\n- 📋 Receive system notifications and approval requests\n- ✅ Approve or reject directly in the conversation\n- 🤖 Interact with the AI team in real time${statusLines}` },
                  { tag: 'hr' },
                  { tag: 'note', elements: [{ tag: 'plain_text', content: 'Powered by Markus — Your AI Team OS' }] },
                ],
              };
              await welcomeClient.sendCardToUser(openId, card);
            } else {
              if (pendingApprovals.length > 0 || notifCounts.unread > 0) {
                statusLines += '\n\n---\n📊 **当前待处理事项：**\n';
                if (pendingApprovals.length > 0) {
                  statusLines += `\n🔔 **${pendingApprovals.length} 个待审批请求**\n`;
                  for (const a of pendingApprovals.slice(0, 5)) {
                    statusLines += `• ${a.title}（来自 ${a.agentName}）\n`;
                  }
                  if (pendingApprovals.length > 5) {
                    statusLines += `• ...还有 ${pendingApprovals.length - 5} 项\n`;
                  }
                }
                if (notifCounts.unread > 0) {
                  statusLines += `\n📬 **${notifCounts.unread} 条未读通知**\n`;
                }
                statusLines += '\n直接回复消息即可处理，例如输入「审批」查看详情。';
              }
              const card = {
                config: { wide_screen_mode: true },
                header: { title: { tag: 'plain_text', content: '🎉 Markus 秘书已上线' }, template: 'green' },
                elements: [
                  { tag: 'markdown', content: `**Markus 秘书** 已成功接入你的飞书！\n\n你现在可以：\n- 💬 直接发消息给我，我来帮你处理\n- 📋 接收系统通知和审批请求\n- ✅ 直接在对话中审批或驳回\n- 🤖 与 AI 团队实时互动${statusLines}` },
                  { tag: 'hr' },
                  { tag: 'note', elements: [{ tag: 'plain_text', content: 'Powered by Markus — Your AI Team OS' }] },
                ],
              };
              await welcomeClient.sendCardToUser(openId, card);
            }
            log.info('Welcome message sent to user', { openId, locale });
          } catch (welcomeErr) {
            log.warn('Failed to send welcome message', { error: String(welcomeErr) });
          }
        }

        this.json(res, 200, {
          success: true,
          appId,
          connected: !!(this.feishuNotifier?.connected),
          userInfo: result.user_info,
        });
      } catch (e: unknown) {
        this.feishuRegisterSessions.delete(auth.orgId);
        const err = e as { code?: string; description?: string; message?: string };
        if (err.code === 'access_denied') {
          this.json(res, 200, { success: false, error: 'user_denied', message: '用户拒绝了授权' });
        } else if (err.code === 'expired_token' || err.code === 'abort') {
          this.json(res, 200, { success: false, error: 'expired', message: '二维码已过期或超时' });
        } else {
          log.error('Feishu register app failed', { error: String(e) });
          this.json(res, 200, { success: false, error: 'unknown', message: String(err.message || err.description || e) });
        }
      }
      return;
    }

    if (path === '/api/settings/integrations/feishu/register/status' && req.method === 'GET') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      const session = this.feishuRegisterSessions.get(auth.orgId);
      if (!session) {
        this.json(res, 200, { active: false });
      } else {
        this.json(res, 200, {
          active: true,
          url: session.url,
          expireIn: session.expireIn,
          status: session.status,
          elapsed: Math.floor((Date.now() - session.createdAt) / 1000),
        });
      }
      return;
    }

    if (path === '/api/settings/integrations/feishu/notifications' && req.method === 'GET') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      try {
        const row = findFeishuConfig(auth.orgId);
        const rules = row?.['forwardRules'] as Array<Record<string, unknown>> | undefined;
        this.json(res, 200, { rules: rules ?? [] });
      } catch (e) {
        log.error('Failed to read notification rules', { error: String(e) });
        this.json(res, 500, { error: 'Failed to read notification rules' });
      }
      return;
    }

    if (path === '/api/settings/integrations/feishu/notifications' && req.method === 'PUT') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      const body = await this.readBody(req);
      const rules = body['rules'] as Array<Record<string, unknown>>;
      if (!Array.isArray(rules)) {
        this.json(res, 400, { error: 'rules must be an array' });
        return;
      }
      try {
        const repo = this.storage?.integrationRepo;
        if (!repo) {
          this.json(res, 503, { error: 'Storage not available' });
          return;
        }
        const row = findFeishuConfig(auth.orgId);
        if (row) {
          await repo.update(row['id'] as string, {
            forwardRules: rules,
            lastVerifiedAt: row['lastVerifiedAt'] ?? null,
            lastError: row['lastError'] ?? null,
          });
          // Update the FeishuNotifier runtime config with new rules
          if (this.feishuNotifier) {
            const { loadConfig: loadCfg } = await import('@markus/shared');
            const markusCfg = loadCfg(this.markusConfigPath);
            const cfgAppId = markusCfg.integrations?.feishu?.appId;
            const cfgAppSecret = markusCfg.integrations?.feishu?.appSecret;
            if (cfgAppId && cfgAppSecret) {
              const cfgConfig = row['config'] as Record<string, unknown> | undefined;
              this.feishuNotifier.updateConfig({
                appId: cfgAppId,
                appSecret: cfgAppSecret,
                domain: cfgConfig?.domain as string | undefined,
                forwardRules: rules as unknown as FeishuNotifierConfig['forwardRules'],
              });
            }
          }
          log.info('Feishu notification rules updated', { orgId: auth.orgId, ruleCount: rules.length });
          this.auditService?.record({
            orgId: auth.orgId,
            type: 'settings_changed',
            action: 'integration_feishu_notifications',
            detail: `Feishu notification rules updated (${rules.length} rules)`,
            userId: auth.userId,
            success: true,
          });
          this.json(res, 200, { rules });
        } else {
          this.json(res, 404, { error: 'Feishu integration not configured' });
        }
      } catch (e) {
        log.error('Failed to update notification rules', { error: String(e) });
        this.json(res, 500, { error: 'Failed to update notification rules' });
      }
      return;
    }

    // Settings — Config Export
    if (path === '/api/settings/export' && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      const body = await this.readBody(req);
      const sections = (body.sections as string[]) ?? ['llm', 'teams', 'agents', 'templates'];
      const exportData: Record<string, unknown> = {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        sections: {},
      };
      const sectionData = exportData.sections as Record<string, unknown>;
      if (sections.includes('llm') && this.llmRouter) {
        sectionData.llm = this.llmRouter.getEnhancedSettings();
      }
      if (sections.includes('teams')) {
        const teams = this.orgService.listTeams(auth.orgId);
        sectionData.teams = teams;
      }
      if (sections.includes('agents')) {
        const agents = this.orgService.getAgentManager().listAgents();
        sectionData.agents = agents.map(a => ({
          id: a.id,
          name: a.name,
          role: a.role,
          status: a.status,
        }));
      }
      this.json(res, 200, exportData);
      return;
    }

    // Settings — Config Import (preview and apply)
    if (path === '/api/settings/import' && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      const body = await this.readBody(req);
      const { data, preview } = body as { data: Record<string, unknown>; preview?: boolean };
      if (!data || !data.sections) {
        this.json(res, 400, { error: 'Invalid import data: missing sections' });
        return;
      }
      const sections = data.sections as Record<string, unknown>;
      const available = Object.keys(sections);
      if (preview) {
        const summary: Record<string, { count: number; items: string[] }> = {};
        if (sections.llm) {
          const llm = sections.llm as Record<string, unknown>;
          const provCount = llm.providers ? Object.keys(llm.providers as object).length : 0;
          summary.llm = {
            count: provCount,
            items: llm.providers ? Object.keys(llm.providers as object) : [],
          };
        }
        if (sections.teams) {
          const teams = sections.teams as Array<{ name: string }>;
          summary.teams = { count: teams.length, items: teams.map(t => t.name) };
        }
        if (sections.agents) {
          const agents = sections.agents as Array<{ name: string }>;
          summary.agents = { count: agents.length, items: agents.map(a => a.name) };
        }
        this.json(res, 200, { available, summary });
        return;
      }
      // Apply import
      const applied: string[] = [];
      if (sections.llm && this.llmRouter) {
        const llm = sections.llm as {
          defaultProvider?: string;
          providers?: Record<
            string,
            {
              cost?: { input: number; output: number };
              contextWindow?: number;
              maxOutputTokens?: number;
            }
          >;
        };
        if (llm.providers) {
          for (const [name, cfg] of Object.entries(llm.providers)) {
            if (cfg.cost || cfg.contextWindow || cfg.maxOutputTokens) {
              this.llmRouter.updateProviderModelConfig(name, {
                cost: cfg.cost,
                contextWindow: cfg.contextWindow,
                maxOutputTokens: cfg.maxOutputTokens,
              });
            }
          }
        }
        if (llm.defaultProvider && this.llmRouter.listProviders().includes(llm.defaultProvider)) {
          this.llmRouter.setDefaultProvider(llm.defaultProvider);
        }
        applied.push('llm');
      }
      this.json(res, 200, { applied, message: `Imported ${applied.length} sections` });
      return;
    }

    // Settings — Import from OpenClaw config
    if (path === '/api/settings/import/openclaw' && req.method === 'POST') {
      const auth = await this.requireAuth(req, res);
      if (!auth) return;
      const body = await this.readBody(req);
      const { configPath, preview } = body as { configPath?: string; preview?: boolean };

      const { existsSync: fsExists, readFileSync: fsRead } = await import('node:fs');
      const { join: pathJoin } = await import('node:path');
      const { homedir } = await import('node:os');

      const possiblePaths = [
        configPath,
        pathJoin(homedir(), '.openclaw', 'openclaw.json'),
        pathJoin(homedir(), '.openclaw', 'openclaw.json5'),
      ].filter(Boolean) as string[];

      let found = '';
      let rawContent = '';
      for (const p of possiblePaths) {
        if (fsExists(p)) {
          found = p;
          rawContent = fsRead(p, 'utf-8');
          break;
        }
      }

      if (!found) {
        this.json(res, 404, { error: 'No OpenClaw config found', searchedPaths: possiblePaths });
        return;
      }

      try {
        const cleaned = rawContent
          .replace(/\/\/.*$/gm, '')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/,\s*([\]}])/g, '$1');
        const parsed = JSON.parse(cleaned) as Record<string, unknown>;

        const modelsSection = parsed.models as
          | {
              providers?: Record<
                string,
                {
                  baseUrl?: string;
                  models?: Array<{
                    id: string;
                    name: string;
                    cost?: { input: number; output: number };
                    contextWindow?: number;
                    maxTokens?: number;
                  }>;
                }
              >;
            }
          | undefined;
        const channelsSection = parsed.channels as Record<string, unknown> | undefined;

        if (preview) {
          const summary: Record<string, unknown> = { configPath: found };
          if (modelsSection?.providers) {
            const provs = Object.entries(modelsSection.providers).map(([name, cfg]) => ({
              name,
              modelCount: cfg.models?.length ?? 0,
              baseUrl: cfg.baseUrl,
            }));
            summary.models = { providerCount: provs.length, providers: provs };
          }
          if (channelsSection) {
            summary.channels = Object.keys(channelsSection).filter(
              k => k !== 'defaults' && k !== 'modelByChannel'
            );
          }
          this.json(res, 200, { found: true, summary });
          return;
        }

        // Apply model configs
        let appliedModels = 0;
        if (modelsSection?.providers && this.llmRouter) {
          for (const [name, cfg] of Object.entries(modelsSection.providers)) {
            if (cfg.models) {
              for (const m of cfg.models) {
                if (m.cost || m.contextWindow || m.maxTokens) {
                  this.llmRouter.updateProviderModelConfig(name, {
                    cost: m.cost,
                    contextWindow: m.contextWindow,
                    maxOutputTokens: m.maxTokens,
                  });
                  appliedModels++;
                }
              }
            }
          }
        }
        this.json(res, 200, { applied: true, appliedModels, configPath: found });
      } catch (err) {
        this.json(res, 400, { error: `Failed to parse OpenClaw config: ${String(err)}` });
      }
      return;
    }

    // ── Workflow Templates (team-scoped) ─────────────────────────────────
    const wfTeamMatch = path.match(/^\/api\/teams\/([^/]+)\/workflows(?:\/([^/]+))?(?:\/(runs|roles))?$/);
    if (wfTeamMatch) {
      const teamId = wfTeamMatch[1]!;
      const wfName = wfTeamMatch[2] ? decodeURIComponent(wfTeamMatch[2]) : undefined;
      const wfSub = wfTeamMatch[3] as 'runs' | 'roles' | undefined;

      // GET /api/teams/:teamId/workflows — list all workflow templates
      if (!wfName && req.method === 'GET') {
        if (!this.workflowService) { this.json(res, 200, { workflows: [] }); return; }
        const workflows = this.workflowService.listWorkflows(teamId);
        this.json(res, 200, { workflows });
        return;
      }

      // POST /api/teams/:teamId/workflows — add a new workflow template
      if (!wfName && req.method === 'POST') {
        if (!this.workflowService) { this.json(res, 500, { error: 'Workflow service not available' }); return; }
        const body = await this.readBody(req);
        const name = body['name'] as string;
        const yaml = body['yaml'] as string;
        if (!name || !yaml) { this.json(res, 400, { error: 'name and yaml are required' }); return; }
        try {
          const template = this.workflowService.addWorkflow(teamId, name, yaml);
          this.json(res, 201, { template: { name: template.name, displayName: template.displayName, description: template.description, version: template.version, stepCount: template.steps.length } });
        } catch (err) {
          this.json(res, 400, { error: String(err) });
        }
        return;
      }

      // GET /api/teams/:teamId/workflows/:name — get a single workflow template
      if (wfName && !wfSub && req.method === 'GET') {
        if (!this.workflowService) { this.json(res, 404, { error: 'Workflow service not available' }); return; }
        const template = this.workflowService.getWorkflow(teamId, wfName);
        if (!template) { this.json(res, 404, { error: `Workflow "${wfName}" not found` }); return; }
        this.json(res, 200, { template });
        return;
      }

      // PUT /api/teams/:teamId/workflows/:name — update a workflow template
      if (wfName && !wfSub && req.method === 'PUT') {
        if (!this.workflowService) { this.json(res, 500, { error: 'Workflow service not available' }); return; }
        const body = await this.readBody(req);
        const yaml = body['yaml'] as string;
        if (!yaml) { this.json(res, 400, { error: 'yaml is required' }); return; }
        try {
          const template = this.workflowService.updateWorkflow(teamId, wfName, yaml);
          this.json(res, 200, { template: { name: template.name, displayName: template.displayName, description: template.description, version: template.version } });
        } catch (err) {
          this.json(res, 400, { error: String(err) });
        }
        return;
      }

      // DELETE /api/teams/:teamId/workflows/:name — remove a workflow template
      if (wfName && !wfSub && req.method === 'DELETE') {
        if (!this.workflowService) { this.json(res, 500, { error: 'Workflow service not available' }); return; }
        try {
          this.workflowService.removeWorkflow(teamId, wfName);
          this.json(res, 200, { ok: true });
        } catch (err) {
          this.json(res, 400, { error: String(err) });
        }
        return;
      }

      // GET /api/teams/:teamId/workflows/:name/roles — resolve role candidates
      if (wfName && wfSub === 'roles' && req.method === 'GET') {
        if (!this.workflowService) { this.json(res, 500, { error: 'Workflow service not available' }); return; }
        const template = this.workflowService.getWorkflow(teamId, wfName);
        if (!template) { this.json(res, 404, { error: `Workflow "${wfName}" not found` }); return; }
        const roles = this.workflowService.resolveRoles(teamId, template);
        this.json(res, 200, { roles });
        return;
      }

      // GET /api/teams/:teamId/workflows/:name/runs — list runs for a workflow
      if (wfName && wfSub === 'runs' && req.method === 'GET') {
        if (!this.workflowRunner) { this.json(res, 200, { runs: [] }); return; }
        const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
        const runs = await this.workflowRunner.listRuns(teamId, wfName, limit);
        this.json(res, 200, { runs });
        return;
      }

      // POST /api/teams/:teamId/workflows/:name/runs — start a new workflow run
      if (wfName && wfSub === 'runs' && req.method === 'POST') {
        if (!this.workflowService || !this.workflowRunner) {
          this.json(res, 500, { error: 'Workflow service not available' });
          return;
        }
        const template = this.workflowService.getWorkflow(teamId, wfName);
        if (!template) { this.json(res, 404, { error: `Workflow "${wfName}" not found` }); return; }

        const authUser = await this.getAuthUser(req);
        const body = await this.readBody(req);
        const params = (body['params'] as Record<string, string>) ?? {};
        let roleMapping = body['roleMapping'] as Record<string, string> | undefined;
        const projectId = body['projectId'] as string;

        if (!projectId) { this.json(res, 400, { error: 'projectId is required' }); return; }

        if (!roleMapping) {
          roleMapping = this.workflowService.buildDefaultRoleMapping(teamId, template);
        }

        try {
          const run = await this.workflowRunner.createRun(
            teamId, template, params, roleMapping, projectId, 'manual', authUser?.userId,
          );
          this.json(res, 201, { run });
        } catch (err) {
          this.json(res, 400, { error: String(err) });
        }
        return;
      }
    }

    // Workflow run by ID
    const wfRunMatch = path.match(/^\/api\/workflow-runs\/([^/]+)$/);
    if (wfRunMatch) {
      const runId = wfRunMatch[1]!;

      if (req.method === 'GET') {
        if (!this.workflowRunner) { this.json(res, 404, { error: 'Run not found' }); return; }
        const run = await this.workflowRunner.getRunAsync(runId);
        if (!run) { this.json(res, 404, { error: 'Run not found' }); return; }
        this.json(res, 200, { run });
        return;
      }

      if (req.method === 'DELETE') {
        if (!this.workflowRunner) { this.json(res, 404, { error: 'Run not found' }); return; }
        try {
          const run = await this.workflowRunner.cancelRun(runId);
          this.json(res, 200, { run });
        } catch (err) {
          this.json(res, 400, { error: String(err) });
        }
        return;
      }
    }

    // Workflow run pause/resume
    const wfRunActionMatch = path.match(/^\/api\/workflow-runs\/([^/]+)\/(pause|resume)$/);
    if (wfRunActionMatch && req.method === 'POST') {
      const runId = wfRunActionMatch[1]!;
      const action = wfRunActionMatch[2] as 'pause' | 'resume';
      if (!this.workflowRunner) { this.json(res, 404, { error: 'Run not found' }); return; }
      try {
        const run = action === 'pause'
          ? await this.workflowRunner.pauseRun(runId)
          : await this.workflowRunner.resumeRun(runId);
        this.json(res, 200, { run });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    // ── Workflow Engine (DEPRECATED — use /api/teams/:teamId/workflows instead) ─
    if ((path === '/api/workflows' || path.startsWith('/api/workflows/')) &&
        !path.startsWith('/api/workflow-runs')) {
      res.setHeader('Deprecation', 'true');
      res.setHeader('Sunset', '2026-09-01');
      res.setHeader('Link', '</api/teams/{teamId}/workflows>; rel="successor-version"');
    }

    if (path === '/api/workflows' && req.method === 'GET') {
      if (!this.workflowEngine) {
        this.json(res, 200, { executions: [], _deprecated: 'Use GET /api/teams/:teamId/workflows instead' });
        return;
      }
      const executions = this.workflowEngine.listExecutions().map(e => ({
        id: e.id,
        workflowId: e.workflowId,
        status: e.status,
        startedAt: e.startedAt,
        completedAt: e.completedAt,
        error: e.error,
        stepCount: e.steps.size,
      }));
      this.json(res, 200, { executions, _deprecated: 'Use GET /api/teams/:teamId/workflows instead' });
      return;
    }

    if (path === '/api/workflows' && req.method === 'POST') {
      if (!this.workflowEngine) this.initWorkflowEngine();
      const body = await this.readBody(req);
      const action = body['action'] as string;
      if (action === 'validate') {
        const errors = this.workflowEngine!.validate(body['workflow'] as WorkflowDefinition);
        this.json(res, 200, { valid: errors.length === 0, errors, _deprecated: 'Use POST /api/teams/:teamId/workflows/:name/runs instead' });
        return;
      }
      try {
        const execution = await this.workflowEngine!.start(
          body['workflow'] as WorkflowDefinition,
          (body['inputs'] as Record<string, unknown>) ?? {}
        );
        this.json(res, 201, {
          executionId: execution.id,
          status: execution.status,
          outputs: execution.outputs,
          error: execution.error,
          _deprecated: 'Use POST /api/teams/:teamId/workflows/:name/runs instead',
        });
      } catch (err) {
        this.json(res, 400, { error: String(err) });
      }
      return;
    }

    if (path.startsWith('/api/workflows/') && req.method === 'GET') {
      if (!this.workflowEngine) {
        this.json(res, 404, { error: 'No workflow engine' });
        return;
      }
      const executionId = path.split('/')[3]!;
      const execution = this.workflowEngine.getExecution(executionId);
      if (!execution) {
        this.json(res, 404, { error: 'Execution not found' });
        return;
      }
      const steps = [...execution.steps.entries()].map(([id, s]) => ({
        id,
        status: s.status,
        agentId: s.agentId,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
        error: s.error,
        retryCount: s.retryCount,
        output: s.output,
      }));
      this.json(res, 200, { execution: { ...execution, steps } });
      return;
    }

    if (path.startsWith('/api/workflows/') && req.method === 'DELETE') {
      if (!this.workflowEngine) {
        this.json(res, 404, { error: 'No workflow engine' });
        return;
      }
      const executionId = path.split('/')[3]!;
      const cancelled = this.workflowEngine.cancel(executionId);
      this.json(res, 200, { cancelled });
      return;
    }

    // ── Team Templates ───────────────────────────────────────────────────
    if (path === '/api/team-templates' && req.method === 'GET') {
      const query = url.searchParams.get('q');
      const templates = query
        ? this.teamTemplateRegistry.search(query)
        : this.teamTemplateRegistry.list();
      this.json(res, 200, { templates });
      return;
    }

    if (path === '/api/team-templates' && req.method === 'POST') {
      const body = await this.readBody(req);
      const tpl = body as unknown as {
        id: string;
        name: string;
        description: string;
        version: string;
        author: string;
        members: Array<{
          templateId: string;
          name?: string;
          count?: number;
          role?: 'manager' | 'worker';
        }>;
        tags?: string[];
        category?: string;
      };
      if (!tpl.name || !tpl.members?.length) {
        this.json(res, 400, { error: 'name and members are required' });
        return;
      }
      tpl.id = tpl.id || generateId('team');
      tpl.version = tpl.version || '1.0.0';
      tpl.author = tpl.author || 'user';
      this.teamTemplateRegistry.register(tpl);
      this.json(res, 201, { template: tpl });
      return;
    }

    if (path.match(/^\/api\/team-templates\/[^/]+\/files$/) && req.method === 'GET') {
      const id = path.split('/')[3]!;
      const tpl = this.teamTemplateRegistry.get(id);
      if (!tpl) {
        this.json(res, 404, { error: 'Team template not found' });
        return;
      }
      const { existsSync: ex, readFileSync: rf, readdirSync: rd } = await import('node:fs');
      const envTemplates = process.env['MARKUS_TEMPLATES_DIR'];
      const rolesDir = envTemplates ? resolve(envTemplates, 'roles') : resolve(process.cwd(), 'templates', 'roles');
      const rolesCandidates = [rolesDir];
      if (!envTemplates) {
        try {
          const thisFile = (await import('node:url')).fileURLToPath(import.meta.url);
          const thisDir = (await import('node:path')).dirname(thisFile);
          rolesCandidates.unshift(resolve(thisDir, '..', 'templates', 'roles'));
          rolesCandidates.push(resolve(thisDir, '..', '..', '..', '..', 'templates', 'roles'));
        } catch { /* skip */ }
      }
      const rolesRoot = rolesCandidates.find(d => ex(d)) ?? rolesDir;
      const files: Record<string, string> = {};
      for (const [idx, member] of tpl.members.entries()) {
        const roleName = member.roleName;
        if (!roleName) continue;
        const memberSlug = kebab(member.name ?? roleName, 'member-' + idx);
        const roleDir = resolve(rolesRoot, roleName);
        if (!ex(roleDir)) continue;
        try {
          for (const entry of rd(roleDir, { withFileTypes: true })) {
            if (entry.isFile() && !entry.name.endsWith('.json')) {
              try { files[`members/${memberSlug}/${entry.name}`] = rf(resolve(roleDir, entry.name), 'utf-8'); } catch { /* skip */ }
            }
          }
        } catch { /* skip */ }
      }
      this.json(res, 200, { files });
      return;
    }

    if (path.startsWith('/api/team-templates/') && req.method === 'GET') {
      const id = path.split('/')[3]!;
      const tpl = this.teamTemplateRegistry.get(id);
      if (!tpl) {
        this.json(res, 404, { error: 'Team template not found' });
        return;
      }
      this.json(res, 200, { template: tpl });
      return;
    }

    if (path.startsWith('/api/team-templates/') && req.method === 'DELETE') {
      const id = path.split('/')[3]!;
      this.teamTemplateRegistry.unregister(id);
      this.json(res, 200, { deleted: true });
      return;
    }

    // System: open a directory in the native file manager
    if (path === '/api/system/open-path' && req.method === 'POST') {
      try {
        const body = await this.readBody(req);
        const dirPath = body['path'] as string;
        if (!dirPath || !existsSync(dirPath)) {
          this.json(res, 400, { error: 'Invalid or non-existent path' });
          return;
        }
        const { spawn: spawnChild } = await import('node:child_process');
        const plat = process.platform;
        if (plat === 'darwin') {
          spawnChild('open', [dirPath], { detached: true, stdio: 'ignore' }).unref();
        } else if (plat === 'win32') {
          spawnChild('explorer', [dirPath], { detached: true, stdio: 'ignore', shell: true }).unref();
        } else {
          spawnChild('xdg-open', [dirPath], { detached: true, stdio: 'ignore' }).unref();
        }
        this.json(res, 200, { ok: true });
      } catch {
        this.json(res, 500, { error: 'Failed to open path' });
      }
      return;
    }

    // Health
    if (path === '/api/health') {
      const health: Record<string, unknown> = {
        status: 'ok',
        version: APP_VERSION,
        agents: this.orgService.getAgentManager().listAgents().length,
      };
      // Non-blocking update check — cached, so normally instant after first call
      try {
        const update = await checkForUpdate();
        if (update.updateAvailable) {
          health.latestVersion = update.latestVersion;
          health.updateAvailable = true;
        }
      } catch { /* never fail health check for this */ }
      this.json(res, 200, health);
      return;
    }

    // ── Governance: System Controls ──────────────────────────────────────────

    if (path === '/api/system/pause-all' && req.method === 'POST') {
      const body = await this.readBody(req);
      const authUser = await this.getAuthUser(req);
      const am = this.orgService.getAgentManager();
      await am.stopAllAgents(body['reason'] as string | undefined);
      this.auditService?.record({
        orgId: 'system',
        type: 'system_pause_all',
        action: 'pause_all',
        detail: body['reason'] as string,
        userId: authUser?.userId,
        success: true,
      });
      this.json(res, 200, { status: 'stopped', message: 'All agents stopped' });
      return;
    }

    if (path === '/api/system/resume-all' && req.method === 'POST') {
      const authUser = await this.getAuthUser(req);
      const am = this.orgService.getAgentManager();
      await am.startAllAgents();
      this.auditService?.record({
        orgId: 'system',
        type: 'system_resume_all',
        action: 'resume_all',
        userId: authUser?.userId,
        success: true,
      });
      this.json(res, 200, { status: 'started', message: 'All agents started' });
      return;
    }

    if (path === '/api/system/emergency-stop' && req.method === 'POST') {
      const authUser = await this.getAuthUser(req);
      const am = this.orgService.getAgentManager();
      await am.emergencyStop();
      this.auditService?.record({
        orgId: 'system',
        type: 'system_emergency_stop',
        action: 'emergency_stop',
        userId: authUser?.userId,
        success: true,
      });
      this.json(res, 200, { status: 'stopped', message: 'EMERGENCY STOP — all agents terminated' });
      return;
    }

    if (path === '/api/system/status' && req.method === 'GET') {
      const am = this.orgService.getAgentManager();
      this.json(res, 200, {
        globalPaused: am.isGlobalStopped(),
        emergencyMode: am.isEmergencyMode(),
      });
      return;
    }

    if (path === '/api/system/storage' && req.method === 'GET') {
      try {
        const dataDir = join(homedir(), '.markus');
        const result = this.collectStorageInfo(dataDir);
        this.json(res, 200, result);
      } catch (err) {
        this.json(res, 500, { error: `Storage scan failed: ${String(err)}` });
      }
      return;
    }

    if (path === '/api/system/storage/orphans' && req.method === 'GET') {
      try {
        const result = this.detectOrphans();
        this.json(res, 200, result);
      } catch (err) {
        this.json(res, 500, { error: `Orphan detection failed: ${String(err)}` });
      }
      return;
    }

    if (path === '/api/system/storage/orphans' && req.method === 'DELETE') {
      try {
        const body = await this.readBody(req);
        const ids = Array.isArray(body?.ids) ? body.ids as string[] : undefined;
        const result = this.purgeOrphans(ids);
        this.json(res, 200, result);
      } catch (err) {
        this.json(res, 500, { error: `Orphan cleanup failed: ${String(err)}` });
      }
      return;
    }

    // ── Governance: Announcements ─────────────────────────────────────────

    if (path === '/api/system/announcements' && req.method === 'POST') {
      const body = await this.readBody(req);
      const authUser = await this.getAuthUser(req);
      const am = this.orgService.getAgentManager();
      const announcement = {
        id: generateId('ann'),
        type: (body['type'] as string) ?? 'info',
        title: body['title'] as string,
        content: body['content'] as string,
        priority: (body['priority'] as string) ?? 'normal',
        createdBy: (body['createdBy'] as string) ?? 'human',
        createdAt: new Date().toISOString(),
        expiresAt: body['expiresAt'] as string | undefined,
        targetScope: (body['targetScope'] as string) ?? 'all',
        targetIds: body['targetIds'] as string[] | undefined,
        acknowledged: [],
      };
      am.broadcastAnnouncement(announcement as any);
      this.auditService?.record({
        orgId: 'system',
        type: 'announcement_broadcast',
        action: 'broadcast',
        detail: announcement.title,
        userId: authUser?.userId,
        success: true,
      });
      this.json(res, 201, { announcement });
      return;
    }

    if (path === '/api/system/announcements' && req.method === 'GET') {
      const am = this.orgService.getAgentManager();
      this.json(res, 200, { announcements: am.getActiveAnnouncements() });
      return;
    }

    // ── File existence batch check ──────────────────────────────────────────

    if (path === '/api/files/check' && req.method === 'POST') {
      const body = await this.readBody(req);
      const paths = body?.paths as string[] | undefined;
      if (!Array.isArray(paths) || paths.length === 0) {
        this.json(res, 400, { error: 'Missing "paths" array in request body' });
        return;
      }

      try {
        const { resolve, extname } = await import('node:path');
        const { existsSync, statSync } = await import('node:fs');
        const { homedir } = await import('node:os');
        const home = homedir();

        const results: Record<string, { exists: boolean; isFile: boolean; type: string }> = {};
        const mdExts = ['.md', '.markdown'];
        const htmlExts = ['.html', '.htm'];
        const jsonExts = ['.json'];
        const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];

        for (const p of paths.slice(0, 50)) {
          try {
            const expanded = p.startsWith('~/') ? resolve(home, p.slice(2)) : p === '~' ? home : p;
            const resolved = resolve(expanded);
            if (!existsSync(resolved)) {
              results[p] = { exists: false, isFile: false, type: 'unknown' };
              continue;
            }
            const stat = statSync(resolved);
            const isFile = stat.isFile();
            const ext = extname(resolved).toLowerCase();
            let type = 'text';
            if (mdExts.includes(ext)) type = 'markdown';
            else if (htmlExts.includes(ext)) type = 'html';
            else if (jsonExts.includes(ext)) type = 'json';
            else if (imageExts.includes(ext)) type = 'image';
            else if (!isFile) type = 'directory';
            results[p] = { exists: true, isFile, type };
          } catch {
            results[p] = { exists: false, isFile: false, type: 'unknown' };
          }
        }

        this.json(res, 200, { results });
      } catch (err) {
        this.json(res, 500, { error: `Failed to check files: ${String(err)}` });
      }
      return;
    }

    // ── File preview ──────────────────────────────────────────────────────

    if (path === '/api/files/preview' && req.method === 'GET') {
      const filePath = url.searchParams.get('path');
      if (!filePath) {
        this.json(res, 400, { error: 'Missing "path" query parameter' });
        return;
      }

      try {
        const { resolve, extname } = await import('node:path');
        const { readFileSync, existsSync, statSync } = await import('node:fs');
        const { homedir } = await import('node:os');
        const home = homedir();
        const expanded = filePath.startsWith('~/') ? resolve(home, filePath.slice(2)) : filePath === '~' ? home : filePath;
        const resolved = resolve(expanded);

        if (!existsSync(resolved)) {
          this.json(res, 404, { error: 'File not found' });
          return;
        }

        const stat = statSync(resolved);
        if (stat.isDirectory()) {
          const { readdirSync } = await import('node:fs');
          const { join, extname: extDir } = await import('node:path');
          const entries = readdirSync(resolved, { withFileTypes: true })
            .filter(e => !e.name.startsWith('.'))
            .map(e => {
              const full = join(resolved, e.name);
              const isDir = e.isDirectory();
              let size: number | undefined;
              try { if (!isDir) size = statSync(full).size; } catch { /* skip */ }
              return { name: e.name, path: full, isDirectory: isDir, size, ext: isDir ? '' : extDir(e.name).toLowerCase() };
            })
            .sort((a, b) => {
              if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
              return a.name.localeCompare(b.name);
            });
          this.json(res, 200, { type: 'directory', name: resolved.split('/').pop(), path: resolved, entries });
          return;
        }
        if (!stat.isFile()) {
          this.json(res, 400, { error: 'Path is not a file' });
          return;
        }

        const maxSize = 2 * 1024 * 1024; // 2MB limit
        if (stat.size > maxSize) {
          this.json(res, 413, { error: 'File too large for preview', size: stat.size, maxSize });
          return;
        }

        const ext = extname(resolved).toLowerCase();
        const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
        if (imageExts.includes(ext)) {
          const data = readFileSync(resolved);
          const mimeMap: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
          this.json(res, 200, {
            type: 'image',
            name: resolved.split('/').pop(),
            mimeType: mimeMap[ext] ?? 'application/octet-stream',
            content: data.toString('base64'),
          });
        } else {
          const content = readFileSync(resolved, 'utf-8');
          const mdExts = ['.md', '.markdown'];
          const htmlExts = ['.html', '.htm'];
          const jsonExts = ['.json'];
          const csvExts = ['.csv', '.tsv'];
          let fileType = 'text';
          if (mdExts.includes(ext)) fileType = 'markdown';
          else if (htmlExts.includes(ext)) fileType = 'html';
          else if (jsonExts.includes(ext)) fileType = 'json';
          else if (csvExts.includes(ext)) fileType = 'csv';
          this.json(res, 200, {
            type: fileType,
            name: resolved.split('/').pop(),
            content,
          });
        }
      } catch (err) {
        this.json(res, 500, { error: `Failed to read file: ${String(err)}` });
      }
      return;
    }

    // GET /api/files/image?path=... — serve local image as raw binary (for markdown rendering)
    if (path === '/api/files/image' && req.method === 'GET') {
      const filePath = url.searchParams.get('path');
      if (!filePath) {
        this.json(res, 400, { error: 'Missing "path" query parameter' });
        return;
      }
      try {
        const { resolve, extname } = await import('node:path');
        const { readFileSync, existsSync, statSync } = await import('node:fs');
        const { homedir } = await import('node:os');
        const home = homedir();
        const expanded = filePath.startsWith('~/') ? resolve(home, filePath.slice(2)) : filePath === '~' ? home : filePath;
        const resolved = resolve(expanded);

        if (!existsSync(resolved) || !statSync(resolved).isFile()) {
          this.json(res, 404, { error: 'Image not found' });
          return;
        }
        const maxSize = 10 * 1024 * 1024;
        if (statSync(resolved).size > maxSize) {
          this.json(res, 413, { error: 'Image too large' });
          return;
        }
        const ext = extname(resolved).toLowerCase();
        const mimeMap: Record<string, string> = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
          '.bmp': 'image/bmp', '.ico': 'image/x-icon',
        };
        const mime = mimeMap[ext];
        if (!mime) {
          this.json(res, 400, { error: 'Not an image file' });
          return;
        }
        const data = readFileSync(resolved);
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Length': data.length,
          'Cache-Control': 'private, max-age=300',
        });
        res.end(data);
      } catch (err) {
        this.json(res, 500, { error: `Failed to read image: ${String(err)}` });
      }
      return;
    }

    if (path === '/api/files/reveal' && req.method === 'POST') {
      const body = await this.readBody(req);
      const filePath = body?.path as string | undefined;
      if (!filePath) {
        this.json(res, 400, { error: 'Missing "path" in request body' });
        return;
      }

      try {
        const { resolve, dirname } = await import('node:path');
        const { existsSync, statSync } = await import('node:fs');
        const { exec } = await import('node:child_process');
        const { homedir } = await import('node:os');
        const home = homedir();
        const expanded = filePath.startsWith('~/') ? resolve(home, filePath.slice(2)) : filePath === '~' ? home : filePath;
        const resolved = resolve(expanded);

        if (!existsSync(resolved)) {
          this.json(res, 404, { error: 'Path not found' });
          return;
        }

        const isDir = statSync(resolved).isDirectory();
        const platform = process.platform;

        let cmd: string;
        if (platform === 'darwin') {
          cmd = isDir ? `open "${resolved}"` : `open -R "${resolved}"`;
        } else if (platform === 'win32') {
          cmd = isDir ? `explorer "${resolved}"` : `explorer /select,"${resolved}"`;
        } else {
          cmd = `xdg-open "${isDir ? resolved : dirname(resolved)}"`;
        }

        exec(cmd, (err) => {
          if (err) {
            log.warn('Failed to reveal file in system browser', { path: resolved, error: String(err) });
          }
        });

        this.json(res, 200, { ok: true, path: resolved });
      } catch (err) {
        this.json(res, 500, { error: `Failed to reveal file: ${String(err)}` });
      }
      return;
    }

    if (await handleGovernanceRoutes(this, req, res, path, url)) return;

    // ── Governance: Knowledge (legacy, redirected to /api/deliverables) ────

    if (path === '/api/knowledge/search' && req.method === 'GET') {
      if (!this.deliverableService) { this.json(res, 200, { results: [] }); return; }
      const query = url.searchParams.get('query') ?? undefined;
      const { results } = this.deliverableService.search({ query });
      this.json(res, 200, { results });
      return;
    }

    if (path === '/api/knowledge' && req.method === 'POST') {
      if (!this.deliverableService) { this.json(res, 503, { error: 'Deliverable service not available' }); return; }
      const body = await this.readBody(req);
      try {
        const d = await this.deliverableService.create({
          type: 'file',
          title: body['title'] as string,
          summary: body['content'] as string,
          tags: body['tags'] as string[],
          agentId: body['source'] as string,
        });
        this.json(res, 201, { entry: d });
      } catch (err) {
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    if (path.match(/^\/api\/knowledge\/[^/]+\/flag-outdated$/) && req.method === 'POST') {
      if (!this.deliverableService) { this.json(res, 503, { error: 'Deliverable service not available' }); return; }
      const knowledgeId = path.split('/')[3]!;
      await this.deliverableService.flagOutdated(knowledgeId);
      this.json(res, 200, { status: 'flagged' });
      return;
    }

    if (path.match(/^\/api\/knowledge\/[^/]+\/verify$/) && req.method === 'POST') {
      if (!this.deliverableService) { this.json(res, 503, { error: 'Deliverable service not available' }); return; }
      const knowledgeId = path.split('/')[3]!;
      await this.deliverableService.update(knowledgeId, { status: 'verified' });
      this.json(res, 200, { status: 'verified' });
      return;
    }

    if (path.match(/^\/api\/knowledge\/[^/]+$/) && req.method === 'DELETE') {
      if (!this.deliverableService) { this.json(res, 503, { error: 'Deliverable service not available' }); return; }
      const knowledgeId = path.split('/')[3]!;
      await this.deliverableService.remove(knowledgeId);
      this.json(res, 200, { status: 'deleted' });
      return;
    }

    // Serve pre-built Web UI static files as SPA fallback
    if (this.webUiDir) {
      const safePath = path.replace(/\.\./g, '').replace(/\/\//g, '/');
      const filePath = join(this.webUiDir, safePath === '/' ? 'index.html' : safePath);
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        this.serveStaticFile(res, filePath, req);
        return;
      }
      // SPA fallback: serve index.html for non-API routes
      const indexPath = join(this.webUiDir, 'index.html');
      if (existsSync(indexPath) && !path.startsWith('/api/')) {
        this.serveStaticFile(res, indexPath, req);
        return;
      }
    }

    // ── 405 Method Not Allowed check ──────────────────────────────────────
    // If the path matches a known API route pattern but with wrong method
    if (path.startsWith('/api/') && req.method) {
      const routeMatch = this.checkMethodAllowed(path, req.method);
      if (routeMatch) {
        res.setHeader('Allow', routeMatch.join(', '));
        this.json(res, 405, { error: 'Method Not Allowed' });
        return;
      }
    }

    this.json(res, 404, { error: 'Not found' });
  }

  /** Build path → allowed methods table (compiled once) */
  static buildRouteTable(): Array<{ test: (path: string) => boolean; methods: string[] }> {
    // Helper: exact path match
    const exact = (p: string, ...methods: string[]) => ({
      test: (path: string) => path === p,
      methods,
    });
    // Helper: regex path match (from raw regex string)
    const regex = (pattern: RegExp, ...methods: string[]) => ({
      test: (path: string) => pattern.test(path),
      methods,
    });
    // Helper: startsWith path match
    const startsWith = (prefix: string, ...methods: string[]) => ({
      test: (path: string) => path.startsWith(prefix),
      methods,
    });

    return [
      // ── Auth ─────────────────────────────────────────────────────────────
      exact('/api/auth/login', 'POST'),
      exact('/api/auth/hub-login', 'POST'),
      exact('/api/auth/logout', 'POST'),
      exact('/api/auth/me', 'GET'),
      exact('/api/auth/change-password', 'POST'),
      exact('/api/auth/setup', 'POST'),
      exact('/api/auth/invite-info', 'GET'),
      exact('/api/auth/profile', 'PUT'),

      // ── Avatars ──────────────────────────────────────────────────────────
      exact('/api/avatars/upload', 'POST'),
      startsWith('/api/avatars/', 'GET'),

      // ── Uploads ───────────────────────────────────────────────────────────
      exact('/api/uploads', 'POST'),
      startsWith('/api/uploads/', 'GET'),

      // ── Agents ───────────────────────────────────────────────────────────
      exact('/api/agents', 'GET', 'POST'),
      exact('/api/agents/role-updates', 'GET'),
      regex(/^\/api\/agents\/[^/]+\/sessions$/, 'GET'),
      regex(/^\/api\/agents\/[^/]+\/(start|stop|pause|resume|cancel-processing|daily-report|a2a|message)$/, 'POST'),
      regex(/^\/api\/agents\/[^/]+$/, 'GET', 'DELETE'),
      regex(/^\/api\/agents\/[^/]+\/mind$/, 'GET'),
      regex(/^\/api\/agents\/[^/]+\/mailbox$/, 'GET'),
      regex(/^\/api\/agents\/[^/]+\/decisions$/, 'GET'),
      regex(/^\/api\/agents\/[^/]+\/metrics$/, 'GET'),
      regex(/^\/api\/agents\/[^/]+\/config$/, 'PATCH'),
      regex(/^\/api\/agents\/[^/]+\/memory$/, 'GET'),
      regex(/^\/api\/agents\/[^/]+\/memory\/sessions\/[^/]+$/, 'GET'),
      regex(/^\/api\/agents\/[^/]+\/memory\/daily$/, 'PUT'),
      regex(/^\/api\/agents\/[^/]+\/memory\/longterm$/, 'PUT'),
      regex(/^\/api\/agents\/[^/]+\/files$/, 'GET'),
      regex(/^\/api\/agents\/[^/]+\/files\/[^/]+$/, 'PUT'),
      regex(/^\/api\/agents\/[^/]+\/system-prompt$/, 'PUT'),
      regex(/^\/api\/agents\/[^/]+\/role-status$/, 'GET'),
      regex(/^\/api\/agents\/[^/]+\/role-diff$/, 'GET'),
      regex(/^\/api\/agents\/[^/]+\/role-sync$/, 'POST'),
      regex(/^\/api\/agents\/[^/]+\/role-smart-sync$/, 'POST'),
      regex(/^\/api\/agents\/[^/]+\/skills$/, 'POST'),
      regex(/^\/api\/agents\/[^/]+\/skills\/[^/]+$/, 'DELETE'),
      regex(/^\/api\/agents\/[^/]+\/tools\/[^/]+\/toggle$/, 'POST'),
      regex(/^\/api\/agents\/[^/]+\/activities$/, 'GET'),
      regex(/^\/api\/agents\/[^/]+\/recent-activities$/, 'GET'),
      regex(/^\/api\/agents\/[^/]+\/activity-logs$/, 'GET'),
      regex(/^\/api\/agents\/[^/]+\/heartbeat$/, 'GET'),
      regex(/^\/api\/agents\/[^/]+\/heartbeat\/trigger$/, 'POST'),

      // ── Sessions / Channels ──────────────────────────────────────────────
      regex(/^\/api\/sessions\/[^/]+\/messages$/, 'GET'),
      regex(/^\/api\/sessions\/[^/]+$/, 'DELETE'),
      regex(/^\/api\/channels\/[^/]+\/messages$/, 'GET', 'POST'),

      // ── Group Chats ──────────────────────────────────────────────────────
      exact('/api/group-chats', 'GET', 'POST'),
      regex(/^\/api\/group-chats\/[^/]+$/, 'GET', 'PATCH', 'DELETE'),
      regex(/^\/api\/group-chats\/[^/]+\/members$/, 'POST'),
      regex(/^\/api\/group-chats\/[^/]+\/members\/[^/]+$/, 'DELETE'),

      // ── Teams ────────────────────────────────────────────────────────────
      exact('/api/teams', 'GET', 'POST'),
      regex(/^\/api\/teams\/[^/]+$/, 'PATCH', 'DELETE'),
      regex(/^\/api\/teams\/[^/]+\/members$/, 'POST'),
      regex(/^\/api\/teams\/[^/]+\/members\/[^/]+$/, 'DELETE'),
      regex(/^\/api\/teams\/[^/]+\/(start|stop|pause|resume)$/, 'POST'),
      regex(/^\/api\/teams\/[^/]+\/status$/, 'GET'),
      regex(/^\/api\/teams\/[^/]+\/files$/, 'GET'),
      regex(/^\/api\/teams\/[^/]+\/files\/[^/]+$/, 'GET', 'PUT'),
      regex(/^\/api\/teams\/[^/]+\/export$/, 'GET'),

      // ── Roles ────────────────────────────────────────────────────────────
      exact('/api/roles', 'GET'),
      startsWith('/api/roles/', 'GET'),

      // ── Tasks ───────────────────────────────────────────────────────────
      exact('/api/tasks', 'GET', 'POST'),
      exact('/api/tasks/scheduled', 'GET'),
      exact('/api/tasks/deliverables', 'GET'),
      exact('/api/tasks/dashboard', 'GET'),
      exact('/api/taskboard', 'GET'),
      exact('/api/ops/dashboard', 'GET'),
      regex(/^\/api\/tasks\/[^/]+$/, 'GET'),
      regex(/^\/api\/tasks\/[^/]+$/, 'PUT', 'DELETE'),
      regex(/^\/api\/tasks\/[^/]+\/approve$/, 'POST'),
      regex(/^\/api\/tasks\/[^/]+\/reject$/, 'POST'),
      regex(/^\/api\/tasks\/[^/]+\/cancel$/, 'POST'),
      regex(/^\/api\/tasks\/[^/]+\/context$/, 'GET'),
      regex(/^\/api\/tasks\/[^/]+\/dependents$/, 'GET'),
      regex(/^\/api\/tasks\/[^/]+\/run$/, 'POST'),
      regex(/^\/api\/tasks\/[^/]+\/subtasks$/, 'GET', 'POST'),
      regex(/^\/api\/tasks\/[^/]+\/subtasks\/[^/]+$/, 'DELETE'),
      regex(/^\/api\/tasks\/[^/]+\/subtasks\/[^/]+\/(complete|cancel)$/, 'POST'),
      regex(/^\/api\/tasks\/[^/]+\/comments$/, 'GET', 'POST'),
      regex(/^\/api\/tasks\/[^/]+\/history$/, 'GET'),
      regex(/^\/api\/tasks\/[^/]+\/pause$/, 'POST'),
      regex(/^\/api\/tasks\/[^/]+\/resume$/, 'POST'),
      regex(/^\/api\/tasks\/[^/]+\/retry$/, 'POST'),
      regex(/^\/api\/tasks\/[^/]+\/revision$/, 'POST'),
      regex(/^\/api\/tasks\/[^/]+\/accept$/, 'POST'),
      regex(/^\/api\/tasks\/[^/]+\/archive$/, 'POST'),
      regex(/^\/api\/tasks\/[^/]+\/schedule$/, 'PUT'),
      regex(/^\/api\/tasks\/[^/]+\/schedule\/pause$/, 'POST'),
      regex(/^\/api\/tasks\/[^/]+\/schedule\/resume$/, 'POST'),
      regex(/^\/api\/tasks\/[^/]+\/schedule\/run-now$/, 'POST'),
      regex(/^\/api\/tasks\/[^/]+\/logs$/, 'GET'),
      regex(/^\/api\/tasks\/[^/]+\/logs\/summary$/, 'GET'),

      // ── Execution ────────────────────────────────────────────────────────
      exact('/api/execution-logs', 'GET'),

      // ── Deliverables / Knowledge ─────────────────────────────────────────
      exact('/api/deliverables', 'GET', 'POST'),
      exact('/api/deliverables/health', 'GET'),
      regex(/^\/api\/deliverables\/[^/]+$/, 'GET', 'PUT', 'DELETE'),
      exact('/api/knowledge', 'POST'),
      exact('/api/knowledge/search', 'GET'),
      regex(/^\/api\/knowledge\/[^/]+$/, 'DELETE'),
      regex(/^\/api\/knowledge\/[^/]+\/flag-outdated$/, 'POST'),
      regex(/^\/api\/knowledge\/[^/]+\/verify$/, 'POST'),

      // ── Reviews ──────────────────────────────────────────────────────────
      exact('/api/reviews', 'GET', 'POST'),
      regex(/^\/api\/reviews\/[^/]+$/, 'GET'),

      // ── Requirements ─────────────────────────────────────────────────────
      exact('/api/requirements', 'GET', 'POST'),
      regex(/^\/api\/requirements\/[^/]+$/, 'GET', 'PUT', 'DELETE'),
      regex(/^\/api\/requirements\/[^/]+\/status$/, 'POST'),
      regex(/^\/api\/requirements\/[^/]+\/approve$/, 'POST'),
      regex(/^\/api\/requirements\/[^/]+\/reject$/, 'POST'),
      regex(/^\/api\/requirements\/[^/]+\/cancel$/, 'POST'),
      regex(/^\/api\/requirements\/[^/]+\/comments$/, 'GET', 'POST'),
      regex(/^\/api\/requirements\/[^/]+\/history$/, 'GET'),

      // ── Projects ─────────────────────────────────────────────────────────
      exact('/api/projects', 'GET', 'POST'),
      regex(/^\/api\/projects\/[^/]+$/, 'GET', 'PUT', 'DELETE'),

      // ── Notifications ────────────────────────────────────────────────────
      exact('/api/notifications', 'GET'),
      exact('/api/notifications/mark-all-read', 'POST'),
      startsWith('/api/notifications/', 'POST'),

      // ── Message search ──────────────────────────────────────────────────
      exact('/api/messages/search', 'GET'),

      // ── Activity feed ─────────────────────────────────────────────────
      exact('/api/activity', 'GET'),

      // ── Users ────────────────────────────────────────────────────────────
      exact('/api/users', 'GET', 'POST'),
      regex(/^\/api\/users\/[^/]+$/, 'PATCH'),
      regex(/^\/api\/users\/[^/]+\/reset-password$/, 'POST'),
      regex(/^\/api\/users\/[^/]+\/reinvite$/, 'POST'),
      startsWith('/api/users/', 'DELETE'),

      // ── API Keys ─────────────────────────────────────────────────────────
      exact('/api/keys', 'GET', 'POST'),
      startsWith('/api/keys/', 'DELETE'),

      // ── Orgs ─────────────────────────────────────────────────────────────
      exact('/api/orgs', 'GET', 'POST'),

      // ── Message ──────────────────────────────────────────────────────────
      exact('/api/message', 'POST'),

      // ── Skills ──────────────────────────────────────────────────────────
      exact('/api/skills', 'GET'),
      exact('/api/skills/builtin', 'GET'),
      exact('/api/skills/install', 'POST'),
      exact('/api/skills/registry', 'GET'),
      exact('/api/skills/registry/skillhub', 'GET'),
      exact('/api/skills/registry/skillssh', 'GET'),
      regex(/^\/api\/skills\/[^/]+$/, 'GET'),
      regex(/^\/api\/skills\/[^/]+\/files$/, 'GET'),
      startsWith('/api/skills/installed/', 'DELETE'),
      // ── Model Catalog ──────────────────────────────────────────────────────
      exact('/api/models/catalog', 'GET'),
      regex(/^\/api\/models\/catalog\/[^/]+$/, 'GET'),
      exact('/api/models/catalog/refresh', 'POST'),
      exact('/api/models/validate-key', 'POST'),
      regex(/^\/api\/models\/live\/[^/]+$/, 'GET'),
      // ── Settings ─────────────────────────────────────────────────────────
      exact('/api/license', 'GET'),
      exact('/api/license/refresh', 'POST'),
      exact('/api/license/activate', 'POST'),
      exact('/api/license/trial', 'POST'),
      exact('/api/license/import', 'POST'),
      exact('/api/license/deactivate', 'POST'),
      exact('/api/settings/telemetry', 'GET', 'POST'),
      exact('/api/settings/hub', 'GET'),
      exact('/api/settings/hub-token', 'POST'),
      exact('/api/settings/llm', 'GET', 'POST'),
      exact('/api/settings/llm/models', 'GET'),
      exact('/api/settings/agent', 'GET', 'POST'),
      exact('/api/settings/network', 'GET', 'POST'),
      exact('/api/settings/browser', 'GET', 'POST'),
      exact('/api/settings/browser/check', 'GET'),
      exact('/api/settings/browser/test-auto-click', 'POST'),
      exact('/api/settings/browser/test-concurrent', 'POST', 'DELETE'),
      exact('/api/settings/search', 'GET', 'POST'),
      exact('/api/settings/env-models', 'GET', 'POST'),
      exact('/api/settings/detect-ollama', 'GET'),
      exact('/api/settings/export', 'POST'),
      exact('/api/settings/import', 'POST'),
      exact('/api/settings/import/openclaw', 'POST'),
      regex(/^\/api\/settings\/llm\/providers\/[^/]+$/, 'PATCH', 'PUT', 'DELETE'),
      exact('/api/settings/llm/providers', 'POST'),
      regex(/^\/api\/settings\/llm\/providers\/[^/]+\/models$/, 'POST'),
      regex(/^\/api\/settings\/llm\/providers\/[^/]+\/models\/[^/]+$/, 'DELETE'),
      regex(/^\/api\/settings\/llm\/providers\/[^/]+\/model$/, 'POST'),
      regex(/^\/api\/settings\/llm\/providers\/[^/]+\/toggle$/, 'POST'),
      regex(/^\/api\/settings\/llm\/providers\/[^/]+\/test$/, 'POST'),
      exact('/api/settings/oauth/providers', 'GET'),
      exact('/api/settings/oauth/profiles', 'GET'),
      exact('/api/settings/oauth/login', 'POST'),
      exact('/api/settings/oauth/callback', 'POST'),
      exact('/api/settings/oauth/status', 'GET'),
      regex(/^\/api\/settings\/oauth\/profiles\/[^/]+$/, 'DELETE'),
      exact('/api/settings/oauth/setup-token', 'POST'),

      // ── Integrations ────────────────────────────────────────────────────
      exact('/api/settings/integrations/feishu', 'GET', 'POST', 'DELETE'),
      exact('/api/settings/integrations/feishu/test', 'POST'),
      exact('/api/settings/integrations/feishu/notifications', 'GET', 'PUT'),

      // ── Approvals ────────────────────────────────────────────────────────
      exact('/api/approvals', 'GET', 'POST'),
      startsWith('/api/approvals/', 'POST'),

      // ── Usage ────────────────────────────────────────────────────────────
      exact('/api/usage', 'GET'),
      exact('/api/usage/agents', 'GET'),

      // ── Audit ────────────────────────────────────────────────────────────
      exact('/api/audit', 'GET'),
      exact('/api/audit/summary', 'GET'),
      exact('/api/audit/tokens', 'GET'),

      // ── Plan ─────────────────────────────────────────────────────────────
      exact('/api/plan', 'GET', 'POST'),

      // ── Reports ──────────────────────────────────────────────────────────
      exact('/api/reports', 'GET'),
      exact('/api/reports/generate', 'POST'),
      regex(/^\/api\/reports\/[^/]+$/, 'GET'),
      regex(/^\/api\/reports\/[^/]+\/plan\/approve$/, 'POST'),
      regex(/^\/api\/reports\/[^/]+\/plan\/reject$/, 'POST'),
      regex(/^\/api\/reports\/[^/]+\/feedback$/, 'GET', 'POST'),

      // ── Gateway ──────────────────────────────────────────────────────────
      exact('/api/gateway/info', 'GET'),
      exact('/api/gateway/register', 'POST'),
      exact('/api/gateway/auth', 'POST'),
      exact('/api/gateway/message', 'POST'),
      exact('/api/gateway/status', 'GET'),
      exact('/api/gateway/manual', 'GET'),
      exact('/api/gateway/team', 'GET'),
      exact('/api/gateway/projects', 'GET'),
      exact('/api/gateway/requirements', 'GET'),
      exact('/api/gateway/deliverables', 'GET', 'POST'),
      exact('/api/gateway/sync', 'POST'),
      regex(/^\/api\/gateway\/deliverables\/[^/]+$/, 'PUT'),
      regex(/^\/api\/gateway\/tasks\/([^/]+)\/(accept|progress|complete|fail|delegate|subtasks)$/, 'POST'),

      // ── Builder ──────────────────────────────────────────────────────────
      exact('/api/builder/artifacts', 'GET'),
      exact('/api/builder/artifacts/installed', 'GET'),
      exact('/api/builder/artifacts/save', 'POST'),
      exact('/api/builder/artifacts/import', 'POST'),
      regex(/^\/api\/builder\/artifacts\/(agents?|teams?|skills?)\/([^/]+)$/, 'GET', 'DELETE'),
      regex(/^\/api\/builder\/artifacts\/(agents?|teams?|skills?)\/([^/]+)\/install$/, 'POST'),
      regex(/^\/api\/builder\/artifacts\/(agents?|teams?|skills?)\/([^/]+)\/uninstall$/, 'POST'),
      regex(/^\/api\/builder\/artifacts\/(agents?|teams?|skills?)\/([^/]+)\/images$/, 'POST'),
      regex(/^\/api\/builder\/artifacts\/(agents?|teams?|skills?)\/([^/]+)\/images\/([^/]+)$/, 'GET', 'DELETE'),

      // ── Hub ──────────────────────────────────────────────────────────────
      exact('/api/hub/publish', 'POST'),
      startsWith('/api/hub/', 'GET', 'POST', 'PUT', 'PATCH'),

      // ── Templates ────────────────────────────────────────────────────────
      exact('/api/templates', 'GET'),
      exact('/api/templates/instantiate', 'POST'),
      exact('/api/templates/teams', 'GET'),
      regex(/^\/api\/templates\/[^/]+$/, 'GET'),

      // ── Team Templates ───────────────────────────────────────────────────
      exact('/api/team-templates', 'GET', 'POST'),
      startsWith('/api/team-templates/', 'GET', 'DELETE'),

      // ── Governance / Workflows ───────────────────────────────────────────
      exact('/api/governance/policy', 'GET', 'PUT'),
      exact('/api/workflows', 'GET', 'POST'),
      startsWith('/api/workflows/', 'GET', 'DELETE'),
      regex(/^\/api\/teams\/[^/]+\/workflows$/, 'GET', 'POST'),
      regex(/^\/api\/teams\/[^/]+\/workflows\/[^/]+$/, 'GET', 'PUT', 'DELETE'),
      regex(/^\/api\/teams\/[^/]+\/workflows\/[^/]+\/roles$/, 'GET'),
      regex(/^\/api\/teams\/[^/]+\/workflows\/[^/]+\/runs$/, 'GET', 'POST'),
      regex(/^\/api\/workflow-runs\/[^/]+$/, 'GET', 'DELETE'),

      // ── System ───────────────────────────────────────────────────────────
      exact('/api/health', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'),
      exact('/api/system/pause-all', 'POST'),
      exact('/api/system/resume-all', 'POST'),
      exact('/api/system/emergency-stop', 'POST'),
      exact('/api/system/status', 'GET'),
      exact('/api/system/storage', 'GET'),
      exact('/api/system/storage/orphans', 'GET', 'DELETE'),
      exact('/api/system/announcements', 'GET', 'POST'),
      exact('/api/system/open-path', 'POST'),

      // ── Files ────────────────────────────────────────────────────────────
      exact('/api/files/check', 'POST'),
      exact('/api/files/preview', 'GET'),
      exact('/api/files/image', 'GET'),
      exact('/api/files/reveal', 'POST'),

      // ── External Agents ──────────────────────────────────────────────────
      exact('/api/external-agents', 'GET'),
      exact('/api/external-agents/register', 'POST'),
      regex(/^\/api\/external-agents\/[^/]+$/, 'DELETE'),
    ];
  }

  /** Check if path matches a known route with wrong method; returns allowed methods if mismatch */
  private checkMethodAllowed(path: string, method: string): string[] | null {
    const table = APIServer.buildRouteTable();
    for (const entry of table) {
      if (entry.test(path)) {
        if (!entry.methods.includes(method)) {
          return entry.methods;
        }
      }
    }
    return null;
  }

  private serveStaticFile(res: ServerResponse, filePath: string, req?: IncomingMessage): void {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const MIME: Record<string, string> = {
      html: 'text/html; charset=utf-8',
      js: 'application/javascript; charset=utf-8',
      mjs: 'application/javascript; charset=utf-8',
      css: 'text/css; charset=utf-8',
      json: 'application/json; charset=utf-8',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      ico: 'image/x-icon',
      woff: 'font/woff',
      woff2: 'font/woff2',
      ttf: 'font/ttf',
      map: 'application/json',
    };
    const contentType = MIME[ext] ?? 'application/octet-stream';
    const body = readFileSync(filePath);
    const cacheControl = ext === 'html' ? 'no-cache' : 'public, max-age=31536000, immutable';

    const COMPRESSIBLE = new Set(['html', 'js', 'mjs', 'css', 'json', 'svg', 'map']);
    const acceptEncoding = req?.headers?.['accept-encoding'] ?? '';
    if (COMPRESSIBLE.has(ext) && body.byteLength > 1024 && typeof acceptEncoding === 'string' && acceptEncoding.includes('gzip')) {
      const compressed = gzipSync(body);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': compressed.byteLength,
        'Content-Encoding': 'gzip',
        'Cache-Control': cacheControl,
        'Vary': 'Accept-Encoding',
      });
      res.end(compressed);
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': body.byteLength,
      'Cache-Control': cacheControl,
    });
    res.end(body);
  }

  private projectService?: ProjectService;
  private reportService?: ReportService;
  private knowledgeService?: KnowledgeService;
  private deliverableService?: DeliverableService;
  private requirementService?: RequirementService;

  setProjectService(svc: ProjectService): void {
    this.projectService = svc;
  }
  setReportService(svc: ReportService): void {
    this.reportService = svc;
  }
  setKnowledgeService(svc: KnowledgeService): void {
    this.knowledgeService = svc;
  }
  setDeliverableService(svc: DeliverableService): void {
    this.deliverableService = svc;
  }
  setRequirementService(svc: RequirementService): void {
    this.requirementService = svc;
  }
  setWorkflowService(svc: WorkflowService): void {
    this.workflowService = svc;
  }
  setWorkflowRunner(runner: WorkflowRunner): void {
    this.workflowRunner = runner;
  }

  private buildOpsDashboard(orgId: string | undefined, period: '1h' | '24h' | '7d') {
    const taskDashboard = this.taskService.getDashboard(orgId);

    // Agent efficiency ranking with health scores
    const agentManager = this.orgService.getAgentManager();
    const allAgents = agentManager.listAgents();
    const agentRanking = allAgents
      .map(a => {
        try {
          const agent = agentManager.getAgent(a.id);
          const metrics = agent.getMetrics(period);
          return {
            agentId: a.id,
            agentName: a.name,
            role: a.role,
            agentRole: a.agentRole,
            status: a.status,
            healthScore: metrics.healthScore,
            tokenUsage: metrics.tokenUsage,
            taskMetrics: metrics.taskMetrics,
            averageResponseTimeMs: metrics.averageResponseTimeMs,
            errorRate: metrics.errorRate,
            totalInteractions: metrics.totalInteractions,
          };
        } catch {
          return {
            agentId: a.id,
            agentName: a.name,
            role: a.role,
            agentRole: a.agentRole,
            status: a.status,
            healthScore: 0,
            tokenUsage: { input: 0, output: 0, cost: 0 },
            taskMetrics: { completed: 0, failed: 0, cancelled: 0, averageCompletionTimeMs: 0 },
            averageResponseTimeMs: 0,
            errorRate: 0,
            totalInteractions: 0,
          };
        }
      })
      .sort((a, b) => b.healthScore - a.healthScore);

    // System health summary
    const healthScores = agentRanking.map(a => a.healthScore);
    const avgHealth =
      healthScores.length > 0
        ? Math.round(healthScores.reduce((s, h) => s + h, 0) / healthScores.length)
        : 0;
    const criticalAgents = agentRanking.filter(a => a.healthScore < 50);
    const totalTokenCost = agentRanking.reduce((s, a) => s + a.tokenUsage.cost, 0);
    const totalInteractions = agentRanking.reduce((s, a) => s + a.totalInteractions, 0);

    const terminalTaskCount =
      taskDashboard.statusCounts.completed +
      taskDashboard.statusCounts.failed +
      taskDashboard.statusCounts.rejected;
    const taskSuccessRate =
      terminalTaskCount > 0
        ? Math.round((taskDashboard.statusCounts.completed / terminalTaskCount) * 100)
        : 0;

    const blockedTasks = taskDashboard.statusCounts.blocked ?? 0;

    return {
      period,
      generatedAt: new Date().toISOString(),
      systemHealth: {
        overallScore: avgHealth,
        activeAgents: allAgents.filter(a => a.status !== 'offline').length,
        totalAgents: allAgents.length,
        criticalAgents: criticalAgents.map(a => ({
          id: a.agentId,
          name: a.agentName,
          score: a.healthScore,
        })),
        totalTokenCost: Math.round(totalTokenCost * 10000) / 10000,
        totalInteractions,
      },
      taskKPI: {
        totalTasks: taskDashboard.totalTasks,
        statusCounts: taskDashboard.statusCounts,
        successRate: taskSuccessRate,
        blockedCount: blockedTasks,
        stuckBlockedCount: taskDashboard.stuckBlockedCount,
        averageCompletionTimeMs: taskDashboard.averageCompletionTimeMs,
        recentActivity: taskDashboard.recentActivity.slice(0, 10),
      },
      agentEfficiency: agentRanking,
    };
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    // Return cached body if already pre-read at route level (BUG-003/005)
    const cached: unknown = (req as any).__parsedBody__;
    if (cached !== undefined) {
      if (cached instanceof Error) return Promise.reject(cached);
      return Promise.resolve(cached as Record<string, unknown>);
    }

    return new Promise((resolve, reject) => {
      // BUG-005: Validate Content-Type for POST/PUT/PATCH requests
      const method = req.method ?? '';
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        const contentType = req.headers['content-type'];
        if (!contentType || !contentType.toLowerCase().includes('application/json')) {
          const err = new Error('CONTENT_TYPE_ERROR: Content-Type must be application/json');
          (req as any).__parsedBody__ = err;
          reject(err);
          return;
        }
      }

      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString();
          const parsed = JSON.parse(raw);
          // BUG-003: JSON literal null or array is not a valid request body
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            const err = new Error('BODY_PARSE_ERROR: Invalid request body');
            (req as any).__parsedBody__ = err;
            reject(err);
            return;
          }
          (req as any).__parsedBody__ = parsed;
          resolve(parsed as Record<string, unknown>);
        } catch {
          // Malformed JSON → treat as empty object (not 400)
          (req as any).__parsedBody__ = {};
          resolve({});
        }
      });
      req.on('error', reject);
    });
  }

  /** Resolve the role directory path for an agent. Uses roleId, normalized role name, or matching by display name. */
  private resolveAgentRoleDir(agent: {
    config: { id: string; roleId?: string };
    role: { name: string };
  }): string | null {
    // Prefer agent's own per-agent role directory (supports self-evolution)
    const agentDataDir = join(this.orgService.getAgentManager().getDataDir(), agent.config.id);
    const agentRoleDir = join(agentDataDir, 'role');
    if (existsSync(join(agentRoleDir, 'ROLE.md'))) return agentRoleDir;

    // Fall back to shared template directory
    const base = process.env['MARKUS_TEMPLATES_DIR']
      ? join(process.env['MARKUS_TEMPLATES_DIR'], 'roles')
      : join(process.cwd(), 'templates', 'roles');
    if (!existsSync(base)) return null;

    const tryDir = (dirName: string): string | null => {
      const p = join(base, dirName, 'ROLE.md');
      return existsSync(p) ? join(base, dirName) : null;
    };

    if (agent.config.roleId) {
      const d = tryDir(agent.config.roleId);
      if (d) return d;
    }

    const normalized = agent.role.name.toLowerCase().replace(/\s+/g, '-');
    const d = tryDir(normalized);
    if (d) return d;

    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rolePath = join(base, entry.name, 'ROLE.md');
      if (!existsSync(rolePath)) continue;
      try {
        const content = readFileSync(rolePath, 'utf-8');
        const match = content.match(/^#\s+(.+)$/m);
        const displayName = match?.[1]?.trim();
        if (displayName && displayName.toLowerCase() === agent.role.name.toLowerCase()) {
          return join(base, entry.name);
        }
      } catch {
        /* skip */
      }
    }
    return null;
  }

  private collectStorageInfo(dataDir: string) {
    const dirSize = (p: string, maxDepth = 3, depth = 0): number => {
      if (!existsSync(p)) return 0;
      try {
        const st = statSync(p);
        if (st.isFile()) return st.size;
        if (!st.isDirectory() || depth >= maxDepth) return 0;
        let total = 0;
        for (const entry of readdirSync(p, { withFileTypes: true })) {
          total += dirSize(join(p, entry.name), maxDepth, depth + 1);
        }
        return total;
      } catch { return 0; }
    };

    const topLevelItems: Array<{ name: string; path: string; size: number; description: string }> = [
      { name: 'Database', path: join(dataDir, 'data.db'), size: 0, description: 'SQLite database (tasks, agents, chat, etc.)' },
      { name: 'Agents', path: join(dataDir, 'agents'), size: 0, description: 'Agent workspaces, memory, role files, sessions' },
      { name: 'Skills', path: join(dataDir, 'skills'), size: 0, description: 'Installed skill packages' },
      { name: 'LLM Logs', path: join(dataDir, 'llm-logs'), size: 0, description: 'Daily LLM request/response audit logs' },
      { name: 'Builder Artifacts', path: join(dataDir, 'builder-artifacts'), size: 0, description: 'Agent, team, and skill build outputs' },
      { name: 'Teams', path: join(dataDir, 'teams'), size: 0, description: 'Team announcements and norms' },
      { name: 'Shared', path: join(dataDir, 'shared'), size: 0, description: 'Cross-agent shared files and task deliverables' },
      { name: 'Knowledge', path: join(dataDir, 'knowledge'), size: 0, description: 'File-based knowledge base entries' },
    ];

    for (const item of topLevelItems) {
      if (item.name === 'Database') {
        for (const ext of ['', '-wal', '-shm']) {
          const f = item.path + ext;
          if (existsSync(f)) { try { item.size += statSync(f).size; } catch { /* */ } }
        }
      } else {
        item.size = dirSize(item.path);
      }
    }

    const agentsDir = join(dataDir, 'agents');
    const agentInfos: Array<{ id: string; name: string; size: number; subItems: Array<{ name: string; size: number }> }> = [];
    const am = this.orgService.getAgentManager();

    if (existsSync(agentsDir)) {
      for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'vector-store') continue;
        const agentDir = join(agentsDir, entry.name);
        const agent = (() => { try { return am.getAgent(entry.name); } catch { return null; } })();
        const subItems = [
          { name: 'workspace', size: dirSize(join(agentDir, 'workspace')) },
          { name: 'memory', size: dirSize(join(agentDir, 'sessions')) + (existsSync(join(agentDir, 'memories.json')) ? statSync(join(agentDir, 'memories.json')).size : 0) + (existsSync(join(agentDir, 'MEMORY.md')) ? statSync(join(agentDir, 'MEMORY.md')).size : 0) },
          { name: 'role', size: dirSize(join(agentDir, 'role')) },
          { name: 'tool-outputs', size: dirSize(join(agentDir, 'tool-outputs')) },
          { name: 'daily-logs', size: dirSize(join(agentDir, 'daily-logs')) },
        ];
        agentInfos.push({
          id: entry.name,
          name: agent?.config?.name ?? entry.name,
          size: subItems.reduce((s, i) => s + i.size, 0),
          subItems,
        });
      }
    }
    agentInfos.sort((a, b) => b.size - a.size);

    const totalSize = topLevelItems.reduce((s, i) => s + i.size, 0);
    const dbItem = topLevelItems.find(i => i.name === 'Database')!;

    return {
      dataDir,
      totalSize,
      breakdown: topLevelItems,
      agents: agentInfos,
      database: { path: dbItem.path, size: dbItem.size },
    };
  }

  private detectOrphans() {
    const dataDir = join(homedir(), '.markus');
    const am = this.orgService.getAgentManager();
    const knownAgentIds = new Set(am.listAgents().map(a => a.id));
    const teams = this.orgService.listTeams('default');
    const knownTeamIds = new Set(teams.map(t => t.id));

    const orphanAgents: Array<{ id: string; path: string; size: number }> = [];
    const orphanTeams: Array<{ id: string; path: string; size: number }> = [];

    const dirSize = (p: string, maxDepth = 3, depth = 0): number => {
      if (!existsSync(p)) return 0;
      try {
        const st = statSync(p);
        if (st.isFile()) return st.size;
        if (!st.isDirectory() || depth >= maxDepth) return 0;
        let total = 0;
        for (const entry of readdirSync(p, { withFileTypes: true })) {
          total += dirSize(join(p, entry.name), maxDepth, depth + 1);
        }
        return total;
      } catch { return 0; }
    };

    const agentsDir = join(dataDir, 'agents');
    if (existsSync(agentsDir)) {
      for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'vector-store') continue;
        if (!knownAgentIds.has(entry.name)) {
          const p = join(agentsDir, entry.name);
          orphanAgents.push({ id: entry.name, path: p, size: dirSize(p) });
        }
      }
    }

    const teamsDir = join(dataDir, 'teams');
    if (existsSync(teamsDir)) {
      for (const entry of readdirSync(teamsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!knownTeamIds.has(entry.name)) {
          const p = join(teamsDir, entry.name);
          orphanTeams.push({ id: entry.name, path: p, size: dirSize(p) });
        }
      }
    }

    return {
      orphanAgents: orphanAgents.sort((a, b) => b.size - a.size),
      orphanTeams: orphanTeams.sort((a, b) => b.size - a.size),
      totalOrphanSize: [...orphanAgents, ...orphanTeams].reduce((s, o) => s + o.size, 0),
    };
  }

  private purgeOrphans(ids?: string[]) {
    const orphans = this.detectOrphans();
    const filter = ids && ids.length > 0 ? new Set(ids) : null;
    const purgedAgents: string[] = [];
    const purgedTeams: string[] = [];
    const failures: string[] = [];

    for (const o of orphans.orphanAgents) {
      if (filter && !filter.has(o.id)) continue;
      try {
        rmSync(o.path, { recursive: true, force: true });
        purgedAgents.push(o.id);
      } catch { failures.push(o.id); }
    }

    for (const o of orphans.orphanTeams) {
      if (filter && !filter.has(o.id)) continue;
      try {
        rmSync(o.path, { recursive: true, force: true });
        purgedTeams.push(o.id);
      } catch { failures.push(o.id); }
    }

    return {
      purgedAgents,
      purgedTeams,
      freedBytes: orphans.totalOrphanSize,
      failures,
    };
  }

  private async validateProviderKey(provider: string, apiKey: string, baseUrl?: string): Promise<{ valid: boolean; error?: string; models: unknown[] }> {
    const PROVIDER_BASE_URLS: Record<string, string> = {
      anthropic: 'https://api.anthropic.com',
      openai: 'https://api.openai.com/v1',
      google: 'https://generativelanguage.googleapis.com/v1beta',
      deepseek: 'https://api.deepseek.com',
      siliconflow: 'https://api.siliconflow.cn/v1',
      minimax: 'https://api.minimax.io/v1',
      'minimax-cn': 'https://api.minimaxi.com/v1',
      'siliconflow-intl': 'https://api-st.siliconflow.cn/v1',
      openrouter: 'https://openrouter.ai/api/v1',
      zai: 'https://api.z.ai/api/paas/v4',
      xai: 'https://api.x.ai/v1',
      mistral: 'https://api.mistral.ai/v1',
      groq: 'https://api.groq.com/openai/v1',
      perplexity: 'https://api.perplexity.ai',
      cohere: 'https://api.cohere.ai/compatibility/v1',
      together_ai: 'https://api.together.xyz/v1',
      fireworks_ai: 'https://api.fireworks.ai/inference/v1',
      moonshot: 'https://api.moonshot.cn/v1',
      volcengine: 'https://ark.cn-beijing.volces.com/api/v3',
      dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      ollama: 'http://localhost:11434/v1',
    };

    const providerBaseUrl = baseUrl || PROVIDER_BASE_URLS[provider];
    if (!providerBaseUrl) {
      return { valid: false, error: `Unknown provider: ${provider}`, models: [] };
    }

    // For Anthropic, use a lightweight models list call
    if (provider === 'anthropic') {
      try {
        const resp = await fetch('https://api.anthropic.com/v1/models', {
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          return { valid: false, error: `HTTP ${resp.status}: ${errText.slice(0, 200)}`, models: [] };
        }
        // Anthropic models endpoint returns { data: [...] }
        const data = await resp.json() as { data?: Array<{ id: string }> };
        const modelIds = (data.data ?? []).map((m: { id: string }) => m.id);
        // Cross-reference with catalog for enrichment (pricing, capabilities).
        // Only enrich models that the API actually returned — don't add extras.
        const result = modelIds.map((id: string) => {
          const match = this.modelCatalog?.getModelInfo(id) || this.modelCatalog?.getModelInfo(`anthropic/${id}`);
          return match ? { ...match, id } : { id, provider: 'anthropic', mode: 'chat' };
        });
        result.sort((a, b) => ((a as { id?: string }).id ?? '').localeCompare((b as { id?: string }).id ?? ''));
        return { valid: true, models: result };
      } catch (err) {
        return { valid: false, error: err instanceof Error ? err.message : String(err), models: [] };
      }
    }

    // For Google Gemini, use key-based auth and different models endpoint
    if (provider === 'google') {
      try {
        const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          return { valid: false, error: `HTTP ${resp.status}: ${errText.slice(0, 200)}`, models: [] };
        }
        const gData = await resp.json() as { models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[]; inputTokenLimit?: number; outputTokenLimit?: number }> };
        const chatModelsRaw = (gData.models ?? [])
          .filter(m => m.supportedGenerationMethods?.includes('generateContent'));
        const catalogModels = this.modelCatalog?.getModelsByProvider('google') ?? [];
        const catalogByStripped = new Map(catalogModels.map(m => [m.id.startsWith('gemini/') ? m.id.slice('gemini/'.length) : m.id, m]));
        const models: Array<unknown> = [];
        const seenIds = new Set<string>();
        for (const gm of chatModelsRaw) {
          const id = gm.name.replace('models/', '');
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          const match = catalogByStripped.get(id) || this.modelCatalog?.getModelInfo(`gemini/${id}`);
          if (match) {
            models.push({
              ...match, id, provider: 'google',
              maxInputTokens: match.maxInputTokens || gm.inputTokenLimit || 128000,
              maxOutputTokens: match.maxOutputTokens || gm.outputTokenLimit || 8192,
            });
          } else {
            models.push({
              id, provider: 'google', mode: 'chat',
              maxInputTokens: gm.inputTokenLimit || 128000,
              maxOutputTokens: gm.outputTokenLimit || 8192,
              inputCostPer1MTokens: 0,
              outputCostPer1MTokens: 0,
              capabilities: { vision: false, functionCalling: false, reasoning: false, promptCaching: false, webSearch: false, audioInput: false, audioOutput: false },
            });
          }
        }
        // Gemini API list is authoritative for chat; append non-chat catalog models
        const catalogGoogle = this.modelCatalog?.getModelsByProvider('google') ?? [];
        for (const cm of catalogGoogle) {
          if (cm.mode === 'chat') continue;
          const bareId = cm.id.startsWith('gemini/') ? cm.id.slice('gemini/'.length) : cm.id;
          if (seenIds.has(bareId) || seenIds.has(cm.id)) continue;
          seenIds.add(bareId);
          models.push({ ...cm, id: bareId, provider: 'google' });
        }
        models.sort((a, b) => String((a as { id?: string }).id ?? '').localeCompare(String((b as { id?: string }).id ?? '')));
        return { valid: true, models };
      } catch (err) {
        const catalogModels = this.modelCatalog?.getModelsByProvider('google') ?? [];
        if (catalogModels.length > 0) {
          const stripped = catalogModels.map(cm => {
            const bareId = cm.id.startsWith('gemini/') ? cm.id.slice('gemini/'.length) : cm.id;
            return { ...cm, id: bareId };
          });
          return { valid: false, error: `Could not verify key (${err instanceof Error ? err.message : String(err)})`, models: stripped };
        }
        return { valid: false, error: err instanceof Error ? err.message : String(err), models: [] };
      }
    }

    // For OpenAI-compatible providers, call /v1/models (or /models)
    try {
      let modelsUrl: string;
      if (providerBaseUrl.endsWith('/v1') || providerBaseUrl.endsWith('/v1/')) {
        modelsUrl = providerBaseUrl.replace(/\/+$/, '') + '/models';
      } else if (providerBaseUrl.includes('/v1/') || providerBaseUrl.includes('/v3') || providerBaseUrl.includes('/v4') || providerBaseUrl.includes('/compatible-mode')) {
        modelsUrl = providerBaseUrl.replace(/\/+$/, '') + '/models';
      } else {
        modelsUrl = providerBaseUrl.replace(/\/+$/, '') + '/v1/models';
      }

      const resp = await fetch(modelsUrl, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        return { valid: false, error: `HTTP ${resp.status}: ${errText.slice(0, 200)}`, models: [] };
      }

      const data = await resp.json() as { data?: Array<Record<string, unknown>> };
      const remoteModels = (data.data ?? []) as Array<Record<string, unknown>>;

      // Filter out moderation/safety models and embedding/rerank models (not usable for chat or multimodal).
      // Keep image/audio/video/tts/speech/whisper models since multimodal routing needs them.
      const remoteFiltered = remoteModels.filter(m => {
        const id = String(m.id ?? '').toLowerCase();
        if (/\b(moderat)\b/i.test(id)) return false;
        if (/\b(embed|rerank)\b/.test(id)) return false;
        return true;
      });

      // Build multiple lookup indices for catalog matching
      const catalogModels = this.modelCatalog?.getModelsByProvider(provider) ?? [];
      const catalogByExactId = new Map(catalogModels.map(m => [m.id, m]));
      // Index by stripped provider prefix (e.g. "minimax/MiniMax-M2.1" -> "MiniMax-M2.1")
      const catalogByStrippedId = new Map<string, typeof catalogModels[0]>();
      for (const m of catalogModels) {
        if (m.id.startsWith(`${provider}/`)) {
          catalogByStrippedId.set(m.id.slice(provider.length + 1), m);
        }
      }
      // Case-insensitive index for stripped IDs
      const catalogByStrippedIdLower = new Map<string, typeof catalogModels[0]>();
      for (const [k, v] of catalogByStrippedId) {
        catalogByStrippedIdLower.set(k.toLowerCase(), v);
      }
      // Also try to get models from other providers that may match (for aggregators like openrouter/siliconflow)
      const allCatalogModels = this.modelCatalog ? (() => {
        const all = new Map<string, typeof catalogModels[0]>();
        for (const p of this.modelCatalog!.getAllProviders()) {
          for (const m of this.modelCatalog!.getModelsByProvider(p)) {
            all.set(m.id, m);
          }
        }
        return all;
      })() : new Map<string, typeof catalogModels[0]>();

      // Common suffixes that can be stripped for fuzzy matching
      const VARIANT_SUFFIXES = ['-highspeed', '-turbo', '-fast', '-latest', '-online', '-hd', '-preview', '-exp', '-free'];

      const findCatalogMatch = (id: string): typeof catalogModels[0] | null => {
        // 1. Exact match in provider catalog
        if (catalogByExactId.has(id)) return catalogByExactId.get(id)!;
        // 2. Match after stripping provider prefix from catalog IDs
        if (catalogByStrippedId.has(id)) return catalogByStrippedId.get(id)!;
        // 3. Case-insensitive match on stripped IDs
        if (catalogByStrippedIdLower.has(id.toLowerCase())) return catalogByStrippedIdLower.get(id.toLowerCase())!;
        // 4. Try adding provider prefix
        const prefixed = `${provider}/${id}`;
        if (catalogByExactId.has(prefixed)) return catalogByExactId.get(prefixed)!;
        // 5. Fuzzy: strip variant suffixes and try again
        const idLower = id.toLowerCase();
        for (const suffix of VARIANT_SUFFIXES) {
          if (idLower.endsWith(suffix)) {
            const base = id.slice(0, -suffix.length);
            if (catalogByStrippedId.has(base)) return catalogByStrippedId.get(base)!;
            if (catalogByStrippedIdLower.has(base.toLowerCase())) return catalogByStrippedIdLower.get(base.toLowerCase())!;
            const basePrefixed = `${provider}/${base}`;
            if (catalogByExactId.has(basePrefixed)) return catalogByExactId.get(basePrefixed)!;
          }
        }
        // 6. For aggregators, try matching model in its native provider catalog
        const slashIdx = id.indexOf('/');
        if (slashIdx > 0) {
          const nativeId = id.slice(slashIdx + 1);
          const globalMatch = allCatalogModels.get(id) || allCatalogModels.get(`${id.slice(0, slashIdx)}/${nativeId}`);
          if (globalMatch) return globalMatch;
        }
        // 7. Try bare model name (last part after /) in global catalog — case-insensitive
        const bareName = id.includes('/') ? id.split('/').pop()! : id;
        const bareNameLower = bareName.toLowerCase();
        for (const [cid, cm] of allCatalogModels) {
          const cBareName = cid.includes('/') ? cid.split('/').pop()! : cid;
          if (cBareName.toLowerCase() === bareNameLower) return cm;
        }
        // 8. Fuzzy: strip suffixes from bare name and try global catalog
        for (const suffix of VARIANT_SUFFIXES) {
          if (bareNameLower.endsWith(suffix)) {
            const baseBare = bareName.slice(0, -suffix.length).toLowerCase();
            for (const [cid, cm] of allCatalogModels) {
              const cBareName = (cid.includes('/') ? cid.split('/').pop()! : cid).toLowerCase();
              if (cBareName === baseBare) return cm;
            }
          }
        }
        return null;
      };

      // Extract metadata from API response if available (many providers return context_length, pricing)
      const extractApiMetadata = (remoteModel: Record<string, unknown>) => {
        const contextLength = (remoteModel.context_length ?? remoteModel.max_context_length ?? remoteModel.context_window ?? remoteModel.max_model_len ?? 0) as number;
        const topProvider = remoteModel.top_provider as Record<string, unknown> | undefined;
        const maxOutput = (remoteModel.max_output ?? topProvider?.max_completion_tokens ?? 0) as number;
        // OpenRouter-style pricing
        const pricing = remoteModel.pricing as Record<string, string> | undefined;
        let inputCostPer1M = 0;
        let outputCostPer1M = 0;
        if (pricing) {
          inputCostPer1M = parseFloat(pricing.prompt || '0') * 1_000_000;
          outputCostPer1M = parseFloat(pricing.completion || '0') * 1_000_000;
        }
        return { contextLength, maxOutput, inputCostPer1M, outputCostPer1M };
      };

      // Compute a fallback context window from provider's known models
      let providerFallbackContext = 128000;
      if (catalogModels.length > 0) {
        const contexts = catalogModels.map(m => m.maxInputTokens).filter(t => t > 0);
        if (contexts.length > 0) {
          providerFallbackContext = Math.round(contexts.reduce((a, b) => a + b, 0) / contexts.length);
        }
      }

      const models: Array<unknown> = [];
      const seenIds = new Set<string>();
      for (const rm of remoteFiltered) {
        const id = String(rm.id ?? '');
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        const match = findCatalogMatch(id);
        const apiMeta = extractApiMetadata(rm);

        if (match) {
          models.push({
            ...match,
            id,
            provider,
            // Prefer catalog data but use API metadata if catalog has no data
            maxInputTokens: match.maxInputTokens || apiMeta.contextLength || providerFallbackContext,
            maxOutputTokens: match.maxOutputTokens || apiMeta.maxOutput || match.maxOutputTokens,
            inputCostPer1MTokens: match.inputCostPer1MTokens || apiMeta.inputCostPer1M,
            outputCostPer1MTokens: match.outputCostPer1MTokens || apiMeta.outputCostPer1M,
          });
        } else {
          models.push({
            id,
            provider,
            mode: 'chat',
            maxInputTokens: apiMeta.contextLength || providerFallbackContext,
            maxOutputTokens: apiMeta.maxOutput || 8192,
            inputCostPer1MTokens: apiMeta.inputCostPer1M,
            outputCostPer1MTokens: apiMeta.outputCostPer1M,
            capabilities: { vision: false, functionCalling: false, reasoning: false, promptCaching: false, webSearch: false, audioInput: false, audioOutput: false },
          });
        }
      }

      // The live /v1/models is authoritative for chat models — don't append
      // catalog chat aliases. But non-chat models (TTS, image, video, STT)
      // are served via separate API endpoints and never appear in /v1/models,
      // so append them from the catalog.
      const catalogAll = this.modelCatalog?.getModelsByProvider(provider) ?? [];
      for (const cm of catalogAll) {
        if (cm.mode === 'chat') continue;
        const stripped = ModelCatalogService.stripProviderPrefix(cm.id);
        if (seenIds.has(stripped) || seenIds.has(cm.id)) continue;
        seenIds.add(stripped);
        models.push({ ...cm, id: stripped, provider });
      }

      models.sort((a, b) => String((a as { id?: string }).id ?? '').localeCompare(String((b as { id?: string }).id ?? '')));
      return { valid: true, models };
    } catch (err) {
      // If /v1/models fails, fall back to catalog models (with stripped provider prefixes)
      const catalogModels = this.modelCatalog?.getModelsByProvider(provider) ?? [];
      if (catalogModels.length > 0) {
        const stripped = catalogModels.map(cm => {
          const strippedId = cm.id.startsWith(`${provider}/`) ? cm.id.slice(provider.length + 1) : cm.id;
          return { ...cm, id: strippedId };
        });
        return { valid: false, error: `Could not verify key (${err instanceof Error ? err.message : String(err)}), showing catalog models`, models: stripped };
      }
      return { valid: false, error: err instanceof Error ? err.message : String(err), models: [] };
    }
  }
}

function stripHtmlTags(value: string): string {
  return value.replace(/<[^>]*>/g, '');
}
