import { OpenClawConfigParser } from './packages/core/src/openclaw-config-parser';

// Test the OpenClaw parser with debug
async function testParser() {
  console.log('Testing OpenClawConfigParser with debug...');
  
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
  
  console.log('Content length:', content.length);
  console.log('First 100 chars:', content.substring(0, 100));
  
  const result = parser.parse(content);
  
  console.log('\nParsed result:');
  console.log('Name:', result.name);
  console.log('Description:', result.description);
  console.log('Category:', result.category);
  console.log('Memory config:', result.memoryConfig);
  console.log('Heartbeat tasks:', result.heartbeatTasks?.length);
  console.log('Policies:', result.policies?.length);
  console.log('Knowledge base:', result.knowledgeBase?.length);
  console.log('System prompt length:', result.systemPrompt?.length);
}

testParser().catch(console.error);