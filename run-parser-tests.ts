import { OpenClawConfigParser } from './packages/core/src/openclaw-config-parser';

console.log('Running OpenClawConfigParser tests...\n');

const parser = new OpenClawConfigParser();
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
    failed++;
  }
}

// Test 1: Parse complete configuration
test('should parse a complete OpenClaw configuration', () => {
  const markdown = `# Test Agent

## Identity
- Name: TestAgent
- Role: Software Developer
- Skills: shell_execute, file_read_write, git_operations

## Core Competencies
- Full-stack development
- Code review
- Debugging

## Memory Configuration
- short-term: 1000 tokens
- medium-term: 5000 tokens
- long-term: 10000 tokens

## Heartbeat Tasks
- Check tasks: Review task board every hour
- Report status: Send daily status report

## Policies
- Code Safety: Never commit secrets to version control
- Communication: Report blockers promptly

## Knowledge Base
- Project documentation
- API specifications`;

  const result = parser.parse(markdown);

  if (result.name !== 'Test Agent') throw new Error(`Expected name "Test Agent", got "${result.name}"`);
  if (result.category !== 'engineering') throw new Error(`Expected category "engineering", got "${result.category}"`);
  if (!result.defaultSkills.includes('shell_execute')) throw new Error('Missing shell_execute skill');
  if (!result.defaultSkills.includes('file_read_write')) throw new Error('Missing file_read_write skill');
  if (!result.defaultSkills.includes('git_operations')) throw new Error('Missing git_operations skill');
  if (result.defaultHeartbeatTasks.length !== 2) throw new Error(`Expected 2 heartbeat tasks, got ${result.defaultHeartbeatTasks.length}`);
  if (result.defaultPolicies.length !== 2) throw new Error(`Expected 2 policies, got ${result.defaultPolicies.length}`);
  if (!result.systemPrompt.includes('# Test Agent')) throw new Error('System prompt missing title');
  if (!result.systemPrompt.includes('## Identity')) throw new Error('System prompt missing Identity section');
  if (!result.systemPrompt.includes('## Core Competencies')) throw new Error('System prompt missing Core Competencies section');
  if (!result.systemPrompt.includes('## Memory Configuration')) throw new Error('System prompt missing Memory Configuration section');
  if (!result.systemPrompt.includes('## Heartbeat Tasks')) throw new Error('System prompt missing Heartbeat Tasks section');
  if (!result.systemPrompt.includes('## Knowledge Base References')) throw new Error('System prompt missing Knowledge Base References section');
  if (result.builtIn !== false) throw new Error(`Expected builtIn=false, got ${result.builtIn}`);
});

// Test 2: Handle minimal configuration
test('should handle minimal configuration', () => {
  const markdown = `# Minimal Agent

## Identity
- Name: MinAgent
- Role: Assistant`;

  const result = parser.parse(markdown);

  if (result.name !== 'Minimal Agent') throw new Error(`Expected name "Minimal Agent", got "${result.name}"`);
  if (result.defaultSkills.length !== 0) throw new Error(`Expected 0 skills, got ${result.defaultSkills.length}`);
  if (result.defaultHeartbeatTasks.length !== 0) throw new Error(`Expected 0 heartbeat tasks, got ${result.defaultHeartbeatTasks.length}`);
  if (result.defaultPolicies.length !== 0) throw new Error(`Expected 0 policies, got ${result.defaultPolicies.length}`);
  if (!result.systemPrompt.includes('# Minimal Agent')) throw new Error('System prompt missing title');
  if (!result.systemPrompt.includes('## Identity')) throw new Error('System prompt missing Identity section');
});

// Test 3: Extract skills from Identity section
test('should extract skills from Identity section', () => {
  const markdown = `# Test Agent

## Identity
- Name: TestAgent
- Role: Tester
- Skills: Testing, Debugging, Documentation

## Heartbeat Tasks
- Test: Run tests`;

  const result = parser.parse(markdown);

  if (!result.defaultSkills.includes('test_runner')) throw new Error('Missing test_runner skill (Testing should map to test_runner)');
  if (!result.defaultSkills.includes('debugging')) throw new Error('Missing debugging skill');
  if (!result.defaultSkills.includes('documentation')) throw new Error('Missing documentation skill');
});

