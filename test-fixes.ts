import { OpenClawConfigParser } from './packages/core/src/openclaw-config-parser.ts';

const testMarkdown = `# Test Agent

## Identity
- Name: TestAgent
- Role: Tester

## Heartbeat Tasks
- Check tasks: Check tasks
- Report status: Report current status

## Policies
- Code Safety: Never commit secrets, API keys, or credentials to version control
- Communication: Report blockers within 30 minutes of encountering them

## Memory Configuration
- Short-term: 1000 tokens
- Medium-term: 5000 tokens
- Long-term: 10000 tokens
- Knowledge-base: true
- Context-window: 8000 tokens

## Capabilities
- shell_execute
- file_read_write
- web_search
- code_review`;

const parser = new OpenClawConfigParser();
const result = parser.parse(testMarkdown);

console.log('=== Test Results ===');
console.log('Name:', result.name);
console.log('Heartbeat Tasks:', JSON.stringify(result.defaultHeartbeatTasks, null, 2));
console.log('Policies:', JSON.stringify(result.defaultPolicies, null, 2));
console.log('\n=== System Prompt (first 500 chars) ===');
console.log(result.systemPrompt.substring(0, 500) + '...');