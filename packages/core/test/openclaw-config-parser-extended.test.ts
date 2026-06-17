import { describe, it, expect } from 'vitest';
import { OpenClawConfigParser } from '../src/openclaw-config-parser';
import type { RoleTemplate } from '@markus/shared';

describe('OpenClawConfigParser format helpers', () => {
  const parser = new OpenClawConfigParser();

  const sampleRole: RoleTemplate = {
    id: 'role_sample',
    name: 'Sample Agent',
    description: 'Does sample work',
    category: 'engineering',
    systemPrompt: 'You are a sample agent.',
    defaultSkills: ['shell_execute', 'web_search'],
    heartbeatChecklist: '- Check inbox\n- Report status',
    defaultPolicies: [{ name: 'Safety', description: 'Be safe', rules: ['No secrets'] }],
    builtIn: false,
  };

  it('isOpenClawFormat detects OpenClaw headers and patterns', () => {
    expect(parser.isOpenClawFormat('# Identity & Role\nName: Bot')).toBe(true);
    expect(parser.isOpenClawFormat('# Agent\n## Memory Configuration\n- short-term: 100')).toBe(true);
    expect(parser.isOpenClawFormat('# Plain Agent\n## Identity\n- Name: X')).toBe(false);
  });

  it('toOpenClawFormat round-trips key role fields', () => {
    const md = parser.toOpenClawFormat(sampleRole);
    expect(md).toContain('# Identity & Role');
    expect(md).toContain('Sample Agent');
    expect(md).toContain('# Capabilities & Tools');
    expect(md).toContain('shell_execute');
    expect(md).toContain('# Memory Configuration');
    expect(md).toContain('# Heartbeat Checklist');
    expect(md).toContain('Check inbox');
    expect(md).toContain('# Communication Preferences');
    expect(md).toContain('# Knowledge Base');
  });

  it('toOpenClawFormat handles role without optional fields', () => {
    const minimal: RoleTemplate = {
      ...sampleRole,
      description: '',
      defaultSkills: [],
      heartbeatChecklist: '',
      defaultPolicies: [],
    };
    const md = parser.toOpenClawFormat(minimal);
    expect(md).toContain('No description provided');
    expect(md).toContain('No heartbeat checklist configured');
  });

  it('parseFullConfig preserves knowledge base entries', () => {
    const markdown = `# Edge Agent

## Identity
- Name: EdgeBot
- Role: QA Engineer

## Heartbeat Tasks
- nightly: Run regression suite

## Knowledge Base
- Data dictionary

## Capabilities
- shell_execute
- test_runner`;

    const { roleTemplate, openClawConfig } = parser.parseFullConfig(markdown);
    expect(roleTemplate.name).toBe('Edge Agent');
    expect(openClawConfig.knowledgeBase).toContain('Data dictionary');
    expect(roleTemplate.defaultSkills).toContain('shell_execute');
  });

  it('inferCategory maps finance and customer service roles', () => {
    const financeMd = `# Finance Agent\n## Identity\n- Name: Fin\n- Role: Finance Analyst`;
    const supportMd = `# Support Agent\n## Identity\n- Name: Help\n- Role: Customer Support`;
    expect(parser.parse(financeMd).category).toBe('finance');
    expect(parser.parse(supportMd).category).toBe('customer_service');
  });
});
