import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { APIServer } from '../api-server.js';

function stripHtmlTags(value: string): string {
  return value.replace(/<[^>]*>/g, '');
}

export async function handleAgentsDeepRoutes(
  server: APIServer,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
): Promise<boolean> {
    if (path.match(/^\/api\/agents\/[^/]+\/mind$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      try {
        const agent = server.orgService.getAgentManager().getAgent(agentId);
        server.json(res, 200, agent.getMindState());
      } catch {
        server.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return true;
    }

    // Agent mailbox — queued items + enriched history (decisions + activity)
    if (path.match(/^\/api\/agents\/[^/]+\/mailbox$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
      const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
      const status = url.searchParams.get('status') ?? undefined;
      const category = url.searchParams.get('category') ?? undefined;
      const sourceType = url.searchParams.get('sourceType') ?? undefined;
      try {
        const agent = server.orgService.getAgentManager().getAgent(agentId);
        const queued = agent.getMailbox().getQueuedItems();

        let sourceTypes: string[] | undefined;
        if (sourceType) {
          sourceTypes = sourceType.split(',').map(s => s.trim()).filter(Boolean);
        } else if (category) {
          const { MAILBOX_CATEGORIES } = await import('@markus/shared');
          const cat = MAILBOX_CATEGORIES[category as keyof typeof MAILBOX_CATEGORIES];
          if (cat) sourceTypes = cat.types;
        }

        let history: Array<Record<string, unknown>> = [];
        if (server.storage?.mailboxRepo) {
          const raw = server.storage.mailboxRepo.getHistory(agentId, { limit, offset, sourceTypes, status });
          const itemIds = raw.map((item: { id: string }) => item.id);

          const decisionsMap = server.storage?.decisionRepo
            ? server.storage.decisionRepo.getByMailboxItemIds(itemIds)
            : new Map<string, unknown[]>();
          const activitiesMap = server.storage?.activityRepo
            ? server.storage.activityRepo.getByMailboxItemIds(itemIds)
            : new Map<string, unknown>();

          history = raw.map((item: { id: string; [k: string]: unknown }) => {
            const enriched: Record<string, unknown> = { ...item };
            enriched.decisions = decisionsMap.get(item.id) ?? [];
            const act = activitiesMap.get(item.id) as Record<string, unknown> | undefined;
            enriched.activity = act ? {
              id: act.id,
              type: act.type,
              label: act.label,
              startedAt: act.startedAt,
              endedAt: act.endedAt,
              totalTokens: act.totalTokens,
              totalTools: act.totalTools,
              success: act.success,
            } : null;
            return enriched;
          });
        }

        const statusCounts = server.storage?.mailboxRepo?.getStatusCounts(agentId) ?? {};
        const sourceTypeCounts = server.storage?.mailboxRepo?.getSourceTypeCounts(agentId) ?? {};

        server.json(res, 200, {
          queued: queued.map(i => ({
            id: i.id,
            sourceType: i.sourceType,
            priority: i.priority,
            status: i.status,
            summary: i.payload.summary,
            queuedAt: i.queuedAt,
          })),
          queueDepth: queued.length,
          statusCounts,
          sourceTypeCounts,
          history,
        });
      } catch {
        server.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return true;
    }

    // Agent attention decisions — decision timeline
    if (path.match(/^\/api\/agents\/[^/]+\/decisions$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
      try {
        const agent = server.orgService.getAgentManager().getAgent(agentId);
        const recent = agent.getAttentionController().getRecentDecisions(limit);

        let persisted: unknown[] = [];
        if (server.storage?.decisionRepo) {
          persisted = server.storage.decisionRepo.getByAgent(agentId, limit);
        }

        server.json(res, 200, {
          recent,
          persisted,
        });
      } catch {
        server.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return true;
    }

    // Agent metrics — must be before the generic GET /api/agents/:id handler
    if (path.match(/^\/api\/agents\/[^/]+\/metrics$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      const period = (url.searchParams.get('period') ?? '24h') as '1h' | '24h' | '7d';
      try {
        const agent = server.orgService.getAgentManager().getAgent(agentId);
        const metrics = agent.getMetrics(period);
        server.json(res, 200, metrics);
      } catch {
        server.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return true;
    }

    // Agent config update (PATCH)
    if (path.match(/^\/api\/agents\/[^/]+\/config$/) && req.method === 'PATCH') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const agentId = path.split('/')[3]!;
      try {
        const agent = server.orgService.getAgentManager().getAgent(agentId);
        const body = await server.readBody(req);
        const cfg = agent.config as unknown as Record<string, unknown>;
        if (body['name'] !== undefined) {
          const name = stripHtmlTags(body['name'] as string);
          if (name.length > 100) {
            server.json(res, 400, { error: 'name must be 100 characters or fewer' });
            return true;
          }
          cfg.name = name;
        }
        if (body['agentRole'] !== undefined) cfg.agentRole = body['agentRole'];
        if (body['skills'] !== undefined) cfg.skills = body['skills'];
        if (body['llmConfig'] !== undefined) {
          const lc = body['llmConfig'] as Record<string, unknown>;
          cfg.llmConfig = { ...(cfg.llmConfig as Record<string, unknown>), ...lc };
        }
        if (body['heartbeatIntervalMs'] !== undefined)
          cfg.heartbeatIntervalMs = body['heartbeatIntervalMs'];

        // Persist config changes to DB
        if (server.storage) {
          try {
            await server.storage.agentRepo.updateConfig(agentId, {
              name: body['name'] !== undefined ? stripHtmlTags(body['name'] as string) : undefined,
              agentRole: body['agentRole'] as string | undefined,
              skills: body['skills'] as unknown,
              llmConfig: cfg.llmConfig,
              heartbeatIntervalMs: body['heartbeatIntervalMs'] as number | undefined,
            });
          } catch (persistErr) {
            log.warn('Failed to persist agent config to DB', { agentId, error: String(persistErr) });
          }
        }

        server.json(res, 200, { ok: true, config: agent.config });
      } catch {
        server.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return true;
    }

    // Agent memory summary
    if (path.match(/^\/api\/agents\/[^/]+\/memory$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      try {
        const agent = server.orgService.getAgentManager().getAgent(agentId);
        const mem = agent.getMemory();
        const entries = mem.getEntries(undefined, 50);
        const sessions = mem.listSessions(agentId);
        const dailyLog = mem.getDailyLog();
        const recentDailyLogs = mem.getRecentDailyLogs(7);
        const longTermMemory = mem.getLongTermMemory();
        server.json(res, 200, {
          entries: entries.map(e => ({
            type: e.type,
            content: e.content,
            timestamp: e.timestamp,
            importance: (e as unknown as Record<string, unknown>).importance,
          })),
          sessions: sessions.map(s => ({
            id: s.id,
            agentId: s.agentId,
            messageCount: s.messages.length,
            createdAt:
              ((s as unknown as Record<string, unknown>).createdAt as string) ??
              new Date().toISOString(),
            updatedAt:
              ((s as unknown as Record<string, unknown>).updatedAt as string) ??
              new Date().toISOString(),
          })),
          dailyLog: dailyLog ?? null,
          recentDailyLogs: recentDailyLogs ?? null,
          longTermMemory: longTermMemory ?? null,
        });
      } catch {
        server.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return true;
    }

    // Agent memory session messages
    if (path.match(/^\/api\/agents\/[^/]+\/memory\/sessions\/[^/]+$/) && req.method === 'GET') {
      const parts = path.split('/');
      const agentId = parts[3]!;
      const sessionId = decodeURIComponent(parts[6]!);
      try {
        const agent = server.orgService.getAgentManager().getAgent(agentId);
        const session = agent.getMemory().getSession(sessionId);
        if (!session) {
          server.json(res, 404, { error: `Session not found: ${sessionId}` });
          return true;
        }
        server.json(res, 200, {
          id: session.id,
          agentId: session.agentId,
          startedAt: session.startedAt,
          lastActivityAt: session.lastActivityAt,
          messages: session.messages.map(m => ({
            role: m.role,
            content: getTextContent(m.content),
            ...(m.toolCalls?.length ? {
              toolCalls: m.toolCalls.map(tc => ({
                id: tc.id,
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              })),
            } : {}),
            ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
          })),
        });
      } catch {
        server.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return true;
    }

    // Agent memory: update daily log
    if (path.match(/^\/api\/agents\/[^/]+\/memory\/daily$/) && req.method === 'PUT') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const agentId = path.split('/')[3]!;
      try {
        const agent = server.orgService.getAgentManager().getAgent(agentId);
        const body = await server.readBody(req);
        const content = (body['content'] as string) ?? '';
        agent.getMemory().writeDailyLog(agentId, content);
        server.json(res, 200, { ok: true });
      } catch {
        server.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return true;
    }

    // Agent memory: update long-term memory
    if (path.match(/^\/api\/agents\/[^/]+\/memory\/longterm$/) && req.method === 'PUT') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const agentId = path.split('/')[3]!;
      try {
        const agent = server.orgService.getAgentManager().getAgent(agentId);
        const body = await server.readBody(req);
        const key = (body['key'] as string) ?? '';
        const content = (body['content'] as string) ?? '';
        agent.getMemory().addLongTermMemory(key, content);
        server.json(res, 200, { ok: true });
      } catch {
        server.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return true;
    }

    // Agent role/prompt files: list
    if (path.match(/^\/api\/agents\/[^/]+\/files$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      try {
        const agent = server.orgService.getAgentManager().getAgent(agentId);
        const roleDir = server.resolveAgentRoleDir(agent);
        if (!roleDir) {
          server.json(res, 404, { error: `Role directory not found for agent: ${agent.role.name}` });
          return true;
        }
        const allowedNames = ['ROLE.md', 'HEARTBEAT.md', 'POLICIES.md', 'CONTEXT.md'];
        const files: Array<{ name: string; content: string }> = [];
        const filesMap: Record<string, string> = {};
        for (const name of allowedNames) {
          const filePath = join(roleDir, name);
          if (existsSync(filePath)) {
            const content = readFileSync(filePath, 'utf-8');
            files.push({ name, content });
            filesMap[name] = content;
          }
        }
        server.json(res, 200, { files, filesMap });
      } catch {
        server.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return true;
    }

    // Agent role/prompt files: update
    if (path.match(/^\/api\/agents\/[^/]+\/files\/[^/]+$/) && req.method === 'PUT') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const parts = path.split('/');
      const agentId = parts[3]!;
      const filename = decodeURIComponent(parts[5]!);
      try {
        const agent = server.orgService.getAgentManager().getAgent(agentId);
        const roleDir = server.resolveAgentRoleDir(agent);
        if (!roleDir) {
          server.json(res, 404, { error: `Role directory not found for agent: ${agent.role.name}` });
          return true;
        }
        const allowedNames = ['ROLE.md', 'HEARTBEAT.md', 'POLICIES.md', 'CONTEXT.md'];
        if (!allowedNames.includes(filename)) {
          server.json(res, 400, { error: `Invalid filename. Allowed: ${allowedNames.join(', ')}` });
          return true;
        }
        const body = await server.readBody(req);
        const content = (body['content'] as string) ?? '';
        writeFileSync(join(roleDir, filename), content, 'utf-8');
        server.json(res, 200, { ok: true });
      } catch {
        server.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return true;
    }

    // Agent system prompt: update (runtime only)
    if (path.match(/^\/api\/agents\/[^/]+\/system-prompt$/) && req.method === 'PUT') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const agentId = path.split('/')[3]!;
      try {
        const agent = server.orgService.getAgentManager().getAgent(agentId);
        const body = await server.readBody(req);
        const systemPrompt = (body['systemPrompt'] as string) ?? '';
        (agent.role as { systemPrompt: string }).systemPrompt = systemPrompt;
        server.json(res, 200, { ok: true });
      } catch {
        server.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return true;
    }

    // ─── Role Template Versioning & Sync ──────────────────────────────────

    // Check role update status for a single agent
    if (path.match(/^\/api\/agents\/[^/]+\/role-status$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      try {
        const status = server.orgService.getAgentManager().checkRoleUpdate(agentId);
        server.json(res, 200, status);
      } catch {
        server.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return true;
    }

    // Get file-level diff between agent's role and template
    if (path.match(/^\/api\/agents\/[^/]+\/role-diff$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const fileName = url.searchParams.get('file') || 'ROLE.md';
      try {
        const diff = server.orgService.getAgentManager().getRoleFileDiff(agentId, fileName);
        server.json(res, 200, diff);
      } catch {
        server.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return true;
    }

    // Sync agent's role files from template
    if (path.match(/^\/api\/agents\/[^/]+\/role-sync$/) && req.method === 'POST') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const agentId = path.split('/')[3]!;
      try {
        const body = await server.readBody(req);
        const files = Array.isArray(body['files']) ? (body['files'] as string[]) : undefined;
        const result = server.orgService.getAgentManager().syncRoleFromTemplate(agentId, files);
        server.json(res, result.success ? 200 : 400, result);
      } catch {
        server.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return true;
    }

    // Smart sync: use LLM to merge template changes while preserving agent customizations
    if (path.match(/^\/api\/agents\/[^/]+\/role-smart-sync$/) && req.method === 'POST') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const agentId = path.split('/')[3]!;
      if (!server.llmRouter) {
        server.json(res, 503, { error: 'LLM router not available for smart sync' });
        return true;
      }
      try {
        const body = await server.readBody(req);
        const fileName = (body['file'] as string) ?? 'ROLE.md';
        const diff = server.orgService.getAgentManager().getRoleFileDiff(agentId, fileName);

        if (!diff.agentContent || !diff.templateContent) {
          server.json(res, 400, { error: 'Cannot smart sync: missing agent or template content' });
          return true;
        }

        if (diff.agentContent === diff.templateContent) {
          server.json(res, 200, { success: true, mergedContent: diff.agentContent, explanation: 'Files are already identical.' });
          return true;
        }

        const prompt = `You are a configuration merge assistant. You need to intelligently merge a template update into an agent's configuration file while preserving the agent's customizations.

AGENT'S CURRENT FILE (${fileName}):
\`\`\`
${diff.agentContent}
\`\`\`

UPDATED TEMPLATE FILE (${fileName}):
\`\`\`
${diff.templateContent}
\`\`\`

INSTRUCTIONS:
1. Identify what changed in the template compared to the agent's current file
2. Preserve the agent's custom modifications (things the user deliberately changed from the original template)
3. Incorporate valuable new additions from the template (new sections, improved wording, new capabilities)
4. If the agent removed something from the original template, keep it removed (respect user intent)
5. If the template added something new, include it
6. If both modified the same section, prefer the agent's version but incorporate template improvements where they don't conflict

Output ONLY two sections:
MERGED_CONTENT_START
(the merged file content here)
MERGED_CONTENT_END

EXPLANATION_START
(brief bullet points of what was kept, added, and why)
EXPLANATION_END`;

        const llmResponse = await server.llmRouter.chat({
          messages: [
            { role: 'system', content: 'You are a precise configuration merge tool. Output exactly the requested format.' },
            { role: 'user', content: prompt },
          ],
          maxTokens: 8192,
          temperature: 0.1,
        });

        const text = llmResponse.content;
        const mergedMatch = text.match(/MERGED_CONTENT_START\n([\s\S]*?)\nMERGED_CONTENT_END/);
        const explanationMatch = text.match(/EXPLANATION_START\n([\s\S]*?)\nEXPLANATION_END/);

        if (!mergedMatch) {
          server.json(res, 500, { error: 'LLM did not produce valid merged content', success: false });
          return true;
        }

        server.json(res, 200, {
          success: true,
          mergedContent: mergedMatch[1]!.trim(),
          explanation: explanationMatch?.[1]?.trim() ?? 'Merge completed.',
        });
      } catch (err) {
        server.json(res, 500, { error: `Smart sync failed: ${String(err)}`, success: false });
      }
      return true;
    }

    // Batch check: all agents' role update status
    if (path === '/api/agents/role-updates' && req.method === 'GET') {
      const results = server.orgService.getAgentManager().checkAllRoleUpdates();
      const stale = results.filter(r => r.hasTemplate && !r.isUpToDate);
      server.json(res, 200, { total: results.length, staleCount: stale.length, stale });
      return true;
    }

    // Agent skills: add
    if (path.match(/^\/api\/agents\/[^/]+\/skills$/) && req.method === 'POST') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const agentId = path.split('/')[3]!;
      try {
        const agent = server.orgService.getAgentManager().getAgent(agentId);
        const body = await server.readBody(req);
        const skillName = (body['skillName'] as string) ?? '';
        if (skillName && !agent.config.skills.includes(skillName)) {
          agent.config.skills.push(skillName);
          // Inject skill instructions into the running agent so it can use them immediately
          if (server.skillRegistry) {
            const skill = server.skillRegistry.get(skillName);
            if (skill?.manifest.instructions) {
              agent.injectSkillInstructions(skillName, skill.manifest.instructions);
            }
          }
          // When a building skill is added, register builder dynamic context so the
          // agent can see available skills/roles, just like the seeded builder agents.
          if (['agent-building', 'team-building', 'skill-building'].includes(skillName)) {
            agent.addDynamicContextProvider(
              () => server.orgService.buildBuilderDynamicContext(server.skillRegistry),
              'builder-context'
            );
          }
        }
        if (server.storage) {
          try { await server.storage.agentRepo.updateConfig(agentId, { skills: agent.config.skills }); }
          catch (e) { log.warn('Failed to persist skill assignment', { agentId, error: String(e) }); }
        }
        server.json(res, 200, { ok: true, skills: agent.getActiveSkillNames() });
      } catch {
        server.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return true;
    }

    // Agent skills: remove
    if (path.match(/^\/api\/agents\/[^/]+\/skills\/[^/]+$/) && req.method === 'DELETE') {
      const authUser = await server.requireAuth(req, res);
      if (!authUser) return true;
      const parts = path.split('/');
      const agentId = parts[3]!;
      const skillName = decodeURIComponent(parts[5]!);
      try {
        const agent = server.orgService.getAgentManager().getAgent(agentId);
        agent.config.skills = agent.config.skills.filter(s => s !== skillName);
        agent.deactivateSkill(skillName);
        if (server.storage) {
          try { await server.storage.agentRepo.updateConfig(agentId, { skills: agent.config.skills }); }
          catch (e) { log.warn('Failed to persist skill removal', { agentId, error: String(e) }); }
        }
        server.json(res, 200, { ok: true, skills: agent.getActiveSkillNames() });
      } catch {
        server.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return true;
    }

    // Agent tools: toggle enable/disable (skeleton - tools can't easily be toggled at runtime)
    if (path.match(/^\/api\/agents\/[^/]+\/tools\/[^/]+\/toggle$/) && req.method === 'POST') {
      const parts = path.split('/');
      const agentId = parts[3]!;
      const toolName = decodeURIComponent(parts[5]!);
      try {
        server.orgService.getAgentManager().getAgent(agentId);
        const body = await server.readBody(req);
        const enabled = (body['enabled'] as boolean) ?? true;
        void toolName;
        void enabled;
        server.json(res, 200, { ok: true });
      } catch {
        server.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return true;
    }

    // Agent activities — persistent history from SQLite (session-grouped)
    if (path.match(/^\/api\/agents\/[^/]+\/activities$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      const typeFilter = url.searchParams.get('type') ?? undefined;
      const limit = parseInt(url.searchParams.get('limit') ?? '30', 10);
      const before = url.searchParams.get('before') ?? undefined;
      const taskIdFilter = url.searchParams.get('taskId') ?? undefined;
      try {
        if (server.storage?.activityRepo) {
          const activities = server.storage.activityRepo.queryActivities(agentId, { type: typeFilter, limit, before, taskId: taskIdFilter });
          server.json(res, 200, { activities });
        } else {
          server.json(res, 200, { activities: [] });
        }
      } catch (err) {
        server.json(res, 500, { error: `Failed to query activities: ${String(err)}` });
      }
      return true;
    }

    // Agent recent activities — list summary of in-memory activities (live)
    if (path.match(/^\/api\/agents\/[^/]+\/recent-activities$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      try {
        const agent = server.orgService.getAgentManager().getAgent(agentId);
        const activities = agent.getRecentActivities();
        server.json(res, 200, { activities });
      } catch {
        server.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return true;
    }

    // Agent activity logs — in-memory for live activities, SQLite for historical
    if (path.match(/^\/api\/agents\/[^/]+\/activity-logs$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      const activityId = url.searchParams.get('activityId');
      if (!activityId) {
        server.json(res, 400, { error: 'activityId query parameter is required' });
        return true;
      }
      try {
        const agent = server.orgService.getAgentManager().getAgent(agentId);
        const currentActivity = agent.getCurrentActivity();
        if (currentActivity?.id === activityId) {
          const logs = agent.getActivityLogs(activityId);
          server.json(res, 200, { logs, activity: currentActivity });
          return true;
        }
      } catch { /* agent not found, try SQLite */ }

      if (server.storage?.activityRepo) {
        const activity = server.storage.activityRepo.getActivity(activityId);
        const logs = server.storage.activityRepo.getActivityLogs(activityId);
        server.json(res, 200, { logs, activity });
      } else {
        server.json(res, 200, { logs: [], activity: undefined });
      }
      return true;
    }

    // Agent heartbeat info — enriched with last summary, next run estimate
    if (path.match(/^\/api\/agents\/[^/]+\/heartbeat$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      try {
        const agent = server.orgService.getAgentManager().getAgent(agentId);
        const hb = (
          agent as unknown as { heartbeat: { getStatus(): { running: boolean; uptimeMs: number; intervalMs: number; initialDelayMs: number } } }
        ).heartbeat;
        const status = hb.getStatus();

        // Get last heartbeat summary from agent memory
        let lastSummary: string | undefined;
        let lastSummaryAt: string | undefined;
        try {
          const mem = agent.getMemory();
          const results = mem.search('heartbeat:summary');
          if (results.length > 0) {
            const latest = results[results.length - 1];
            lastSummary = latest?.content;
            lastSummaryAt = latest?.timestamp;
          }
        } catch { /* ok */ }

        const state = agent.getState();
        const lastHeartbeat = state.lastHeartbeat;

        // Estimate next heartbeat time
        let nextRunAt: string | undefined;
        if (status.running && status.intervalMs > 0 && lastHeartbeat) {
          const next = new Date(new Date(lastHeartbeat).getTime() + status.intervalMs);
          if (next.getTime() > Date.now()) nextRunAt = next.toISOString();
        } else if (status.running && status.intervalMs > 0) {
          const next = new Date(Date.now() + status.intervalMs - status.uptimeMs % status.intervalMs);
          nextRunAt = next.toISOString();
        }

        server.json(res, 200, {
          ...status,
          lastHeartbeat,
          lastSummary,
          lastSummaryAt,
          nextRunAt,
        });
      } catch {
        server.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return true;
    }

    // Manual heartbeat trigger
    if (path.match(/^\/api\/agents\/[^/]+\/heartbeat\/trigger$/) && req.method === 'POST') {
      const agentId = path.split('/')[3]!;
      try {
        const agent = server.orgService.getAgentManager().getAgent(agentId);
        const hb = (
          agent as unknown as { heartbeat: { trigger(): void; isRunning(): boolean } }
        ).heartbeat;
        if (!hb.isRunning()) {
          server.json(res, 400, { error: 'Heartbeat scheduler is not running' });
          return true;
        }
        hb.trigger();
        server.json(res, 200, { status: 'triggered', message: 'Heartbeat triggered. Check activity logs for results.' });
      } catch {
        server.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return true;
    }

    // Agent detail (GET) — enriched with config, tools, heartbeat summary
    if (path.match(/^\/api\/agents\/[^/]+$/) && req.method === 'GET') {
      const agentId = path.split('/')[3]!;
      try {
        const agent = server.orgService.getAgentManager().getAgent(agentId);
        const state = agent.getState();
        const tools = (
          agent as unknown as { tools: Map<string, { name: string; description: string }> }
        ).tools;
        const toolList = [...tools.values()].map(t => ({
          name: t.name,
          description: t.description,
        }));
        const virtualToolNames = new Set(toolList.map(t => t.name));
        const VIRTUAL_TOOLS: Array<{ name: string; description: string }> = [
          { name: 'discover_tools', description: 'Discover and activate additional tools and skills available to this agent' },
          { name: 'notify_user', description: 'Send a notification to a human team member (appears in chat + notification bell)' },
          { name: 'request_user_approval', description: 'Request a decision or approval from a human (blocks until response)' },
          { name: 'recall_activity', description: 'Query your own execution history and past activity logs' },
        ];
        for (const vt of VIRTUAL_TOOLS) {
          if (!virtualToolNames.has(vt.name)) toolList.push(vt);
        }
        const hb = (
          agent as unknown as { heartbeat: { getStatus(): { running: boolean; uptimeMs: number; intervalMs: number; initialDelayMs: number } } }
        ).heartbeat;
        let heartbeatSummary: Record<string, unknown> = {};
        try {
          heartbeatSummary = hb.getStatus() as unknown as Record<string, unknown>;
        } catch {
          /* ok */
        }
        const storedAgent = server.storage?.agentRepo.findById(agentId);
        server.json(res, 200, {
          id: agent.id,
          name: agent.config.name,
          role: agent.role.name,
          roleDescription: agent.role.description,
          agentRole: agent.config.agentRole,
          avatarUrl: storedAgent?.avatarUrl ?? undefined,
          state,
          activeTaskCount: state.activeTaskCount,
          activeTaskIds: state.activeTaskIds,
          skills: agent.getActiveSkillNames(),
          availableSkills: server.skillRegistry?.list().map(s => ({
            name: s.name,
            description: s.description,
            category: s.category,
            builtIn: !!s.builtIn,
            alwaysOn: !!s.alwaysOn,
          })) ?? [],
          proficiency: agent.getSkillProficiency(),
          config: {
            llmConfig: agent.config.llmConfig,
            channels: agent.config.channels,
            heartbeatIntervalMs: agent.config.heartbeatIntervalMs,
            orgId: agent.config.orgId,
            teamId: agent.config.teamId,
            createdAt: agent.config.createdAt,
          },
          tools: toolList,
          heartbeat: heartbeatSummary,
        });
      } catch {
        server.json(res, 404, { error: `Agent not found: ${agentId}` });
      }
      return true;
    }
  return false;
}
