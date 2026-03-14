import { describe, it, expect } from 'vitest';
import { OpenClawConfigParser } from '../src/openclaw-config-parser';

describe('OpenClawConfigParser', () => {
  const parser = new OpenClawConfigParser();

  describe('parse', () => {
    it('should parse a complete OpenClaw configuration', () => {
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

      expect(result.name).toBe('Test Agent');
      expect(result.category).toBe('engineering');
      expect(result.defaultSkills).toContain('shell_execute');
      expect(result.defaultSkills).toContain('file_read_write');
      expect(result.defaultSkills).toContain('git_operations');
      expect(result.heartbeatChecklist).toContain('Check tasks');
      expect(result.defaultPolicies).toHaveLength(2);
      expect(result.systemPrompt).toContain('# Test Agent');
      expect(result.systemPrompt).toContain('## Identity');
      expect(result.systemPrompt).toContain('## Core Competencies');
      expect(result.systemPrompt).toContain('## Memory Configuration');
      expect(result.systemPrompt).toContain('## Knowledge Base References');
      expect(result.builtIn).toBe(false);
    });

    it('should handle minimal configuration', () => {
      const markdown = `# Minimal Agent

## Identity
- Name: MinAgent
- Role: Assistant`;

      const result = parser.parse(markdown);

      expect(result.name).toBe('Minimal Agent');
      expect(result.defaultSkills).toEqual([]);
      expect(result.heartbeatChecklist).toBe('');
      expect(result.defaultPolicies).toEqual([]);
      expect(result.systemPrompt).toContain('# Minimal Agent');
      expect(result.systemPrompt).toContain('## Identity');
    });

    it('should throw error for invalid input', () => {
      expect(() => parser.parse('')).toThrow();
      expect(() => parser.parse('not a markdown')).toThrow();
    });

    it('should extract skills from Identity section', () => {
      const markdown = `# Test Agent

## Identity
- Name: TestAgent
- Role: Tester
- Skills: Testing, Debugging, Documentation

## Heartbeat Tasks
- Test: Run tests`;

      const result = parser.parse(markdown);

      expect(result.defaultSkills).toContain('test_runner'); // Testing maps to test_runner
      expect(result.defaultSkills).toContain('debugging');
      expect(result.defaultSkills).toContain('documentation');
    });

    it('should extract skills from Capabilities section', () => {
      const markdown = `# Test Agent

## Identity
- Name: TestAgent
- Role: Tester

## Capabilities
- shell_execute
- web_search
- code_review`;

      const result = parser.parse(markdown);

      expect(result.defaultSkills).toContain('shell_execute');
      expect(result.defaultSkills).toContain('web_search');
      expect(result.defaultSkills).toContain('code_review');
    });

    it('should handle policies with colon format', () => {
      const markdown = `# Test Agent

## Identity
- Name: TestAgent

## Policies
- Security: Never share credentials
- Communication: Report issues`;

      const result = parser.parse(markdown);

      expect(result.defaultPolicies).toHaveLength(2);
      expect(result.defaultPolicies[0].name).toBe('Security');
      expect(result.defaultPolicies[0].description).toBe('Never share credentials');
      expect(result.defaultPolicies[1].name).toBe('Communication');
      expect(result.defaultPolicies[1].description).toBe('Report issues');
    });

    it('should infer category from role', () => {
      const testCases = [
        { role: 'Software Developer', expected: 'engineering' },
        { role: 'Product Manager', expected: 'product' },
        { role: 'Designer', expected: 'engineering' },
        { role: 'QA Engineer', expected: 'engineering' },
        { role: 'DevOps Engineer', expected: 'engineering' },
        { role: 'Unknown Role', expected: 'custom' },
      ];

      testCases.forEach(({ role, expected }) => {
        const markdown = `# Test Agent

## Identity
- Name: TestAgent
- Role: ${role}`;

        const result = parser.parse(markdown);
        expect(result.category).toBe(expected);
      });
    });
  });

  describe('extractTitle', () => {
    it('should extract title from first # heading', () => {
      const markdown = `# My Agent Title

Some content`;
      // @ts-expect-error - accessing private method for testing
      const title = parser.extractTitle(markdown);
      expect(title).toBe('My Agent Title');
    });

    it('should return empty string if no title', () => {
      const markdown = `No title here`;
      // @ts-expect-error - accessing private method for testing
      const title = parser.extractTitle(markdown);
      expect(title).toBe('');
    });
  });

  describe('parseCapabilities', () => {
    it('should extract capabilities from multiple sections', () => {
      const markdown = `# Test Agent

## Identity
- Name: TestAgent
- Skills: Testing, Debugging

## Capabilities
- shell_execute
- web_search

## Tools
- git_operations`;

      // @ts-expect-error - accessing private method for testing
      const capabilities = parser.parseCapabilities(markdown);
      
      expect(capabilities).toContain('Testing');
      expect(capabilities).toContain('Debugging');
      expect(capabilities).toContain('shell_execute');
      expect(capabilities).toContain('web_search');
      expect(capabilities).toContain('git_operations');
    });
  });

  describe('parseHeartbeatChecklist', () => {
    it('should return raw checklist text from heartbeat section', () => {
      const markdown = `# Test Agent

## Heartbeat Tasks
- Task 1: Description of task 1
- Task 2: Description of task 2`;

      // @ts-expect-error - accessing private method for testing
      const checklist = parser.parseHeartbeatChecklist(markdown);

      expect(checklist).toContain('Task 1');
      expect(checklist).toContain('Task 2');
    });

    it('should return empty string when no heartbeat section', () => {
      const markdown = `# Test Agent

## Identity
- Name: TestAgent`;

      // @ts-expect-error - accessing private method for testing
      const checklist = parser.parseHeartbeatChecklist(markdown);

      expect(checklist).toBe('');
    });
  });

  describe('parsePolicies', () => {
    it('should parse policies with colon format', () => {
      const markdown = `# Test Agent

## Policies
- Policy 1: Description 1
- Policy 2: Description 2`;

      // @ts-expect-error - accessing private method for testing
      const policies = parser.parsePolicies(markdown);
      
      expect(policies).toHaveLength(2);
      expect(policies[0].name).toBe('Policy 1');
      expect(policies[0].description).toBe('Description 1');
      expect(policies[0].rules).toEqual([]);
      expect(policies[1].name).toBe('Policy 2');
      expect(policies[1].description).toBe('Description 2');
    });

    it('should handle policies without descriptions', () => {
      const markdown = `# Test Agent

## Policies
- Policy 1
- Policy 2: With description`;

      // @ts-expect-error - accessing private method for testing
      const policies = parser.parsePolicies(markdown);
      
      expect(policies).toHaveLength(2);
      expect(policies[0].name).toBe('Policy 1');
      expect(policies[0].description).toBe('Policy 1'); // Falls back to name
      expect(policies[1].name).toBe('Policy 2');
      expect(policies[1].description).toBe('With description');
    });
  });

  describe('extractSkills', () => {
    it('should map OpenClaw capabilities to Markus skills', () => {
      const capabilities = ['shell_execute', 'web_search', 'team_management', 'testing'];
      
      // @ts-expect-error - accessing private method for testing
      const skills = parser.extractSkills(capabilities);
      
      expect(skills).toContain('shell_execute');
      expect(skills).toContain('web_search');
      expect(skills).toContain('team-management'); // Mapped
      expect(skills).toContain('test_runner'); // testing maps to test_runner
    });

    it('should handle unknown capabilities', () => {
      const capabilities = ['unknown_capability', 'another_skill'];
      
      // @ts-expect-error - accessing private method for testing
      const skills = parser.extractSkills(capabilities);
      
      expect(skills).toContain('unknown_capability');
      expect(skills).toContain('another_skill');
    });
  });

  describe('buildSystemPrompt', () => {
    it('should build system prompt without duplicates', () => {
      const originalMd = `# Test Agent

## Identity
- Name: TestAgent

## Memory Configuration
- short-term: 1000

## Heartbeat Tasks
- Task 1: Description`;

      const capabilities = ['shell_execute'];
      const memoryConfig = { 'short-term-tokens': 1000 };
      const heartbeatTasks = [{ name: 'Task 1', description: 'Description', enabled: true }];
      const knowledgeBase = ['Docs'];

      // @ts-expect-error - accessing private method for testing
      const prompt = parser.buildSystemPrompt(originalMd, capabilities, memoryConfig, heartbeatTasks, knowledgeBase);
      
      // Should not have duplicate sections
      const memorySectionCount = (prompt.match(/## Memory Configuration/g) || []).length;
      const heartbeatSectionCount = (prompt.match(/## Heartbeat Tasks/g) || []).length;
      
      expect(memorySectionCount).toBe(1);
      expect(heartbeatSectionCount).toBe(1);
      expect(prompt).toContain('## Core Competencies');
      expect(prompt).toContain('## Knowledge Base References');
    });
  });
});