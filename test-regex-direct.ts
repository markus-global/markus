// Test regex directly
const testMarkdown = `# Test Agent

## Identity
- Name: TestAgent
- Role: Tester

## Heartbeat
- Check tasks: Check tasks
- Report status: Report current status

## Policies
- Code Safety: Never commit secrets, API keys, or credentials to version control`;

const header = '## Heartbeat';
const escapedHeader = header.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
const regex = new RegExp(`^${escapedHeader}\\s*$\\n([\\s\\S]*?)(?=^##\\s|^#\\s|$)`, 'gm');

console.log('Testing regex on full string...');
const matches = [...testMarkdown.matchAll(regex)];
console.log(`Number of matches: ${matches.length}`);

for (let i = 0; i < matches.length; i++) {
  const match = matches[i];
  console.log(`\nMatch ${i}:`);
  console.log(`Full match: "${match[0]}"`);
  console.log(`Group 1: "${match[1]}"`);
  console.log(`Index: ${match.index}`);
  
  // Show context
  const start = Math.max(0, match.index! - 20);
  const end = Math.min(testMarkdown.length, match.index! + match[0].length + 20);
  console.log(`Context: "${testMarkdown.substring(start, end)}"`);
}

// Also test with just the heartbeat section
const heartbeatSection = testMarkdown.substring(testMarkdown.indexOf('## Heartbeat'));
console.log('\n\nTesting on just heartbeat section:');
console.log('Section:', JSON.stringify(heartbeatSection.substring(0, 100)));
const matches2 = [...heartbeatSection.matchAll(regex)];
console.log(`Number of matches: ${matches2.length}`);
for (const match of matches2) {
  console.log(`Match: "${match[0]}"`);
  console.log(`Group 1: "${match[1]}"`);
}