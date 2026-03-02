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

function extractSection(md: string, possibleHeaders: string[]): string | null {
  for (const header of possibleHeaders) {
    const escapedHeader = header.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
    const regex = new RegExp(`^${escapedHeader}\\s*$\\n([\\s\\S]*?)(?=\\n\\s*\\n##|\\n\\s*\\n#|$)`, 'm');
    const match = md.match(regex);
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}

const sections = extractSection(testConfig, ['## Heartbeat', '## Heartbeat Tasks', '## Periodic Tasks', '## Scheduled Tasks']);
console.log('Heartbeat section:', JSON.stringify(sections));
console.log('Section length:', sections?.length);

if (sections) {
  const lines = sections.split('\n');
  console.log('\nLines:');
  lines.forEach((line, i) => console.log(`${i}: "${line}"`));
  
  // Test the parsing logic
  const tasks: any[] = [];
  let currentTask: any = {};
  
  for (const line of lines) {
    const trimmed = line.trim();
    console.log(`\nProcessing line: "${trimmed}"`);
    
    if (trimmed.startsWith('###') || trimmed.match(/^[-*]\s*[^:]+:/)) {
      console.log('  -> Task header detected');
      if (currentTask.name && currentTask.description) {
        tasks.push({
          name: currentTask.name,
          description: currentTask.description,
          enabled: true,
        });
        console.log(`  -> Saved previous task: ${currentTask.name}`);
      }
      
      currentTask = {};
      
      let taskName = trimmed;
      if (trimmed.startsWith('###')) {
        taskName = trimmed.replace(/^###\s*/, '');
      } else {
        taskName = trimmed.replace(/^[-*]\s*/, '');
      }
      
      currentTask.name = taskName.replace(/:.*$/, '').trim();
      
      const inlineDesc = trimmed.match(/:\s*(.+)$/);
      if (inlineDesc && inlineDesc[1]) {
        currentTask.description = inlineDesc[1].trim();
      }
      
      console.log(`  -> New task: name="${currentTask.name}", desc="${currentTask.description}"`);
    } else if (trimmed && currentTask.name && !trimmed.startsWith('#')) {
      console.log('  -> Description continuation');
      if (currentTask.description) {
        currentTask.description += ' ' + trimmed;
      } else {
        currentTask.description = trimmed;
      }
    }
  }
  
  if (currentTask.name && currentTask.description) {
    tasks.push({
      name: currentTask.name,
      description: currentTask.description,
      enabled: true,
    });
    console.log(`  -> Saved last task: ${currentTask.name}`);
  }
  
  console.log('\nParsed tasks:', JSON.stringify(tasks, null, 2));
}