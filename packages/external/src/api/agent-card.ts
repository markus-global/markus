/**
 * Agent Card - A2A Protocol discovery endpoint.
 *
 * Generates /.well-known/agent.json from ExternalServiceConfig,
 * enabling discovery by A2A-compatible agents (LangGraph, CrewAI, AutoGen, etc.)
 */
import type { ExternalServiceConfig, AgentServiceCard } from '@markus/shared';

export interface AgentCardOptions {
  /** Base URL of the service (e.g. https://mymarkus.com) */
  baseUrl: string;
  /** Organization name */
  organization: string;
  /** Organization URL */
  organizationUrl?: string;
}

/**
 * Generate an A2A-compatible Agent Card from an ExternalServiceConfig.
 */
export function generateAgentCard(
  service: ExternalServiceConfig,
  options: AgentCardOptions,
): AgentServiceCard {
  const serviceUrl = `${options.baseUrl}/api/gateway/service/${service.agentId}`;

  return {
    name: service.name,
    description: service.description ?? `External service provided by ${service.name}`,
    version: `${service.version}.0.0`,
    provider: {
      organization: options.organization,
      url: options.organizationUrl,
    },
    url: serviceUrl,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      fileUpload: service.inputValidation.allowFileUpload,
    },
    skills: [
      {
        id: 'chat',
        name: 'Conversational Service',
        description: service.description ?? 'General conversational assistance',
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
      },
    ],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    securitySchemes: {
      bearerToken: {
        type: 'http',
        scheme: 'bearer',
        description: 'Gateway token obtained via /api/gateway/register',
      },
      shareToken: {
        type: 'apiKey',
        in: 'query',
        name: 'token',
        description: 'Share link token for human access',
      },
    },
  };
}

/**
 * Route handler for GET /.well-known/agent.json
 * Returns the agent card for the primary active external service.
 */
export function createAgentCardHandler(opts: {
  getActiveServices: () => ExternalServiceConfig[];
  cardOptions: AgentCardOptions;
}) {
  return () => {
    const services = opts.getActiveServices();
    if (services.length === 0) {
      return { status: 404, body: { error: 'No active external services' } };
    }

    const cards = services.map(s => generateAgentCard(s, opts.cardOptions));

    if (cards.length === 1) {
      return { status: 200, headers: { 'Content-Type': 'application/json' }, body: cards[0] };
    }

    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { agents: cards } };
  };
}
