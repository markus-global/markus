import { OpenClawConfigParser } from './packages/core/src/openclaw-config-parser.ts';
import { readFileSync } from 'fs';

// Test with a proper OpenClaw configuration
const testMarkdown = `# Test Agent

## Identity
- Name: TestAgent
- Role: Tester
- Skills: Testing, Debugging, Documentation

## Heartbeat
- Check tasks: Check tasks
- Report status: Report current status

## Policies
- Code Safety: Never commit secrets, API keys, or credentials to version control
- Communication: Report blockers within 30 minutes of encountering them

## Memory Configuration
- short-term-tokens: 1000
- medium-term-tokens: 5000  
- long-term-tokens: 10000
- knowledge-base: true
- context-window: 8000

## Knowledge Base
- Project documentation
- API specifications
- User guides`;

console.log('Testing OpenClawConfigParser with fixes...\n');

try {
  const parser = new OpenClawConfigParser();
  const result = parser.parse(testMarkdown);
  
  console.log('=== Parsed Result ===');
  console.log(`Name: ${result.name}`);
  console.log(`Description: ${result.description}`);
  console.log(`Category: ${result.category}`);
  console.log(`Default Skills: ${JSON.stringify(result.defaultSkills, null, 2)}`);
  console.log(`Default Heartbeat Tasks: ${JSON.stringify(result.defaultHeartbeatTasks, null, 2)}`);
  console.log(`Default Policies: ${JSON.stringify(result.defaultPolicies, null, 2)}`);
  console.log(`Built-in: ${result.builtIn}`);
  
  console.log('\n=== System Prompt ===');
  console.log(result.systemPrompt);
  
  // Check for issues
  console.log('\n=== Validation ===');
  const promptLines = result.systemPrompt.split('\n');
  const heartbeatLines = promptLines.filter(line => line.includes('Check tasks') || line.includes('Report status'));
  console.log(`Heartbeat lines in system prompt: ${heartbeatLines.length}`);
  heartbeatLines.forEach((line, i) => console.log(`  ${i+1}. ${line}`));
  
  // Check for duplicate sections
  const identityCount = promptLines.filter(line => line.includes('## Identity')).length;
  const heartbeatCount = promptLines.filter(line => line.includes('## Heartbeat')).length;
  const policiesCount = promptLines.filter(line => line.includes('## Policies')).length;
  
  console.log(`\nSection counts in system prompt:`);
  console.log(`  Identity sections: ${identityCount} (should be 1)`);
  console.log(`  Heartbeat sections: ${heartbeatCount} (should be 1)`);
  console.log(`  Policies sections: ${policiesCount} (should be 0 - handled separately)`);
  
} catch (error) {
  console.error('Error:', error);
}