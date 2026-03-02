import { OpenClawConfigParser } from './packages/core/src/openclaw-config-parser.ts';
import { readFileSync } from 'fs';

console.log('Testing parser with debug...\n');

const content = readFileSync('test-heartbeat-issue.md', 'utf-8');
console.log('Content length:', content.length);
console.log('First 200 chars:', content.substring(0, 200));
console.log('\n=== Looking for Heartbeat section ===');

// Manually check for the section
const lines = content.split('\n');
let inHeartbeatSection = false;
let heartbeatLines: string[] = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.trim() === '## Heartbeat Tasks') {
    inHeartbeatSection = true;
    console.log(`Found header at line ${i}: "${line}"`);
    continue;
  }
  
  if (inHeartbeatSection) {
    if (line.trim().startsWith('## ')) {
      console.log(`End of section at line ${i}: "${line}"`);
      break;
    }
    if (line.trim()) {
      heartbeatLines.push(line);
    }
  }
}

console.log('\nHeartbeat section lines:', heartbeatLines);

// Now parse with the actual parser
console.log('\n=== Parsing with OpenClawConfigParser ===');
const parser = new OpenClawConfigParser();
const result = parser.parse(content);

console.log('\nParsed result:');
console.log('Name:', result.name);
console.log('Heartbeat Tasks count:', result.defaultHeartbeatTasks.length);
console.log('Heartbeat Tasks:', JSON.stringify(result.defaultHeartbeatTasks, null, 2));