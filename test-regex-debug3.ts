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

console.log('Test config length:', testConfig.length);
console.log('First 500 chars:');
console.log(testConfig.substring(0, 500));

// Test regex
const header = '## Heartbeat';
const escapedHeader = header.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
const regex = new RegExp(`^${escapedHeader}\\s*$\\n([\\s\\S]*?)(?=\\n\\s*\\n##|\\n\\s*\\n#|$)`, 'm');

console.log('\nRegex:', regex);
console.log('Regex source:', regex.source);

// Find all matches
let match;
let lastIndex = 0;
while ((match = regex.exec(testConfig.substring(lastIndex))) !== null) {
  console.log('\nMatch found at index:', match.index + lastIndex);
  console.log('Match[0]:', JSON.stringify(match[0]));
  console.log('Match[1]:', JSON.stringify(match[1]));
  lastIndex = match.index + match[0].length;
}

// Also test with global flag
console.log('\n=== Testing with global flag ===');
const regexGlobal = new RegExp(`^${escapedHeader}\\s*$\\n([\\s\\S]*?)(?=\\n\\s*\\n##|\\n\\s*\\n#|$)`, 'gm');
const matches = testConfig.matchAll(regexGlobal);
for (const match of matches) {
  console.log('Match[0]:', JSON.stringify(match[0]));
  console.log('Match[1]:', JSON.stringify(match[1]));
}

// Test simpler regex
console.log('\n=== Testing simpler regex ===');
const simpleRegex = /## Heartbeat\s*\n([\s\S]*?)(?=\n##|\n#|$)/;
const simpleMatch = testConfig.match(simpleRegex);
if (simpleMatch) {
  console.log('Simple match[0]:', JSON.stringify(simpleMatch[0]));
  console.log('Simple match[1]:', JSON.stringify(simpleMatch[1]));
}

// What's actually in the config after "## Heartbeat Tasks"?
console.log('\n=== Finding "## Heartbeat" in config ===');
const heartbeatIndex = testConfig.indexOf('## Heartbeat');
console.log('Index of "## Heartbeat":', heartbeatIndex);
if (heartbeatIndex >= 0) {
  console.log('Context around index:');
  console.log(testConfig.substring(Math.max(0, heartbeatIndex - 20), Math.min(testConfig.length, heartbeatIndex + 100)));
}