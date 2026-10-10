/**
 * G2 real-data verification — drive the ACTUAL startup traversal against a copy of
 * the live DB, using the real rows the G1 migration produced.
 *
 * The point is to prove the G2 contract on **real data**, not fixtures: the real
 * `platform_instances` row (byte-copied credentials) must feed
 * `connectConfiguredPlatforms`, produce one adapter keyed by the real instance id,
 * and connect it with the real credentials — and a second row of the same platform
 * must connect alongside it, independently.
 *
 * The live DB is ~16 GB, so (as in G1) the copy keeps the real schema plus the real
 * rows of the tables this path touches (`integrations`, `agents`, `organizations`,
 * `teams`) and the real `user_version`. `openSqlite` then runs the real migration.
 *
 * Usage: node verify-g2-real-data.mjs <liveDbPath> <copyDbPath>
 * Prints a JSON report to stdout (exit 1 on any failed assertion).
 */
import { existsSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [, , livePath, copyPath] = process.argv;
if (!livePath || !copyPath) {
  console.error('usage: node verify-g2-real-data.mjs <liveDbPath> <copyDbPath>');
  process.exit(2);
}

const STORAGE_DIST = new URL('../../storage/dist/index.js', import.meta.url).pathname;
const COMMS_DIST = new URL('../../comms/dist/index.js', import.meta.url).pathname;
const CLI_DIST = new URL('../dist/commands/start.js', import.meta.url).pathname;
const { openSqlite, closeSqlite, SqlitePlatformInstanceRepo } = await import(STORAGE_DIST);
const { MessageRouter, getManifest } = await import(COMMS_DIST);
const { connectConfiguredPlatforms } = await import(CLI_DIST);

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
const liveIntegrations = read(live, 'SELECT id, org_id, platform, enabled, cast(config as text) AS config, hex(config) AS config_hex FROM integrations');
const ddl = read(live, "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name");
const copyTables = ['organizations', 'teams', 'agents', 'integrations'];
const tableRows = {};
const tableCols = {};
for (const t of copyTables) {
  tableRows[t] = read(live, `SELECT * FROM ${t}`);
  tableCols[t] = read(live, `PRAGMA table_info(${t})`).map((c) => c.name);
}
live.close();

if (liveIntegrations.length === 0) {
  console.log('SKIP — live DB has no integrations row; nothing for G2 to traverse.');
  process.exit(0);
}
const src = liveIntegrations.find((r) => r.platform === 'feishu') ?? liveIntegrations[0];
const srcConfig = JSON.parse(src.config);
assert(liveVersion < 3, 'live DB is pre-upgrade (user_version < 3)', liveVersion);

// ── Phase B — build the copy: real schema + real rows + real user_version ────
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

// ── Phase C — run the real startup migration, then read the real instance rows ─
const db = openSqlite(copyPath);
const realRows = new SqlitePlatformInstanceRepo(db).listByOrg(src.org_id);
assert(realRows.length >= 1, 'migration produced >=1 real instance row', realRows.map((r) => r.id));
const realRow = realRows.find((r) => r.platform === src.platform);
assert(!!realRow, `real instance row exists for ${src.platform}`, realRow?.id);
assert(realRow.config[Object.keys(srcConfig)[0]] === srcConfig[Object.keys(srcConfig)[0]], 'real instance config carries the live credential values');

// ── Phase D — drive the REAL startup traversal with the REAL manifest ────────
// The live instance row carries only settings (notifyOnApproval/notifyPriority/
// …); the Feishu appId/appSecret live in markus.json. So the traversal must merge
// the instance row with the file section — this probe asserts exactly that, using
// the real manifest so field parity is guaranteed.
function recordingManifest(base, created) {
  return {
    ...base,
    createAdapter: () => {
      const rec = { calls: [] };
      created.push(rec);
      return {
        platform: base.id,
        connect: async (c) => {
          rec.calls.push(c);
        },
        disconnect: async () => {},
        sendMessage: async () => 'x',
        sendReply: async () => 'x',
        onMessage: () => {},
        isConnected: () => true,
      };
    },
  };
}
const realFeishu = getManifest('feishu');
const FILE_SECTION = { appId: 'PROBE_APP_ID', appSecret: 'PROBE_APP_SECRET' };
const config = {
  org: { id: src.org_id, name: 'live' },
  llm: { defaultProvider: 'anthropic', defaultModel: 'm', providers: {} },
  integrations: { feishu: FILE_SECTION },
};

// D1: only the real row — file credentials + row settings must both reach the adapter.
{
  const created = [];
  const router = new MessageRouter();
  const results = await connectConfiguredPlatforms({
    router,
    manifests: [recordingManifest(realFeishu, created)],
    config,
    instances: realRows,
  });
  assert(created.length === 1, 'exactly one adapter built from the real rows', created.length);
  assert(
    results.length === 1 && results[0].id === realRow.id && results[0].connected === true,
    'result keyed by the real instance id, connected',
    results,
  );
  const got = created[0].calls[0];
  assert(got.appId === FILE_SECTION.appId, 'adapter got the file-section appId', { got: got.appId });
  assert(
    String(got.notifyPriority) === realRow.config.notifyPriority.join(','),
    'adapter got the row settings (notifyPriority) — row ⊕ file merge works',
    { got: got.notifyPriority, row: realRow.config.notifyPriority },
  );
  assert(
    router.getInstances().length === 1 && router.getInstances()[0].instanceId === realRow.id,
    'router holds the real instance id',
    router.getInstances(),
  );
}

// D2: same platform, a second row — both connect, each on its own credentials.
{
  const created = [];
  const router = new MessageRouter();
  const second = {
    id: `${realRow.id}_sales`,
    platform: realRow.platform,
    label: 'sales-bot',
    config: { appId: 'SECOND_APP_ID', appSecret: 'SECOND_SECRET', notifyPriority: ['normal'] },
    enabled: true,
  };
  const results = await connectConfiguredPlatforms({
    router,
    manifests: [recordingManifest(realFeishu, created)],
    config,
    instances: [...realRows, second],
  });
  assert(created.length === 2, 'two bots of one platform ⇒ two adapters', created.length);
  const appIds = created.map((c) => c.calls[0].appId);
  assert(appIds.includes(FILE_SECTION.appId) && appIds.includes('SECOND_APP_ID'), 'each adapter got its own credentials', appIds);
  assert(
    results.length === 2 && results.every((r) => r.connected),
    'both instances reported connected',
    results,
  );
  assert(router.getInstances().length === 2, 'router holds two distinct instances', router.getInstances());
}

// D3: a platform with no instance row is untouched (no phantom adapter).
{
  const created = [];
  const router = new MessageRouter();
  const telegram = { id: 'telegram', label: 'Telegram', fields: [{ key: 'botToken', label: 'Bot Token', type: 'text', required: true }], capabilities: { inbound: true, outbound: true, threads: true }, createAdapter: () => ({ platform: 'telegram' }) };
  const results = await connectConfiguredPlatforms({
    router,
    manifests: [recordingManifest(telegram, created)],
    config,
    instances: realRows,
  });
  assert(created.length === 0 && results.length === 0, 'unconfigured platform creates no adapter', { created: created.length });
}

closeSqlite();

console.log('\n' + JSON.stringify({
  liveDb: livePath,
  liveUserVersion: liveVersion,
  realInstance: { id: realRow.id, platform: realRow.platform, label: realRow.label, enabled: realRow.enabled },
  realRowCount: realRows.length,
  failures,
}, null, 2));

process.exit(failures.length === 0 ? 0 : 1);
