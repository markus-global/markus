import { openSqlite, closeSqlite, SqliteChatSessionRepo } from './packages/storage/src/sqlite-storage.js';

// Minimal test: open DB, insert messages, delete
const db = openSqlite(':memory:');
const repo = new SqliteChatSessionRepo(db);
const session = repo.createSession('agent-1', 'user-1');
repo.appendMessage(session.id, 'agent-1', 'user', 'Hello world');
repo.appendMessage(session.id, 'agent-1', 'assistant', 'Hi there');
console.log('Count:', repo.getMessageCount(session.id));
try {
  const deleted = repo.deleteLastAssistantMessage(session.id);
  console.log('Deleted:', JSON.stringify(deleted));
} catch(e: any) {
  console.error('ERROR:', e.message);
  console.error('Code:', (e as any).code);
}
console.log('After delete count:', repo.getMessageCount(session.id));

// Also check FTS5 tables exist
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='virtual_table'").all() as any[];
console.log('Virtual tables:', tables.map((t: any) => t.name));

const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger'").all() as any[];
for (const t of triggers) {
  console.log('Trigger:', t.name);
}
closeSqlite();
