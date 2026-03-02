// Check newlines
const testMarkdown = `# Test Agent

## Identity
- Name: TestAgent
- Role: Tester

## Heartbeat
- Check tasks: Check tasks
- Report status: Report current status

## Policies
- Code Safety: Never commit secrets, API keys, or credentials to version control`;

console.log('String with escaped newlines:');
console.log(JSON.stringify(testMarkdown.substring(testMarkdown.indexOf('## Heartbeat'), testMarkdown.indexOf('## Heartbeat') + 150)));