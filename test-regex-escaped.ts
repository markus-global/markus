// Test the regex with the exact escaping from the code
const content = `# Test Agent

## Identity
- Name: TestAgent
- Role: Tester

## Heartbeat Tasks
- Check tasks: Check tasks
- Report status: Report current status`;

console.log('Testing exact regex from code...\n');

const escapedHeader = '## Heartbeat Tasks'.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
console.log('Escaped header:', escapedHeader);

// This is what the code creates:
const regexString = `^${escapedHeader}\\s*$\\n([\\s\\S]*?)(?=^##\\s|^#\\s|$)`;
console.log('Regex string:', regexString);

const regex = new RegExp(regexString, 'm');
console.log('Regex:', regex);

const match = content.match(regex);
console.log('\nMatch:', match ? 'Found' : 'Not found');
if (match) {
  console.log('Group 1:', match[1]);
  console.log('Group 1 length:', match[1].length);
}

// Also test with a simpler regex
console.log('\n=== Testing simpler regex ===');
const regex2 = new RegExp(`^${escapedHeader}[^\\n]*\\n([\\s\\S]*?)(?=\\n##|\\n#|$)`, 'm');
console.log('Regex2:', regex2);
const match2 = content.match(regex2);
console.log('Match2:', match2 ? match2[1] : 'Not found');

// Test the actual bug: we need to match until next ## heading or end of file
console.log('\n=== Testing fix ===');
// The issue is that ^ in lookahead with m flag checks start of line
// But we're matching across multiple lines
// We need to stop at \n## or \n# or end of string
const regex3 = new RegExp(`^${escapedHeader}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|\\n#\\s|$)`, 'm');
console.log('Regex3:', regex3);
const match3 = content.match(regex3);
console.log('Match3:', match3 ? match3[1] : 'Not found');