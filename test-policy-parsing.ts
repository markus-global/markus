import { OpenClawConfigParser } from './packages/core/src/openclaw-config-parser';

const testMarkdown = `# Test Agent

## Identity
- Name: TestAgent
- Role: Tester
- Skills: Testing, Debugging, Documentation

## Memory Configuration
- short-term: 1000 tokens
- medium-term: 5000 tokens
- long-term: 10000 tokens
- knowledge-base: true
- context-window: 8000

## Heartbeat Tasks
- Check tasks: Check tasks
- Report status: Report current status

## Policies
- Code Safety: Never commit secrets, API keys, or credentials to version control
- Communication: Report blockers within 30 minutes of encountering them
- Resource Limits: Do not install packages without checking license compatibility

## Knowledge Base References
- Project documentation
- API specifications
- User guides`;

console.log('Testing OpenClawConfigParser policy parsing...\n');

const parser = new OpenClawConfigParser();
const result = parser.parse(testMarkdown);

console.log('=== Parsed Result ===');
console.log(`Name: ${result.name}`);
console.log(`Default Policies: ${JSON.stringify(result.defaultPolicies, null, 2)}`);

// Check if policies were parsed correctly
console.log('\n=== Policy Validation ===');
if (result.defaultPolicies.length === 3) {
  console.log('✓ Correct number of policies parsed: 3');
  
  const policyNames = result.defaultPolicies.map(p => p.name);
  const expectedNames = ['Code Safety', 'Communication', 'Resource Limits'];
  
  const allPresent = expectedNames.every(name => policyNames.includes(name));
  if (allPresent) {
    console.log('✓ All expected policy names found');
  } else {
    console.log('✗ Missing some policy names');
    console.log(`  Expected: ${expectedNames.join(', ')}`);
    console.log(`  Found: ${policyNames.join(', ')}`);
  }
  
  // Check policy descriptions
  const codeSafetyPolicy = result.defaultPolicies.find(p => p.name === 'Code Safety');
  if (codeSafetyPolicy && codeSafetyPolicy.description.includes('Never commit secrets')) {
    console.log('✓ Code Safety policy description correct');
  } else {
    console.log('✗ Code Safety policy description incorrect');
  }
} else {
  console.log(`✗ Expected 3 policies, got ${result.defaultPolicies.length}`);
}