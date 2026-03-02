// Test extractSection directly
const testMarkdown = `# Test Agent

## Identity
- Name: TestAgent
- Role: Tester

## Heartbeat Tasks
- Check tasks: Check tasks
- Report status: Report current status

## Policies
- Code Safety: Never commit secrets, API keys, or credentials to version control
- Communication: Report blockers within 30 minutes of encountering them

## Memory Configuration
- Short-term: 1000 tokens
- Medium-term: 5000 tokens
- Long-term: 10000 tokens
- Knowledge-base: true
- Context-window: 8000 tokens

## Capabilities
- shell_execute
- file_read_write
- web_search
- code_review`;

// Simple extractSection implementation for debugging
function extractSection(md: string, possibleHeaders: string[]): string | null {
  for (const header of possibleHeaders) {
    // Escape regex special characters in header
    const escapedHeader = header.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
    const regex = new RegExp(`^${escapedHeader}\\s*$\\n([\\s\\S]*)(?=^##\\s|^#\\s|$)`, 'm');
    const match = md.match(regex);
    if (match) {
      console.log(`Found header: "${header}"`);
      console.log(`Match[0]: "${match[0].substring(0, 100)}..."`);
      console.log(`Match[1]: "${match[1].substring(0, 100)}..."`);
      return match[1].trim();
    }
  }
  return null;
}

console.log('Testing extractSection for Heartbeat Tasks...');
const section = extractSection(testMarkdown, ['## Heartbeat Tasks']);
console.log('Result:', section);