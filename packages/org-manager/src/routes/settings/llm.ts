import { saveConfig } from '@markus/shared';
import { ModelCatalogService } from '@markus/core';
import { createLogger } from '@markus/shared';
import { stripProviderPrefix, enrichModelFromCatalog } from '../../middleware/auth.js';

const log = createLogger('api-server:llm');
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { APIServer } from '../api-server.js';

export async function handleLlmSettingsRoutes(
  server: APIServer,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
): Promise<boolean> {
    // ── Model Catalog API ──────────────────────────────────────────────────

    // ── CU Quota Status ────────────────────────────────────────────────────
    if (path === '/api/cu/status' && req.method === 'GET') {
      const quotaInfo = server.llmRouter?.getMarkusQuotaInfo();
      const cuUsage = server.llmRouter?.getMarkusCuUsage();
      server.json(res, 200, {
        available: !!quotaInfo,
        ...(quotaInfo ?? { cuCost: 0, cuRemaining: -1, cuLimit: 0 }),
        cuUsedToday: cuUsage?.cuUsedToday ?? 0,
        totalCuUsed: cuUsage?.totalCuUsed ?? 0,
      });
      return true;
    }

    if (path === '/api/models/catalog' && req.method === 'GET') {
      if (!server.modelCatalog) {
        server.json(res, 503, { error: 'Model catalog not available' });
        return true;
      }
      const provider = url.searchParams.get('provider');
      if (provider) {
        server.json(res, 200, { models: server.modelCatalog.getModelsByProvider(provider) });
      } else {
        const providers = server.modelCatalog.getAllProviders();
        const allModels: Record<string, unknown[]> = {};
        for (const p of providers) {
          allModels[p] = server.modelCatalog.getModelsByProvider(p);
        }
        server.json(res, 200, { providers: allModels });
      }
      return true;
    }

    if (path.startsWith('/api/models/catalog/') && req.method === 'GET') {
      if (!server.modelCatalog) {
        server.json(res, 503, { error: 'Model catalog not available' });
        return true;
      }
      const provider = path.replace('/api/models/catalog/', '');
      if (provider === 'status') {
        server.json(res, 200, server.modelCatalog.getStatus());
        return true;
      }
      const models = server.modelCatalog.getModelsByProvider(provider);
      server.json(res, 200, { provider, models });
      return true;
    }

    if (path === '/api/models/catalog/refresh' && req.method === 'POST') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;
      if (!server.modelCatalog) {
        server.json(res, 503, { error: 'Model catalog not available' });
        return true;
      }
      const success = await server.modelCatalog.refresh();
      server.json(res, 200, { success, status: server.modelCatalog.getStatus() });
      return true;
    }

    if (path === '/api/models/validate-key' && req.method === 'POST') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;
      const body = await server.readBody(req);
      const { provider, apiKey, baseUrl } = body as { provider?: string; apiKey?: string; baseUrl?: string };
      if (!provider || !apiKey) {
        server.json(res, 400, { error: 'provider and apiKey are required' });
        return true;
      }

      try {
        // Attempt to validate key by calling provider's models endpoint or a minimal chat request
        const result = await server.validateProviderKey(provider, apiKey, baseUrl);
        server.json(res, 200, result);
      } catch (err) {
        server.json(res, 200, { valid: false, error: err instanceof Error ? err.message : String(err), models: [] });
      }
      return true;
    }

    // Fetch live models for a configured provider using its stored API key
    if (path.startsWith('/api/models/live/') && req.method === 'GET') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;
      const providerName = path.replace('/api/models/live/', '');
      if (!providerName) {
        server.json(res, 400, { error: 'provider is required' });
        return true;
      }

      try {
        // Get provider instance to access its API key
        const providerInstance = server.llmRouter?.getProvider(providerName);
        const apiKey = (providerInstance as any)?.apiKey ?? '';
        const baseUrl = (providerInstance as any)?.baseUrl;

        if (!apiKey) {
          // No key available, fallback to catalog (strip LiteLLM provider prefixes)
          const catalogModels = (server.modelCatalog?.getModelsByProvider(providerName) ?? [])
            .map(cm => ({ ...cm, id: stripProviderPrefix(cm.id) }));
          server.json(res, 200, { provider: providerName, models: catalogModels, source: 'catalog' });
          return true;
        }

        const result = await server.validateProviderKey(providerName, apiKey, baseUrl);
        server.json(res, 200, { provider: providerName, models: result.models, source: result.valid ? 'live' : 'catalog' });
      } catch (err) {
        const catalogModels = (server.modelCatalog?.getModelsByProvider(providerName) ?? [])
          .map(cm => ({ ...cm, id: stripProviderPrefix(cm.id) }));
        server.json(res, 200, { provider: providerName, models: catalogModels, source: 'catalog', error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    // Settings — LLM configuration
    if (path === '/api/settings/llm' && req.method === 'GET') {
      if (!server.llmRouter) {
        server.json(res, 200, { defaultProvider: 'unknown', providers: {} });
        return true;
      }
      server.json(res, 200, server.llmRouter.getEnhancedSettings());
      return true;
    }

    if (path === '/api/settings/llm' && req.method === 'POST') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;
      if (!server.llmRouter) {
        server.json(res, 503, { error: 'LLM router not available' });
        return true;
      }
      const body = await server.readBody(req);
      const { defaultProvider, autoFallback, capabilityRouting, routingDefaultModel } = body as {
        defaultProvider?: string; autoFallback?: boolean;
        capabilityRouting?: Record<string, unknown>;
        routingDefaultModel?: { provider: string; model: string } | null;
      };
      if (!defaultProvider && autoFallback === undefined && !capabilityRouting && routingDefaultModel === undefined) {
        server.json(res, 400, { error: 'defaultProvider, autoFallback, capabilityRouting, or routingDefaultModel is required' });
        return true;
      }
      try {
        const configUpdates: Record<string, unknown> = {};
        if (defaultProvider) {
          server.llmRouter.setDefaultProvider(defaultProvider);
          configUpdates.defaultProvider = defaultProvider;
        }
        if (typeof autoFallback === 'boolean') {
          server.llmRouter.setAutoFallback(autoFallback);
          configUpdates.autoFallback = autoFallback;
        }
        if (capabilityRouting) {
          const prevAssignments = { ...server.llmRouter.capabilityRouting.assignments };
          server.llmRouter.setCapabilityRouting(capabilityRouting as any);
          const incomingAssignments = (capabilityRouting as any).assignments ?? {};
          const persistAssignments: Record<string, unknown> = { ...incomingAssignments };
          for (const key of Object.keys(prevAssignments)) {
            if (!(key in incomingAssignments)) {
              persistAssignments[key] = null;
            }
          }
          configUpdates.capabilityRouting = { assignments: persistAssignments };
        }
        if (routingDefaultModel !== undefined) {
          if (routingDefaultModel === null) {
            server.llmRouter.setRoutingDefaultModel(undefined);
            configUpdates.routingDefaultModel = undefined;
          } else if (routingDefaultModel.provider && routingDefaultModel.model) {
            server.llmRouter.setRoutingDefaultModel(routingDefaultModel);
            configUpdates.routingDefaultModel = routingDefaultModel;
          } else {
            server.json(res, 400, { error: 'routingDefaultModel must have provider and model fields' });
            return true;
          }
        }
        try {
          saveConfig({ llm: configUpdates } as any, server.markusConfigPath);
        } catch (e) {
          log.warn('Failed to persist LLM settings to config file', { error: String(e) });
        }
        server.auditService?.record({
          orgId: 'system',
          type: 'settings_changed',
          action: 'llm_settings',
          detail: `${defaultProvider ? `defaultProvider=${defaultProvider}` : ''}${autoFallback !== undefined ? ` autoFallback=${autoFallback}` : ''}${capabilityRouting ? ' capabilityRouting=updated' : ''}`.trim(),
          userId: auth.userId,
          success: true,
        });
        server.json(res, 200, server.llmRouter.getEnhancedSettings());
      } catch (err) {
        server.json(res, 400, { error: String(err) });
      }
      return true;
    }

    // Models — Routing candidates (enriched model list for task routing UI)
    if (path === '/api/models/routing-candidates' && req.method === 'GET') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;
      if (!server.llmRouter) {
        server.json(res, 200, { providers: [] });
        return true;
      }

      // Serve from cache if still valid
      if (server.routingCandidatesCache && Date.now() < server.routingCandidatesCache.expireAt) {
        server.json(res, 200, server.routingCandidatesCache.data);
        return true;
      }

      const settings = server.llmRouter.getEnhancedSettings();
      const result: Array<{ provider: string; displayName: string; models: Array<{ id: string; name: string; mode?: string; tier?: string; costTier?: string; capabilities?: string[] }> }> = [];

      for (const [providerName, providerSettings] of Object.entries(settings.providers)) {
        if (!providerSettings.enabled || !providerSettings.configured) continue;
        const seenIds = new Set<string>();
        const models: Array<{ id: string; name: string; mode?: string; tier?: string; costTier?: string; capabilities?: string[] }> = [];

        for (const m of providerSettings.models ?? []) {
          seenIds.add(m.id);
          const enriched = enrichModelFromCatalog(m.id, m.tier, server.modelCatalog);
          let caps = enriched.capabilities ?? (m as any).capabilities;
          if (!caps && (m as any).inputTypes?.includes('image')) {
            caps = ['vision'];
          }
          models.push({
            id: m.id,
            name: m.name ?? m.id,
            mode: enriched.mode,
            tier: enriched.tier,
            costTier: enriched.costTier,
            capabilities: caps,
          });
        }

        try {
          const providerInstance = server.llmRouter?.getProvider(providerName);
          const apiKey = (providerInstance as any)?.apiKey ?? '';
          const providerBaseUrl = (providerInstance as any)?.baseUrl;
          if (apiKey) {
            const liveResult = await server.validateProviderKey(providerName, apiKey, providerBaseUrl);
            if (liveResult.valid && Array.isArray(liveResult.models)) {
              for (const lm of liveResult.models as Array<{ id?: string; name?: string }>) {
                const rawId = String(lm.id ?? lm.name ?? '');
                if (!rawId) continue;
                const modelId = stripProviderPrefix(rawId);
                if (seenIds.has(modelId)) continue;
                seenIds.add(modelId);
                seenIds.add(rawId);
                const enriched = enrichModelFromCatalog(modelId, undefined, server.modelCatalog);
                models.push({
                  id: modelId,
                  name: modelId,
                  mode: enriched.mode,
                  tier: enriched.tier,
                  costTier: enriched.costTier,
                  capabilities: enriched.capabilities,
                });
              }
            }
          }
        } catch { /* non-critical: live fetch failure just means fewer results */ }

        if (server.modelCatalog) {
          for (const cm of server.modelCatalog.getModelsByProvider(providerName)) {
            if (seenIds.has(cm.id)) continue;
            seenIds.add(cm.id);
            const enriched = enrichModelFromCatalog(cm.id, undefined, server.modelCatalog);
            models.push({
              id: cm.id,
              name: cm.id,
              mode: enriched.mode,
              tier: enriched.tier,
              costTier: enriched.costTier,
              capabilities: enriched.capabilities,
            });
          }
        }

        result.push({
          provider: providerName,
          displayName: providerSettings.displayName ?? providerName,
          models,
        });
      }
      const payload = { providers: result };
      server.routingCandidatesCache = { data: payload, expireAt: Date.now() + APIServer.ROUTING_CACHE_TTL_MS };
      server.json(res, 200, payload);
      return true;
    }

    // Models — Suggested assignments (auto-prefill best model per task type)
    if (path === '/api/models/suggested-assignments' && req.method === 'GET') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;

      const ALL_CAPABILITY_TYPES: string[] = [
        'text',
        'image_recognition', 'image_generation',
        'audio_tts', 'audio_stt',
        'video_generation',
      ];

      const TEXT_CAPABILITIES = new Set(['text']);

      const CAP_MAP: Record<string, string[]> = {
        image_recognition: ['vision'],
        image_generation: ['imageGeneration'],
        audio_tts: ['audioOutput', 'tts'],
        audio_stt: ['audioInput', 'stt'],
        video_generation: ['videoGeneration'],
      };


      interface CandidateModel {
        provider: string;
        modelId: string;
        tier?: string;
        capabilities?: string[];
      }

      const allCandidates: CandidateModel[] = [];
      const settings = server.llmRouter!.getEnhancedSettings();

      for (const [providerName, providerSettings] of Object.entries(settings.providers)) {
        if (!providerSettings.enabled || !providerSettings.configured) continue;
        const seenIds = new Set<string>();

        for (const m of providerSettings.models ?? []) {
          seenIds.add(m.id);
          const enriched = enrichModelFromCatalog(m.id, m.tier, server.modelCatalog);
          let caps = enriched.capabilities ?? (m as any).capabilities;
          if (!caps && (m as any).inputTypes?.includes('image')) {
            caps = ['vision'];
          }
          allCandidates.push({
            provider: providerName,
            modelId: m.id,
            tier: enriched.tier,
            capabilities: caps,
          });
        }

        if (server.modelCatalog) {
          for (const cm of server.modelCatalog.getModelsByProvider(providerName)) {
            if (seenIds.has(cm.id)) continue;
            seenIds.add(cm.id);
            const enriched = enrichModelFromCatalog(cm.id, undefined, server.modelCatalog);
            allCandidates.push({
              provider: providerName,
              modelId: cm.id,
              tier: enriched.tier,
              capabilities: enriched.capabilities,
            });
          }
        }
      }

      // For each capability type, find the best model
      const suggestions: Record<string, { provider: string; model: string; tier?: string } | null> = {};

      for (const capabilityType of ALL_CAPABILITY_TYPES) {
        let candidates: CandidateModel[];

        const NON_TEXT_CAPS = new Set(['imageGeneration', 'tts', 'stt', 'videoGeneration', 'audioOutput', 'audioInput']);
        if (TEXT_CAPABILITIES.has(capabilityType)) {
          candidates = allCandidates.filter(m => {
            if (m.capabilities && m.capabilities.some(c => NON_TEXT_CAPS.has(c))) return false;
            return true;
          });
        } else {
          const requiredCaps = CAP_MAP[capabilityType] ?? [];
          candidates = allCandidates.filter(m =>
            m.capabilities && m.capabilities.length > 0 &&
            requiredCaps.some(cap => m.capabilities!.includes(cap))
          );
        }

        if (candidates.length === 0) {
          suggestions[capabilityType] = null;
          continue;
        }

        const tierRank: Record<string, number> = { max: 3, pro: 2, base: 1 };
        candidates.sort((a, b) => {
          const ta = tierRank[a.tier ?? ''] ?? 0;
          const tb = tierRank[b.tier ?? ''] ?? 0;
          return tb - ta;
        });

        const best = candidates[0];
        suggestions[capabilityType] = { provider: best.provider, model: best.modelId, tier: best.tier };
      }

      server.json(res, 200, { suggestions });
      return true;
    }

    // Settings — Model routing config (GET/POST)
    if (path === '/api/settings/llm/routing' && req.method === 'GET') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;
      if (!server.llmRouter) {
        server.json(res, 200, { capabilityRouting: {}, routingDefaultModel: null });
        return true;
      }
      server.json(res, 200, {
        capabilityRouting: server.llmRouter.capabilityRouting,
        routingDefaultModel: server.llmRouter.routingDefaultModel ?? null,
      });
      return true;
    }

    // Settings — Agent configuration (maxToolIterations, cognitive etc.)
    if (path === '/api/settings/agent' && req.method === 'GET') {
      const am = server.orgService.getAgentManager();
      server.json(res, 200, {
        maxToolIterations: am.maxToolIterations,
        cognitive: am.cognitiveConfig ?? { enabled: false },
      });
      return true;
    }

    if (path === '/api/settings/agent' && req.method === 'POST') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;
      const body = await server.readBody(req);
      const am = server.orgService.getAgentManager();
      let changed = false;
      if (typeof body['maxToolIterations'] === 'number') {
        am.maxToolIterations = body['maxToolIterations'];
        changed = true;
      }
      if (body['cognitive'] && typeof body['cognitive'] === 'object') {
        const cc = body['cognitive'] as Record<string, unknown>;
        am.cognitiveConfig = {
          enabled: cc['enabled'] === true,
          maxDepth: typeof cc['maxDepth'] === 'number' ? cc['maxDepth'] : undefined,
          appraisalModel: typeof cc['appraisalModel'] === 'string' ? cc['appraisalModel'] : undefined,
          timeoutMs: typeof cc['timeoutMs'] === 'number' ? cc['timeoutMs'] : undefined,
        };
        changed = true;
      }
      if (changed) {
        try {
          saveConfig({ agent: { maxToolIterations: am.maxToolIterations } } as any, server.markusConfigPath);
        } catch (e) {
          log.warn('Failed to persist agent settings to config file', { error: String(e) });
        }
        for (const info of am.listAgents()) {
          const agent = am.getAgent(info.id);
          if (agent) agent.maxToolIterations = am.maxToolIterations;
        }
        server.auditService?.record({
          orgId: 'system',
          type: 'settings_changed',
          action: 'agent_max_tool_iterations',
          detail: `maxToolIterations=${am.maxToolIterations}`,
          userId: auth.userId,
          success: true,
        });
      }
      server.json(res, 200, {
        maxToolIterations: am.maxToolIterations,
        cognitive: am.cognitiveConfig ?? { enabled: false },
      });
      return true;
    }

    // Settings — Network / Proxy
    if (path === '/api/settings/network' && req.method === 'GET') {
      const { loadConfig: loadCfg } = await import('@markus/shared');
      const { getEffectiveProxy } = await import('@markus/core');
      const currentConfig = loadCfg(server.markusConfigPath);
      const effective = getEffectiveProxy();
      server.json(res, 200, {
        network: currentConfig.network ?? {},
        effective: { proxy: effective.url ?? null, source: effective.source },
      });
      return true;
    }

    if (path === '/api/settings/network' && req.method === 'POST') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;
      const body = await server.readBody(req);
      const updates: Record<string, unknown> = {};
      if (typeof body['proxy'] === 'string') updates.proxy = body['proxy'] || undefined;
      if (typeof body['proxyEnabled'] === 'boolean') updates.proxyEnabled = body['proxyEnabled'];
      try {
        saveConfig({ network: updates } as any, server.markusConfigPath);
        server.json(res, 200, { ok: true, network: updates });
      } catch (e) {
        server.json(res, 500, { error: `Failed to save network settings: ${e}` });
      }
      return true;
    }

    // Settings — Browser automation
    if (path === '/api/settings/browser' && req.method === 'GET') {
      const { loadConfig: loadCfg } = await import('@markus/shared');
      const currentConfig = loadCfg(server.markusConfigPath);
      const browser = currentConfig.browser ?? {};
      const am = server.orgService.getAgentManager();
      server.json(res, 200, {
        bringToFront: browser.bringToFront ?? false,
        remoteDebuggingPort: browser.remoteDebuggingPort ?? 0,
        autoCloseTabs: browser.autoCloseTabs ?? true,
        autoClickAllowDialog: browser.autoClickAllowDialog ?? false,
        extensionBridgePort: browser.extensionBridgePort ?? 9333,
        extensionConnected: am.browserExtensionConnected,
      });
      return true;
    }

    if (path === '/api/settings/browser' && req.method === 'POST') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;
      const body = await server.readBody(req);
      const updates: Record<string, unknown> = {};
      if (typeof body['bringToFront'] === 'boolean') updates.bringToFront = body['bringToFront'];
      if (typeof body['remoteDebuggingPort'] === 'number') updates.remoteDebuggingPort = body['remoteDebuggingPort'];
      if (typeof body['autoCloseTabs'] === 'boolean') updates.autoCloseTabs = body['autoCloseTabs'];
      if (typeof body['autoClickAllowDialog'] === 'boolean') updates.autoClickAllowDialog = body['autoClickAllowDialog'];
      try {
        saveConfig({ browser: updates } as any, server.markusConfigPath);
        const am = server.orgService.getAgentManager();
        if (typeof updates.bringToFront === 'boolean') {
          am.setBrowserBringToFront(updates.bringToFront);
        }
        if (typeof updates.autoCloseTabs === 'boolean') {
          am.setBrowserAutoCloseTabs(updates.autoCloseTabs);
        }
        if (typeof updates.remoteDebuggingPort === 'number') {
          am.setBrowserRemoteDebuggingPort(updates.remoteDebuggingPort);
        }
        if (typeof updates.autoClickAllowDialog === 'boolean') {
          am.setBrowserAutoClickAllowDialog(updates.autoClickAllowDialog);
        }
      } catch (e) {
        log.warn('Failed to persist browser settings', { error: String(e) });
      }
      if (Object.keys(updates).length > 0) {
        server.auditService?.record({
          orgId: 'system',
          type: 'settings_changed',
          action: 'browser',
          detail: 'Browser automation settings updated',
          userId: auth.userId,
          success: true,
          metadata: { updates },
        });
      }
      const { loadConfig: loadCfg } = await import('@markus/shared');
      const currentConfig = loadCfg(server.markusConfigPath);
      const browser = currentConfig.browser ?? {};
      const am2 = server.orgService.getAgentManager();
      server.json(res, 200, {
        bringToFront: browser.bringToFront ?? false,
        remoteDebuggingPort: browser.remoteDebuggingPort ?? 0,
        autoCloseTabs: browser.autoCloseTabs ?? true,
        autoClickAllowDialog: browser.autoClickAllowDialog ?? false,
        extensionBridgePort: browser.extensionBridgePort ?? 9333,
        extensionConnected: am2.browserExtensionConnected,
      });
      return true;
    }

    // Settings — Chrome Extension: download zip
    if (path === '/api/settings/browser/extension.zip' && req.method === 'GET') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;

      try {
        const { fileURLToPath } = await import('node:url');
        const { dirname: dn, resolve: rslv, join: jn } = await import('node:path');
        const { execSync } = await import('node:child_process');
        const { existsSync: ex, readFileSync, statSync } = await import('node:fs');

        const thisDir = dn(fileURLToPath(import.meta.url));
        // Search order: Electron bundled → dev workspace → binary install → cwd fallback
        const zipCandidates = [
          // Electron desktop: zip is sibling of main.js in dist/ (unpacked from asar)
          jn(thisDir, 'markus-browser-extension.zip'),
          // Also check MARKUS_TEMPLATES_DIR parent (points to unpacked dist/)
          ...(process.env.MARKUS_TEMPLATES_DIR
            ? [jn(rslv(process.env.MARKUS_TEMPLATES_DIR, '..'), 'markus-browser-extension.zip')]
            : []),
          jn(rslv(thisDir, '..', '..', 'chrome-extension'), 'dist', 'markus-browser-extension.zip'),
          jn(rslv(thisDir, '..', 'chrome-extension'), 'markus-browser-extension.zip'),
          jn(rslv(thisDir, '..', '..', '..', 'chrome-extension'), 'markus-browser-extension.zip'),
          jn(rslv(process.cwd(), 'packages', 'chrome-extension'), 'dist', 'markus-browser-extension.zip'),
          jn(rslv(process.cwd(), 'chrome-extension'), 'markus-browser-extension.zip'),
        ];
        let zipPath = zipCandidates.find(p => ex(p));

        // If not found, try building from source
        if (!zipPath) {
          const extDir = [
            rslv(thisDir, '..', '..', 'chrome-extension'),
            rslv(process.cwd(), 'packages', 'chrome-extension'),
          ].find(d => ex(jn(d, 'package.json')));
          if (extDir) {
            try { execSync('pnpm run pack', { cwd: extDir, timeout: 30000, stdio: 'pipe' }); } catch { /* ignore */ }
            const built = jn(extDir, 'dist', 'markus-browser-extension.zip');
            if (ex(built)) zipPath = built;
          }
        }
        if (!zipPath) { server.json(res, 404, { error: 'Extension zip not found.' }); return; }

        const data = readFileSync(zipPath);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="markus-browser-extension.zip"',
          'Content-Length': data.length,
        });
        res.end(data);
      } catch (e) {
        server.json(res, 500, { error: String(e) });
      }
      return true;
    }

    // Settings — Chrome Extension: open chrome://extensions page
    if (path === '/api/settings/browser/open-extensions-page' && req.method === 'POST') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;

      try {
        const { exec: execCb } = await import('node:child_process');
        const platform = process.platform;
        if (platform === 'darwin') {
          execCb('open -a "Google Chrome" "chrome://extensions"', () => {});
        } else if (platform === 'win32') {
          execCb('start "" "chrome://extensions"', () => {});
        } else {
          execCb('xdg-open "chrome://extensions" 2>/dev/null || google-chrome "chrome://extensions"', () => {});
        }
        server.json(res, 200, { ok: true });
      } catch (e) {
        server.json(res, 500, { error: String(e) });
      }
      return true;
    }

    // Settings — Browser auto-click test
    if (path === '/api/settings/browser/test-auto-click' && req.method === 'POST') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;
      const { testAutoClick } = await import('@markus/core');
      const result = await testAutoClick();
      server.json(res, 200, result);
      return true;
    }

    // Settings — Browser concurrent integration test
    if (path === '/api/settings/browser/test-concurrent' && req.method === 'POST') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;
      const am = server.orgService.getAgentManager();
      const params = await server.readBody(req).catch(() => ({} as Record<string, unknown>));
      const mode = (params.mode as string) ?? 'quick';

      if (mode === 'chaos') {
        const durationMs = Math.min(((params.durationSec as number) ?? 120) * 1000, 600_000);
        const agentCount = Math.min((params.agents as number) ?? 3, 5);

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        const ac = new AbortController();
        const chaosAbortKey = '__chaos_abort__';
        (this as unknown as Record<string, AbortController>)[chaosAbortKey] = ac;

        req.on('close', () => ac.abort());

        try {
          const gen = am.runChaosBrowserTest({ durationMs, agentCount, signal: ac.signal });
          for await (const ev of gen) {
            if (ac.signal.aborted) break;
            res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          res.write(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`);
        }
        res.end();
        delete (this as unknown as Record<string, AbortController>)[chaosAbortKey];
        return true;
      }

      // Quick mode (default)
      const result = await am.runQuickBrowserTest();
      server.json(res, 200, result);
      return true;
    }

    // Settings — Stop chaos test
    if (path === '/api/settings/browser/test-concurrent' && req.method === 'DELETE') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;
      const chaosAbortKey = '__chaos_abort__';
      const ac = (this as unknown as Record<string, AbortController>)[chaosAbortKey];
      if (ac) {
        ac.abort();
        delete (this as unknown as Record<string, AbortController>)[chaosAbortKey];
      }
      server.json(res, 200, { ok: true });
      return true;
    }

    // Settings — Search API keys
    if (path === '/api/settings/search' && req.method === 'GET') {
      const { loadConfig: loadCfg } = await import('@markus/shared');
      const currentConfig = loadCfg(server.markusConfigPath);
      const search = currentConfig.integrations?.search ?? {};
      const mask = (key?: string) => key ? '***' + key.slice(-4) : '';
      server.json(res, 200, {
        serper: { configured: !!search.serperApiKey || !!process.env['SERPER_API_KEY'], preview: mask(search.serperApiKey || process.env['SERPER_API_KEY']) },
        tavily: { configured: !!search.tavilyApiKey || !!process.env['TAVILY_API_KEY'], preview: mask(search.tavilyApiKey || process.env['TAVILY_API_KEY']) },
        bing: { configured: !!search.bingApiKey || !!process.env['BING_SEARCH_API_KEY'], preview: mask(search.bingApiKey || process.env['BING_SEARCH_API_KEY']) },
        google: { configured: !!(search.googleSearchApiKey && search.googleSearchCx) || !!(process.env['GOOGLE_SEARCH_API_KEY'] && process.env['GOOGLE_SEARCH_CX']), preview: mask(search.googleSearchApiKey || process.env['GOOGLE_SEARCH_API_KEY']) },
        serpapi: { configured: !!search.serpApiKey || !!process.env['SERPAPI_API_KEY'], preview: mask(search.serpApiKey || process.env['SERPAPI_API_KEY']) },
        brave: { configured: !!search.braveApiKey || !!process.env['BRAVE_SEARCH_API_KEY'], preview: mask(search.braveApiKey || process.env['BRAVE_SEARCH_API_KEY']) },
        exa: { configured: !!search.exaApiKey || !!process.env['EXA_API_KEY'], preview: mask(search.exaApiKey || process.env['EXA_API_KEY']) },
        bocha: { configured: !!search.bochaApiKey || !!process.env['BOCHA_API_KEY'], preview: mask(search.bochaApiKey || process.env['BOCHA_API_KEY']) },
      });
      return true;
    }

    if (path === '/api/settings/search' && req.method === 'POST') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;
      const body = await server.readBody(req);
      const updates: Record<string, string | undefined> = {};
      if (typeof body['serperApiKey'] === 'string') {
        updates.serperApiKey = body['serperApiKey'] || undefined;
        if (body['serperApiKey']) process.env['SERPER_API_KEY'] = body['serperApiKey'] as string;
        else delete process.env['SERPER_API_KEY'];
      }
      if (typeof body['tavilyApiKey'] === 'string') {
        updates.tavilyApiKey = body['tavilyApiKey'] || undefined;
        if (body['tavilyApiKey']) process.env['TAVILY_API_KEY'] = body['tavilyApiKey'] as string;
        else delete process.env['TAVILY_API_KEY'];
      }
      if (typeof body['bingApiKey'] === 'string') {
        updates.bingApiKey = body['bingApiKey'] || undefined;
        if (body['bingApiKey']) process.env['BING_SEARCH_API_KEY'] = body['bingApiKey'] as string;
        else delete process.env['BING_SEARCH_API_KEY'];
      }
      if (typeof body['googleSearchApiKey'] === 'string') {
        updates.googleSearchApiKey = body['googleSearchApiKey'] || undefined;
        if (body['googleSearchApiKey']) process.env['GOOGLE_SEARCH_API_KEY'] = body['googleSearchApiKey'] as string;
        else delete process.env['GOOGLE_SEARCH_API_KEY'];
      }
      if (typeof body['googleSearchCx'] === 'string') {
        updates.googleSearchCx = body['googleSearchCx'] || undefined;
        if (body['googleSearchCx']) process.env['GOOGLE_SEARCH_CX'] = body['googleSearchCx'] as string;
        else delete process.env['GOOGLE_SEARCH_CX'];
      }
      if (typeof body['serpApiKey'] === 'string') {
        updates.serpApiKey = body['serpApiKey'] || undefined;
        if (body['serpApiKey']) process.env['SERPAPI_API_KEY'] = body['serpApiKey'] as string;
        else delete process.env['SERPAPI_API_KEY'];
      }
      if (typeof body['braveApiKey'] === 'string') {
        updates.braveApiKey = body['braveApiKey'] || undefined;
        if (body['braveApiKey']) process.env['BRAVE_SEARCH_API_KEY'] = body['braveApiKey'] as string;
        else delete process.env['BRAVE_SEARCH_API_KEY'];
      }
      if (typeof body['exaApiKey'] === 'string') {
        updates.exaApiKey = body['exaApiKey'] || undefined;
        if (body['exaApiKey']) process.env['EXA_API_KEY'] = body['exaApiKey'] as string;
        else delete process.env['EXA_API_KEY'];
      }
      if (typeof body['bochaApiKey'] === 'string') {
        updates.bochaApiKey = body['bochaApiKey'] || undefined;
        if (body['bochaApiKey']) process.env['BOCHA_API_KEY'] = body['bochaApiKey'] as string;
        else delete process.env['BOCHA_API_KEY'];
      }
      try {
        saveConfig({ integrations: { search: updates } } as any, server.markusConfigPath);
      } catch (e) {
        log.warn('Failed to persist search settings', { error: String(e) });
      }
      server.auditService?.record({
        orgId: 'system',
        type: 'settings_changed',
        action: 'search',
        detail: 'Search API key settings updated',
        userId: auth.userId,
        success: true,
        metadata: { keys: Object.keys(updates) },
      });
      const { loadConfig: loadCfg } = await import('@markus/shared');
      const currentConfig = loadCfg(server.markusConfigPath);
      const search = currentConfig.integrations?.search ?? {};
      const mask = (key?: string) => key ? '***' + key.slice(-4) : '';
      server.json(res, 200, {
        serper: { configured: !!search.serperApiKey || !!process.env['SERPER_API_KEY'], preview: mask(search.serperApiKey || process.env['SERPER_API_KEY']) },
        tavily: { configured: !!search.tavilyApiKey || !!process.env['TAVILY_API_KEY'], preview: mask(search.tavilyApiKey || process.env['TAVILY_API_KEY']) },
        bing: { configured: !!search.bingApiKey || !!process.env['BING_SEARCH_API_KEY'], preview: mask(search.bingApiKey || process.env['BING_SEARCH_API_KEY']) },
        google: { configured: !!(search.googleSearchApiKey && search.googleSearchCx) || !!(process.env['GOOGLE_SEARCH_API_KEY'] && process.env['GOOGLE_SEARCH_CX']), preview: mask(search.googleSearchApiKey || process.env['GOOGLE_SEARCH_API_KEY']) },
        serpapi: { configured: !!search.serpApiKey || !!process.env['SERPAPI_API_KEY'], preview: mask(search.serpApiKey || process.env['SERPAPI_API_KEY']) },
        brave: { configured: !!search.braveApiKey || !!process.env['BRAVE_SEARCH_API_KEY'], preview: mask(search.braveApiKey || process.env['BRAVE_SEARCH_API_KEY']) },
        exa: { configured: !!search.exaApiKey || !!process.env['EXA_API_KEY'], preview: mask(search.exaApiKey || process.env['EXA_API_KEY']) },
        bocha: { configured: !!search.bochaApiKey || !!process.env['BOCHA_API_KEY'], preview: mask(search.bochaApiKey || process.env['BOCHA_API_KEY']) },
      });
      return true;
    }

    // Settings — Coding Tools
    // Settings — Coding Tools: shared detection logic
    const _detectOneTool = async (toolName: string) => {
      const { resolveWhich: _resolveWhich, execSafeSync: _execSafe, loadConfig: _loadCfg } = await import('@markus/shared');
      const toolDefs: Record<string, { displayName: string; binaryName: string; installHint: string; authEnvKeys: string[]; authArgs: string[] | null; authFailPattern: RegExp | null; authHint: string }> = {
        'claude-code': { displayName: 'Claude Code', binaryName: 'claude', installHint: 'npm install -g @anthropic-ai/claude-code', authEnvKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'], authArgs: ['api-key-status'], authFailPattern: /not authenticated|invalid api key/i, authHint: 'Run `claude` to complete interactive login, or set ANTHROPIC_API_KEY' },
        'codex': { displayName: 'Codex', binaryName: 'codex', installHint: 'npm install -g @openai/codex', authEnvKeys: ['CODEX_API_KEY', 'OPENAI_API_KEY'], authArgs: null, authFailPattern: null, authHint: 'Run `codex login` or set CODEX_API_KEY environment variable' },
        'cursor-agent': { displayName: 'Cursor Agent', binaryName: 'cursor', installHint: 'Install Cursor from https://cursor.com/downloads then run: cursor agent install-shell-integration', authEnvKeys: ['CURSOR_API_KEY'], authArgs: ['agent', 'status'], authFailPattern: /not logged in/i, authHint: 'Run `cursor agent login` or set CURSOR_API_KEY environment variable' },
      };
      const def = toolDefs[toolName];
      if (!def) return null;

      const cfg = _loadCfg(server.markusConfigPath);
      const toolCfg = cfg.codingTools?.tools?.[toolName];
      const binPath = toolCfg?.binaryPath || _resolveWhich(def.binaryName);
      if (!binPath) {
        return { name: toolName, displayName: def.displayName, binaryName: def.binaryName, available: false, installHint: def.installHint };
      }

      let version: string | undefined;
      const verResult = _execSafe(binPath, ['--version'], { timeout: 5000 });
      if (verResult.exitCode === 0 && verResult.stdout) version = verResult.stdout;

      const detectEnv = { ...process.env, ...(toolCfg?.env ?? {}) };

      // Check auth: env vars first (fast, reliable), then CLI command (slower, may not detect third-party keys)
      let authenticated = false;
      let authUser: string | undefined;
      if (def.authEnvKeys.some(k => !!detectEnv[k])) {
        authenticated = true;
      } else if (def.authArgs && def.authFailPattern) {
        const statusResult = _execSafe(binPath, def.authArgs, { timeout: 10_000, env: detectEnv });
        const statusOut = statusResult.stdout;
        if (statusOut) {
          authenticated = !def.authFailPattern.test(statusOut);
          if (authenticated && statusOut.length < 200) authUser = statusOut;
        }
      }

      return {
        name: toolName, displayName: def.displayName, binaryName: def.binaryName,
        available: true, path: binPath, version,
        authenticated, authHint: authenticated ? undefined : def.authHint, authUser,
      };
    };

    if (path === '/api/settings/coding-tools/detect' && req.method === 'GET') {
      const tools = [];
      for (const name of ['claude-code', 'codex', 'cursor-agent']) {
        const result = await _detectOneTool(name);
        if (result) tools.push(result);
      }
      server.json(res, 200, { tools });
      return true;
    }

    const perToolDetectMatch = path.match(/^\/api\/settings\/coding-tools\/detect\/([a-z-]+)$/);
    if (perToolDetectMatch && req.method === 'GET') {
      const toolName = perToolDetectMatch[1] as string;
      const result = await _detectOneTool(toolName);
      if (!result) {
        server.json(res, 404, { error: `Unknown tool: ${toolName}` });
        return true;
      }
      server.json(res, 200, result);
      return true;
    }

    // Settings — Coding Tools: quick test
    const testMatch = path.match(/^\/api\/settings\/coding-tools\/([a-z-]+)\/test$/);
    if (testMatch && req.method === 'POST') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;

      const toolName = testMatch[1] as string;
      const { resolveWhich: _resolveWhich, loadConfig: _loadCfg } = await import('@markus/shared');

      const binaryMap: Record<string, string> = {
        'claude-code': 'claude',
        codex: 'codex',
        'cursor-agent': 'cursor',
      };
      const binaryName = binaryMap[toolName];
      if (!binaryName) {
        server.json(res, 404, { error: `Unknown tool: ${toolName}` });
        return true;
      }

      const cfg = _loadCfg(server.markusConfigPath);
      const toolCfg = cfg.codingTools?.tools?.[toolName];
      const binPath = toolCfg?.binaryPath || _resolveWhich(binaryName);
      if (!binPath) {
        server.json(res, 200, { success: false, error: `${binaryName} not found in PATH` });
        return true;
      }

      const env = { ...process.env, ...(toolCfg?.env ?? {}) };

      const spawnAsync = async (bin: string, args: string[], spawnEnv: Record<string, string | undefined>, timeoutMs: number) => {
        const { spawn: _spawn } = await import('node:child_process');
        return new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
          const proc = _spawn(bin, args, { env: spawnEnv as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
          proc.stdin.end();
          let stdout = '', stderr = '';
          proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
          proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
          const timer = setTimeout(() => { try { proc.kill(); } catch { /* */ } }, timeoutMs);
          proc.on('close', (code: number | null) => { clearTimeout(timer); resolve({ stdout, stderr, code: code ?? 1 }); });
          proc.on('error', (e: Error) => { clearTimeout(timer); resolve({ stdout, stderr: e.message, code: 1 }); });
        });
      };

      try {
        if (toolName === 'cursor-agent') {
          const r = await spawnAsync(binPath, ['agent', 'about', '--format', 'json'], env, 15_000);
          try {
            const info = JSON.parse(r.stdout);
            const hasEmail = !!(info.userEmail);
            server.json(res, 200, {
              success: hasEmail,
              apiKeySource: hasEmail ? (info.userEmail as string) : null,
              model: (info.model as string) ?? null,
              detail: hasEmail ? `${info.subscriptionTier ?? ''} · ${info.userEmail ?? ''}`.trim() : 'Not authenticated',
            });
          } catch {
            const errOutput = (r.stderr || r.stdout || '').trim().slice(0, 300);
            server.json(res, 200, { success: false, error: errOutput || 'Not authenticated or unable to connect' });
          }
        } else if (toolName === 'claude-code') {
          const r = await spawnAsync(binPath, [
            '--print', '--output-format', 'text', '--max-turns', '1',
            '--permission-mode', 'plan',
            'respond with exactly: MARKUS_TEST_OK',
          ], env, 30_000);
          const output = (r.stdout || '').trim();
          const success = r.code === 0 && output.length > 0;
          if (success) {
            server.json(res, 200, { success: true, detail: output.slice(0, 200) });
          } else {
            const errOutput = (r.stderr || r.stdout || '').trim().slice(0, 500);
            server.json(res, 200, { success: false, error: errOutput || `Exit code ${r.code}` });
          }
        } else if (toolName === 'codex') {
          const r = await spawnAsync(binPath, [
            'exec', '--full-auto', '--skip-git-repo-check',
            'respond with exactly: MARKUS_TEST_OK',
          ], env, 30_000);
          const output = (r.stdout || '').trim();
          const success = r.code === 0 && output.length > 0;
          if (success) {
            server.json(res, 200, { success: true, detail: output.slice(0, 200) });
          } else {
            const errOutput = (r.stderr || r.stdout || '').trim().slice(0, 500);
            server.json(res, 200, { success: false, error: errOutput || `Exit code ${r.code}` });
          }
        } else {
          server.json(res, 200, { success: false, error: `No test strategy for ${toolName}` });
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        server.json(res, 200, { success: false, error: errMsg.slice(0, 500) });
      }
      return true;
    }

    if (path === '/api/settings/coding-tools' && req.method === 'GET') {
      const { loadConfig: loadCfg } = await import('@markus/shared');
      const currentConfig = loadCfg(server.markusConfigPath);
      const ct = currentConfig.codingTools ?? {};
      const toolNames = ['claude-code', 'codex', 'cursor-agent'] as const;
      const tools: Record<string, unknown> = {};
      for (const name of toolNames) {
        const cfg = ct.tools?.[name] ?? {};
        tools[name] = {
          tool: name,
          enabled: cfg.enabled ?? true,
          binaryPath: cfg.binaryPath,
          defaultArgs: cfg.defaultArgs ?? [],
          timeoutMs: cfg.timeoutMs ?? 600_000,
          defaultModel: cfg.defaultModel,
          maxBudgetPerSessionUsd: cfg.maxBudgetPerSessionUsd,
          approvalRequired: cfg.approvalRequired,
          env: cfg.env,
        };
      }
      server.json(res, 200, { enabled: ct.enabled ?? false, tools });
      return true;
    }

    if (path === '/api/settings/coding-tools' && req.method === 'POST') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;
      const body = await server.readBody(req);
      const { loadConfig: loadCfg } = await import('@markus/shared');
      const currentConfig = loadCfg(server.markusConfigPath);
      const existing = currentConfig.codingTools ?? {};
      const updates: Record<string, unknown> = {
        enabled: typeof body['enabled'] === 'boolean' ? body['enabled'] : (existing.enabled ?? false),
        tools: { ...(existing.tools ?? {}) },
      };
      const toolsBody = body['tools'];
      if (toolsBody && typeof toolsBody === 'object') {
        for (const [name, cfg] of Object.entries(toolsBody as Record<string, Record<string, unknown>>)) {
          if (!['claude-code', 'codex', 'cursor-agent'].includes(name)) continue;
          const prev = (updates.tools as Record<string, unknown>)[name] as Record<string, unknown> ?? {};
          const merged: Record<string, unknown> = { ...prev };
          if (typeof cfg.enabled === 'boolean') merged.enabled = cfg.enabled;
          if (typeof cfg.binaryPath === 'string') merged.binaryPath = cfg.binaryPath || undefined;
          if (Array.isArray(cfg.defaultArgs)) merged.defaultArgs = cfg.defaultArgs.filter(a => typeof a === 'string');
          if (typeof cfg.timeoutMs === 'number' && cfg.timeoutMs > 0) merged.timeoutMs = cfg.timeoutMs;
          if (typeof cfg.defaultModel === 'string') merged.defaultModel = cfg.defaultModel || undefined;
          if (typeof cfg.maxBudgetPerSessionUsd === 'number' && cfg.maxBudgetPerSessionUsd > 0) merged.maxBudgetPerSessionUsd = cfg.maxBudgetPerSessionUsd;
          else if (cfg.maxBudgetPerSessionUsd === undefined || cfg.maxBudgetPerSessionUsd === null) merged.maxBudgetPerSessionUsd = undefined;
          if (typeof cfg.approvalRequired === 'boolean') merged.approvalRequired = cfg.approvalRequired || undefined;
          if (cfg.env !== undefined) {
            if (cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)) {
              const sanitized: Record<string, string> = {};
              for (const [k, v] of Object.entries(cfg.env as Record<string, unknown>)) {
                if (typeof k === 'string' && typeof v === 'string') sanitized[k] = v;
              }
              merged.env = Object.keys(sanitized).length > 0 ? sanitized : undefined;
            } else {
              merged.env = undefined;
            }
          }
          (updates.tools as Record<string, unknown>)[name] = merged;
        }
      }
      try {
        saveConfig({ codingTools: updates } as any, server.markusConfigPath);
        const am = server.orgService.getAgentManager();
        am.setCodingToolsConfig(updates as Parameters<typeof am.setCodingToolsConfig>[0]);
      } catch (e) {
        log.warn('Failed to persist coding tools settings', { error: String(e) });
        server.json(res, 500, { error: `Failed to save coding tools settings: ${e}` });
        return true;
      }
      server.auditService?.record({
        orgId: 'system',
        type: 'settings_changed',
        action: 'coding_tools',
        detail: 'Coding tools settings updated',
        userId: auth.userId,
        success: true,
      });
      const ct = updates;
      const toolNames = ['claude-code', 'codex', 'cursor-agent'] as const;
      const tools: Record<string, unknown> = {};
      for (const name of toolNames) {
        const cfg = (ct.tools as Record<string, Record<string, unknown>>)?.[name] ?? {};
        tools[name] = {
          tool: name,
          enabled: cfg.enabled ?? true,
          binaryPath: cfg.binaryPath,
          defaultArgs: cfg.defaultArgs ?? [],
          timeoutMs: cfg.timeoutMs ?? 600_000,
        };
      }
      server.json(res, 200, { enabled: ct.enabled ?? false, tools });
      return true;
    }

    // Coding tool models: list available models for a tool
    const modelsMatch = path.match(/^\/api\/settings\/coding-tools\/([^/]+)\/models$/);
    if (modelsMatch && req.method === 'GET') {
      const toolName = modelsMatch[1] as string;
      if (!['claude-code', 'codex', 'cursor-agent'].includes(toolName)) {
        server.json(res, 400, { error: `Unknown tool: ${toolName}` });
        return true;
      }
      try {
        const { loadConfig: loadCfg3 } = await import('@markus/shared');
        const cfg3 = loadCfg3(server.markusConfigPath);
        const toolEnv = (cfg3.codingTools?.tools as Record<string, Record<string, unknown>> | undefined)?.[toolName]?.env as Record<string, string> | undefined;
        const savedEnv: Record<string, string | undefined> = {};
        if (toolEnv) {
          for (const [k, v] of Object.entries(toolEnv)) {
            if (v) { savedEnv[k] = process.env[k]; process.env[k] = v; }
          }
        }

        let result;
        try {
          const { getAdapter: _getAdapter } = await import('@markus/core');
          const adapter = _getAdapter(toolName as 'claude-code' | 'codex' | 'cursor-agent');
          result = await adapter.listModels();
        } finally {
          for (const [k, orig] of Object.entries(savedEnv)) {
            if (orig === undefined) delete process.env[k]; else process.env[k] = orig;
          }
        }
        server.json(res, 200, { tool: toolName, models: result.models, source: result.source, hint: result.hint });
      } catch (err) {
        log.error(`Failed to list models for ${toolName}`, { error: err instanceof Error ? err.message : String(err) });
        server.json(res, 200, { tool: toolName, models: [], source: 'cli', error: err instanceof Error ? err.message : 'Unknown error' });
      }
      return true;
    }

    // Coding tool auth: CLI login or API key
    const authMatch = path.match(/^\/api\/settings\/coding-tools\/([^/]+)\/auth$/);
    if (authMatch && req.method === 'POST') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;
      const toolName = authMatch[1];
      if (!['claude-code', 'codex', 'cursor-agent'].includes(toolName)) {
        server.json(res, 400, { error: `Unknown tool: ${toolName}` });
        return true;
      }
      const body = await server.readBody(req);
      const method = body['method'] as string; // 'cli_login' or 'api_key'

      if (method === 'api_key') {
        const apiKey = body['apiKey'] as string;
        if (!apiKey || typeof apiKey !== 'string') {
          server.json(res, 400, { error: 'apiKey is required' });
          return true;
        }
        const envVarMap: Record<string, string> = {
          'cursor-agent': 'CURSOR_API_KEY',
          'claude-code': 'ANTHROPIC_API_KEY',
          codex: 'CODEX_API_KEY',
        };
        const envVar = envVarMap[toolName];
        if (envVar) {
          process.env[envVar] = apiKey;
          // Also persist to config env
          const { loadConfig: loadCfg2 } = await import('@markus/shared');
          const cfg2 = loadCfg2(server.markusConfigPath);
          const ctCfg = cfg2.codingTools ?? {};
          const toolsCfg = (ctCfg.tools ?? {}) as Record<string, Record<string, unknown>>;
          const toolCfg = toolsCfg[toolName] ?? {};
          const envCfg = (toolCfg.env ?? {}) as Record<string, string>;
          envCfg[envVar] = apiKey;
          toolCfg.env = envCfg;
          toolsCfg[toolName] = toolCfg;
          try {
            saveConfig({ codingTools: { ...ctCfg, tools: toolsCfg } } as any, server.markusConfigPath);
          } catch (e) {
            log.warn('Failed to persist API key to config', { error: String(e) });
          }
        }
        server.json(res, 200, { success: true, method: 'api_key', envVar });
        return true;
      }

      if (method === 'cli_login') {
        const { resolveWhich: _rw, execSafeSync: _es } = await import('@markus/shared');
        const loginCmds: Record<string, { bin: string; args: string[] }> = {
          'cursor-agent': { bin: 'cursor', args: ['agent', 'login'] },
          'claude-code': { bin: 'claude', args: ['login'] },
        };
        const loginDef = loginCmds[toolName];
        if (!loginDef) {
          server.json(res, 400, { error: `CLI login not supported for ${toolName}. Use API key instead.` });
          return true;
        }
        const loginBin = _rw(loginDef.bin) ?? loginDef.bin;
        try {
          const { exec } = await import('node:child_process');
          const { promisify } = await import('node:util');
          const execAsync = promisify(exec);
          const loginCmd = [loginBin, ...loginDef.args].join(' ');
          const { stdout, stderr } = await execAsync(loginCmd, { timeout: 60_000 });
          // Re-detect auth status after login
          let authenticated = false;
          if (toolName === 'cursor-agent') {
            const { stdout: status } = _es(loginBin, ['agent', 'status'], { timeout: 5000 });
            authenticated = !!status && !status.toLowerCase().includes('not logged in');
          } else if (toolName === 'claude-code') {
            const { stdout: status } = _es(loginBin, ['api-key-status'], { timeout: 10_000 });
            authenticated = !!status && !status.toLowerCase().includes('not authenticated');
          }
          server.json(res, 200, { success: true, method: 'cli_login', authenticated, output: (stdout + stderr).slice(0, 500) });
        } catch (e: any) {
          server.json(res, 200, { success: false, method: 'cli_login', error: e.message?.slice(0, 300) ?? String(e) });
        }
        return true;
      }

      server.json(res, 400, { error: 'method must be "cli_login" or "api_key"' });
      return true;
    }

    if (path === '/api/settings/llm/models' && req.method === 'GET') {
      if (!server.llmRouter) {
        server.json(res, 200, { models: [] });
        return true;
      }
      server.json(res, 200, { models: server.llmRouter.getModelCatalog() });
      return true;
    }

    if (path.match(/^\/api\/settings\/llm\/providers\/[^/]+$/) && req.method === 'PATCH') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;
      if (!server.llmRouter) {
        server.json(res, 503, { error: 'LLM router not available' });
        return true;
      }
      const providerName = path.split('/')[5]!;
      const body = await server.readBody(req);
      try {
        server.llmRouter.updateProviderModelConfig(
          providerName,
          body as {
            contextWindow?: number;
            maxOutputTokens?: number;
            cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
          }
        );
        server.auditService?.record({
          orgId: 'system',
          type: 'settings_changed',
          action: 'llm_provider_model_config',
          detail: `PATCH provider ${providerName}`,
          userId: auth.userId,
          success: true,
          metadata: { providerName, body },
        });
        server.json(res, 200, server.llmRouter.getEnhancedSettings());
      } catch (err) {
        server.json(res, 400, { error: String(err) });
      }
      return true;
    }

    // Settings — Add new provider
    if (path === '/api/settings/llm/providers' && req.method === 'POST') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;
      if (!server.llmRouter) {
        server.json(res, 503, { error: 'LLM router not available' });
        return true;
      }
      const body = await server.readBody(req);
      const { name, apiKey, baseUrl, model, enabled, contextWindow, maxOutputTokens, cost } = body as {
        name?: string; apiKey?: string; baseUrl?: string; model?: string; enabled?: boolean;
        contextWindow?: number; maxOutputTokens?: number; cost?: { input: number; output: number };
      };
      if (!name || typeof name !== 'string') {
        server.json(res, 400, { error: 'name (string) is required' });
        return true;
      }
      if (!model || typeof model !== 'string') {
        server.json(res, 400, { error: 'model (string) is required' });
        return true;
      }
      if (name !== 'ollama' && (!apiKey || typeof apiKey !== 'string')) {
        server.json(res, 400, { error: 'apiKey (string) is required' });
        return true;
      }
      try {
        server.llmRouter.registerProviderFromConfig(name, {
          provider: name as any,
          model,
          apiKey,
          baseUrl,
        });
        if (enabled === false) {
          server.llmRouter.setProviderEnabled(name, false);
        }
        if (contextWindow || maxOutputTokens || cost) {
          server.llmRouter.updateProviderModelConfig(name, {
            ...(contextWindow ? { contextWindow } : {}),
            ...(maxOutputTokens ? { maxOutputTokens } : {}),
            ...(cost ? { cost } : {}),
          });
        }
        server.invalidateRoutingCache();
        // Auto-set routing default model if none configured yet
        if (!server.llmRouter.routingDefaultModel && enabled !== false) {
          server.llmRouter.setRoutingDefaultModel({ provider: name, model });
          log.info('Auto-set routing default model for first provider', { provider: name, model });
        }
        try {
          const { loadConfig: loadCfg } = await import('@markus/shared');
          const currentConfig = loadCfg(server.markusConfigPath);
          const providers = { ...currentConfig.llm.providers };
          providers[name] = {
            ...providers[name],
            apiKey,
            model,
            ...(baseUrl ? { baseUrl } : {}),
            enabled: enabled !== false,
          };
          const configUpdates: Record<string, unknown> = { providers };
          if (!currentConfig.llm.routingDefaultModel && enabled !== false) {
            configUpdates.routingDefaultModel = { provider: name, model };
          }
          saveConfig({ llm: configUpdates } as any, server.markusConfigPath);
        } catch (e) {
          log.warn('Failed to persist new provider', { error: String(e) });
        }
        server.auditService?.record({
          orgId: 'system',
          type: 'settings_changed',
          action: 'llm_provider_add',
          detail: `Added LLM provider ${name}`,
          userId: auth.userId,
          success: true,
          metadata: { name, model, enabled: enabled !== false },
        });
        server.json(res, 200, server.llmRouter.getEnhancedSettings());
      } catch (err) {
        server.json(res, 400, { error: String(err) });
      }
      return true;
    }

    // Settings — Update existing provider
    if (path.match(/^\/api\/settings\/llm\/providers\/[^/]+$/) && req.method === 'PUT') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;
      if (!server.llmRouter) {
        server.json(res, 503, { error: 'LLM router not available' });
        return true;
      }
      const providerName = path.split('/')[5]!;
      const body = await server.readBody(req);
      const { apiKey, baseUrl, model, enabled, contextWindow, maxOutputTokens, cost } = body as {
        apiKey?: string; baseUrl?: string; model?: string; enabled?: boolean;
        contextWindow?: number; maxOutputTokens?: number; cost?: { input: number; output: number };
      };
      try {
        const provider = server.llmRouter.getProvider(providerName);
        if (provider) {
          const configUpdate: any = { provider: providerName };
          if (model) configUpdate.model = model;
          if (apiKey) configUpdate.apiKey = apiKey;
          if (baseUrl !== undefined) configUpdate.baseUrl = baseUrl;
          provider.configure(configUpdate);
        } else if (model) {
          server.llmRouter.registerProviderFromConfig(providerName, {
            provider: providerName as any,
            model,
            apiKey,
            baseUrl,
          });
        }
        if (typeof enabled === 'boolean') {
          server.llmRouter.setProviderEnabled(providerName, enabled);
        }
        if (contextWindow || maxOutputTokens || cost) {
          server.llmRouter.updateProviderModelConfig(providerName, {
            ...(contextWindow ? { contextWindow } : {}),
            ...(maxOutputTokens ? { maxOutputTokens } : {}),
            ...(cost ? { cost } : {}),
          });
        }
        server.invalidateRoutingCache();
        try {
          const { loadConfig: loadCfg } = await import('@markus/shared');
          const currentConfig = loadCfg(server.markusConfigPath);
          const providers = { ...currentConfig.llm.providers };
          const existing = providers[providerName] ?? {};
          providers[providerName] = {
            ...existing,
            ...(apiKey ? { apiKey } : {}),
            ...(model ? { model } : {}),
            ...(baseUrl !== undefined ? { baseUrl: baseUrl || undefined } : {}),
            ...(typeof enabled === 'boolean' ? { enabled } : {}),
          };
          saveConfig({ llm: { providers } } as any, server.markusConfigPath);
        } catch (e) {
          log.warn('Failed to persist provider update', { error: String(e) });
        }
        server.auditService?.record({
          orgId: 'system',
          type: 'settings_changed',
          action: 'llm_provider_update',
          detail: `Updated LLM provider ${providerName}`,
          userId: auth.userId,
          success: true,
          metadata: { providerName, hasApiKey: !!apiKey, model, enabled },
        });
        server.json(res, 200, server.llmRouter.getEnhancedSettings());
      } catch (err) {
        server.json(res, 400, { error: String(err) });
      }
      return true;
    }

    // Settings — Delete provider
    if (path.match(/^\/api\/settings\/llm\/providers\/[^/]+$/) && req.method === 'DELETE') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;
      if (!server.llmRouter) {
        server.json(res, 503, { error: 'LLM router not available' });
        return true;
      }
      const providerName = path.split('/')[5]!;
      try {
        server.llmRouter.unregisterProvider(providerName);
        server.invalidateRoutingCache();
        try {
          const { loadConfig: loadCfg } = await import('@markus/shared');
          const currentConfig = loadCfg(server.markusConfigPath);
          const configUpdates: any = { llm: { providers: { [providerName]: null } } };
          if (currentConfig.llm.defaultProvider === providerName) {
            const providers = { ...currentConfig.llm.providers };
            delete providers[providerName];
            const remaining = Object.keys(providers).filter(k => providers[k]?.enabled !== false);
            configUpdates.llm.defaultProvider = remaining[0] ?? 'anthropic';
          }
          saveConfig(configUpdates, server.markusConfigPath);
        } catch (e) {
          log.warn('Failed to persist provider deletion', { error: String(e) });
        }
        server.auditService?.record({
          orgId: 'system',
          type: 'settings_changed',
          action: 'llm_provider_delete',
          detail: `Removed LLM provider ${providerName}`,
          userId: auth.userId,
          success: true,
          metadata: { providerName },
        });
        server.json(res, 200, server.llmRouter.getEnhancedSettings());
      } catch (err) {
        server.json(res, 400, { error: String(err) });
      }
      return true;
    }

    // Settings — Add custom model to provider catalog
    if (path.match(/^\/api\/settings\/llm\/providers\/[^/]+\/models$/) && req.method === 'POST') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;
      if (!server.llmRouter) {
        server.json(res, 503, { error: 'LLM router not available' });
        return true;
      }
      const providerName = path.split('/')[5]!;
      const body = await server.readBody(req);
      const { id, name, contextWindow, maxOutputTokens, cost, reasoning, inputTypes } = body as {
        id?: string; name?: string; contextWindow?: number; maxOutputTokens?: number;
        cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
        reasoning?: boolean; inputTypes?: Array<'text' | 'image'>;
      };
      if (!id || !name || !contextWindow || !maxOutputTokens || !cost) {
        server.json(res, 400, { error: 'id, name, contextWindow, maxOutputTokens, and cost are required' });
        return true;
      }
      try {
        const modelDef = {
          id, name, provider: providerName, contextWindow, maxOutputTokens, cost,
          ...(reasoning !== null && reasoning !== undefined ? { reasoning } : {}),
          ...(inputTypes ? { inputTypes } : {}),
        };
        server.llmRouter.addCustomModel(providerName, modelDef);
        server.invalidateRoutingCache();
        try {
          const { loadConfig: loadCfg } = await import('@markus/shared');
          const currentConfig = loadCfg(server.markusConfigPath);
          const customModels = { ...(currentConfig.llm.customModels ?? {}) };
          const existing = customModels[providerName] ?? [];
          customModels[providerName] = [...existing.filter(m => m.id !== id), modelDef];
          saveConfig({ llm: { customModels } } as any, server.markusConfigPath);
        } catch (e) {
          log.warn('Failed to persist custom model', { error: String(e) });
        }
        server.auditService?.record({
          orgId: 'system',
          type: 'settings_changed',
          action: 'llm_custom_model_add',
          detail: `Custom model ${id} on provider ${providerName}`,
          userId: auth.userId,
          success: true,
          metadata: { providerName, modelId: id },
        });
        server.json(res, 200, server.llmRouter.getEnhancedSettings());
      } catch (err) {
        server.json(res, 400, { error: String(err) });
      }
      return true;
    }

    // Settings — Delete custom model from provider catalog
    if (path.match(/^\/api\/settings\/llm\/providers\/[^/]+\/models\/[^/]+$/) && req.method === 'DELETE') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;
      if (!server.llmRouter) {
        server.json(res, 503, { error: 'LLM router not available' });
        return true;
      }
      const parts = path.split('/');
      const providerName = parts[5]!;
      const modelId = decodeURIComponent(parts[7]!);
      try {
        server.llmRouter.removeCustomModel(providerName, modelId);
        server.invalidateRoutingCache();
        try {
          const { loadConfig: loadCfg } = await import('@markus/shared');
          const currentConfig = loadCfg(server.markusConfigPath);
          const models = (currentConfig.llm.customModels?.[providerName] ?? []).filter(m => m.id !== modelId);
          const customModelsUpdate: Record<string, unknown> = {
            [providerName]: models.length > 0 ? models : null,
          };
          saveConfig({ llm: { customModels: customModelsUpdate } } as any, server.markusConfigPath);
        } catch (e) {
          log.warn('Failed to persist custom model removal', { error: String(e) });
        }
        server.auditService?.record({
          orgId: 'system',
          type: 'settings_changed',
          action: 'llm_custom_model_delete',
          detail: `Removed custom model ${modelId} from ${providerName}`,
          userId: auth.userId,
          success: true,
          metadata: { providerName, modelId },
        });
        server.json(res, 200, server.llmRouter.getEnhancedSettings());
      } catch (err) {
        server.json(res, 400, { error: String(err) });
      }
      return true;
    }

    // Settings — Switch provider model
    if (path.match(/^\/api\/settings\/llm\/providers\/[^/]+\/model$/) && req.method === 'POST') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;
      if (!server.llmRouter) {
        server.json(res, 503, { error: 'LLM router not available' });
        return true;
      }
      const providerName = path.split('/')[5]!;
      const body = await server.readBody(req);
      const { model } = body as { model?: string };
      if (!model || typeof model !== 'string') {
        server.json(res, 400, { error: 'model (string) is required' });
        return true;
      }
      try {
        server.llmRouter.setProviderModel(providerName, model);
        try {
          const { loadConfig: loadCfg } = await import('@markus/shared');
          const currentConfig = loadCfg(server.markusConfigPath);
          const providers = { ...currentConfig.llm.providers };
          providers[providerName] = { ...providers[providerName], model };
          saveConfig({ llm: { providers } } as any, server.markusConfigPath);
        } catch (e) {
          log.warn('Failed to persist provider model change', { error: String(e) });
        }
        server.auditService?.record({
          orgId: 'system',
          type: 'settings_changed',
          action: 'llm_provider_model_switch',
          detail: `Provider ${providerName} model → ${model}`,
          userId: auth.userId,
          success: true,
          metadata: { providerName, model },
        });
        server.json(res, 200, server.llmRouter.getEnhancedSettings());
      } catch (err) {
        server.json(res, 400, { error: String(err) });
      }
      return true;
    }

    // Settings — Toggle provider enabled/disabled
    if (path.match(/^\/api\/settings\/llm\/providers\/[^/]+\/toggle$/) && req.method === 'POST') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;
      if (!server.llmRouter) {
        server.json(res, 503, { error: 'LLM router not available' });
        return true;
      }
      const providerName = path.split('/')[5]!;
      const body = await server.readBody(req);
      const { enabled } = body as { enabled: boolean };
      if (typeof enabled !== 'boolean') {
        server.json(res, 400, { error: 'enabled (boolean) is required' });
        return true;
      }
      try {
        const prevDefault = server.llmRouter.getSettings().defaultProvider;
        server.llmRouter.setProviderEnabled(providerName, enabled);
        server.invalidateRoutingCache();
        const newDefault = server.llmRouter.getSettings().defaultProvider;
        try {
          const { loadConfig: loadCfg } = await import('@markus/shared');
          const currentConfig = loadCfg(server.markusConfigPath);
          const providers = { ...currentConfig.llm.providers };
          if (providers[providerName]) {
            providers[providerName] = { ...providers[providerName], enabled };
          } else {
            providers[providerName] = { enabled };
          }
          const configUpdates: any = { llm: { providers } };
          if (prevDefault !== newDefault) {
            configUpdates.llm.defaultProvider = newDefault;
          }
          saveConfig(configUpdates, server.markusConfigPath);
        } catch (e) {
          log.warn('Failed to persist provider enabled state', { error: String(e) });
        }
        server.auditService?.record({
          orgId: 'system',
          type: 'settings_changed',
          action: 'llm_provider_toggle',
          detail: `Provider ${providerName} enabled=${enabled}`,
          userId: auth.userId,
          success: true,
          metadata: { providerName, enabled },
        });
        server.json(res, 200, server.llmRouter.getEnhancedSettings());
      } catch (err) {
        server.json(res, 400, { error: String(err) });
      }
      return true;
    }

    // Settings — Test provider connectivity (direct, no fallback)
    if (path.match(/^\/api\/settings\/llm\/providers\/[^/]+\/test$/) && req.method === 'POST') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;
      if (!server.llmRouter) {
        server.json(res, 503, { error: 'LLM router not available' });
        return true;
      }
      const providerName = path.split('/')[5]!;
      const provider = server.llmRouter.getProvider(providerName);
      if (!provider) {
        server.json(res, 404, { ok: false, error: `Provider "${providerName}" not found or not configured` });
        return true;
      }
      const requestBody = {
        messages: [{ role: 'user' as const, content: 'Reply with exactly one word: hello' }],
        maxTokens: 32,
        temperature: 0,
      };
      const baseUrl = (provider as any).baseUrl ?? (provider as any).config?.baseUrl ?? '';
      try {
        const startMs = Date.now();
        const response = await server.llmRouter.chatDirect(requestBody, providerName);
        const durationMs = Date.now() - startMs;
        const reply = (response.content ?? '').trim();
        const requestUrl = response._providerBaseUrl ?? baseUrl;
        if (!reply) {
          server.json(res, 200, {
            ok: false,
            error: 'Model returned empty response — API key or model may be misconfigured',
            model: provider.model,
            durationMs,
            requestUrl,
            requestBody,
          });
        } else {
          server.json(res, 200, {
            ok: true,
            durationMs,
            model: provider.model,
            reply: reply.slice(0, 100),
            usage: response.usage,
            requestUrl,
            requestBody,
          });
        }
      } catch (err) {
        const raw = String(err);
        const statusMatch = raw.match(/(?:API error|status)\s+(\d{3})/i);
        const errorCode = statusMatch ? Number(statusMatch[1]) : undefined;
        let errorMsg = raw.replace(/^Error:\s*/, '');
        const jsonStart = errorMsg.indexOf('{');
        if (jsonStart >= 0) {
          try {
            const jsonStr = errorMsg.slice(jsonStart);
            const parsed = JSON.parse(jsonStr) as { error?: { message?: string; type?: string; code?: string } };
            if (parsed.error?.message) {
              errorMsg = `[${parsed.error.type ?? parsed.error.code ?? errorCode ?? 'error'}] ${parsed.error.message}`;
            }
          } catch { /* keep original */ }
        }
        server.json(res, 200, {
          ok: false,
          error: errorMsg.slice(0, 500),
          errorCode,
          model: provider.model,
          requestUrl: baseUrl,
          requestBody,
        });
      }
      return true;
    }

    // Settings — Detect model configs from environment variables
    if (path === '/api/settings/env-models' && req.method === 'GET') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;

      const ENV_MODEL_MAP: Array<{
        provider: string;
        displayName: string;
        keyEnv: string;
        modelEnv?: string;
        baseUrlEnv?: string;
        defaultModel: string;
        defaultBaseUrl?: string;
      }> = [
        { provider: 'anthropic', displayName: 'Anthropic', keyEnv: 'ANTHROPIC_API_KEY', defaultModel: 'claude-opus-4-6' },
        { provider: 'openai', displayName: 'OpenAI', keyEnv: 'OPENAI_API_KEY', defaultModel: 'gpt-5.4' },
        { provider: 'google', displayName: 'Google Gemini', keyEnv: 'GOOGLE_API_KEY', defaultModel: 'gemini-3-1-pro' },
        { provider: 'siliconflow', displayName: 'SiliconFlow (中国)', keyEnv: 'SILICONFLOW_API_KEY', modelEnv: 'SILICONFLOW_MODEL', baseUrlEnv: 'SILICONFLOW_BASE_URL', defaultModel: 'Qwen/Qwen3.5-35B-A3B', defaultBaseUrl: 'https://api.siliconflow.cn/v1' },
        { provider: 'siliconflow-intl', displayName: 'SiliconFlow (Global)', keyEnv: 'SILICONFLOW_INTL_API_KEY', modelEnv: 'SILICONFLOW_INTL_MODEL', baseUrlEnv: 'SILICONFLOW_INTL_BASE_URL', defaultModel: 'Qwen/Qwen3.5-35B-A3B', defaultBaseUrl: 'https://api-st.siliconflow.cn/v1' },
        { provider: 'minimax', displayName: 'MiniMax (Global)', keyEnv: 'MINIMAX_API_KEY', modelEnv: 'MINIMAX_MODEL', baseUrlEnv: 'MINIMAX_BASE_URL', defaultModel: 'MiniMax-M3', defaultBaseUrl: 'https://api.minimax.io/v1' },
        { provider: 'minimax-cn', displayName: 'MiniMax (中国)', keyEnv: 'MINIMAX_CN_API_KEY', modelEnv: 'MINIMAX_CN_MODEL', baseUrlEnv: 'MINIMAX_CN_BASE_URL', defaultModel: 'MiniMax-M3', defaultBaseUrl: 'https://api.minimaxi.com/v1' },
        { provider: 'openrouter', displayName: 'OpenRouter', keyEnv: 'OPENROUTER_API_KEY', modelEnv: 'OPENROUTER_MODEL', baseUrlEnv: 'OPENROUTER_BASE_URL', defaultModel: 'xiaomi/mimo-v2-pro', defaultBaseUrl: 'https://openrouter.ai/api/v1' },
        { provider: 'zai', displayName: 'ZAI', keyEnv: 'ZAI_API_KEY', modelEnv: 'ZAI_MODEL', baseUrlEnv: 'ZAI_BASE_URL', defaultModel: 'glm-5.1', defaultBaseUrl: 'https://api.z.ai/api/paas/v4' },
        { provider: 'deepseek', displayName: 'DeepSeek', keyEnv: 'DEEPSEEK_API_KEY', modelEnv: 'DEEPSEEK_MODEL', baseUrlEnv: 'DEEPSEEK_BASE_URL', defaultModel: 'deepseek-v4-flash', defaultBaseUrl: 'https://api.deepseek.com' },
        { provider: 'markus', displayName: 'Markus', keyEnv: 'MARKUS_SUBSCRIPTION_KEY', defaultModel: 'markus-lite' },
      ];

      const detected: Array<{
        provider: string;
        displayName: string;
        apiKeySet: boolean;
        apiKeyPreview: string;
        model: string;
        baseUrl?: string;
        envVars: Record<string, string>;
        ollamaModels?: Array<{ name: string; size?: number; parameterSize?: string; family?: string }>;
      }> = [];

      for (const def of ENV_MODEL_MAP) {
        const apiKey = process.env[def.keyEnv];
        if (!apiKey) continue;

        const model = def.modelEnv ? (process.env[def.modelEnv] ?? def.defaultModel) : def.defaultModel;
        const baseUrl = def.baseUrlEnv ? (process.env[def.baseUrlEnv] ?? def.defaultBaseUrl) : def.defaultBaseUrl;
        const envVars: Record<string, string> = { [def.keyEnv]: '***' + apiKey.slice(-4) };
        if (def.modelEnv && process.env[def.modelEnv]) envVars[def.modelEnv] = process.env[def.modelEnv]!;
        if (def.baseUrlEnv && process.env[def.baseUrlEnv]) envVars[def.baseUrlEnv] = process.env[def.baseUrlEnv]!;

        detected.push({
          provider: def.provider,
          displayName: def.displayName,
          apiKeySet: true,
          apiKeyPreview: '***' + apiKey.slice(-4),
          model,
          baseUrl,
          envVars,
        });
      }

      // Also probe local Ollama service (no API key needed)
      try {
        const ollamaUrl = process.env['OLLAMA_BASE_URL'] || 'http://localhost:11434';
        const ctrl = new AbortController();
        const tmr = setTimeout(() => ctrl.abort(), 3000);
        const ollamaRes = await fetch(`${ollamaUrl.replace(/\/+$/, '')}/api/tags`, { signal: ctrl.signal });
        clearTimeout(tmr);
        if (ollamaRes.ok) {
          const ollamaData = await ollamaRes.json() as { models?: Array<{ name: string; size?: number; details?: { parameter_size?: string; family?: string } }> };
          const models = ollamaData.models ?? [];
          if (models.length > 0) {
            detected.push({
              provider: 'ollama',
              displayName: 'Ollama (Local)',
              apiKeySet: false,
              apiKeyPreview: 'local',
              model: models[0]!.name.replace(/:latest$/, ''),
              baseUrl: ollamaUrl,
              envVars: { OLLAMA_BASE_URL: ollamaUrl },
              ollamaModels: models.map(m => ({
                name: m.name.replace(/:latest$/, ''),
                size: m.size,
                parameterSize: m.details?.parameter_size,
                family: m.details?.family,
              })),
            });
          }
        }
      } catch { /* Ollama not running — skip silently */ }

      const timeoutMs = process.env['LLM_TIMEOUT_MS'];
      server.json(res, 200, {
        detected,
        timeoutMs: timeoutMs ? Number(timeoutMs) : undefined,
      });
      return true;
    }

    // Settings — Detect local Ollama service and list available models
    if (path === '/api/settings/detect-ollama' && req.method === 'GET') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;

      const ollamaUrl = process.env['OLLAMA_BASE_URL'] || 'http://localhost:11434';
      try {
        const ctrl = new AbortController();
        const tmr = setTimeout(() => ctrl.abort(), 5000);
        const ollamaRes = await fetch(`${ollamaUrl.replace(/\/+$/, '')}/api/tags`, { signal: ctrl.signal });
        clearTimeout(tmr);
        if (!ollamaRes.ok) {
          server.json(res, 200, { found: false, error: `Ollama returned HTTP ${ollamaRes.status}` });
          return true;
        }
        const data = await ollamaRes.json() as { models?: Array<{ name: string; size?: number; modified_at?: string; details?: { parameter_size?: string; family?: string; quantization_level?: string } }> };
        const models = (data.models ?? []).map(m => ({
          name: m.name.replace(/:latest$/, ''),
          fullName: m.name,
          size: m.size,
          modifiedAt: m.modified_at,
          parameterSize: m.details?.parameter_size,
          family: m.details?.family,
          quantization: m.details?.quantization_level,
        }));
        server.json(res, 200, { found: true, baseUrl: ollamaUrl, models });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        server.json(res, 200, { found: false, error: msg.includes('abort') ? 'Connection timed out' : msg });
      }
      return true;
    }

    // Settings — Apply env model configs to markus.json
    if (path === '/api/settings/env-models' && req.method === 'POST') {
      const auth = await server.requireAuth(req, res);
      if (!auth) return true;
      const body = await server.readBody(req);
      const { providers: providerUpdates } = body as {
        providers: Array<{
          provider: string;
          model: string;
          baseUrl?: string;
          enabled?: boolean;
        }>;
      };
      if (!Array.isArray(providerUpdates) || providerUpdates.length === 0) {
        server.json(res, 400, { error: 'providers array is required' });
        return true;
      }
      try {
        const { loadConfig: loadCfg } = await import('@markus/shared');
        const currentConfig = loadCfg(server.markusConfigPath);
        const updatedProviders = { ...currentConfig.llm.providers };
        const applied: string[] = [];
        for (const pu of providerUpdates) {
          const envKeyMap: Record<string, string> = {
            anthropic: 'ANTHROPIC_API_KEY',
            openai: 'OPENAI_API_KEY',
            google: 'GOOGLE_API_KEY',
            siliconflow: 'SILICONFLOW_API_KEY',
            'siliconflow-intl': 'SILICONFLOW_INTL_API_KEY',
            minimax: 'MINIMAX_API_KEY',
            'minimax-cn': 'MINIMAX_CN_API_KEY',
            openrouter: 'OPENROUTER_API_KEY',
            zai: 'ZAI_API_KEY',
            deepseek: 'DEEPSEEK_API_KEY',
          };
          const apiKey = process.env[envKeyMap[pu.provider] ?? ''];
          if (!apiKey && pu.provider !== 'ollama') continue;
          updatedProviders[pu.provider] = {
            ...updatedProviders[pu.provider],
            ...(apiKey ? { apiKey } : {}),
            model: pu.model,
            ...(pu.baseUrl ? { baseUrl: pu.baseUrl } : {}),
            enabled: pu.enabled !== false,
          };
          applied.push(pu.provider);
        }
        saveConfig({ llm: { providers: updatedProviders } } as any, server.markusConfigPath);
        // Hot-register newly applied providers in the running router
        if (server.llmRouter) {
          for (const provName of applied) {
            if (!server.llmRouter.getProvider(provName)) {
              const cfg = updatedProviders[provName];
              if (cfg?.apiKey || provName === 'ollama') {
                try {
                  server.llmRouter.registerProviderFromConfig(provName, {
                    provider: provName as any,
                    model: cfg.model ?? '',
                    apiKey: cfg.apiKey,
                    baseUrl: cfg.baseUrl,
                  });
                } catch (e) {
                  log.warn(`Failed to hot-register provider ${provName}`, { error: String(e) });
                }
              }
            }
          }
          server.invalidateRoutingCache();
          // Auto-set routing default model if none configured yet
          if (!server.llmRouter.routingDefaultModel && applied.length > 0) {
            const first = providerUpdates.find(pu => applied.includes(pu.provider));
            if (first) {
              server.llmRouter.setRoutingDefaultModel({ provider: first.provider, model: first.model });
              saveConfig({ llm: { routingDefaultModel: { provider: first.provider, model: first.model } } } as any, server.markusConfigPath);
              log.info('Auto-set routing default model from env detection', { provider: first.provider, model: first.model });
            }
          }
        }
        server.json(res, 200, {
          applied,
          message: `Updated ${applied.length} provider(s) in markus.json`,
          ...(server.llmRouter ? { settings: server.llmRouter.getEnhancedSettings() } : {}),
        });
      } catch (err) {
        server.json(res, 400, { error: String(err) });
      }
      return true;
    }
  return false;
}
