// Debug the regex step by step
const content = `# Test Agent

## Identity
- Name: TestAgent
- Role: Tester

## Heartbeat Tasks
- Check tasks: Check tasks
- Report status: Report current status`;

console.log('Debugging regex step by step...\n');

// Test 1: What if we make the * greedy instead of non-greedy?
const escapedHeader = '## Heartbeat Tasks'.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const regexGreedy = new RegExp(`^${escapedHeader}\\s*$\\n([\\s\\S]*)(?=^##\\s|^#\\s|$)`, 'm');
console.log('Greedy regex:', regexGreedy);
const matchGreedy = content.match(regexGreedy);
console.log('Greedy match:', matchGreedy ? matchGreedy[1] : 'Not found');

// Test 2: What if we remove the lookahead entirely?
const regexNoLookahead = new RegExp(`^${escapedHeader}\\s*$\\n([\\s\\S]*)`, 'm');
console.log('\nNo lookahead regex:', regexNoLookahead);
const matchNoLookahead = content.match(regexNoLookahead);
console.log('No lookahead match:', matchNoLookahead ? matchNoLookahead[1] : 'Not found');

// Test 3: What if we match to end of string?
const regexToEnd = new RegExp(`^${escapedHeader}\\s*$\\n([\\s\\S]*)$`, 'm');
console.log('\nTo end regex:', regexToEnd);
const matchToEnd = content.match(regexToEnd);
console.log('To end match:', matchToEnd ? matchToEnd[1] : 'Not found');

// Test 4: Let's trace through what the regex engine sees
console.log('\n=== Tracing regex execution ===');
// Write a simple regex engine trace
const testRegex = new RegExp(`^${escapedHeader}\\s*$\\n([\\s\\S]*?)(?=^##\\s|^#\\s|$)`, 'mg');
let m;
while ((m = testRegex.exec(content)) !== null) {
  console.log('Found match at index', m.index);
  console.log('Group 1:', m[1]);
  console.log('Next char after match:', content.charCodeAt(m.index + m[0].length));
}

// Test 5: What's the actual content after the header?
const headerIndex = content.indexOf('## Heartbeat Tasks');
console.log('\n=== Manual check ===');
console.log('Header index:', headerIndex);
const afterHeader = content.substring(headerIndex);
console.log('After header (first 100 chars):', afterHeader.substring(0, 100));
const lines = afterHeader.split('\n');
console.log('Lines after header:');
lines.forEach((line, i) => {
  console.log(`${i}: "${line}"`);
});