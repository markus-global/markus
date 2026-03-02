// Simple test to check parser methods
import { OpenClawConfigParser } from './packages/core/src/openclaw-config-parser.ts';

const testMarkdown = `# Test Agent

## Identity
- Name: TestAgent
- Role: Tester

## Heartbeat
- Check tasks: Check tasks
- Report status: Report current status`;

console.log('Testing simple parser...\n');

try {
  const parser = new OpenClawConfigParser();
  
  // Test individual methods
  console.log('Testing extractTitle:');
  const title = parser['extractTitle'](testMarkdown);
  console.log(`Title: ${title}`);
  
  console.log('\nTesting parseHeartbeatTasks:');
  const heartbeatTasks = parser['parseHeartbeatTasks'](testMarkdown);
  console.log(`Heartbeat tasks: ${JSON.stringify(heartbeatTasks, null, 2)}`);
  
  console.log('\nTesting parsePolicies:');
  const policies = parser['parsePolicies'](testMarkdown);
  console.log(`Policies: ${JSON.stringify(policies, null, 2)}`);
  
  console.log('\nTesting parseCapabilities:');
  const capabilities = parser['parseCapabilities'](testMarkdown);
  console.log(`Capabilities: ${JSON.stringify(capabilities, null, 2)}`);
  
} catch (error) {
  console.error('Error:', error);
  if (error instanceof Error) {
    console.error('Stack:', error.stack);
  }
}