import type { AgentToolHandler } from '../agent.js';
import type { LLMRouter } from '../llm/router.js';
import { createLogger, type MarkusConfig, type ModelTaskType, type TaskModelAssignment } from '@markus/shared';

const log = createLogger('settings-tools');

export interface SettingsToolsContext {
  llmRouter: LLMRouter;
  /** Persist config changes to markus.json */
  persistConfig?: (updates: Partial<MarkusConfig>) => void;
}

export function createSettingsTools(ctx: SettingsToolsContext): AgentToolHandler[] {
  return [
    {
      name: 'llm_list_providers',
      description:
        'List LLM providers. By default only shows enabled (configured + active) providers. ' +
        'Use show_all=true to include disabled and unconfigured providers.',
      inputSchema: {
        type: 'object',
        properties: {
          show_all: {
            type: 'boolean',
            description: 'When true, include disabled and unconfigured providers. Default: false (only enabled).',
          },
        },
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const settings = ctx.llmRouter.getEnhancedSettings();
        const showAll = args['show_all'] === true;
        const entries = Object.entries(settings.providers)
          .filter(([, p]) => showAll || (p.configured && p.enabled))
          .map(([name, p]) => ({
            name,
            displayName: p.displayName,
            currentModel: p.model,
            configured: p.configured,
            enabled: p.enabled,
            isDefault: name === settings.defaultProvider,
            availableModels: p.models?.map(m => ({
              id: m.id,
              name: m.name,
              contextWindow: m.contextWindow,
              maxOutputTokens: m.maxOutputTokens,
              cost: m.cost,
              reasoning: m.reasoning,
              vision: m.inputTypes?.includes('image'),
            })) ?? [],
          }));
        const enabled = entries.filter(p => p.configured && p.enabled);
        return JSON.stringify({
          defaultProvider: settings.defaultProvider,
          enabled_count: enabled.length,
          total_count: entries.length,
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

          if (ctx.persistConfig) {
            try {
              ctx.persistConfig({ llm: { defaultProvider: provider } } as any);
            } catch (e) {
              log.warn('Failed to persist default provider change', { error: String(e) });
            }
          }

          return JSON.stringify({
            status: 'success',
            previousDefault: oldDefault,
            newDefault: provider,
            message: `Default provider changed from ${oldDefault} to ${provider}`,
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
      name: 'llm_get_task_routing',
      description:
        'Get current task routing configuration. Shows which provider+model is assigned to each task type ' +
        '(text, image_generation, audio_tts, audio_stt, video_generation) and the routing default model.',
      inputSchema: { type: 'object', properties: {} },
      async execute(): Promise<string> {
        const routing = ctx.llmRouter.taskRouting;
        const defaultModel = ctx.llmRouter.routingDefaultModel;
        return JSON.stringify({
          routing_default_model: defaultModel ?? null,
          assignments: routing.assignments,
          task_types: ['text', 'image_recognition', 'image_generation', 'audio_tts', 'audio_stt', 'video_generation'],
        });
      },
    },
    {
      name: 'llm_set_task_routing',
      description:
        'Assign a specific provider+model to a task type. For example, assign OpenAI gpt-image-1 to image_generation, ' +
        'or assign a TTS model to audio_tts. Use llm_get_task_routing to see current assignments and llm_list_providers to see available providers. ' +
        'Set provider and model to empty strings to clear an assignment.',
      inputSchema: {
        type: 'object',
        properties: {
          task_type: {
            type: 'string',
            enum: ['text', 'image_recognition', 'image_generation', 'audio_tts', 'audio_stt', 'video_generation'],
            description: 'The task type to configure',
          },
          provider: {
            type: 'string',
            description: 'Provider name (e.g. "openai", "anthropic"). Use llm_list_providers to see available names.',
          },
          model: {
            type: 'string',
            description: 'Model ID to use for this task (e.g. "gpt-image-1", "tts-1", "whisper-1")',
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
        required: ['task_type', 'provider', 'model'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const taskType = args['task_type'] as ModelTaskType;
        const provider = args['provider'] as string;
        const model = args['model'] as string;

        try {
          if (!provider && !model) {
            const current = { ...ctx.llmRouter.taskRouting };
            delete current.assignments[taskType];
            ctx.llmRouter.setTaskRouting(current);

            if (ctx.persistConfig) {
              try {
                ctx.persistConfig({ llm: { taskRouting: { assignments: { [taskType]: null } } } } as any);
              } catch { /* best effort */ }
            }

            return JSON.stringify({
              status: 'success',
              message: `Cleared task routing for ${taskType}`,
            });
          }

          if (taskType !== 'text') {
            const mismatch = detectModelTaskMismatch(model, taskType);
            if (mismatch) {
              return JSON.stringify({
                status: 'error',
                error: mismatch,
                hint: `Use llm_list_providers to find models that support ${taskType}.`,
              });
            }
          }

          const assignment: TaskModelAssignment = { provider, model };
          const fbProvider = args['fallback_provider'] as string | undefined;
          const fbModel = args['fallback_model'] as string | undefined;
          if (fbProvider && fbModel) {
            assignment.fallback = { provider: fbProvider, model: fbModel };
          }

          const updated = {
            ...ctx.llmRouter.taskRouting,
            assignments: {
              ...ctx.llmRouter.taskRouting.assignments,
              [taskType]: assignment,
            },
          };
          ctx.llmRouter.setTaskRouting(updated);

          if (ctx.persistConfig) {
            try { ctx.persistConfig({ llm: { taskRouting: updated } } as any); } catch { /* best effort */ }
          }

          return JSON.stringify({
            status: 'success',
            task_type: taskType,
            provider,
            model,
            fallback: assignment.fallback ?? null,
            message: `Task ${taskType} now routed to ${provider}/${model}`,
          });
        } catch (err) {
          return JSON.stringify({ status: 'error', error: String(err) });
        }
      },
    },
  ];
}

const TASK_MODEL_PATTERNS: Record<string, RegExp> = {
  image_generation: /\bdall-?e\b|gpt-image|flux|stable.?diffusion|sdxl|imagen|wanx|wan[.-]?ai|kolors|playground|cogview|glm-image|seedream|grok-imagine|image-01/i,
  image_recognition: /\bvl\b|vision|visual|eye|gpt-4o|gemini|claude/i,
  audio_tts: /\btts\b|cosy.?voice|speech|bark|xtts|voice|orpheus|music/i,
  audio_stt: /\bstt\b|whisper|sense.?voice|paraformer|speech.?to.?text|transcribe|asr|voxtral/i,
  video_generation: /\bvideo\b|hailuo|wan.*[ti]2v|sora|kling|gen-?[23]|cogvideo|vidu|seedance|veo/i,
};

const TEXT_MODEL_PATTERN = /deepseek|qwen|gpt-[34]|gpt-5|claude|gemini|glm-[45]|llama|mistral|phi-|command|minimax-m/i;

function detectModelTaskMismatch(model: string, taskType: ModelTaskType): string | null {
  const expectedPattern = TASK_MODEL_PATTERNS[taskType];
  if (!expectedPattern) return null;

  if (expectedPattern.test(model)) return null;

  if (TEXT_MODEL_PATTERN.test(model)) {
    return `Model "${model}" appears to be a text/chat model, not suitable for ${taskType}. ` +
      `Expected a model matching patterns like: ${expectedPattern.source}`;
  }

  return null;
}
