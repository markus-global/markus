import { OpenClawConfigParser } from './packages/core/src/openclaw-config-parser';

// Test the OpenClaw parser with simple content
async function testParser() {
  console.log('Testing OpenClawConfigParser with simple content...');
  
  const parser = new OpenClawConfigParser();
  const content = `# Simple Test

## Identity
- Name: SimpleAgent
- Role: Tester

## Memory
- short-term: 1000 tokens

## Heartbeat
- Check tasks: Check tasks

## Policies
- Test Policy: Test description

## Knowledge Base
- https://example.com`;
  
  const result = parser.parse(content);
  
  console.log('\n=== System Prompt ===');
  console.log(result.systemPrompt);
  
  console.log('\n=== Skills ===');
  console.log(result.defaultSkills);
  
  console.log('\n=== Policies ===');
  console.log(JSON.stringify(result.defaultPolicies, null, 2));
}

testParser().catch(console.error);