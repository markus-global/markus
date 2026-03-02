import { createLogger } from '@markus/shared';
import type { A2ABus } from './bus.js';
import type {
  A2AEnvelope,
  ResourceRequest,
  ResourceResponse,
  ProgressSync,
  CapabilityDiscovery,
  StatusBroadcast,
} from './protocol.js';

const log = createLogger('a2a-structured');

export interface ResourceManager {
  requestResource(request: ResourceRequest): Promise<ResourceResponse>;
  releaseResource(requestId: string): Promise<void>;
  listAvailableResources(): Promise<Array<{ type: string; name: string; available: boolean }>>;
}

export interface ProgressTracker {
  trackProgress(sync: ProgressSync): Promise<void>;
  getTaskProgress(taskId: string): Promise<ProgressSync | undefined>;
  listActiveTasks(): Promise<ProgressSync[]>;
}

export interface CapabilityRegistry {
  registerCapabilities(agentId: string, capabilities: string[], skills: string[]): Promise<void>;
  discoverCapabilities(query?: CapabilityDiscovery['query']): Promise<CapabilityDiscovery['response'][]>;
  getAgentCapabilities(agentId: string): Promise<CapabilityDiscovery['response'] | undefined>;
}

export interface StatusMonitor {
  updateStatus(broadcast: StatusBroadcast): Promise<void>;
  getAgentStatus(agentId: string): Promise<StatusBroadcast | undefined>;
  listAvailableAgents(): Promise<StatusBroadcast[]>;
}

/**
 * Structured Message Manager for handling structured A2A collaboration messages.
 * This manager handles the new structured message types defined in the protocol.
 */
export class StructuredMessageManager {
  private resourceRequests = new Map<string, { request: ResourceRequest; from: string; timestamp: string }>();
  private progressStore = new Map<string, ProgressSync>();
  private capabilityRegistry = new Map<string, CapabilityDiscovery['response']>();
  private statusStore = new Map<string, StatusBroadcast>();

  constructor(private bus: A2ABus) {
    // Register handlers for structured message types
    bus.on('resource_request', (env) => this.handleResourceRequest(env));
    bus.on('resource_response', (env) => this.handleResourceResponse(env));
    bus.on('progress_sync', (env) => this.handleProgressSync(env));
    bus.on('capability_discovery', (env) => this.handleCapabilityDiscovery(env));
    bus.on('status_broadcast', (env) => this.handleStatusBroadcast(env));
  }

  // ======================
  // Resource Management
  // ======================

  /**
   * Request a resource from another agent
   */
  async requestResource(
    fromAgentId: string,
    toAgentId: string,
    request: ResourceRequest
  ): Promise<ResourceResponse> {
    const envelope: A2AEnvelope = {
      id: `a2a_res_req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'resource_request',
      from: fromAgentId,
      to: toAgentId,
      timestamp: new Date().toISOString(),
      correlationId: request.requestId,
      payload: request,
    };

    // Store the request for tracking
    this.resourceRequests.set(request.requestId, {
      request,
      from: fromAgentId,
      timestamp: envelope.timestamp,
    });

    await this.bus.send(envelope);

    log.info(`Resource request sent: ${request.resourceType}/${request.resourceName}`, {
      from: fromAgentId,
      to: toAgentId,
      requestId: request.requestId,
    });

    // In a real implementation, we would wait for a response
    // For now, return a placeholder response
    return {
      requestId: request.requestId,
      granted: false,
      reason: 'Response pending',
    };
  }

  /**
   * Respond to a resource request
   */
  async respondToResourceRequest(
    fromAgentId: string,
    toAgentId: string,
    response: ResourceResponse
  ): Promise<void> {
    const envelope: A2AEnvelope = {
      id: `a2a_res_res_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'resource_response',
      from: fromAgentId,
      to: toAgentId,
      timestamp: new Date().toISOString(),
      correlationId: response.requestId,
      payload: response,
    };

    await this.bus.send(envelope);

    log.info(`Resource response sent: ${response.granted ? 'granted' : 'denied'}`, {
      from: fromAgentId,
      to: toAgentId,
      requestId: response.requestId,
    });
  }

  // ======================
  // Progress Synchronization
  // ======================

