import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoleLoader } from '../src/role-loader.js';

const TEST_DIR = join(tmpdir(), `markus-role-loader-test-${Date.now()}`);

function createRoleDir(name: string, files: Record<string, string>): string {
  const roleDir = join(TEST_DIR, name);
  mkdirSync(roleDir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(roleDir, file), content);
  }
  return roleDir;
}

describe('RoleLoader', () => {
  let loader: RoleLoader;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    loader = new RoleLoader([TEST_DIR]);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('lists available roles', () => {
    createRoleDir('developer', { 'ROLE.md': '# Developer\nA dev role.' });
    createRoleDir('no-role', { 'README.md': 'no role file' });

    const roles = loader.listAvailableRoles();
    expect(roles).toContain('developer');
    expect(roles).not.toContain('no-role');
  });

  it('resolves template dir by name', () => {
    createRoleDir('engineer', { 'ROLE.md': '# Engineer\nBuilds things.' });
    expect(loader.resolveTemplateDir('engineer')).toBe(join(TEST_DIR, 'engineer'));
  });

  it('resolves template dir by absolute path', () => {
    const roleDir = createRoleDir('direct', { 'ROLE.md': '# Direct\nDirect path.' });
    expect(loader.resolveTemplateDir(roleDir)).toBe(roleDir);
  });

  it('returns undefined for unknown role', () => {
    expect(loader.resolveTemplateDir('nonexistent')).toBeUndefined();
  });

  it('loads role with parsed title and description', () => {
    createRoleDir('product-manager', {
      'ROLE.md': '# Product Manager\nOwns the product roadmap and priorities.',
    });

    const role = loader.loadRole('product-manager');
    expect(role.name).toBe('Product Manager');
    expect(role.description).toBe('Owns the product roadmap and priorities.');
    expect(role.category).toBe('product');
    expect(role.builtIn).toBe(true);
    expect(role.id).toMatch(/^role_/);
  });

  it('infers engineering category from role name', () => {
    createRoleDir('software-developer', {
      'ROLE.md': '# Dev\nWrites code.',
    });
    expect(loader.loadRole('software-developer').category).toBe('engineering');
  });

  it('loads heartbeat and policies files', () => {
    createRoleDir('ops-manager', {
      'ROLE.md': '# Ops Manager\nRuns operations.',
      'HEARTBEAT.md': '- Check alerts\n- Review queue',
      'POLICIES.md': '## Security\n- No prod access\n- Escalate incidents',
    });

    const role = loader.loadRole('ops-manager');
    expect(role.heartbeatChecklist).toContain('Check alerts');
    expect(role.defaultPolicies).toHaveLength(1);
    expect(role.defaultPolicies[0].name).toBe('Security');
    expect(role.defaultPolicies[0].rules).toContain('No prod access');
  });

  it('appends SHARED.md to system prompt', () => {
    writeFileSync(join(TEST_DIR, 'SHARED.md'), 'Shared team instructions.');
    createRoleDir('custom-role', {
      'ROLE.md': '# Custom\nA custom role.',
    });

    const role = loader.loadRole('custom-role');
    expect(role.systemPrompt).toContain('A custom role.');
    expect(role.systemPrompt).toContain('Shared team instructions.');
  });

  it('throws when role not found', () => {
    expect(() => loader.loadRole('missing-role')).toThrow('Role not found: missing-role');
  });

  it('returns template dirs', () => {
    expect(loader.getTemplateDirs()).toEqual([TEST_DIR]);
  });
});
