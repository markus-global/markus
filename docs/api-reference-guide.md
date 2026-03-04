# Markus API Reference Guide

## Overview

This guide provides an overview of the Markus API structure and how to navigate the generated documentation.

## Package Overview

### Core (`@markus/core`)
The foundation of the Markus platform. Contains:
- **Agent system**: `Agent`, `AgentManager`, `AgentMetricsCollector`
- **LLM integration**: `LLMRouter`, `OpenAIProvider`, `AnthropicProvider`, `GoogleProvider`
- **Memory system**: `EnhancedMemorySystem`, `MemoryStore`, `LocalVectorStore`
- **Tool system**: `ToolSelector`, `ToolHookRegistry`, `MCPClientManager`
- **Event system**: `EventBus`, `ContextEngine`
- **Security**: `SecurityGuard`, `GuardrailPipeline`

### Organization Manager (`@markus/org-manager`)
Manages organizations, teams, and tasks:
- **Task system**: Task creation, assignment, and tracking
- **Team coordination**: Agent collaboration and workflow management
- **Organization structure**: Multi-agent team management

### Communication (`@markus/comms`)
Agent communication protocols:
- **Message routing**: Between agents and external systems
- **Protocol handlers**: Different communication protocols
- **Message serialization**: Structured message formats

### Compute (`@markus/compute`)
Resource management and task execution:
- **Compute resources**: Allocation and management
- **Task execution**: Parallel and sequential task processing
- **Resource monitoring**: Performance and utilization tracking

### GUI Automation (`@markus/gui`)
Browser and desktop automation:
- **Browser control**: Page navigation, element interaction
- **Desktop automation**: Application control
- **Screenshot capture**: Visual feedback and debugging

### Agent-to-Agent (`@markus/a2a`)
Structured agent communication:
- **Protocol definitions**: Standardized agent communication
- **Message formats**: Structured data exchange
- **Coordination patterns**: Multi-agent collaboration patterns

### Storage (`@markus/storage`)
Data persistence and management:
- **Database integration**: SQL and NoSQL databases
- **File storage**: Local and remote file systems
- **Data models**: Structured data schemas

### CLI (`@markus/cli`)
Command-line interface tools:
- **Developer tools**: Code generation, project setup
- **Administration**: System management and monitoring
- **Debugging**: Development and troubleshooting tools

### Shared (`@markus/shared`)
Common utilities and types:
- **Type definitions**: Shared TypeScript interfaces and types
- **Utilities**: Common helper functions
- **Constants**: Configuration and default values

## Key APIs

### Agent Management
```typescript
// Creating and managing agents
import { Agent, AgentManager } from '@markus/core';

const agent = new Agent({
  id: 'my-agent',
  role: { /* role definition */ }
});

const manager = new AgentManager();
manager.registerAgent(agent);
```

### LLM Integration
```typescript
// Using LLM providers
import { LLMRouter, OpenAIProvider } from '@markus/core';

const router = new LLMRouter();
router.registerProvider('openai', new OpenAIProvider({ apiKey: '...' }));

const response = await router.complete({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello' }]
});
```

### Task System
```typescript
// Creating and executing tasks
import { TaskService } from '@markus/org-manager';

const taskService = new TaskService();
const task = await taskService.createTask({
  title: 'Analyze data',
  description: 'Process and analyze dataset',
  priority: 'high'
});
```

### Memory System
```typescript
// Using semantic memory
import { EnhancedMemorySystem } from '@markus/core';

const memory = new EnhancedMemorySystem();
await memory.save('user-preference', 'theme', 'dark');
const result = await memory.search('theme preferences');
```

## Navigation Tips

### Finding APIs
1. **By package**: Start at the package level (`docs/api/core/`)
2. **By type**: Browse classes, interfaces, or functions
3. **By name**: Use your IDE's search functionality

### Understanding Documentation
- **Type signatures**: Hover over types to see definitions
- **Source links**: Click source file links to view implementation
- **Cross-references**: Follow links between related APIs

### Common Patterns
- **Factory functions**: Look for `create*()` functions
- **Configuration objects**: Many classes accept options objects
- **Event emitters**: Many components emit events for extensibility

## Best Practices

### Code Organization
1. **Import by package**: Import from specific packages
2. **Use interfaces**: Program to interfaces, not implementations
3. **Leverage types**: Use TypeScript types for type safety

### Error Handling
1. **Check return types**: Many methods return `Promise<Result<T>>`
2. **Handle events**: Subscribe to relevant events
3. **Validate inputs**: Use provided validation utilities

### Performance
1. **Reuse instances**: Many components are designed for reuse
2. **Batch operations**: Use batch methods when available
3. **Cache results**: Implement caching for expensive operations

## Examples

See the `examples/` directory for complete usage examples:
- `examples/basic-agent.ts` - Basic agent setup
- `examples/task-workflow.ts` - Task management workflow
- `examples/memory-search.ts` - Semantic memory usage
- `examples/gui-automation.ts` - Browser automation

## Getting Help

1. **Documentation**: Refer to this guide and generated API docs
2. **Examples**: Study the example code
3. **Source code**: View implementation details in source files
4. **Community**: Join the Markus community for support

## Contributing

To improve documentation:
1. **Add JSDoc comments**: Document your code with `/** */` comments
2. **Include examples**: Add `@example` tags to show usage
3. **Update types**: Keep TypeScript types accurate and comprehensive
4. **Test documentation**: Regenerate and verify documentation changes

---

*Last updated: 2026-03-04*  
*Documentation version: 1.0.0*