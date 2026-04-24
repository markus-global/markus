import type { AgentToolHandler } from '../agent.js';
import type { LLMRouter } from '../llm/router.js';
import { createLogger, type MarkusConfig } from '@markus/shared';

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
      description: 'List all configured LLM providers, their current models, and available alternative models.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      async execute(): Promise<string> {
        const settings = ctx.llmRouter.getEnhancedSettings();
        const providers = Object.entries(settings.providers)
          .filter(([, p]) => p.configured)
          .map(([name, p]) => ({
            name,
            displayName: p.displayName,
            currentModel: p.model,
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
        return JSON.stringify({
          defaultProvider: settings.defaultProvider,
          providers,
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
            description: 'The provider name (e.g. "openrouter", "anthropic", "openai")',
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
            description: 'The provider name to set as default (e.g. "openrouter", "anthropic", "openai")',
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
            description: 'The provider name to edit',
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
  ];
}
