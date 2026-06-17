import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initStorage } from '../src/storage-bridge.js';

vi.mock('@markus/storage', () => ({
  openSqlite: vi.fn(() => ({})),
  SqliteOrgRepo: vi.fn(),
  SqliteTaskRepo: vi.fn(),
  SqliteTaskLogRepo: vi.fn(),
  SqliteAgentRepo: vi.fn(),
  SqliteTeamRepo: vi.fn(),
  SqliteMessageRepo: vi.fn(),
  SqliteChatSessionRepo: vi.fn(),
  SqliteChannelMessageRepo: vi.fn(),
  SqliteUserRepo: vi.fn(),
  SqliteTaskCommentRepo: vi.fn(),
  SqliteRequirementCommentRepo: vi.fn(),
  SqliteRequirementRepo: vi.fn(),
  SqliteProjectRepo: vi.fn(),
  SqliteExternalAgentRepo: vi.fn(),
  SqliteDeliverableRepo: vi.fn(),
  SqliteActivityRepo: vi.fn(),
  SqliteExecutionStreamRepo: vi.fn(),
  SqliteMailboxRepo: vi.fn(),
  SqliteDecisionRepo: vi.fn(),
  SqliteNotificationRepo: vi.fn(),
  SqliteApprovalRepo: vi.fn(),
  SqliteGroupChatRepo: vi.fn(),
  SqliteAuditRepo: vi.fn(),
  SqliteStatusTransitionRepo: vi.fn(),
  SqliteReadCursorRepo: vi.fn(),
  SqliteWorkflowRunRepo: vi.fn(),
  SqliteWorkflowScheduleRepo: vi.fn(),
  SqliteIntegrationRepo: vi.fn(),
}));

describe('initStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['DATABASE_URL'];
  });

  it('initializes sqlite storage with default path', async () => {
    const bridge = await initStorage();
    expect(bridge).not.toBeNull();
    expect(bridge?.orgRepo).toBeDefined();
    expect(bridge?.taskRepo).toBeDefined();
    expect(bridge?.integrationRepo).toBeDefined();
  });

  it('resolves sqlite: path with tilde', async () => {
    const bridge = await initStorage('sqlite:~/test-data.db');
    expect(bridge).not.toBeNull();
  });

  it('uses DATABASE_URL env when no arg', async () => {
    process.env['DATABASE_URL'] = 'sqlite:/tmp/markus-test.db';
    const bridge = await initStorage();
    expect(bridge).not.toBeNull();
  });

  it('returns null when sqlite init fails', async () => {
    const storage = await import('@markus/storage');
    vi.mocked(storage.openSqlite).mockImplementationOnce(() => { throw new Error('db fail'); });
    const bridge = await initStorage('sqlite:/bad/path.db');
    expect(bridge).toBeNull();
  });
});
