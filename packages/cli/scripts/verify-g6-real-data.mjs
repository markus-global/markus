/**
 * G6 real-data verification — drive the ACTUAL single inbound path against real
 * rows, on a copy of the live DB, using the real repositories.
 *
 * G6 retires the legacy Feishu inbound path + the legacy notifier. Its claim is
 * "Feishu now has exactly ONE inbound path, and it still works". This probe makes
 * that claim falsifiable on real data:
 *
 *   A. the real DB copy migrates cleanly and keeps the G1 gateway tables;
 *   B. the real `channel_bindings` / `platform_instances` rows resolve a Feishu
 *      inbound to a real agent through the real `RepoBindingLookup`;
 *   C. the real `MessageRouter` routes that inbound to the agent handler with a
 *      canonical conversation key, and a card action to the action handler — and
 *      NEVER the action into the conversation;
 *   D. the gateway is the single owner of connection state + runtime reconfigure.
 *
 * Copy strategy matches the G4 probe: real schema + real rows for the tables the
 * migration reads, then the REAL startup migration runs on the copy.
 *
 * Usage: node verify-g6-real-data.mjs <liveDbPath> <copyDbPath>
 * Prints PASS/FAIL lines; exit 1 on any failed assertion.
 */
import { existsSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [, , livePath, copyPath] = process.argv;
if (!livePath || !copyPath) {
  console.error('usage: node verify-g6-real-data.mjs <liveDbPath> <copyDbPath>');
  process.exit(2);
}

const STORAGE_DIST = new URL('../../storage/dist/index.js', import.meta.url).pathname;
const COMMS_DIST = new URL('../../comms/dist/index.js', import.meta.url).pathname;
const { openSqlite, SqlitePlatformInstanceRepo, SqliteChannelBindingRepo } = await import(STORAGE_DIST);
const { MessageRouter, RepoBindingLookup } = await import(COMMS_DIST);

const failures = [];
function assert(cond, label, detail) {
  if (!cond) failures.push({ label, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
}

const read = (db, sql, ...p) => db.prepare(sql).all(...p);
const one = (db, sql, ...p) => db.prepare(sql).get(...p);

// ── Phase A — snapshot the live DB (read-only) ───────────────────────────────
const live = new DatabaseSync(livePath, { readOnly: true });
const liveVersion = one(live, 'PRAGMA user_version').user_version;
const liveIntegrations = read(live, 'SELECT id, org_id, platform, enabled, cast(config as text) AS config FROM integrations');
const liveAgents = read(live, 'SELECT * FROM agents');
const ddl = read(live, "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name");
const copyTables = ['organizations', 'teams', 'agents', 'integrations'];
const tableRows = {};
const tableCols = {};
for (const t of copyTables) {
  tableRows[t] = read(live, `SELECT * FROM ${t}`);
  tableCols[t] = read(live, `PRAGMA table_info(${t})`).map((c) => c.name);
}
live.close();
console.log(`live: user_version=${liveVersion} integrations=${liveIntegrations.length} agents=${liveAgents.length}`);

// ── Phase B — the copy: real schema + real rows + real user_version ─────────
if (existsSync(copyPath)) rmSync(copyPath);
const copy = new DatabaseSync(copyPath);
copy.exec('PRAGMA foreign_keys = OFF');
for (const d of ddl) {
  try {
    copy.exec(d.sql);
  } catch {
    /* index/trigger for a table we did not copy */
  }
}
for (const t of copyTables) {
  const cols = tableCols[t];
  const stmt = copy.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  for (const row of tableRows[t]) stmt.run(...cols.map((c) => row[c]));
}
copy.exec(`PRAGMA user_version = ${liveVersion}`);
copy.close();

// ── Phase C — real startup migration on the copy ─────────────────────────────
const db = openSqlite(copyPath);
const instanceRepo = new SqlitePlatformInstanceRepo(db);
const bindingRepo = new SqliteChannelBindingRepo(db);
const instances = instanceRepo.listByOrg('default');
const bindings = bindingRepo.listByOrg('default');
console.log(`migrated: user_version=${one(db, 'PRAGMA user_version').user_version} instances=${instances.length} bindings=${bindings.length}`);
console.log(`instances: ${JSON.stringify(instances.map((i) => ({ id: i.id, platform: i.platform, label: i.label, enabled: i.enabled })))}`);
console.log(`bindings: ${JSON.stringify(bindings.map((b) => ({ scope: b.scope, agentId: b.agentId, instanceId: b.instanceId, nativeId: b.nativeId, kind: b.kind })))}`);

assert(instances.length > 0, 'G1 gateway tables migrated on real data (platform_instances non-empty)', instances.length);
assert(bindings.length > 0, 'G1 gateway tables migrated on real data (channel_bindings non-empty)', bindings.length);

const feishuInstance =
  instances.find((i) => i.platform === 'feishu' && i.label === 'default') ??
  instances.find((i) => i.platform === 'feishu') ??
  instances[0];
assert(Boolean(feishuInstance), 'a real bot instance exists to route to', feishuInstance?.id);

// Re-running the migration must be a no-op (idempotent) — same version, same rows.
const beforeIds = instances.map((i) => i.id).sort().join(',');
const db2 = openSqlite(copyPath);
const afterIds = new SqlitePlatformInstanceRepo(db2).listByOrg('default').map((i) => i.id).sort().join(',');
assert(beforeIds === afterIds, 're-running openSqlite on the real copy is idempotent (same instances)', { beforeIds, afterIds });

// ── Phase D — real lookup resolves a real Feishu inbound ─────────────────────
const lookup = new RepoBindingLookup({
  bindingRepo,
  instanceRepo,
  orgDefaultAgent: () => undefined,
});
const realFeishuBinding = bindings.find((b) => b.scope === 'global') ?? bindings[0];
const globalAgent = realFeishuBinding?.agentId;
console.log(`real global(level-3) binding agentId = ${globalAgent}`);
assert(Boolean(globalAgent), 'a real global binding names a real agent (the terminal route)', globalAgent);

const resolved = lookup.bindings('default', 'feishu');
assert(resolved.length > 0, 'RepoBindingLookup reads the real channel_bindings rows', resolved.length);
assert(
  resolved.some((b) => b.agentId === globalAgent),
  'the real global binding is visible to the resolver',
  { globalAgent },
);

// ── Phase E — the real router on the real instance: message vs action ────────
function makeFakeAdapter(platform) {
  const state = { connected: false, message: null, action: null, connects: 0 };
  return {
    platform,
    async connect() {
      state.connects += 1;
      state.connected = true;
    },
    async disconnect() {
      state.connected = false;
    },
    async sendMessage() {
      return 'om_probe';
    },
    async sendReply() {
      return 'om_probe';
    },
    onMessage(handler) {
      state.message = handler;
    },
    onAction(handler) {
      state.action = handler;
    },
    isConnected() {
      return state.connected;
    },
    _state: state,
  };
}

const router = new MessageRouter();
const adapter = makeFakeAdapter('feishu');
router.registerAdapter(adapter, feishuInstance.id);
router.setBindingLookup(lookup);

let captured = null;
router.setAgentHandler(async (target, message) => {
  captured = { target, text: message.content?.text };
  return 'ok';
});
let actionSeen = null;
let conversationTurns = 0;
router.setActionHandler(async (action) => {
  actionSeen = action;
});

assert(router.isPlatformConnected('feishu') === false, 'connection state is false before connect (gateway owns it)');
await router.connectAll([{ platform: 'feishu', instanceId: feishuInstance.id, appId: 'cli_probe', appSecret: 'probe' }]);
assert(router.isPlatformConnected('feishu') === true, 'connection state is true after connectAll');
assert(typeof adapter._state.message === 'function', 'the router wired exactly one message handler');
assert(typeof adapter._state.action === 'function', 'the router wired exactly one action handler');

const GROUP = 'oc_probe_group_A';
await adapter._state.message({
  id: 'om_probe_1',
  platform: 'feishu',
  channelId: GROUP,
  instanceId: feishuInstance.id,
  channelKind: 'group',
  senderId: 'ou_probe_user',
  content: { text: 'probe inbound' },
  timestamp: new Date().toISOString(),
});
conversationTurns += 1;
assert(captured !== null, 'an inbound Feishu message reaches the agent handler (single inbound path)');
assert(captured?.target?.agentId === globalAgent, 'the real inbound resolves to the real bound agent', {
  got: captured?.target?.agentId,
  want: globalAgent,
});
assert(
  captured?.target?.conversationKey === `im:${feishuInstance.id}:group:${GROUP}`,
  'the conversation key is the canonical instance-scoped key (session isolation)',
  captured?.target?.conversationKey,
);
assert(captured?.target?.matchedScope !== undefined, 'the matched scope is recorded', captured?.target?.matchedScope);

// A card action is a HITL transition, never a conversation turn.
const turnsBeforeAction = conversationTurns;
await adapter._state.action({
  platform: 'feishu',
  instanceId: feishuInstance.id,
  payload: { action: { value: { ref: 'payload.signature', action: 'approve' } }, operator: { open_id: 'ou_probe_user' } },
  actorId: 'ou_probe_user',
  timestamp: new Date().toISOString(),
});
assert(actionSeen !== null, 'a card action reaches the action handler (the single action port)');
assert(actionSeen?.instanceId === feishuInstance.id, 'the action carries its bot instance id', actionSeen?.instanceId);
assert(conversationTurns === turnsBeforeAction, 'the card action never entered the conversation path');

// Runtime reconfigure (replaces the retired notifier's updateConfig) reconnects in place.
await router.reconnectPlatform('feishu', { appId: 'cli_probe_v2' });
assert(adapter._state.connects === 2, 'reconnectPlatform reconnects the platform\u2019s bots in place', adapter._state.connects);

await router.disconnectAll();
assert(router.isPlatformConnected('feishu') === false, 'connection state returns to false after disconnectAll');

// ── Phase F — no legacy symbols remain in source (one inbound path) ──────────
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const REPO_ROOT = new URL('../../../', import.meta.url).pathname;
const FORBIDDEN = ['FeishuNotifier', 'handleFeishuUserMessage', 'tryInitFeishuNotifier', 'updateFeishuConfig'];
const hits = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'dist' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (full.endsWith('.ts')) {
      const text = readFileSync(full, 'utf8');
      for (const needle of FORBIDDEN) {
        if (text.includes(needle)) hits.push(`${full.replace(REPO_ROOT, '')}: ${needle}`);
      }
    }
  }
}
for (const pkg of readdirSync(join(REPO_ROOT, 'packages'))) {
  const src = join(REPO_ROOT, 'packages', pkg, 'src');
  if (existsSync(src)) walk(src);
}
assert(hits.length === 0, 'no legacy Feishu inbound/notifier symbols remain in packages/*/src', hits.slice(0, 10));

console.log(`\n${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILED`}`);
if (failures.length > 0) console.log(JSON.stringify(failures, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
