import { OpenClawConfigParser } from './packages/core/src/openclaw-config-parser.ts';
import { readFileSync } from 'fs';

console.log('Testing heartbeat task parsing...');

const content = readFileSync('test-heartbeat-issue.md', 'utf-8');
const parser = new OpenClawConfigParser();
const result = parser.parse(content);

console.log('\n=== Parsed Result ===');
console.log('Name:', result.name);
console.log('Heartbeat Tasks:', JSON.stringify(result.defaultHeartbeatTasks, null, 2));
console.log('\n=== System Prompt ===');
console.log(result.systemPrompt);