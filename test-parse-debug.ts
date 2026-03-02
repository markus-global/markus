import { OpenClawConfigParser } from './packages/core/src/openclaw-config-parser';

const testConfig = `# Test Agent

## Identity
- Name: TestAgent
- Role: Tester

## Core Competencies
- shell_execute

## Capabilities
- file_read_write
- web_search
- code_review

## Memory Configuration
- Short-term: 1000 tokens
- Medium-term: 5000 tokens
- Long-term: 10000 tokens
- Knowledge-base: true
- Context-window: 8000 tokens

## Heartbeat Tasks
- Check tasks: Check tasks
- Report status: Report current status

## Communication
- Report blockers within 30 minutes of encountering them

## Policies
- Code Safety: Never commit secrets, API keys, or credentials to version control
- Communication: Report blockers within 30 minutes of encountering them`;

const parser = new OpenClawConfigParser();

// Test extractSection directly
function extractSection(md: string, possibleHeaders: string[]): string | null {
  for (const header of possibleHeaders) {
    const escapedHeader = header.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
    const regex = new RegExp(`^${escapedHeader}\\s*$\\n([\\s\\S]*?)(?=\\n\\s*\\n##|\\n\\s*\\n#|$)`, 'm');
    const match = md.match(regex);
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}

console.log('=== Testing extractSection ===');
const heartbeatSection = extractSection(testConfig, ['## Heartbeat', '## Periodic Tasks', '## Scheduled Tasks']);
console.log('Heartbeat section:', JSON.stringify(heartbeatSection));

const policiesSection = extractSection(testConfig, ['## Policies', '## Rules', '## Guidelines']);
console.log('Policies section:', JSON.stringify(policiesSection));

// Test parseHeartbeatTasks logic
console.log('\n=== Testing parseHeartbeatTasks logic ===');
if (heartbeatSection) {
  const lines = heartbeatSection.split('\n');
  console.log('Lines:', lines);
  
  const tasks: any[] = [];
  let currentTask: any = {};
  
  for (const line of lines) {
    const trimmed = line.trim();
    console.log(`Processing line: "${trimmed}"`);
    
    if (trimmed.startsWith('###') || trimmed.match(/^[-*]\s*[^:]+:/)) {
      console.log('  -> Task header detected');
      if (currentTask.name && currentTask.description) {
        tasks.push({
          name: currentTask.name,
          description: currentTask.description,
          enabled: true,
        });
        console.log(`  -> Saved previous task: ${currentTask.name}`);
      }
      
      currentTask = {};
      
      let taskName = trimmed;
      if (trimmed.startsWith('###')) {
        taskName = trimmed.replace(/^###\s*/, '');
      } else {
        taskName = trimmed.replace(/^[-*]\s*/, '');
      }
      
      currentTask.name = taskName.replace(/:.*$/, '').trim();
      
      const inlineDesc = trimmed.match(/:\s*(.+)$/);
      if (inlineDesc && inlineDesc[1]) {
        currentTask.description = inlineDesc[1].trim();
      }
      
      console.log(`  -> New task: name="${currentTask.name}", desc="${currentTask.description}"`);
    } else if (trimmed && currentTask.name && !trimmed.startsWith('#')) {
      console.log('  -> Description continuation');
      if (currentTask.description) {
        currentTask.description += ' ' + trimmed;
      } else {
        currentTask.description = trimmed;
      }
    }
  }
  
  if (currentTask.name && currentTask.description) {
    tasks.push({
      name: currentTask.name,
      description: currentTask.description,
      enabled: true,
    });
    console.log(`  -> Saved last task: ${currentTask.name}`);
  }
  
  console.log('\nParsed tasks:', JSON.stringify(tasks, null, 2));
}

// Test parsePolicies logic
console.log('\n=== Testing parsePolicies logic ===');
if (policiesSection) {
  const lines = policiesSection.split('\n');
  console.log('Lines:', lines);
  
  const policies: any[] = [];
  let currentPolicy: any = {};
  
  for (const line of lines) {
    const trimmed = line.trim();
    console.log(`Processing line: "${trimmed}"`);
    
    if (trimmed.startsWith('###') || trimmed.match(/^[-*]\s*[^:]+:/)) {
      console.log('  -> Policy header detected');
      if (currentPolicy.name && currentPolicy.description) {
        policies.push({
          id: `policy_${Math.random().toString(36).substring(2)}`,
          name: currentPolicy.name,
          description: currentPolicy.description,
          category: 'operational',
        });
        console.log(`  -> Saved previous policy: ${currentPolicy.name}`);
      }
      
      currentPolicy = {};
      
      let policyName = trimmed;
      if (trimmed.startsWith('###')) {
        policyName = trimmed.replace(/^###\s*/, '');
      } else {
        policyName = trimmed.replace(/^[-*]\s*/, '');
      }
      
      currentPolicy.name = policyName.replace(/:.*$/, '').trim();
      
      const inlineDesc = trimmed.match(/:\s*(.+)$/);
      if (inlineDesc && inlineDesc[1]) {
        currentPolicy.description = inlineDesc[1].trim();
      }
      
      console.log(`  -> New policy: name="${currentPolicy.name}", desc="${currentPolicy.description}"`);
    } else if (trimmed && currentPolicy.name && !trimmed.startsWith('#')) {
      console.log('  -> Description continuation');
      if (currentPolicy.description) {
        currentPolicy.description += ' ' + trimmed;
      } else {
        currentPolicy.description = trimmed;
      }
    }
  }
  
  if (currentPolicy.name && currentPolicy.description) {
    policies.push({
      id: `policy_${Math.random().toString(36).substring(2)}`,
      name: currentPolicy.name,
      description: currentPolicy.description,
      category: 'operational',
    });
    console.log(`  -> Saved last policy: ${currentPolicy.name}`);
  }
  
  console.log('\nParsed policies:', JSON.stringify(policies, null, 2));
}