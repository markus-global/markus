import type { AgentToolHandler } from '../agent.js';
import type { LLMRouter } from '../llm/router.js';
import { createLogger, type MarkusConfig, type ModelCapabilityType, type CapabilityModelAssignment, type LLMAssignment } from '@markus/shared';

const log = createLogger('settings-tools');

/** Per-agent context injected when the settings tools are wired into an agent. */
export interface SettingsAgentContext {
  /** The id of the agent that is running this tool. */
  agentId: string;
  /** Live LLM assignment of the running agent (modelMode/primary/defaultModel...). */
  getLlmConfig: () => LLMAssignment | undefined;
  /**
   * Apply a partial update to the running agent's llmConfig and persist it.
   * Mutates the live object so the new model takes effect on the next turn.
   */
  persistLlmConfig: (patch: Partial<LLMAssignment>) => Promise<boolean> | boolean;
}

export interface SettingsToolsContext {
  llmRouter: LLMRouter;
  /** Persist config changes to markus.json */
  persistConfig?: (updates: Partial<MarkusConfig>) => void;
  /** When present, enables per-agent default model read/set/reset tools. */
  agent?: SettingsAgentContext;
}

export function createSettingsTools(ctx: SettingsToolsContext): AgentToolHandler[] {
  return [
    {
      name: 'llm_list_providers',
      description:
        'List LLM providers and their models. By default only shows USABLE providers (configured + enabled) — ' +
        'these are the only ones you can actually call. Use show_all=true to also see disabled/unconfigured ' +
        'providers, which are returned WITHOUT their model lists and marked usable:false — do not try to call ' +
        'their models until they are enabled.',
      inputSchema: {
        type: 'object',
        properties: {
          show_all: {
            type: 'boolean',
            description: 'When true, include disabled and unconfigured providers (marked usable:false, no model list). Default: false (only usable).',
          },
        },
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const settings = ctx.llmRouter.getEnhancedSettings();
        const showAll = args['show_all'] === true;
        const entries = Object.entries(settings.providers)
          .filter(([, p]) => showAll || (p.configured && p.enabled))
          .map(([name, p]) => {
            const usable = !!(p.configured && p.enabled);
            const base = {
              name,
              displayName: p.displayName,
              currentModel: p.model,
              configured: p.configured,
              enabled: p.enabled,
              // Only usable providers can actually serve a request. This is the
              // single field the agent should gate on before choosing a model.
              usable,
              isDefault: name === settings.defaultProvider,
            };
            if (!usable) {
              // Do NOT advertise models for providers the agent cannot call —
              // that is exactly what led it to "test" unreachable models. Explain
              // why instead so it can enable them first if needed.
              const reason = !p.configured
                ? 'not configured (no API key / not connected)'
                : 'disabled (turned off in settings)';
              return {
                ...base,
                availableModels: [],
                unusable_reason: reason,
                hint: `This provider is ${reason}; its models cannot be called. Enable/configure it first, or pick a usable provider.`,
              };
            }
            return {
              ...base,
              availableModels: p.models?.map(m => ({
                id: m.id,
                name: m.name,
                contextWindow: m.contextWindow,
                maxOutputTokens: m.maxOutputTokens,
                cost: m.cost,
                reasoning: m.reasoning,
                vision: m.inputTypes?.includes('image'),
              })) ?? [],
            };
          });
        const enabled = entries.filter(p => p.usable);
        return JSON.stringify({
          defaultProvider: settings.defaultProvider,
          usable_count: enabled.length,
          total_count: entries.length,
          note: 'Only providers with usable:true can be called. Models from usable:false providers will fail until the provider is enabled/configured.',
          providers: entries,
        });
      },
    },
    {
      name: 'llm_switch_model',
      description: 'Switch the active model for a given LLM provider. Use llm_list_providers first to see available models.',
      inputSchema: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            description: 'The provider name (e.g. "openrouter", "anthropic", "openai"). Use llm_list_providers to see available names.',
          },
          model: {
            type: 'string',
            description: 'The model ID to switch to (e.g. "anthropic/claude-opus-4-6")',
          },
        },
        required: ['provider', 'model'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const provider = args['provider'] as string;
        const model = args['model'] as string;
        try {
          const oldModel = ctx.llmRouter.getActiveModelName(provider);
          ctx.llmRouter.setProviderModel(provider, model);

          if (ctx.persistConfig) {
            try {
              ctx.persistConfig({ llm: { providers: { [provider]: { model } } } } as any);
            } catch (e) {
              log.warn('Failed to persist model change', { error: String(e) });
            }
          }

          return JSON.stringify({
            status: 'success',
            provider,
            previousModel: oldModel,
            newModel: model,
            message: `Switched ${provider} model from ${oldModel} to ${model}`,
          });
        } catch (err) {
          return JSON.stringify({
            status: 'error',
            error: String(err),
          });
        }
      },
    },
    {
      name: 'llm_switch_default_provider',
      description: 'Change the default LLM provider used by all agents (unless overridden). Use llm_list_providers first to see available providers.',
      inputSchema: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            description: 'The provider name to set as default. Use llm_list_providers to see available names.',
          },
        },
        required: ['provider'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const provider = args['provider'] as string;
        try {
          const oldDefault = ctx.llmRouter.getDefaultProvider();
          ctx.llmRouter.setDefaultProvider(provider);
          // setDefaultProvider retargets the routing default model at the new
          // provider; persist it too so the switch survives a restart.
          const syncedDefaultModel = ctx.llmRouter.routingDefaultModel;

          if (ctx.persistConfig) {
            try {
              ctx.persistConfig({ llm: { defaultProvider: provider, routingDefaultModel: syncedDefaultModel } } as any);
            } catch (e) {
              log.warn('Failed to persist default provider change', { error: String(e) });
            }
          }

          return JSON.stringify({
            status: 'success',
            previousDefault: oldDefault,
            newDefault: provider,
            newDefaultModel: syncedDefaultModel?.model,
            message: `Default provider changed from ${oldDefault} to ${provider}${syncedDefaultModel ? ` (default model: ${syncedDefaultModel.model})` : ''}`,
          });
        } catch (err) {
          return JSON.stringify({
            status: 'error',
            error: String(err),
          });
        }
      },
    },
    {
      name: 'llm_add_provider',
      description: 'Add a new LLM provider at runtime. Uses OpenAI-compatible API for custom provider names. Persists to config.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Provider name (e.g. "deepseek", "openrouter", "anthropic"). Use "anthropic", "openai", "google", "ollama" for first-party; any other name uses OpenAI-compatible API.',
          },
          api_key: {
            type: 'string',
            description: 'API key for the provider',
          },
          base_url: {
            type: 'string',
            description: 'Optional base URL for the API (e.g. "https://api.deepseek.com")',
          },
          model: {
            type: 'string',
            description: 'Default model ID (e.g. "deepseek-v4-flash")',
          },
        },
        required: ['name', 'model'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const name = args['name'] as string;
        const apiKey = args['api_key'] as string | undefined;
        const baseUrl = args['base_url'] as string | undefined;
        const model = args['model'] as string;
        try {
          ctx.llmRouter.registerProviderFromConfig(name, {
            provider: name as any,
            model,
            apiKey,
            baseUrl,
          });

          if (ctx.persistConfig) {
            try {
              ctx.persistConfig({
                llm: {
                  providers: {
                    [name]: {
                      ...(apiKey ? { apiKey } : {}),
                      model,
                      ...(baseUrl ? { baseUrl } : {}),
                      enabled: true,
                    },
                  },
                },
              } as any);
            } catch (e) {
              log.warn('Failed to persist new provider', { error: String(e) });
            }
          }

          return JSON.stringify({
            status: 'success',
            provider: name,
            model,
            message: `Provider ${name} added with model ${model}`,
          });
        } catch (err) {
          return JSON.stringify({ status: 'error', error: String(err) });
        }
      },
    },
    {
      name: 'llm_edit_provider',
      description: 'Edit an existing LLM provider settings (API key, base URL, model). Only provided fields are updated.',
      inputSchema: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            description: 'The provider name to edit. Use llm_list_providers to see available names.',
          },
          api_key: {
            type: 'string',
            description: 'New API key (optional)',
          },
          base_url: {
            type: 'string',
            description: 'New base URL (optional)',
          },
          model: {
            type: 'string',
            description: 'New model ID (optional)',
          },
        },
        required: ['provider'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const providerName = args['provider'] as string;
        const apiKey = args['api_key'] as string | undefined;
        const baseUrl = args['base_url'] as string | undefined;
        const model = args['model'] as string | undefined;
        try {
          const provider = ctx.llmRouter.getProvider(providerName);
          if (!provider) {
            return JSON.stringify({ status: 'error', error: `Provider ${providerName} not found` });
          }
          const configUpdate: any = { provider: providerName };
          if (model) configUpdate.model = model;
          if (apiKey) configUpdate.apiKey = apiKey;
          if (baseUrl !== undefined) configUpdate.baseUrl = baseUrl;
          provider.configure(configUpdate);

          if (ctx.persistConfig) {
            try {
              const updates: any = {};
              if (apiKey) updates.apiKey = apiKey;
              if (model) updates.model = model;
              if (baseUrl !== undefined) updates.baseUrl = baseUrl || undefined;
              ctx.persistConfig({ llm: { providers: { [providerName]: updates } } } as any);
            } catch (e) {
              log.warn('Failed to persist provider edit', { error: String(e) });
            }
          }

          return JSON.stringify({
            status: 'success',
            provider: providerName,
            message: `Provider ${providerName} updated`,
          });
        } catch (err) {
          return JSON.stringify({ status: 'error', error: String(err) });
        }
      },
    },
    {
      name: 'llm_add_model',
      description: 'Add a custom model definition to a provider catalog. The model becomes available for switching.',
      inputSchema: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            description: 'Provider name to add the model to',
          },
          id: {
            type: 'string',
            description: 'Model ID (e.g. "deepseek-v4-flash")',
          },
          name: {
            type: 'string',
            description: 'Display name (e.g. "DeepSeek Chat V3")',
          },
          context_window: {
            type: 'number',
            description: 'Context window size in tokens (e.g. 128000)',
          },
          max_output_tokens: {
            type: 'number',
            description: 'Maximum output tokens (e.g. 16384)',
          },
          cost_input: {
            type: 'number',
            description: 'Input cost per 1M tokens in USD (e.g. 0.5)',
          },
          cost_output: {
            type: 'number',
            description: 'Output cost per 1M tokens in USD (e.g. 1.5)',
          },
          reasoning: {
            type: 'boolean',
            description: 'Whether the model supports reasoning (optional)',
          },
          vision: {
            type: 'boolean',
            description: 'Whether the model supports image input (optional)',
          },
        },
        required: ['provider', 'id', 'name', 'context_window', 'max_output_tokens', 'cost_input', 'cost_output'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const providerName = args['provider'] as string;
        const modelDef = {
          id: args['id'] as string,
          name: args['name'] as string,
          provider: providerName,
          contextWindow: args['context_window'] as number,
          maxOutputTokens: args['max_output_tokens'] as number,
          cost: {
            input: args['cost_input'] as number,
            output: args['cost_output'] as number,
          },
          ...(args['reasoning'] ? { reasoning: true } : {}),
          ...(args['vision'] ? { inputTypes: ['text' as const, 'image' as const] } : { inputTypes: ['text' as const] }),
        };
        try {
          ctx.llmRouter.addCustomModel(providerName, modelDef);

          if (ctx.persistConfig) {
            try {
              ctx.persistConfig({
                llm: { customModels: { [providerName]: [modelDef] } },
              } as any);
            } catch (e) {
              log.warn('Failed to persist custom model', { error: String(e) });
            }
          }

          return JSON.stringify({
            status: 'success',
            provider: providerName,
            model: modelDef.id,
            message: `Custom model ${modelDef.name} added to ${providerName}`,
          });
        } catch (err) {
          return JSON.stringify({ status: 'error', error: String(err) });
        }
      },
    },
    {
      name: 'llm_get_capability_routing',
      description:
        'Get current capability routing configuration AND the authoritative list of models you can actually use for each ' +
        'non-text capability (image_generation, image_recognition, audio_tts, audio_stt, video_generation). ' +
        'Use this BEFORE any image/audio/video task instead of guessing model ids or probing models: `usable_models` ' +
        'only lists models from providers that are configured AND enabled, so anything here is safe to call. ' +
        'If a capability has an empty `usable_models` list, that capability is not available — do not attempt it.',
      inputSchema: { type: 'object', properties: {} },
      async execute(): Promise<string> {
        const routing = ctx.llmRouter.capabilityRouting;
        const defaultModel = ctx.llmRouter.routingDefaultModel;
        const settings = ctx.llmRouter.getEnhancedSettings();

        // Model-level capability tag for each non-text capability type. These match
        // the strings carried on ModelDefinition.capabilities (populated from the
        // Hub catalog / static catalog), so a model is usable for a capability iff
        // it advertises the corresponding tag.
        const CAP_TAG: Record<string, string> = {
          image_generation: 'imageGeneration',
          audio_tts: 'tts',
          audio_stt: 'stt',
          video_generation: 'videoGeneration',
        };

        const usableModels: Record<string, Array<{ provider: string; model: string; name: string; tier?: string }>> = {};
        for (const [capType, tag] of Object.entries(CAP_TAG)) {
          const list: Array<{ provider: string; model: string; name: string; tier?: string }> = [];
          for (const p of Object.values(settings.providers)) {
            // Only advertise models the agent can actually call right now.
            if (!(p.configured && p.enabled)) continue;
            for (const m of p.models ?? []) {
              if (m.capabilities?.includes(tag)) {
                list.push({ provider: p.name, model: m.id, name: m.name, tier: m.tier });
              }
            }
          }
          usableModels[capType] = list;
        }

        // image_recognition is a property of text models (vision), not a standalone
        // media model — surface vision-capable text models separately.
        usableModels['image_recognition'] = Object.values(settings.providers)
          .filter(p => p.configured && p.enabled)
          .flatMap(p => (p.models ?? [])
            .filter(m => m.inputTypes?.includes('image'))
            .map(m => ({ provider: p.name, model: m.id, name: m.name, tier: m.tier })));

        return JSON.stringify({
          routing_default_model: defaultModel ?? null,
          assignments: routing.assignments,
          capability_types: ['text', 'image_recognition', 'image_generation', 'audio_tts', 'audio_stt', 'video_generation'],
          usable_models: usableModels,
          note: 'usable_models lists only models from configured+enabled providers. You can pass model=... directly on generate_image / text_to_speech / speech_to_text / generate_video without calling llm_set_capability_routing. Routing assignments are only the default when model is omitted. An empty usable_models list means the capability is unavailable.',
        });
      },
    },
    {
      name: 'llm_set_capability_routing',
      description:
        'Assign a specific provider+model to a capability type. Required arg name is capability_type ' +
        '(values: text, image_recognition, image_generation, audio_tts, audio_stt, video_generation) — not "type". ' +
        'Pick model from llm_get_capability_routing.usable_models for that capability. ' +
        'Set provider and model to empty strings to clear an assignment.',
      inputSchema: {
        type: 'object',
        properties: {
          capability_type: {
            type: 'string',
            enum: ['text', 'image_recognition', 'image_generation', 'audio_tts', 'audio_stt', 'video_generation'],
            description: 'The capability type to configure (required; use this exact key name)',
          },
          provider: {
            type: 'string',
            description: 'Provider name (e.g. "markus", "openai"). Use llm_list_providers to see available names.',
          },
          model: {
            type: 'string',
            description: 'Model ID to use for this capability (e.g. "openai/gpt-image-1", "deepgram/aura-2", "deepgram/nova-3"). Prefer ids from llm_get_capability_routing.usable_models.',
          },
          fallback_provider: {
            type: 'string',
            description: 'Optional fallback provider if primary is unavailable',
          },
          fallback_model: {
            type: 'string',
            description: 'Optional fallback model',
          },
        },
        required: ['capability_type', 'provider', 'model'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const VALID: Set<string> = new Set([
          'text', 'image_recognition', 'image_generation',
          'audio_tts', 'audio_stt', 'video_generation',
        ]);
        const capabilityType = resolveCapabilityTypeArg(args, VALID);
        const provider = String(args['provider'] ?? '').trim();
        const model = String(args['model'] ?? '').trim();

        try {
          if (!capabilityType) {
            const raw = args['capability_type'] ?? args['capabilityType'] ?? args['type'] ?? args['capability'];
            return JSON.stringify({
              status: 'error',
              error: `Invalid or missing capability_type "${String(raw)}". Must be one of: ${[...VALID].join(', ')}`,
              hint: 'Pass capability_type (not type/capability). Call llm_get_capability_routing first.',
            });
          }

          if (!provider && !model) {
            const current = {
              assignments: { ...ctx.llmRouter.capabilityRouting.assignments },
            };
            delete current.assignments[capabilityType];
            ctx.llmRouter.setCapabilityRouting(current);

            if (ctx.persistConfig) {
              try {
                ctx.persistConfig({ llm: { capabilityRouting: ctx.llmRouter.capabilityRouting } } as any);
              } catch { /* best effort */ }
            }

            return JSON.stringify({
              status: 'success',
              message: `Cleared capability routing for ${capabilityType}`,
            });
          }

          if (!provider || !model) {
            return JSON.stringify({
              status: 'error',
              error: 'Both provider and model are required (or both empty to clear).',
            });
          }

          if (capabilityType !== 'text') {
            const catalogErr = validateModelAgainstCatalog(ctx.llmRouter, provider, model, capabilityType);
            if (catalogErr) {
              return JSON.stringify({
                status: 'error',
                error: catalogErr,
                hint: `Call llm_get_capability_routing and pick from usable_models.${capabilityType}.`,
              });
            }
            const mismatch = detectModelCapabilityMismatch(model, capabilityType);
            if (mismatch) {
              return JSON.stringify({
                status: 'error',
                error: mismatch,
                hint: `Use llm_get_capability_routing.usable_models.${capabilityType} to find a suitable model.`,
              });
            }
          }

          const assignment: CapabilityModelAssignment = { provider, model };
          const fbProvider = args['fallback_provider'] as string | undefined;
          const fbModel = args['fallback_model'] as string | undefined;
          if (fbProvider && fbModel) {
            assignment.fallback = { provider: fbProvider, model: fbModel };
          }

          ctx.llmRouter.setCapabilityRouting({
            assignments: {
              ...ctx.llmRouter.capabilityRouting.assignments,
              [capabilityType]: assignment,
            },
          });

          if (ctx.persistConfig) {
            try {
              ctx.persistConfig({ llm: { capabilityRouting: ctx.llmRouter.capabilityRouting } } as any);
            } catch { /* best effort */ }
          }

          return JSON.stringify({
            status: 'success',
            capability_type: capabilityType,
            provider,
            model,
            fallback: assignment.fallback ?? null,
            message: `Capability ${capabilityType} now routed to ${provider}/${model}`,
          });
        } catch (err) {
          return JSON.stringify({ status: 'error', error: String(err) });
        }
      },
    },
    // ─── Per-agent default model management (agent self-inspection) ───────────
    // These tools only exist when a SettingsAgentContext (agentId + live config
    // + persist callback) was injected at registration.
    {
      name: 'agent_model_get',
      description:
        'Inspect LLM configuration: what THIS agent is configured to use (its per-agent default model, if any) ' +
        'and the GLOBAL model routing defaults that apply when the agent has no per-agent override. ' +
        'Use BEFORE deciding whether to set/reset a per-agent model. ' +
        'Priority when an agent makes a call: session/turn override > per-agent defaultModel > global routing. ' +
        'For available provider+model ids, call llm_list_providers.',
      inputSchema: { type: 'object', properties: {} },
      async execute(): Promise<string> {
        const me = ctx.agent;
        const settings = ctx.llmRouter.getEnhancedSettings();
        const globalDefault = ctx.llmRouter.routingDefaultModel ?? null;
        const defaultProvider = settings?.defaultProvider ?? ctx.llmRouter.getDefaultProvider();

        const lc = me?.getLlmConfig();
        const hasPerAgent = !!me && lc?.modelMode === 'custom' && !!lc.defaultModel;
        return JSON.stringify({
          agent_id: me?.agentId ?? null,
          // The agent's own LLM assignment from its persisted config.
          agent_llm_config: lc ? {
            model_mode: lc.modelMode,
            provider: lc.modelMode === 'custom' ? lc.primary : undefined,
            default_model: lc.modelMode === 'custom' ? lc.defaultModel ?? null : null,
            fallback: lc.fallback ?? null,
          } : null,
          agent_has_per_agent_default: hasPerAgent,
          agent_follows_global: !hasPerAgent,
          // What this agent would actually use (provider + model) for a normal
          // text call given its current config and the global default.
          effective: hasPerAgent
            ? { provider: lc!.primary, model: lc!.defaultModel, source: 'per_agent_default' }
            : globalDefault
              ? { provider: globalDefault.provider, model: globalDefault.model, source: 'global_default' }
              : { provider: defaultProvider ?? undefined, model: undefined, source: 'provider_default' },
          // Global picture (shared by all agents without their own default).
          global: {
            default_provider: defaultProvider,
            routing_default_model: globalDefault,
            capability_text_assignment: ctx.llmRouter.capabilityRouting.assignments?.text ?? null,
          },
          note: 'The agent effective model is the highest-priority of: session/turn override > per-agent default > global. To change per-agent model: agent_model_set_default {provider, model}. To reset to follow global: agent_model_reset_default.',
        });
      },
    },
    {
      name: 'agent_model_set_default',
      description:
        'Set THIS agent\'s per-agent default model to a specific provider+model. ' +
        'The change IMMEDIATELY updates this agent\'s config (applies on the next call) and is persisted. ' +
        'Only affects this agent — the global default for other agents is untouched. ' +
        'Call agent_model_get / llm_list_providers first to pick a valid model on a usable (configured+enabled) provider. ' +
        'To revert to following the global default instead, call agent_model_reset_default.',
      inputSchema: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            description: 'Provider name (e.g. "markus", "openrouter", "anthropic"). Use llm_list_providers to see usable providers.',
          },
          model: {
            type: 'string',
            description: 'Model ID on that provider (e.g. "anthropic/claude-opus-4-6"). Must belong to the provider.',
          },
        },
        required: ['provider', 'model'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const me = ctx.agent;
        if (!me) {
          return JSON.stringify({ status: 'error', error: 'Per-agent model tools are not wired for this agent.' });
        }
        const provider = String(args['provider'] ?? '').trim();
        const model = String(args['model'] ?? '').trim();
        if (!provider || !model) {
          return JSON.stringify({ status: 'error', error: 'Both provider and model are required.' });
        }
        if (ctx.llmRouter.isProviderDisabled(provider)) {
          return JSON.stringify({
            status: 'error',
            error: `Provider "${provider}" is disabled. Enable it (or pick a usable provider) first.`,
            hint: 'Call llm_list_providers to see usable providers.',
          });
        }
        try {
          const prev = me.getLlmConfig();
          const persisted = await me.persistLlmConfig({
            modelMode: 'custom',
            primary: provider,
            defaultModel: model,
          });
          return JSON.stringify({
            status: 'success',
            agent_id: me.agentId,
            previous_provider: prev?.modelMode === 'custom' ? prev.primary : undefined,
            previous_model: prev?.modelMode === 'custom' ? prev.defaultModel : undefined,
            provider,
            model,
            persisted: !!persisted,
            message: `This agent (${me.agentId}) will now use ${provider}/${model}.`,
          });
        } catch (err) {
          return JSON.stringify({ status: 'error', error: String(err) });
        }
      },
    },
    {
      name: 'agent_model_reset_default',
      description:
        'Clear THIS agent\'s per-agent default model so it follows the global default routing again. ' +
        'The agent will use the global routing_default_model / provider default for its calls. Persists immediately.',
      inputSchema: { type: 'object', properties: {} },
      async execute(): Promise<string> {
        const me = ctx.agent;
        if (!me) {
          return JSON.stringify({ status: 'error', error: 'agent model tools are not wired for this agent.' });
        }
        try {
          const was = me.getLlmConfig();
          const hadOverride = was?.modelMode === 'custom';
          await me.persistLlmConfig({ modelMode: 'default', defaultModel: undefined, primary: '' });
          const globalDefault = ctx.llmRouter.routingDefaultModel ?? null;
          return JSON.stringify({
            status: 'success',
            agent_id: me.agentId,
            cleared: hadOverride,
            message: hadOverride
              ? `Cleared ${was!.primary}/${was!.defaultModel}; this agent now follows the global default.`
              : 'This agent had no per-agent override; it already follows the global default.',
            global_default: globalDefault
              ? { provider: globalDefault.provider, model: globalDefault.model }
              : null,
          });
        } catch (err) {
          return JSON.stringify({ status: 'error', error: String(err) });
        }
      },
    },
    {
      name: 'agent_model_test',
      description:
        'Test connectivity for a given provider+model by sending a minimal request. ' +
        'Returns success/failure. Use to verify a provider/model works before setting it as this agent\'s default.',
      inputSchema: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            description: 'Provider name to test.',
          },
          model: {
            type: 'string',
            description: 'Model ID on that provider to test.',
          },
        },
        required: ['provider', 'model'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const provider = String(args['provider'] ?? '').trim();
        const model = String(args['model'] ?? '').trim();
        if (!provider || !model) {
          return JSON.stringify({ status: 'error', error: 'Both provider and model are required.' });
        }
        if (ctx.llmRouter.isProviderDisabled(provider)) {
          return JSON.stringify({ status: 'error', error: `Provider "${provider}" is disabled.` });
        }
        try {
          const res = await ctx.llmRouter.chatDirect(
            { messages: [{ role: 'user', content: 'ping' }], model, maxTokens: 8 },
            provider,
            model,
          );
          const text = (res?.content ?? '').slice(0, 120) || 'ok';
          return JSON.stringify({
            status: 'success',
            provider,
            model,
            response: text,
          });
        } catch (err) {
          return JSON.stringify({ status: 'error', provider, model, error: String(err) });
        }
      },
    },
  ];
}

