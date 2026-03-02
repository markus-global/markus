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
Long-term: 10000 tokens
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

const header = '## Heartbeat Tasks';
const escapedHeader = header.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');

// Test different regexes
const regexes = [
  { name: 'Original (lazy)', regex: new RegExp(`^${escapedHeader}\\s*$\\n([\\s\\S]*?)(?=\\n##|\\n#|$)`, 'm') },
  { name: 'Greedy', regex: new RegExp(`^${escapedHeader}\\s*$\\n([\\s\\S]*)(?=\\n##|\\n#|$)`, 'm') },
  { name: 'Match to end then backtrack', regex: new RegExp(`^${escapedHeader}\\s*$\\n([\\s\\S]*)`, 'm') },
  { name: 'Simple capture', regex: new RegExp(`^${escapedHeader}\\s*$\\n([^]*)`, 'm') },
];

for (const { name, regex } of regexes) {
  console.log(`\n=== Testing ${name} ===`);
  console.log('Regex:', regex);
  
  const match = testConfig.match(regex);
  if (match) {
    console.log('Match[0] length:', match[0].length);
    console.log('Match[0] (first 100 chars):', JSON.stringify(match[0].substring(0, 100)));
    console.log('Match[1] length:', match[1]?.length);
    console.log('Match[1] (first 100 chars):', JSON.stringify(match[1]?.substring(0, 100)));
    
    // Show what comes after
    const afterIndex = match.index! + match[0].length;
    const next50 = testConfig.substring(afterIndex, afterIndex + 50);
    console.log('After match (50 chars):', JSON.stringify(next50));
  } else {
    console.log('No match');
  }
}

// Also test what the actual content should be
console.log('\n=== Manual analysis ===');
const headerIndex = testConfig.indexOf('## Heartbeat Tasks');
console.log('Header index:', headerIndex);
const nextHeaderIndex = testConfig.indexOf('\n##', headerIndex + 1);
console.log('Next header index:', nextHeaderIndex);
console.log('Content between:');
console.log(JSON.stringify(testConfig.substring(headerIndex + header.length, nextHeaderIndex)));