// Test 4: Extract skills from Capabilities section
test('should extract skills from Capabilities section', () => {
  const markdown = `# Test Agent

## Identity
- Name: TestAgent
- Role: Tester

## Capabilities
- shell_execute
- web_search
- code_review`;

  const result = parser.parse(markdown);

  if (!result.defaultSkills.includes('shell_execute')) throw new Error('Missing shell_execute skill');
  if (!result.defaultSkills.includes('web_search')) throw new Error('Missing web_search skill');
  if (!result.defaultSkills.includes('code_review')) throw new Error('Missing code_review skill');
});

// Test 5: Handle policies with colon format
test('should handle policies with colon format', () => {
  const markdown = `# Test Agent

## Identity
- Name: TestAgent

## Policies
- Security: Never share credentials
- Communication: Report issues`;

  const result = parser.parse(markdown);

  if (result.defaultPolicies.length !== 2) throw new Error(`Expected 2 policies, got ${result.defaultPolicies.length}`);
  if (result.defaultPolicies[0].name !== 'Security') throw new Error(`Expected policy name "Security", got "${result.defaultPolicies[0].name}"`);
  if (result.defaultPolicies[0].description !== 'Never share credentials') throw new Error(`Expected policy description "Never share credentials", got "${result.defaultPolicies[0].description}"`);
  if (result.defaultPolicies[1].name !== 'Communication') throw new Error(`Expected policy name "Communication", got "${result.defaultPolicies[1].name}"`);
  if (result.defaultPolicies[1].description !== 'Report issues') throw new Error(`Expected policy description "Report issues", got "${result.defaultPolicies[1].description}"`);
});

// Test 6: Infer category from role
test('should infer category from role', () => {
  const testCases = [
    { role: 'Software Developer', expected: 'engineering' },
    { role: 'Product Manager', expected: 'product' },
    { role: 'Designer', expected: 'custom' }, // 'design' is not a valid RoleCategory
    { role: 'QA Engineer', expected: 'engineering' },
    { role: 'DevOps Engineer', expected: 'engineering' },
    { role: 'Unknown Role', expected: 'custom' }, // 'general' is not a valid RoleCategory
  ];

  testCases.forEach(({ role, expected }) => {
    const markdown = `# Test Agent

## Identity
- Name: TestAgent
- Role: ${role}`;

    const result = parser.parse(markdown);
    if (result.category !== expected) {
      throw new Error(`For role "${role}", expected category "${expected}", got "${result.category}"`);
    }
  });
});

// Test 7: Error handling for invalid input
test('should throw error for invalid input', () => {
  try {
    parser.parse('');
    throw new Error('Should have thrown error for empty input');
  } catch (error) {
    // Expected
  }

  try {
    parser.parse('not a markdown');
    throw new Error('Should have thrown error for non-markdown input');
  } catch (error) {
    // Expected
  }
});

// Test 8: Parse heartbeat tasks with colon format
test('should parse heartbeat tasks with colon format', () => {
  const markdown = `# Test Agent

## Heartbeat Tasks
- Task 1: Description of task 1
- Task 2: Description of task 2`;

  const result = parser.parse(markdown);
  
  if (result.defaultHeartbeatTasks.length !== 2) throw new Error(`Expected 2 heartbeat tasks, got ${result.defaultHeartbeatTasks.length}`);
  if (result.defaultHeartbeatTasks[0].name !== 'Task 1') throw new Error(`Expected task name "Task 1", got "${result.defaultHeartbeatTasks[0].name}"`);
  if (result.defaultHeartbeatTasks[0].description !== 'Description of task 1') throw new Error(`Expected task description "Description of task 1", got "${result.defaultHeartbeatTasks[0].description}"`);
  if (result.defaultHeartbeatTasks[1].name !== 'Task 2') throw new Error(`Expected task name "Task 2", got "${result.defaultHeartbeatTasks[1].name}"`);
  if (result.defaultHeartbeatTasks[1].description !== 'Description of task 2') throw new Error(`Expected task description "Description of task 2", got "${result.defaultHeartbeatTasks[1].description}"`);
});