const CAP_TAG_BY_TYPE: Partial<Record<ModelCapabilityType, string>> = {
  image_generation: 'imageGeneration',
  audio_tts: 'tts',
  audio_stt: 'stt',
  video_generation: 'videoGeneration',
};

/** Accept capability_type plus common model typos (type / capability). */
function resolveCapabilityTypeArg(
  args: Record<string, unknown>,
  valid: Set<string>,
): ModelCapabilityType | null {
  const raw = args['capability_type'] ?? args['capabilityType'] ?? args['type'] ?? args['capability'];
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const v = raw.trim();
  return valid.has(v) ? (v as ModelCapabilityType) : null;
}

/**
 * When the provider catalog has tagged this model, require the matching capability tag.
 * Untagged / unknown catalog entries fall through to name heuristics.
 */
function validateModelAgainstCatalog(
  router: LLMRouter,
  provider: string,
  model: string,
  capabilityType: ModelCapabilityType,
): string | null {
  const tag = CAP_TAG_BY_TYPE[capabilityType];
  if (!tag && capabilityType !== 'image_recognition') return null;

  const settings = router.getEnhancedSettings();
  const p = settings.providers[provider];
  if (!p?.models?.length) return null;

  const entry = p.models.find(m => m.id === model);
  if (!entry) return null;

  if (capabilityType === 'image_recognition') {
    if (entry.capabilities && entry.capabilities.length > 0) {
      if (!entry.capabilities.includes('vision') && !entry.inputTypes?.includes('image')) {
        return `Model "${model}" does not advertise vision / image input for image_recognition.`;
      }
    }
    return null;
  }

  // Only enforce when the catalog explicitly tagged the model.
  if (!entry.capabilities || entry.capabilities.length === 0) return null;

  if (!entry.capabilities.includes(tag!)) {
    return `Model "${model}" is not tagged for ${capabilityType} (missing "${tag}"). ` +
      `Multimodal chat/audio models are not valid speech endpoints — pick from usable_models.${capabilityType}.`;
  }
  return null;
}

