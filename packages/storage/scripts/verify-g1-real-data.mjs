/**
 * G1 real-data verification — run the ACTUAL startup migration against a copy of
 * the live pre-upgrade DB and assert nothing is lost.
 *
 * The live DB is ~16 GB, so the copy keeps the **real schema** (all 48 tables /
 * 105 indexes, byte-for-byte DDL from the running install) plus the **real rows**
 * of the four tables this slice touches directly or via FK
 * (`integrations`, `agents`, `organizations`, `teams`) — and the real
 * `user_version = 2`. That is the complete input surface of the G1 migration.
 *
 * Usage: node verify-g1-real-data.mjs <liveDbPath> <copyDbPath>
 * Prints a JSON report to stdout (exit 1 on any failed assertion).
 */
import { existsSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [, , livePath, copyPath] = process.argv;
if (!livePath || !copyPath) {
  console.error('usage: node verify-g1-real-data.mjs <liveDbPath> <copyDbPath>');
  process.exit(2);
}

const STORAGE_DIST = new URL('../dist/index.js', import.meta.url).pathname;
const { openSqlite, closeSqlite, migrateMessagingGateway, resolveInstanceConfig } = await import(STORAGE_DIST);

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
const liveIntegrations = read(live, 'SELECT id, org_id, platform, display_name, enabled, cast(config as text) AS config, hex(config) AS config_hex FROM integrations');
const liveSecretary = one(
  live,
  `SELECT id FROM agents WHERE org_id = ? AND (deleted_at IS NULL OR deleted_at = '') AND (agent_role = 'secretary' OR name IN ('Secretary','秘书') OR lower(role_name) LIKE 'secretary%') LIMIT 1`,
  liveIntegrations[0]?.org_id ?? 'default',
);
const ddl = read(live, "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name");
const copyTables = ['organizations', 'teams', 'agents', 'integrations'];
const tableRows = {};
for (const t of copyTables) tableRows[t] = read(live, `SELECT * FROM ${t}`);
const tableCols = {};
for (const t of copyTables) tableCols[t] = read(live, `PRAGMA table_info(${t})`).map((c) => c.name);
live.close();

assert(liveIntegrations.length >= 1, 'live DB 含 integrations 行', liveIntegrations.length);
assert(liveIntegrations.some((r) => r.platform === 'feishu'), 'live DB 含 Feishu 配置');
assert(liveVersion < 3, 'live DB 为升级前版本 (<3)', liveVersion);

// ── Phase B — build the copy: real schema + real rows + real user_version ────
if (existsSync(copyPath)) rmSync(copyPath);
const copy = new DatabaseSync(copyPath);
copy.exec('PRAGMA foreign_keys = OFF');
for (const d of ddl) {
  try { copy.exec(d.sql); } catch (e) { /* index/trigger for a skipped table */ void e; }
}
for (const t of copyTables) {
  const cols = tableCols[t];
  const stmt = copy.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  for (const row of tableRows[t]) stmt.run(...cols.map((c) => row[c]));
}
copy.exec(`PRAGMA user_version = ${liveVersion}`);
copy.close();

// ── Phase C — pre-migration assertions on the copy ──────────────────────────
const pre = new DatabaseSync(copyPath);
const preHex = one(pre, "SELECT hex(config) AS h FROM integrations WHERE id = ?", liveIntegrations[0].id).h;
pre.close();
assert(preHex === liveIntegrations[0].config_hex, 'copy 凭据 blob 与 live 字节一致（迁移前）');

// ── Phase D — run the real startup path (openSqlite ⇒ v3 migration) ──────────
const db = openSqlite(copyPath);

// ── Phase E — post-migration assertions ─────────────────────────────────────
const src = liveIntegrations[0];
const instances = read(db, 'SELECT id, org_id, platform, label, enabled, hex(config) AS config_hex FROM platform_instances');
assert(instances.length === 1, 'platform_instances 恰 1 行', instances.length);
assert(
  instances[0].org_id === src.org_id && instances[0].platform === src.platform && instances[0].label === 'default' && instances[0].enabled === src.enabled,
  'instance 行映射正确 (org/platform/label/enabled)',
  instances[0],
);
assert(instances[0].config_hex === src.config_hex, 'instance 凭据 blob 字节级一致（绝不重新序列化）');

const bindings = read(db, 'SELECT org_id, scope, instance_id, native_id, kind, agent_id FROM channel_bindings');
assert(bindings.length === 1, 'channel_bindings 恰 1 行', bindings.length);
// No agentId in the live config ⇒ no instance binding ⇒ global → Secretary.
if (liveSecretary) {
  assert(
    bindings[0].scope === 'global' && bindings[0].instance_id === null && bindings[0].agent_id === liveSecretary.id,
    '无 agentId ⇒ global → Secretary',
    { expected: liveSecretary.id, got: bindings[0] },
  );
} else {
  assert(bindings.length === 0, '无 Secretary agent ⇒ 不插 binding', bindings.length);
}

const legacyAfter = read(db, 'SELECT hex(config) AS config_hex, enabled FROM integrations WHERE id = ?', src.id);
assert(
  legacyAfter.length === 1 && legacyAfter[0].config_hex === src.config_hex && legacyAfter[0].enabled === src.enabled,
  'legacy integrations 行迁移后原样保留',
);

const resolved = resolveInstanceConfig(db, src.org_id, src.platform);
assert(resolved?.source === 'instance', '读路径优先新表', resolved?.source);

// Idempotency on real data: a second pass must add nothing.
const stats2 = migrateMessagingGateway(db);
assert(stats2.instancesCreated === 0 && stats2.bindingsCreated === 0, '重跑迁移无新增（幂等）', stats2);

// Old read path must be intact: with no instance row, it falls back to legacy.
db.prepare('DELETE FROM platform_instances').run();
const fallback = resolveInstanceConfig(db, src.org_id, src.platform);
assert(fallback?.source === 'legacy', '新表缺席时回落 legacy（旧读路径行为不变）', fallback?.source);

const finalVersion = one(db, 'PRAGMA user_version').user_version;
assert(finalVersion === 3, 'user_version 推进到 3', finalVersion);
closeSqlite();

console.log('\n' + JSON.stringify({
  liveDb: livePath,
  liveUserVersion: liveVersion,
  integrations: liveIntegrations.map((r) => ({ id: r.id, org: r.org_id, platform: r.platform, enabled: r.enabled, bytes: r.config.length })),
  secretary: liveSecretary?.id ?? null,
  migratedInstance: instances[0] ?? null,
  migratedBindings: bindings,
  failures,
}, null, 2));

process.exit(failures.length === 0 ? 0 : 1);
