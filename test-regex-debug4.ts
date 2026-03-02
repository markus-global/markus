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

const header = '## Heartbeat Tasks';
const escapedHeader = header.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
const regex = new RegExp(`^${escapedHeader}\\s*$\\n([\\s\\S]*?)(?=\\n##|\\n#|$)`, 'm');

console.log('Regex:', regex);
console.log('Testing match...');

const match = testConfig.match(regex);
if (match) {
  console.log('Match found!');
  console.log('Match[0]:', JSON.stringify(match[0]));
  console.log('Match[1]:', JSON.stringify(match[1]));
  
  // Show what comes after match[1]
  const afterIndex = match.index! + match[0].length;
  console.log('\nWhat comes after the match (next 50 chars):');
  console.log(JSON.stringify(testConfig.substring(afterIndex, afterIndex + 50)));
} else {
  console.log('No match!');
  
  // Try to find the header
  const headerIndex = testConfig.indexOf('## Heartbeat Tasks');
  console.log('\nHeader found at index:', headerIndex);
  if (headerIndex >= 0) {
    console.log('Context around header (100 chars after):');
    console.log(testConfig.substring(headerIndex, headerIndex + 100));
    
    // Manually check what the regex should match
    const afterHeader = testConfig.substring(headerIndex + header.length);
    console.log('\nAfter header (first 200 chars):');
    console.log(JSON.stringify(afterHeader.substring(0, 200)));
    
    // Find next ##
    const nextHeaderIndex = testConfig.indexOf('\n##', headerIndex + 1);
    console.log('\nNext header at index:', nextHeaderIndex);
    if (nextHeaderIndex > 0) {
      console.log('Content between headers:');
      console.log(JSON.stringify(testConfig.substring(headerIndex + header.length, nextHeaderIndex)));
    }
  }
}