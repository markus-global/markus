import type { AgentToolHandler } from '../agent.js';
import { createLogger } from '@markus/shared';
import type {
  ResourceRequest,
  ResourceResponse,
  ProgressSync,
  CapabilityDiscovery,
  StatusBroadcast,
  TaskDelegation,
  DelegationResult,
} from '@markus/a2a';
import crypto from 'crypto';

const log = createLogger('a2a-structured-tools');

const A2A_SEND_INTERVAL_MS = 30_000;

// Global send queue: serialises all structured A2A dispatches so only one
// message is in-flight at a time, with a gap between each to avoid rate-limiting.
let sendQueue: Promise<void> = Promise.resolve();
function enqueueSend(fn: () => Promise<void>): void {
  sendQueue = sendQueue.then(async () => {
    await fn();
    await new Promise(r => setTimeout(r, A2A_SEND_INTERVAL_MS));
  }).catch(() => { /* individual errors are already logged */ });
}

export interface A2AMessage {
  type: string;
  payload: Record<string, unknown>;
  timestamp: number;
  sender: {
    id: string;
    name: string;
  };
}

export interface CollaborationRequest {
  collaborationType: 'pair_programming' | 'code_review' | 'design_discussion' | 'problem_solving' | 'research';
  topic: string;
  taskId?: string;
  durationMs?: number;
  resourcesNeeded?: string;
}

export interface StructuredA2AContext {
  selfId: string;
  selfName: string;
  listColleagues: () => Array<{ id: string; name: string; role: string; status: string; skills?: string[] }>;
  sendMessage: (targetId: string, message: string, fromId: string, fromName: string) => Promise<string>;
  /** When provided, delegations go through DelegationManager for real task creation */
  delegateTask?: (targetId: string, delegation: TaskDelegation) => Promise<DelegationResult>;
}

