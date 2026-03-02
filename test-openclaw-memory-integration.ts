import { OpenClawConfigParser } from './packages/core/src/openclaw-config-parser.ts';
import { EnhancedMemorySystem } from './packages/core/src/enhanced-memory-system.ts';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';

// Test OpenClaw configuration with memory settings
const testConfig = `# Memory Test Agent

## Identity
- Name: MemoryTestAgent
- Role: Memory Tester
- Skills: Testing, Memory Management

## Memory Configuration
- short-term: 1000 tokens
- medium-term: 5000 tokens  
- long-term: 10000 tokens
- knowledge-base: true
- context-window: 8000 tokens

## Heartbeat Tasks
- Check memory usage: Monitor memory usage and report statistics
- Cleanup old entries: Remove old memory entries if limits exceeded

## Policies
- Memory Safety: Always respect memory limits and clean up when needed
- Data Privacy: Never store sensitive information in memory

## Knowledge Base References
- Memory management best practices
- OpenClaw memory configuration guidelines
- Markus memory system documentation`;

console.log('Testing OpenClaw memory system integration...\n');

// Create test directory
const testDir = join(process.cwd(), 'test-memory-integration');
if (existsSync(testDir)) {
  rmSync(testDir, { recursive: true });
}
mkdirSync(testDir, { recursive: true });

try {
  // Parse OpenClaw configuration
  const parser = new OpenClawConfigParser();
  const { roleTemplate, openClawConfig } = parser.parseFullConfig(testConfig);
  
  console.log('=== Parsed Configuration ===');
  console.log(`Agent Name: ${roleTemplate.name}`);
  console.log(`Memory Config: ${JSON.stringify(openClawConfig.memoryConfig, null, 2)}`);
  console.log(`Heartbeat Tasks: ${openClawConfig.heartbeatTasks?.length || 0}`);
  console.log(`Knowledge Base: ${openClawConfig.knowledgeBase?.length || 0} references\n`);
  
  // Create EnhancedMemorySystem with OpenClaw configuration
  console.log('=== Creating EnhancedMemorySystem ===');
  const memorySystem = new EnhancedMemorySystem(testDir, openClawConfig.memoryConfig);
  
  // Test memory statistics
  console.log('=== Memory Statistics ===');
  const stats = memorySystem.getMemoryStats();
  console.log(`Total Entries: ${stats.totalEntries}`);
  console.log(`Total Sessions: ${stats.totalSessions}`);
  console.log(`Knowledge Base Size: ${stats.knowledgeBaseSize}`);
  console.log(`Config Limits: ${JSON.stringify(stats.configLimits, null, 2)}`);
  console.log(`Within Limits: ${memorySystem.isWithinMemoryLimits()}\n`);
  
  // Test adding some memory entries
  console.log('=== Testing Memory Operations ===');
  
  // Create a session
  const session = memorySystem.createSession('test-agent-1');
  console.log(`Created session: ${session.id}`);
  
  // Add some entries
  memorySystem.addEntry({
    id: 'test-entry-1',
    timestamp: new Date().toISOString(),
    agentId: 'test-agent-1',
    type: 'thought',
    content: 'Test thought about memory integration',
    metadata: { test: true }
  });
  
  memorySystem.addEntry({
    id: 'test-entry-2', 
    timestamp: new Date().toISOString(),
    agentId: 'test-agent-1',
    type: 'action',
    content: 'Test action: checking memory limits',
    metadata: { test: true }
  });
  
  // Get updated statistics
  const updatedStats = memorySystem.getMemoryStats();
  console.log(`Updated Total Entries: ${updatedStats.totalEntries}`);
  console.log(`Updated Total Sessions: ${updatedStats.totalSessions}`);
  console.log(`Within Limits: ${memorySystem.isWithinMemoryLimits()}\n`);
  
  // Apply memory limits
  console.log('=== Applying Memory Limits ===');
  memorySystem.applyMemoryLimits();
  
  console.log('✅ Memory system integration test completed successfully!');
  
} catch (error) {
  console.error('❌ Test failed:', error);
} finally {
  // Cleanup
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
}