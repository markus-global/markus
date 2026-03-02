# OpenClaw Ecosystem Integration Design

## Overview

This document outlines the design for integrating Markus with the OpenClaw ecosystem. The goal is to enable bidirectional interoperability between Markus digital employees and OpenClaw agents.

## Core Requirements

Based on task requirements and product analysis:

1. **Document-driven Agent configuration system** - Support OpenClaw-style configuration via markdown documents
2. **Enhanced memory system** - Long-term memory, context management, knowledge base
3. **Heartbeat mechanism** - Health monitoring, automatic recovery
4. **External Agent integration** - OpenClaw Agents can join Markus organization as digital employees

## Current Markus Architecture Analysis

### Existing Capabilities
- ✅ **Heartbeat system** - Already implemented in `packages/core/src/heartbeat.ts`
- ✅ **Memory system** - Sophisticated 3-tier memory (short/medium/long-term) in `packages/core/src/memory/store.ts`
- ✅ **Agent system** - Full agent runtime with tools, sandboxing, and organization context
- ✅ **Task system** - Task management with assignment, tracking, and status updates
- ✅ **Communication adapters** - Support for Feishu, WhatsApp, Slack, etc.

### Gaps for OpenClaw Integration
- 🔄 **Document-driven configuration** - Need to support OpenClaw-style markdown configuration files
- 🔄 **External agent protocol** - Standardized API for external agents to join Markus organization
- 🔄 **Memory interoperability** - Shared memory/knowledge base between Markus and OpenClaw agents
- 🔄 **Heartbeat compatibility** - Ensure heartbeat systems can interoperate

## Integration Architecture

### 1. Document-driven Agent Configuration System

**Design:**
- Extend existing role template system to support OpenClaw-style markdown documents
- Create a `DocumentConfigParser` that can parse OpenClaw configuration formats
- Support both Markus JSON role templates and OpenClaw markdown configurations

**Implementation Plan:**
```typescript
// New: DocumentConfigParser for OpenClaw-style configs
class DocumentConfigParser {
  parse(markdown: string): Partial<AgentConfig> {
    // Parse OpenClaw-style sections:
    // - Identity & Role
    // - Capabilities & Tools  
    // - Memory Configuration
    // - Heartbeat Tasks
    // - Communication Preferences
  }
}

// Integration with existing role system
interface ExtendedRoleTemplate extends RoleTemplate {
  sourceFormat: 'markus-json' | 'openclaw-md';
  sourceDocument?: string; // Original markdown for OpenClaw configs
}
```

### 2. Enhanced Memory System Integration

**Design:**
- Extend existing MemoryStore to support OpenClaw memory formats
- Add knowledge base indexing and search capabilities
- Implement memory synchronization between Markus and OpenClaw agents

**Implementation Plan:**
```typescript
// Enhance MemoryStore with OpenClaw compatibility
class OpenClawCompatibleMemoryStore extends MemoryStore {
  // Add knowledge base with vector search
  private knowledgeBase: VectorStore;
  
  // Support OpenClaw memory import/export
  importOpenClawMemory(data: OpenClawMemoryFormat): void;
  exportToOpenClawFormat(): OpenClawMemoryFormat;
  
  // Enhanced search with semantic capabilities
  semanticSearch(query: string, limit?: number): MemoryEntry[];
}

// New: Memory synchronization service
class MemorySyncService {
  syncBetweenAgents(agent1Id: string, agent2Id: string, memoryTypes: string[]): Promise<void>;
}
```

### 3. Heartbeat Mechanism Enhancement

**Design:**
- Extend existing HeartbeatScheduler to support OpenClaw heartbeat tasks
- Add health monitoring and automatic recovery
- Support cross-agent heartbeat dependencies

**Implementation Plan:**
```typescript
// Enhanced heartbeat with OpenClaw compatibility
class OpenClawHeartbeatScheduler extends HeartbeatScheduler {
  // Support OpenClaw heartbeat task format
  addOpenClawTask(task: OpenClawHeartbeatTask): void;
  
  // Health monitoring with automatic recovery
  monitorHealth(): HealthStatus;
  attemptRecovery(): Promise<RecoveryResult>;
  
  // Cross-agent heartbeat coordination
  coordinateWithExternalAgent(agentId: string, taskName: string): void;
}
```

