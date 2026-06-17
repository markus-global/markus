import { describe, it, expect } from 'vitest';
import { generateId, agentId, taskId, orgId, envId, msgId, requirementId, userId } from '../src/utils/id.js';

describe('generateId', () => {
  it('returns 24-char hex without prefix', () => {
    const id = generateId();
    expect(id).toMatch(/^[0-9a-f]{24}$/);
  });

  it('returns prefixed ID', () => {
    const id = generateId('test');
    expect(id).toMatch(/^test_[0-9a-f]{24}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

describe('typed ID generators', () => {
  const cases: [string, () => string, string][] = [
    ['agentId', agentId, 'agt'],
    ['taskId', taskId, 'tsk'],
    ['orgId', orgId, 'org'],
    ['envId', envId, 'env'],
    ['msgId', msgId, 'msg'],
    ['requirementId', requirementId, 'req'],
    ['userId', userId, 'usr'],
  ];

  for (const [name, fn, prefix] of cases) {
    it(`${name} returns ID with prefix "${prefix}"`, () => {
      const id = fn();
      expect(id).toMatch(new RegExp(`^${prefix}_[0-9a-f]{24}$`));
    });
  }
});
