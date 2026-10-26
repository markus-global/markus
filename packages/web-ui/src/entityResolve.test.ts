/**
 * Behaviour tests for shortened-id resolution.
 *
 * The bug these guard (production, 2026-10-26): chat prose quoted `tsk_42810f44`
 * (a readable prefix of a 24-hex id). The renderer turned it into a clickable
 * chip because it is shaped like an id, the click navigated, `api.tasks.get()`
 * 404'd, and the error was swallowed — the user landed on Work with nothing
 * open. A click that does nothing is indistinguishable from a broken app.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tasksList = vi.fn();
const requirementsList = vi.fn();
const projectsList = vi.fn();
const agentsList = vi.fn();
const teamsList = vi.fn();
const deliverablesSearch = vi.fn();

vi.mock('./api.ts', () => ({
  api: {
    tasks: { list: (...a: unknown[]) => tasksList(...a) },
    requirements: { list: (...a: unknown[]) => requirementsList(...a) },
    projects: { list: (...a: unknown[]) => projectsList(...a) },
    agents: { list: (...a: unknown[]) => agentsList(...a) },
    teams: { list: (...a: unknown[]) => teamsList(...a) },
    deliverables: { search: (...a: unknown[]) => deliverablesSearch(...a) },
  },
}));

const { resolveEntityId, isFullEntityId, __clearEntityResolveCache } = await import('./entityResolve.ts');

const FULL = 'tsk_42810f4429545ffb6fd55146';

beforeEach(() => {
  __clearEntityResolveCache();
  vi.clearAllMocks();
  tasksList.mockResolvedValue({ tasks: [{ id: FULL }] });
  requirementsList.mockResolvedValue({ requirements: [] });
  projectsList.mockResolvedValue({ projects: [] });
  agentsList.mockResolvedValue({ agents: [] });
  teamsList.mockResolvedValue({ teams: [] });
  deliverablesSearch.mockResolvedValue({ results: [] });
});

describe('isFullEntityId', () => {
  it('recognises a canonical 24-hex id', () => {
    expect(isFullEntityId(FULL)).toBe(true);
  });

  it('treats a quoted prefix as shortened', () => {
    expect(isFullEntityId('tsk_42810f44')).toBe(false);
  });

  it('rejects strings without a prefix separator', () => {
    expect(isFullEntityId('42810f4429545ffb6fd55146')).toBe(false);
  });
});

describe('resolveEntityId', () => {
  it('resolves a unique shortened task id to the full id', async () => {
    await expect(resolveEntityId('tsk_42810f44')).resolves.toBe(FULL);
  });

  it('returns a full id unchanged without touching the network', async () => {
    await expect(resolveEntityId(FULL)).resolves.toBe(FULL);
    expect(tasksList).not.toHaveBeenCalled();
  });

  it('refuses to guess when a prefix matches several entities', async () => {
    tasksList.mockResolvedValue({
      tasks: [{ id: `${FULL}` }, { id: 'tsk_42810f44deadbeefdeadbeef' }],
    });
    // Opening the wrong task is worse than opening none.
    await expect(resolveEntityId('tsk_42810f44')).resolves.toBeNull();
  });

  it('returns null when nothing matches the prefix', async () => {
    await expect(resolveEntityId('tsk_deadbeef')).resolves.toBeNull();
  });

  it('returns null for an unknown prefix instead of throwing', async () => {
    await expect(resolveEntityId('zzz_42810f44')).resolves.toBeNull();
  });

  it('caches the collection so repeated clicks are free', async () => {
    await resolveEntityId('tsk_42810f44');
    tasksList.mockResolvedValue({ tasks: [{ id: 'tsk_aaaaaaaaaaaaaaaaaaaaaaaa' }] });
    await resolveEntityId('tsk_42810f44');
    expect(tasksList).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed collection fetch as "no such entity"', async () => {
    tasksList.mockRejectedValueOnce(new Error('network down'));
    await expect(resolveEntityId('tsk_42810f44')).rejects.toThrow('network down');
    // Retry must hit the network again rather than trust a poisoned cache.
    tasksList.mockResolvedValue({ tasks: [{ id: FULL }] });
    await expect(resolveEntityId('tsk_42810f44')).resolves.toBe(FULL);
  });

  it('resolves across entity kinds', async () => {
    projectsList.mockResolvedValue({ projects: [{ id: 'proj_40f53109c140a789c5145a2c' }] });
    await expect(resolveEntityId('proj_40f53109')).resolves.toBe('proj_40f53109c140a789c5145a2c');
  });
});
