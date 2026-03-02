import { OpenClawConfigParser } from './packages/core/src/openclaw-config-parser';

// Test the OpenClaw parser with full output
async function testParser() {
  console.log('Testing OpenClawConfigParser with full output...');
  
  const parser = new OpenClawConfigParser();
  const content = `# OpenClaw Test Agent

## Identity
- Name: TestAgent
- Role: Software Developer
- Skills: shell_execute, file_read_write, git_operations

## Memory
- short-term: 1000 tokens
- medium-term: 5000 tokens  
- long-term: 20000 tokens
- knowledge-base: true
- context-window: 4000 tokens

## Heartbeat
- Check assigned issues: Check if there are new issues assigned to me. Review each one and start working on the highest priority item.
- Update task status: Review all tasks and update their status based on current progress.

## Policies
- Code Safety: Never commit secrets, API keys, or credentials to version control
- Communication: Report blockers within 30 minutes of encountering them

## Knowledge Base
- https://github.com/openclaw/docs/wiki/Agent-Architecture
- https://github.com/openclaw/docs/wiki/Memory-Systems`;
  
  const result = parser.parse(content);
  
  console.log('\n=== Full Parsed Result ===');
  console.log(JSON.stringify(result, null, 2));
  
  console.log('\n=== System Prompt (first 500 chars) ===');
  console.log(result.systemPrompt.substring(0, 500) + '...');
}

testParser().catch(console.error);