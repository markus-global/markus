// Test extractSection logic
const md = `# Test Agent

## Identity
- Name: TestAgent
- Role: Tester

## Heartbeat Tasks
- Check tasks: Check tasks
- Report status: Report current status`;

console.log('Testing extractSection...\n');

// Simple implementation of extractSection logic
function extractSection(md: string, possibleHeaders: string[]): string | null {
  for (const header of possibleHeaders) {
    // Escape special regex characters in header
    const escapedHeader = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^${escapedHeader}\\s*$\\n([\\s\\S]*?)(?=^#{2,}\\s|$)`, 'm');
    const match = md.match(regex);
    if (match) {
      console.log(`Found header: "${header}"`);
      console.log(`Match: "${match[0].substring(0, 100)}..."`);
      console.log(`Content: "${match[1]}"`);
      return match[1].trim();
    }
  }
  return null;
}

const sections = extractSection(md, ['## Heartbeat', '## Periodic Tasks', '## Scheduled Tasks', '## Heartbeat Tasks']);
console.log('\nSections found:', sections);