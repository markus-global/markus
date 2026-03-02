// Test the actual extractSection method
import { OpenClawConfigParser } from './packages/core/src/openclaw-config-parser.ts';
import { readFileSync } from 'fs';

console.log('Testing extractSection method...\n');

const content = readFileSync('test-heartbeat-issue.md', 'utf-8');

// Create a parser instance
const parser = new OpenClawConfigParser();

// Access private method via any type
const parserAny = parser as any;
const extractSection = parserAny.extractSection.bind(parserAny);

const sections = extractSection(content, ['## Heartbeat', '## Periodic Tasks', '## Scheduled Tasks', '## Heartbeat Tasks']);
console.log('Sections found:', sections);
console.log('Sections length:', sections?.length);
console.log('Sections === null?', sections === null);
console.log('Sections === undefined?', sections === undefined);
console.log('Sections type:', typeof sections);

if (sections) {
  console.log('\nLines in section:');
  const lines = sections.split('\n');
  lines.forEach((line: string, i: number) => {
    console.log(`${i}: "${line}"`);
  });
}