### 4. External Agent Integration Protocol

**Design:**
- Define standard API for external agents (OpenClaw) to join Markus organization
- Authentication and authorization mechanism
- Capability discovery and negotiation
- Task delegation and coordination protocol

**Implementation Plan:**
```typescript
// External Agent API
interface ExternalAgentAPI {
  // Discovery and registration
  register(agentInfo: ExternalAgentInfo): Promise<RegistrationResult>;
  discoverCapabilities(): Promise<AgentCapabilities>;
  
  // Task coordination
  acceptTask(task: TaskDefinition): Promise<TaskAcceptance>;
  reportProgress(taskId: string, progress: TaskProgress): Promise<void>;
  completeTask(taskId: string, result: TaskResult): Promise<void>;
  
  // Communication
  sendMessage(toAgentId: string, message: AgentMessage): Promise<void>;
  receiveMessages(): AsyncGenerator<AgentMessage>;
}

// Markus-side integration service
class ExternalAgentIntegrationService {
  // Manage external agents
  registerExternalAgent(agent: ExternalAgent): Promise<void>;
  unregisterExternalAgent(agentId: string): Promise<void>;
  
  // Task routing to external agents
  routeTaskToExternalAgent(task: Task, agentCapabilities: AgentCapabilities): Promise<boolean>;
  
  // Communication bridge
  bridgeMessages(internalAgentId: string, externalAgentId: string): MessageBridge;
}
```

## Implementation Phases

### Phase 1: Foundation (Week 1-2)
1. DocumentConfigParser implementation
2. OpenClaw memory format support
3. Basic external agent registration API

### Phase 2: Core Integration (Week 3-4)
1. Enhanced MemoryStore with knowledge base
2. Heartbeat system interoperability
3. Task delegation to external agents

### Phase 3: Advanced Features (Week 5-6)
1. Memory synchronization between agents
2. Health monitoring and automatic recovery
3. Performance optimization and scaling

### Phase 4: Production Ready (Week 7-8)
1. Security hardening
2. Comprehensive testing
3. Documentation and examples

## API Design

### External Agent Registration
```http
POST /api/v1/external-agents/register
Content-Type: application/json

{
  "agentId": "openclaw-agent-123",
  "name": "OpenClaw Developer Agent",
  "capabilities": ["coding", "debugging", "code-review"],
  "configuration": "openclaw-md or markus-json",
  "authToken": "secure-token"
}
```

### Memory Synchronization
```http
POST /api/v1/agents/:agentId/memory/sync
Content-Type: application/json

{
  "targetAgentId": "markus-agent-456",
  "memoryTypes": ["conversation", "facts", "task_results"],
  "direction": "bidirectional"
}
```

### Heartbeat Coordination
```http
POST /api/v1/agents/:agentId/heartbeat/coordinate
Content-Type: application/json

{
  "externalAgentId": "openclaw-agent-123",
  "taskName": "daily-standup",
  "coordinationMode": "sequential|parallel|dependent"
}
```

## Security Considerations

1. **Authentication**: JWT tokens for external agent authentication
2. **Authorization**: Role-based access control for external agents
3. **Data isolation**: Memory and task data isolation between organizations
4. **Rate limiting**: Prevent abuse of external agent APIs
5. **Audit logging**: Comprehensive logging of all external agent interactions

## Testing Strategy

1. **Unit tests**: Individual component testing
2. **Integration tests**: Markus ↔ OpenClaw interoperability
3. **End-to-end tests**: Complete workflow testing
4. **Performance tests**: Scaling and load testing
5. **Security tests**: Authentication, authorization, and data isolation

## Success Metrics

1. **Integration success rate**: % of successful OpenClaw agent registrations
2. **Task completion rate**: % of tasks successfully completed by external agents
3. **Memory sync accuracy**: Accuracy of memory synchronization
4. **Heartbeat reliability**: % of successful heartbeat coordination
5. **Performance impact**: Latency and throughput impact on Markus system

## Next Steps

1. Create detailed technical specifications for each component
2. Implement Phase 1 components
3. Test with mock OpenClaw agents
4. Iterate based on testing feedback
5. Deploy to staging environment for integration testing