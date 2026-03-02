// Test removeSection
const testMarkdown = `# Test Agent

## Identity
- Name: TestAgent
- Role: Tester

## Heartbeat
- Check tasks: Check tasks
- Report status: Report current status

## Policies
- Code Safety: Never commit secrets, API keys, or credentials to version control`;

function removeSection(md: string, possibleHeaders: string[]): string {
  let result = md;
  for (const header of possibleHeaders) {
    // Escape regex special characters in header
    const escapedHeader = header.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
    const regex = new RegExp(`^${escapedHeader}\\s*$\\n([\\s\\S]*?)(?=^##\\s|^#\\s|$)`, 'gm');
    console.log(`Trying to remove header: "${header}"`);
    console.log(`Regex: ${regex}`);
    
    const matches = [...result.matchAll(regex)];
    console.log(`Matches found: ${matches.length}`);
    for (const match of matches) {
      console.log(`Match[0]: "${match[0].substring(0, 100)}..."`);
      console.log(`Match[1]: "${match[1].substring(0, 100)}..."`);
    }
    
    result = result.replace(regex, '');
  }
  return result;
}

console.log('Original markdown:');
console.log(testMarkdown);
console.log('\n---\n');

const cleaned = removeSection(testMarkdown, ['## Heartbeat']);
console.log('\nCleaned markdown:');
console.log(cleaned);