import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  openSqlite,
  closeSqlite,
  SqliteOrgRepo,
  SqliteAgentRepo,
  SqliteChatSessionRepo,
  SqliteReadCursorRepo,
  SqliteChannelMessageRepo,
  SqliteTeamRepo,
} from '../src/sqlite-storage.js';

/**
 * Unread counts must be scoped to the conversations the requesting user owns.
 *
 * The bug these lock down: a read cursor can outlive an ownership change, and an
 * admin browsing somebody else's session creates a cursor for it. Because
 * `getSessionAgentMap()` maps EVERY session (no ownership filter), the client's
 * "session maps to an agent" check cannot catch this - it happily mapped a
 * foreign session and counted it. Measured on real data: one admin held 41
 * cursors for sessions owned by other users, surfacing 190 messages that were
 * never theirs.
 */

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-unread-scope-'));
  dbPath = join(tempDir, 'scope.db');
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

function seed(db: ReturnType<typeof openSqlite>) {
  const orgRepo = new SqliteOrgRepo(db);
  orgRepo.createOrg({ id: 'org-1', name: 'Test Org', ownerId: 'user-1', plan: 'pro', maxAgents: 20 });
  const agentRepo = new SqliteAgentRepo(db);
  agentRepo.create({
    id: 'agent-1',
    name: 'Worker',
    orgId: 'org-1',
    roleId: 'role-1',
    roleName: 'Developer',
    agentRole: 'worker',
    skills: ['code'],
    llmConfig: { model: 'gpt-4' },
    computeConfig: { cpu: 2 },
    heartbeatIntervalMs: 30000,
  });
}

describe('SqliteReadCursorRepo.getUnreadCounts scoping', () => {
  it('excluding another user session even when WE hold a cursor for it', () => {
    const db = openSqlite(dbPath);
    seed(db);
    const chatRepo = new SqliteChatSessionRepo(db);
    const cursorRepo = new SqliteReadCursorRepo(db);

    // user-2 owns the session...
    const theirs = chatRepo.createSession('agent-1', 'user-2');
    chatRepo.appendMessage(theirs.id, 'agent-1', 'assistant', 'not yours');

    // ...and has read it before, so a baseline cursor exists for them.
    cursorRepo.setReadCursor('user-2', `session:${theirs.id}`, '2000-01-01T00:00:00Z');
    // user-1 somehow ALSO has a cursor on it (the leak).
    cursorRepo.setReadCursor('user-1', `session:${theirs.id}`, '2000-01-01T00:00:00Z');

    // Counts are cursor-relative: a conversation with no cursor is not reported
    // at all. The point here is that the foreign session is dropped for user-1
    // while remaining visible to its actual owner.
    expect(cursorRepo.getUnreadCounts('user-1')).toEqual({});
    expect(cursorRepo.getUnreadCounts('user-2')[`session:${theirs.id}`]).toBe(1);
  });

  it('still counts the requesting user OWN sessions (no over-correction)', () => {
    const db = openSqlite(dbPath);
    seed(db);
    const chatRepo = new SqliteChatSessionRepo(db);
    const cursorRepo = new SqliteReadCursorRepo(db);

    const mine = chatRepo.createSession('agent-1', 'user-1');
    chatRepo.appendMessage(mine.id, 'agent-1', 'assistant', 'hello');
    chatRepo.appendMessage(mine.id, 'user-1', 'user', 'hi');

    cursorRepo.setReadCursor('user-1', `session:${mine.id}`, '2000-01-01T00:00:00Z');

    expect(cursorRepo.getUnreadCounts('user-1')[`session:${mine.id}`]).toBe(2);
  });

  it('ignores a cursor whose session no longer exists (dangling cursor)', () => {
    const db = openSqlite(dbPath);
    seed(db);
    const cursorRepo = new SqliteReadCursorRepo(db);

    cursorRepo.setReadCursor('user-1', 'session:cs_deleted_agent_session', '2000-01-01T00:00:00Z');

    expect(cursorRepo.getUnreadCounts('user-1')).toEqual({});
  });

  it('markAllRead only seeds cursors for the caller own sessions', () => {
    const db = openSqlite(dbPath);
    seed(db);
    const chatRepo = new SqliteChatSessionRepo(db);
    const cursorRepo = new SqliteReadCursorRepo(db);

    chatRepo.createSession('agent-1', 'user-1');
    chatRepo.createSession('agent-1', 'user-2');

    cursorRepo.markAllRead('user-1');

    const keys = cursorRepo.getReadCursors('user-1').map(c => c.conversationKey);
    expect(keys.length).toBe(1);
    // Exactly the caller's own session - none of user-2's.
    expect(cursorRepo.getUnreadCounts('user-1')).toEqual({});
  });
});

/**
 * Unread must also be scoped to conversations that still EXIST.
 *
 * Team channels are synthetic (`group:<teamId>` and, verified on the live DB,
 * have no group_chats row). Deleting a team removes every handle on the
 * conversation while leaving channel_messages and the read cursor behind, so the
 * cursor reported unread forever for a channel no client could render or open to
 * clear. The result was an aggregate that could never be driven to zero.
 *
 * Measured before this check: two deleted teams contributed 4 such messages, so
 * the mobile Team badge read 8 while only 4 unread were visible as dots.
 */
describe('SqliteReadCursorRepo.getUnreadCounts conversation reachability', () => {
  const appendChannel = (db: ReturnType<typeof openSqlite>, channel: string, text: string) =>
    new SqliteChannelMessageRepo(db).append({
      orgId: 'org-1',
      channel,
      senderId: 'agent-1',
      senderType: 'agent',
      senderName: 'Worker',
      text,
    });

  it('drops unread for a team channel whose team no longer exists', async () => {
    const db = openSqlite(dbPath);
    seed(db);
    const cursorRepo = new SqliteReadCursorRepo(db);

    const channel = 'group:team_deleted';
    await appendChannel(db, channel, 'orphaned message');
    cursorRepo.setReadCursor('user-1', `channel:${channel}`, '2000-01-01T00:00:00Z');

    expect(cursorRepo.getUnreadCounts('user-1')).toEqual({});
  });

  it('still counts unread for a team channel whose team exists (no over-correction)', async () => {
    const db = openSqlite(dbPath);
    seed(db);
    new SqliteTeamRepo(db).create({ id: 'team_live', orgId: 'org-1', name: 'Live' });
    const cursorRepo = new SqliteReadCursorRepo(db);

    const channel = 'group:team_live';
    await appendChannel(db, channel, 'hello');
    cursorRepo.setReadCursor('user-1', `channel:${channel}`, '2000-01-01T00:00:00Z');

    expect(cursorRepo.getUnreadCounts('user-1')[`channel:${channel}`]).toBe(1);
  });

  it('leaves channel types without a team handle alone', async () => {
    const db = openSqlite(dbPath);
    seed(db);
    const cursorRepo = new SqliteReadCursorRepo(db);

    // Custom group chats and agent DMs are not team channels; the team-existence
    // check must not touch them.
    const custom = 'group:custom:gc_1';
    const a2a = 'dm:a2a:agt_a:agt_b';
    await appendChannel(db, custom, 'x');
    await appendChannel(db, a2a, 'y');
    cursorRepo.setReadCursor('user-1', `channel:${custom}`, '2000-01-01T00:00:00Z');
    cursorRepo.setReadCursor('user-1', `channel:${a2a}`, '2000-01-01T00:00:00Z');

    const counts = cursorRepo.getUnreadCounts('user-1');
    expect(counts[`channel:${custom}`]).toBe(1);
    expect(counts[`channel:${a2a}`]).toBe(1);
  });
});
