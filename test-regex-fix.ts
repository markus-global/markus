// Test the fixed regex
const testString = `## Heartbeat
- Check tasks: Check tasks
- Report status: Report current status

## Policies
- Code Safety: Never commit secrets`;

const regex = /^## Heartbeat\s*$\n([\s\S]*?)(?=^##\s|^#\s|$(?!\S))/m;

console.log('Test string:');
console.log(JSON.stringify(testString));
console.log('\nRegex:', regex);

const match = testString.match(regex);
if (match) {
  console.log('\nMatch found!');
  console.log('Match[0]:', JSON.stringify(match[0]));
  console.log('Match[1]:', JSON.stringify(match[1]));
} else {
  console.log('\nNo match!');
}

// Also test extractSection logic
function extractSection(md: string, possibleHeaders: string[]): string | null {
  for (const header of possibleHeaders) {
    const escapedHeader = header.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
    const regex = new RegExp(`^${escapedHeader}\\s*$\\n([\\s\\S]*?)(?=^##\\s|^#\\s|$(?!\\S))`, 'm');
    const match = md.match(regex);
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}

const section = extractSection(testString, ['## Heartbeat']);
console.log('\nExtracted section:', JSON.stringify(section));