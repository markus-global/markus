// Test the removeSection method
const md = `# Simple Test

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

// Test regex
const header = '## Heartbeat';
const regex = new RegExp(`^${header}\\s*$\\n([\\s\\S]*?)(?=^##\\s|^#\\s|$)`, 'gm');
console.log('Testing regex for header:', header);
console.log('Input:', md);
console.log('\nRegex matches:');
const matches = md.matchAll(regex);
for (const match of matches) {
  console.log('Full match:', match[0]);
  console.log('Content:', match[1]);
}

// Test removing section
let result = md;
result = result.replace(regex, '');
console.log('\nAfter removing section:');
console.log(result);