export function createStructuredA2ATools(ctx: StructuredA2AContext): AgentToolHandler[] {
  const sendStructuredMessage = async (
    targetId: string,
    messageType: string,
    payload: any
  ): Promise<string> => {
    if (targetId === ctx.selfId) {
      return JSON.stringify({ status: 'error', error: 'Cannot send a message to yourself' });
    }

    const structuredMessage: A2AMessage = {
      type: messageType as any,
      payload,
      timestamp: Date.now(),
      sender: {
        id: ctx.selfId,
        name: ctx.selfName,
      },
    };

    const message = JSON.stringify(structuredMessage);
    log.info(`Structured A2A message dispatched: ${ctx.selfName} → ${targetId}`, { 
      messageType,
      payloadSize: JSON.stringify(payload).length 
    });
    
    // Enqueue dispatch so sends are serialised globally with a gap between each
    enqueueSend(async () => {
      try {
        await ctx.sendMessage(targetId, message, ctx.selfId, ctx.selfName);
      } catch (err: unknown) {
        log.warn(`Structured A2A message to ${targetId} failed in background`, { 
          error: String(err),
          messageType 
        });
      }
    });
    
    return JSON.stringify({ 
      status: 'dispatched', 
      message: `Structured ${messageType} message dispatched. The agent will process it independently.`,
      messageType 
    });
  };

  return [
    {
      name: 'agent_request_resource',
      description: 'Request a resource (file, data, API access) from another agent. Use this to collaborate on shared resources.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The ID of the agent to request resource from' },
          resource_type: { type: 'string', description: 'Type of resource (file, api, data, compute, etc.)' },
          resource_id: { type: 'string', description: 'Identifier for the specific resource' },
          access_level: { type: 'string', description: 'Required access level (read, write, execute)', enum: ['read', 'write', 'execute'] },
          purpose: { type: 'string', description: 'Purpose of the resource request' },
          timeout_ms: { type: 'number', description: 'Timeout in milliseconds (optional)' },
        },
        required: ['agent_id', 'resource_type', 'resource_id', 'access_level', 'purpose'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const targetId = args['agent_id'] as string;
        const resourceType = args['resource_type'] as string;
        // 验证resourceType是否为有效值
        const validResourceTypes = ['compute', 'storage', 'tool', 'data', 'network', 'other'];
        const validatedResourceType = validResourceTypes.includes(resourceType) 
          ? resourceType as 'compute' | 'storage' | 'tool' | 'data' | 'network' | 'other'
          : 'other';
          
        const resourceRequest: ResourceRequest = {
          requestId: crypto.randomUUID(),
          resourceType: validatedResourceType,
          resourceName: args['resource_id'] as string,
          description: args['purpose'] as string,
          requirements: args['timeout_ms'] ? { timeout: args['timeout_ms'] as number } : undefined,
        };
        
        return sendStructuredMessage(targetId, 'resource_request', resourceRequest);
      },
    },
    {
      name: 'agent_sync_progress',
      description: 'Synchronize task progress with another agent. Use this to keep collaborators updated on task status.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The ID of the agent to sync progress with' },
          task_id: { type: 'string', description: 'Task ID being worked on' },
          progress_percent: { type: 'number', description: 'Progress percentage (0-100)' },
          status: { type: 'string', description: 'Current status', enum: ['pending', 'in_progress', 'blocked', 'completed', 'failed'] },
          details: { type: 'string', description: 'Progress details or notes (optional)' },
          estimated_completion_ms: { type: 'number', description: 'Estimated time to completion in milliseconds (optional)' },
        },
        required: ['agent_id', 'task_id', 'progress_percent', 'status'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const targetId = args['agent_id'] as string;
        const progressSync: ProgressSync = {
          taskId: args['task_id'] as string,
          phase: args['phase'] as string || 'default',
          progress: args['progress_percent'] as number,
          status: args['status'] as 'pending' | 'in_progress' | 'blocked' | 'completed' | 'failed',
          message: args['details'] as string || '',
        };
        
        return sendStructuredMessage(targetId, 'progress_sync', progressSync);
      },
    },
    {
      name: 'agent_discover_capabilities',
      description: 'Discover capabilities of another agent. Use this to find agents with specific skills or resources.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The ID of the agent to discover capabilities from' },
          capability_filter: { type: 'string', description: 'Filter for specific capabilities (optional, comma-separated)' },
        },
        required: ['agent_id'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const targetId = args['agent_id'] as string;
        const capabilityDiscovery: CapabilityDiscovery = {
          discoveryId: crypto.randomUUID(),
          query: args['capability_filter'] ? {
            skills: [args['capability_filter'] as string]
          } : undefined,
        };
        
        return sendStructuredMessage(targetId, 'capability_discovery', capabilityDiscovery);
      },
    },
    {
      name: 'agent_broadcast_status',
      description: 'Broadcast your current status to all agents. Use this to keep the team informed of your availability and current work.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Current status', enum: ['idle', 'busy', 'blocked', 'available', 'unavailable'] },
          current_task_id: { type: 'string', description: 'Current task ID (optional)' },
          current_task_title: { type: 'string', description: 'Current task title (optional)' },
          available_capacity: { type: 'number', description: 'Available capacity (0-100) for new work (optional)' },
          skills_available: { type: 'string', description: 'Skills currently available (optional, comma-separated)' },
        },
        required: ['status'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const status = args['status'] as string;
        const validStatuses = ['idle', 'working', 'busy', 'blocked', 'offline'];
        const validatedStatus = validStatuses.includes(status) 
          ? status as 'idle' | 'working' | 'busy' | 'blocked' | 'offline'
          : 'idle';
          
        const statusBroadcast: StatusBroadcast = {
          agentId: ctx.selfId,
          status: validatedStatus,
          load: args['available_capacity'] ? 100 - (args['available_capacity'] as number) : 50,
          capabilities: args['skills_available'] ? (args['skills_available'] as string).split(',') : [],
          availableForWork: validatedStatus === 'idle' || validatedStatus === 'working',
          currentTask: args['current_task_id'] ? {
            taskId: args['current_task_id'] as string,
            title: args['current_task_title'] as string || 'Unknown task',
            progress: 0
          } : undefined,
        };
        
        // Enqueue broadcasts sequentially via the global send queue
        const colleagues = ctx.listColleagues().filter(a => a.id !== ctx.selfId);
        for (const colleague of colleagues) {
          await sendStructuredMessage(colleague.id, 'status_broadcast', statusBroadcast);
        }
        
        return JSON.stringify({ 
          status: 'broadcasted', 
          message: `Status broadcast enqueued for ${colleagues.length} agents`,
          broadcastCount: colleagues.length,
          totalAgents: colleagues.length
        });
      },
    },
    {
      name: 'agent_delegate_task',
      description: 'Delegate a task to another agent. Use this to distribute work among team members.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The ID of the agent to delegate task to' },
          task_id: { type: 'string', description: 'Task ID to delegate' },
          task_title: { type: 'string', description: 'Task title' },
          task_description: { type: 'string', description: 'Task description' },
          priority: { type: 'string', description: 'Task priority', enum: ['low', 'medium', 'high', 'urgent'] },
          deadline_ms: { type: 'number', description: 'Deadline in milliseconds from now (optional)' },
          required_skills: { type: 'string', description: 'Required skills (optional, comma-separated)' },
        },
        required: ['agent_id', 'task_id', 'task_title', 'task_description', 'priority'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const targetId = args['agent_id'] as string;
        const taskDelegation: TaskDelegation = {
          taskId: args['task_id'] as string,
          title: args['task_title'] as string,
          description: args['task_description'] as string,
          priority: args['priority'] as 'low' | 'medium' | 'high' | 'urgent',
          deadline: args['deadline_ms'] ? new Date(Date.now() + (args['deadline_ms'] as number)).toISOString() : undefined,
          context: args['required_skills'] as string || undefined,
        };

        if (ctx.delegateTask) {
          const result = await ctx.delegateTask(targetId, taskDelegation);
          return JSON.stringify({
            status: result.accepted ? 'delegated' : 'rejected',
            delegatedTo: result.delegatedTo,
            reason: result.reason,
          });
        }
        return sendStructuredMessage(targetId, 'task_delegate', taskDelegation);
      },
    },
    {
      name: 'agent_request_collaboration',
      description: 'Request collaboration with another agent on a specific task or topic.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The ID of the agent to collaborate with' },
          collaboration_type: { type: 'string', description: 'Type of collaboration', enum: ['pair_programming', 'code_review', 'design_discussion', 'problem_solving', 'research'] },
          topic: { type: 'string', description: 'Collaboration topic' },
          task_id: { type: 'string', description: 'Related task ID (optional)' },
          duration_ms: { type: 'number', description: 'Expected duration in milliseconds (optional)' },
          resources_needed: { type: 'string', description: 'Resources needed for collaboration (optional)' },
        },
        required: ['agent_id', 'collaboration_type', 'topic'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const targetId = args['agent_id'] as string;
        const collaborationRequest: CollaborationRequest = {
          collaborationType: args['collaboration_type'] as 'pair_programming' | 'code_review' | 'design_discussion' | 'problem_solving' | 'research',
          topic: args['topic'] as string,
          taskId: args['task_id'] as string || undefined,
          durationMs: args['duration_ms'] as number || undefined,
          resourcesNeeded: args['resources_needed'] as string || undefined,
        };
        
        return sendStructuredMessage(targetId, 'collaboration_request', collaborationRequest);
      },
    },
  ];
}