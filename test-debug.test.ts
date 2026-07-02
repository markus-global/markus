import { describe, it, expect } from 'vitest';
import { openSqlite, closeSqlite, SqliteChatSessionRepo } from '../src/sqlite-storage.js';

describe('FTS5 delete debug', () => {
  it('deleteLastAssistantMessage with FTS5 active', () => {
    const db = openSqlite(':memory:');
    const repo = new SqliteChatSessionRepo(db);
    const session = repo.createSession('agent-1', 'user-1');
    repo.appendMessage(session.id, 'agent-1', 'user', 'Hello world');
    repo.appendMessage(session.id, 'agent-1', 'assistant', 'Hi there');
    expect(repo.getMessageCount(session.id)).toBe(2);
    const deleted = repo.deleteLastAssistantMessage(session.id);
    expect(deleted?.content).toBe('Hi there');
    expect(repo.getMessageCount(session.id)).toBe(1);
  });
});
