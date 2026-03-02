import { StructuredMessageManager } from '../src/structured.js';
import type { A2AMessage } from '../src/protocol.js';

/**
 * Example demonstrating structured A2A message usage
 */
export class StructuredMessagesExample {
  private manager: StructuredMessageManager;

  constructor() {
    this.manager = new StructuredMessageManager();
  }

  /**
   * Example 1: Resource request between agents
   */
  async demonstrateResourceRequest(): Promise<void> {
    console.log('=== Example 1: Resource Request ===');
    
    // Agent A requests a file from Agent B
    const requestId = this.manager.requestResource({
      resourceType: 'file',
      resourceId: 'project-config.json',
      accessLevel: 'read',
      purpose: 'Need to read configuration for task processing',
      timeoutMs: 30000,
    });

    console.log(`Resource request created with ID: ${requestId}`);

    // Simulate Agent B receiving and responding to the request
    const mockMessage: A2AMessage = {
      type: 'resource_request',
      payload: {
        requestId,
        resourceType: 'file',
        resourceId: 'project-config.json',
        accessLevel: 'read',
        purpose: 'Need to read configuration for task processing',
        timeoutMs: 30000,
      },
      timestamp: Date.now(),
      sender: {
        id: 'agent-a',
        name: 'Agent A',
      },
    };

    // Agent B handles the request
    const response = this.manager.handleResourceRequest(mockMessage);
    console.log('Agent B response:', response);

    // Agent A receives the response
    const resource = this.manager.respondToResourceRequest(requestId, {
      status: 'granted',
      resourceUrl: 'file:///path/to/project-config.json',
      accessToken: 'read-token-123',
      expiresAt: Date.now() + 3600000, // 1 hour
    });

    console.log('Resource granted:', resource);
  }

  /**
   * Example 2: Progress synchronization
   */
  async demonstrateProgressSync(): Promise<void> {
    console.log('\n=== Example 2: Progress Synchronization ===');
    
    // Agent A syncs progress on a task
    const syncId = this.manager.syncProgress({
      taskId: 'tsk_1234567890',
      progressPercent: 75,
      status: 'in_progress',
      details: 'Completed API implementation, working on UI components',
      estimatedCompletionMs: 7200000, // 2 hours
    });

    console.log(`Progress sync created with ID: ${syncId}`);

    // Broadcast progress to all agents
    this.manager.broadcastProgress({
      taskId: 'tsk_1234567890',
      progressPercent: 75,
      status: 'in_progress',
      details: 'Completed API implementation, working on UI components',
      estimatedCompletionMs: 7200000,
    });

    console.log('Progress broadcasted to all agents');

    // Query task progress
    const progress = this.manager.getTaskProgress('tsk_1234567890');
    console.log('Current task progress:', progress);
  }

  /**
   * Example 3: Capability discovery
   */
  async demonstrateCapabilityDiscovery(): Promise<void> {
    console.log('\n=== Example 3: Capability Discovery ===');
    
    // Agent A registers its capabilities
    this.manager.registerCapabilities({
      agentId: 'agent-a',
      agentName: 'Agent A',
      capabilities: [
        {
          type: 'code_generation',
          level: 'expert',
          technologies: ['TypeScript', 'React', 'Node.js'],
        },
        {
          type: 'code_review',
          level: 'advanced',
          technologies: ['JavaScript', 'Python'],
        },
        {
          type: 'testing',
          level: 'intermediate',
          technologies: ['Jest', 'Cypress'],
        },
      ],
    });

    console.log('Agent A capabilities registered');

    // Agent B discovers capabilities
    const capabilities = this.manager.discoverCapabilities({
      capabilityFilter: 'code_generation,code_review',
    });

    console.log('Discovered capabilities:', capabilities);

    // Query specific agent capabilities
    const agentCapabilities = this.manager.getAgentCapabilities('agent-a');
    console.log('Agent A capabilities:', agentCapabilities);
  }

  /**
   * Example 4: Status broadcasting
   */
  async demonstrateStatusBroadcast(): Promise<void> {
    console.log('\n=== Example 4: Status Broadcasting ===');
    
    // Agent A broadcasts its status
    this.manager.broadcastStatus({
      agentId: 'agent-a',
      agentName: 'Agent A',
      status: 'busy',
      currentTaskId: 'tsk_1234567890',
      currentTaskTitle: 'Implement structured A2A messages',
      availableCapacity: 30,
      skillsAvailable: 'TypeScript,Node.js,React',
    });

    console.log('Status broadcasted');

    // Query agent status
    const status = this.manager.getAgentStatus('agent-a');
    console.log('Agent A status:', status);
  }

  /**
   * Example 5: Task delegation
   */
  async demonstrateTaskDelegation(): Promise<void> {
    console.log('\n=== Example 5: Task Delegation ===');
    
    // Simulate receiving a task delegation
    const mockDelegationMessage: A2AMessage = {
      type: 'task_delegation',
      payload: {
        taskId: 'tsk_9876543210',
        taskTitle: 'Fix authentication bug',
        taskDescription: 'Users are unable to login with OAuth provider',
        priority: 'high',
        deadlineMs: Date.now() + 86400000, // 24 hours
        requiredSkills: 'authentication,OAuth,security',
      },
      timestamp: Date.now(),
      sender: {
        id: 'manager-agent',
        name: 'Manager Agent',
      },
    };

    // Handle the delegation
    const delegation = this.manager.handleTaskDelegation(mockDelegationMessage);
    console.log('Task delegation received:', delegation);
  }

  /**
   * Run all examples
   */
  async runAllExamples(): Promise<void> {
    console.log('Starting Structured A2A Messages Examples\n');
    
    await this.demonstrateResourceRequest();
    await this.demonstrateProgressSync();
    await this.demonstrateCapabilityDiscovery();
    await this.demonstrateStatusBroadcast();
    await this.demonstrateTaskDelegation();
    
    console.log('\nAll examples completed successfully!');
  }
}

// Run the examples if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const example = new StructuredMessagesExample();
  example.runAllExamples().catch(console.error);
}