  /**
   * Synchronize task progress with other agents
   */
  async syncProgress(
    fromAgentId: string,
    toAgentId: string,
    sync: ProgressSync
  ): Promise<void> {
    const envelope: A2AEnvelope = {
      id: `a2a_prog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'progress_sync',
      from: fromAgentId,
      to: toAgentId,
      timestamp: new Date().toISOString(),
      correlationId: sync.taskId,
      payload: sync,
    };

    // Store progress locally
    this.progressStore.set(sync.taskId, sync);

    await this.bus.send(envelope);

    log.info(`Progress sync sent: ${sync.taskId} (${sync.progress}%)`, {
      from: fromAgentId,
      to: toAgentId,
      status: sync.status,
    });
  }

  /**
   * Broadcast progress to all agents
   */
  async broadcastProgress(fromAgentId: string, sync: ProgressSync): Promise<void> {
    await this.bus.broadcast(fromAgentId, 'progress_sync', sync);
    
    // Store progress locally
    this.progressStore.set(sync.taskId, sync);

    log.info(`Progress broadcast: ${sync.taskId} (${sync.progress}%)`, {
      status: sync.status,
      recipients: this.bus.listRegisteredAgents().length - 1,
    });
  }

  // ======================
  // Capability Discovery
  // ======================

  /**
   * Discover agent capabilities
   */
  async discoverCapabilities(
    fromAgentId: string,
    query?: CapabilityDiscovery['query']
  ): Promise<CapabilityDiscovery['response'][]> {
    const discoveryId = `disc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const discovery: CapabilityDiscovery = {
      discoveryId,
      query,
    };

    // Broadcast discovery request
    await this.bus.broadcast(fromAgentId, 'capability_discovery', discovery);

    log.info(`Capability discovery initiated: ${discoveryId}`, {
      query: query ? JSON.stringify(query) : 'none',
    });

    // Return currently known capabilities
    return [...this.capabilityRegistry.values()];
  }

  /**
   * Register agent capabilities
   */
  async registerCapabilities(
    agentId: string,
    capabilities: CapabilityDiscovery['response']
  ): Promise<void> {
    // Ensure capabilities has all required properties
    const safeCapabilities = capabilities || {
      agentId,
      name: agentId,
      role: 'agent',
      skills: [],
      capabilities: [],
      currentLoad: 0,
      availability: 'idle' as const,
    };
    
    this.capabilityRegistry.set(agentId, safeCapabilities);

    // Broadcast status update
    const broadcast: StatusBroadcast = {
      agentId,
      status: safeCapabilities.availability,
      currentTask: undefined,
      load: safeCapabilities.currentLoad,
      capabilities: safeCapabilities.capabilities,
      availableForWork: safeCapabilities.availability === 'idle' || safeCapabilities.availability === 'working',
    };

    await this.bus.broadcast(agentId, 'status_broadcast', broadcast);

    log.info(`Capabilities registered for agent: ${agentId}`, {
      skills: safeCapabilities.skills.length,
      capabilities: safeCapabilities.capabilities.length,
    });
  }

  // ======================
  // Status Broadcasting
  // ======================

  /**
   * Broadcast agent status
   */
  async broadcastStatus(broadcast: StatusBroadcast): Promise<void> {
    this.statusStore.set(broadcast.agentId, broadcast);
    await this.bus.broadcast(broadcast.agentId, 'status_broadcast', broadcast);

    log.info(`Status broadcast: ${broadcast.agentId} -> ${broadcast.status}`, {
      load: broadcast.load,
      availableForWork: broadcast.availableForWork,
    });
  }

  // ======================
  // Message Handlers
  // ======================

  private async handleResourceRequest(envelope: A2AEnvelope): Promise<void> {
    const request = envelope.payload as ResourceRequest;
    log.info(`Resource request received: ${request.resourceType}/${request.resourceName}`, {
      from: envelope.from,
      requestId: request.requestId,
      urgency: request.urgency,
    });

    // In a real implementation, this would check local resources and respond
    // For now, just log the request
  }

  private async handleResourceResponse(envelope: A2AEnvelope): Promise<void> {
    const response = envelope.payload as ResourceResponse;
    log.info(`Resource response received: ${response.granted ? 'granted' : 'denied'}`, {
      from: envelope.from,
      requestId: response.requestId,
      reason: response.reason,
    });

    // Remove the pending request
    this.resourceRequests.delete(response.requestId);
  }

  private async handleProgressSync(envelope: A2AEnvelope): Promise<void> {
    const sync = envelope.payload as ProgressSync;
    this.progressStore.set(sync.taskId, sync);

    log.debug(`Progress sync received: ${sync.taskId} (${sync.progress}%)`, {
      from: envelope.from,
      status: sync.status,
      phase: sync.phase,
    });
  }

  private async handleCapabilityDiscovery(envelope: A2AEnvelope): Promise<void> {
    const discovery = envelope.payload as CapabilityDiscovery;
    
    if (discovery.query) {
      // This is a discovery request, respond with capabilities
      const response = this.capabilityRegistry.get(envelope.to);
      if (response) {
        const discoveryResponse: CapabilityDiscovery = {
          discoveryId: discovery.discoveryId,
          response,
        };

        await this.bus.send({
          id: `a2a_cap_res_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          type: 'capability_discovery',
          from: envelope.to,
          to: envelope.from,
          timestamp: new Date().toISOString(),
          correlationId: discovery.discoveryId,
          payload: discoveryResponse,
        });
      }
    } else if (discovery.response) {
      // This is a discovery response, store the capabilities
      this.capabilityRegistry.set(envelope.from, discovery.response);
      log.debug(`Capabilities discovered for agent: ${envelope.from}`, {
        skills: discovery.response.skills.length,
      });
    }
  }

  private async handleStatusBroadcast(envelope: A2AEnvelope): Promise<void> {
    const broadcast = envelope.payload as StatusBroadcast;
    this.statusStore.set(broadcast.agentId, broadcast);

    log.debug(`Status broadcast received: ${broadcast.agentId} -> ${broadcast.status}`, {
      load: broadcast.load,
      currentTask: broadcast.currentTask?.title,
    });
  }

  // ======================
  // Query Methods
  // ======================

  getResourceRequest(requestId: string) {
    return this.resourceRequests.get(requestId);
  }

  getTaskProgress(taskId: string) {
    return this.progressStore.get(taskId);
  }

  getAgentCapabilities(agentId: string) {
    return this.capabilityRegistry.get(agentId);
  }

  getAgentStatus(agentId: string) {
    return this.statusStore.get(agentId);
  }

  listAvailableAgents(): StatusBroadcast[] {
    return [...this.statusStore.values()].filter(
      (status) => status.availableForWork && status.status !== 'offline'
    );
  }

  listActiveTasks(): ProgressSync[] {
    return [...this.progressStore.values()].filter(
      (sync) => sync.status === 'in_progress' || sync.status === 'blocked'
    );
  }
}