// Test 9: Handle tasks without descriptions
test('should handle tasks without descriptions', () => {
  const markdown = `# Test Agent

## Heartbeat Tasks
- Task 1
- Task 2: With description`;

  const result = parser.parse(markdown);
  
  if (result.defaultHeartbeatTasks.length !== 2) throw new Error(`Expected 2 heartbeat tasks, got ${result.defaultHeartbeatTasks.length}`);
  if (result.defaultHeartbeatTasks[0].name !== 'Task 1') throw new Error(`Expected task name "Task 1", got "${result.defaultHeartbeatTasks[0].name}"`);
  if (result.defaultHeartbeatTasks[0].description !== 'Task 1') throw new Error(`Expected task description "Task 1", got "${result.defaultHeartbeatTasks[0].description}"`);
  if (result.defaultHeartbeatTasks[1].name !== 'Task 2') throw new Error(`Expected task name "Task 2", got "${result.defaultHeartbeatTasks[1].name}"`);
  if (result.defaultHeartbeatTasks[1].description !== 'With description') throw new Error(`Expected task description "With description", got "${result.defaultHeartbeatTasks[1].description}"`);
});

// Test 10: Handle policies without descriptions
test('should handle policies without descriptions', () => {
  const markdown = `# Test Agent

## Policies
- Policy 1
- Policy 2: With description`;

  const result = parser.parse(markdown);
  
  if (result.defaultPolicies.length !== 2) throw new Error(`Expected 2 policies, got ${result.defaultPolicies.length}`);
  if (result.defaultPolicies[0].name !== 'Policy 1') throw new Error(`Expected policy name "Policy 1", got "${result.defaultPolicies[0].name}"`);
  if (result.defaultPolicies[0].description !== 'Policy 1') throw new Error(`Expected policy description "Policy 1", got "${result.defaultPolicies[0].description}"`);
  if (result.defaultPolicies[1].name !== 'Policy 2') throw new Error(`Expected policy name "Policy 2", got "${result.defaultPolicies[1].name}"`);
  if (result.defaultPolicies[1].description !== 'With description') throw new Error(`Expected policy description "With description", got "${result.defaultPolicies[1].description}"`);
});

// Test 11: Build system prompt without duplicates
test('should build system prompt without duplicates', () => {
  const originalMd = `# Test Agent

## Identity
- Name: TestAgent

## Capabilities
- shell_execute
- web_search

## Memory Configuration
- short-term: 1000

## Heartbeat Tasks
- Task 1: Description`;

  const result = parser.parse(originalMd);
  
  const prompt = result.systemPrompt;
  
  // Count sections
  const memorySectionCount = (prompt.match(/## Memory Configuration/g) || []).length;
  const heartbeatSectionCount = (prompt.match(/## Heartbeat Tasks/g) || []).length;
  const coreCompetenciesCount = (prompt.match(/## Core Competencies/g) || []).length;
  const knowledgeBaseCount = (prompt.match(/## Knowledge Base References/g) || []).length;
  
  if (memorySectionCount !== 1) throw new Error(`Expected 1 Memory Configuration section, got ${memorySectionCount}`);
  if (heartbeatSectionCount !== 1) throw new Error(`Expected 1 Heartbeat Tasks section, got ${heartbeatSectionCount}`);
  if (coreCompetenciesCount !== 1) throw new Error(`Expected 1 Core Competencies section, got ${coreCompetenciesCount}`);
  // Knowledge Base References section is only added if there are knowledge base items
  // if (knowledgeBaseCount !== 1) throw new Error(`Expected 1 Knowledge Base References section, got ${knowledgeBaseCount}`);
});

console.log(`\nTest Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}