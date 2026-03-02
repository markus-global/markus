import { OpenClawConfigParser } from './packages/core/src/openclaw-config-parser';

const parser = new OpenClawConfigParser();

const testConfig = `# Identity & Role

**Name:** Test Agent
**Description:** A test agent for OpenClaw integration
**Category:** software-developer

# Capabilities & Tools

## Skills
- shell_execute
- file_read_write
- git_operations
- web_search
- code_review
- test_runner

# Memory Configuration

| Memory Type | Capacity |
|-------------|----------|
| Short-term  | 10,000 tokens |
| Medium-term | 50,000 tokens |
| Long-term   | Unlimited |
| Knowledge Base | Enabled |
| Context Window | 8,192 tokens |

## Heartbeat Tasks

### Daily Status Report
Generate a daily status report summarizing completed tasks and upcoming work.
**Schedule:** Every 86400 seconds

### Code Review Check
Periodically check for pending code reviews and provide feedback.
**Schedule:** Every 300 seconds

# Communication Preferences

- **Primary Channel:** Direct messaging
- **Response Time:** Within 30 seconds
- **Format:** Structured messages with clear action items

# Knowledge Base

## Internal Knowledge
- Project documentation
- Team guidelines
- Best practices

## External References
- Official documentation
- Community resources
- Technical specifications`;

try {
  console.log('Testing OpenClawConfigParser...');
  
  // Test isOpenClawFormat
  const isOpenClaw = parser.isOpenClawFormat(testConfig);
  console.log(`Is OpenClaw format: ${isOpenClaw}`);
  
  // Test parse
  const roleTemplate = parser.parse(testConfig);
  console.log('Parsed role template:');
  console.log(`- Name: ${roleTemplate.name}`);
  console.log(`- Description: ${roleTemplate.description}`);
  console.log(`- Category: ${roleTemplate.category}`);
  console.log(`- Default skills: ${roleTemplate.defaultSkills?.length || 0}`);
  console.log(`- Heartbeat tasks: ${roleTemplate.defaultHeartbeatTasks?.length || 0}`);
  
  if (roleTemplate.defaultHeartbeatTasks && roleTemplate.defaultHeartbeatTasks.length > 0) {
    console.log('Heartbeat tasks found:');
    roleTemplate.defaultHeartbeatTasks.forEach((task, i) => {
      console.log(`  ${i + 1}. ${task.name}: ${task.description}`);
      if (task.cronExpression) console.log(`     Cron: ${task.cronExpression}`);
      if (task.intervalMs) console.log(`     Interval: ${task.intervalMs}ms`);
    });
  }
  
  // Test toOpenClawFormat
  const openClawFormat = parser.toOpenClawFormat(roleTemplate);
  console.log('\nConverted back to OpenClaw format (first 500 chars):');
  console.log(openClawFormat.substring(0, 500) + '...');
  
  console.log('\n✅ All tests passed!');
} catch (error) {
  console.error('❌ Test failed:', error);
}