const CAPABILITY_MODEL_PATTERNS: Record<string, RegExp> = {
  image_generation: /\bdall-?e\b|gpt-image|flux|stable.?diffusion|sdxl|imagen|wanx|wan[.-]?ai|kolors|playground|cogview|glm-image|seedream|grok-imagine|image-01/i,
  image_recognition: /\bvl\b|vision|visual|eye|gpt-4o|gemini|claude/i,
  // Dedicated TTS ids only — do NOT match bare "speech"/"voice" (too broad) or music models.
  audio_tts: /\btts\b|cosy.?voice|bark|xtts|orpheus|aura-?\d|tts-1|text[-_.]?to[-_.]?speech/i,
  audio_stt: /\bstt\b|whisper|sense.?voice|paraformer|speech.?to.?text|transcribe|asr|voxtral|nova-?\d/i,
  video_generation: /\bvideo\b|hailuo|wan.*[ti]2v|sora|kling|gen-?[23]|cogvideo|vidu|seedance|veo/i,
};

const TEXT_MODEL_PATTERN = /deepseek|qwen|gpt-[345]|gpt-5|claude|gemini|glm-[45]|llama|mistral|phi-|command|minimax-m/i;
const AUDIO_CHAT_PATTERN = /gpt-audio|gpt-4o-audio|realtime|\baudio-preview\b/i;

function detectModelCapabilityMismatch(model: string, capabilityType: ModelCapabilityType): string | null {
  if (capabilityType === 'audio_tts' && AUDIO_CHAT_PATTERN.test(model)) {
    return `Model "${model}" is a multimodal chat/audio model, not a dedicated TTS endpoint. ` +
      `Use a speech model such as deepgram/aura-2 or openai/tts-1.`;
  }

  const expectedPattern = CAPABILITY_MODEL_PATTERNS[capabilityType];
  if (!expectedPattern) return null;

  if (expectedPattern.test(model)) return null;

  if (TEXT_MODEL_PATTERN.test(model) || AUDIO_CHAT_PATTERN.test(model)) {
    return `Model "${model}" appears to be a text/chat model, not suitable for ${capabilityType}. ` +
      `Expected a model matching patterns like: ${expectedPattern.source}`;
  }

  return null;
}
