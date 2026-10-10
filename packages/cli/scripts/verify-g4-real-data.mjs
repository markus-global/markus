/**
 * G4 real-data verification — drive the ACTUAL outbound chain against a copy of
 * the live DB, using the real rows the G1 migration produced.
 *
 * The point is to prove the G4 contract on **real data**, not fixtures:
 *   - the real `channel_bindings` rows the migration seeds, read through the real
 *     `RepoNotifyTargetLookup`;
 *   - the real `platform_instances` rows, so a binding resolves to a real platform;
 *   - a real approval notification (the shape `HITLService.notify` emits) walked
 *     through `OutboundDispatcher` into a recording sink.
 *
 * It also **reports the truth about level 3**: the migration cannot know which
 * conversation should receive notifications, so its rows carry `kind = NULL` and
 * `native_id = NULL` — they are ROUTING rows, not addressable destinations. On the
 * live DB there is therefore no configured level-3 terminus today, and the
 * dispatcher must say so loudly instead of silently dropping the notification.
 * The probe asserts both halves: the gap is reported, and once a target is
 * configured on top of the REAL instances/Secretary, delivery works.
 *
 * Usage: node verify-g4-real-data.mjs <liveDbPath> <copyDbPath>
 * Prints a JSON report to stdout (exit 1 on any failed assertion).
 */
import { existsSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [, , livePath, copyPath] = process.argv;
if (!livePath || !copyPath) {
  console.error('usage: node verify-g4-real-data.mjs <liveDbPath> <copyDbPath>');
  process.exit(2);
}

const STORAGE_DIST = new URL('../../storage/dist/index.js', import.meta.url).pathname;
const COMMS_DIST = new URL('../../comms/dist/index.js', import.meta.url).pathname;
const {
  openSqlite,
  closeSqlite,
  SqlitePlatformInstanceRepo,
  SqliteChannelBindingRepo,
} = await import(STORAGE_DIST);
const {
  RepoNotifyTargetLookup,
  OutboundDispatcher,
  RouterOutboundSink,
  renderCapabilitiesOf,
  notificationToOutbound,
  verifyActionRef,
  getManifest,
} = await import(COMMS_DIST);

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
const ddl = read(live, "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name");
const copyTables = ['organizations', 'teams', 'agents', 'integrations'];
const tableRows = {};
const tableCols = {};
for (const t of copyTables) {
  tableRows[t] = read(live, `SELECT * FROM ${t}`);
  tableCols[t] = read(live, `PRAGMA table_info(${t})`).map((c) => c.name);
}
live.close();

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

// ── Phase C — run the real startup migration, read the real gateway rows ─────
const db = openSqlite(copyPath);
const instanceRepo = new SqlitePlatformInstanceRepo(db);
const bindingRepo = new SqliteChannelBindingRepo(db);

const orgId = liveIntegrations[0]?.org_id ?? liveAgents[0]?.org_id ?? 'default';
const realInstances = instanceRepo.listByOrg(orgId);
const realBindings = bindingRepo.listByOrg(orgId);
assert(realInstances.length >= 1, 'migration produced >=1 real instance row', realInstances.map((r) => `${r.id}/${r.platform}`));
assert(realBindings.length >= 1, 'migration produced >=1 real channel_binding row', realBindings.length);

const globalBinding = realBindings.find((b) => b.scope === 'global');
const secretaryId = globalBinding?.agentId;
assert(!!secretaryId, 'migration seeded a global → Secretary binding', globalBinding?.id);
const secretaryAgent = liveAgents.find((a) => a.id === secretaryId);
assert(!!secretaryAgent, 'the global binding points at a REAL agent row', secretaryAgent?.name);

// The honest fact about what the migration can address:
const addressable = realBindings.filter((b) => b.instanceId && b.nativeId);
assert(
  addressable.length === 0,
  'real migrated rows are routing rows only (instance_id/native_id NULL) — level 3 is UNCONFIGURED today',
  addressable.map((b) => b.id),
);

// ── Phase D — the real lookup on real rows ───────────────────────────────────
const lookup = new RepoNotifyTargetLookup({
  bindingRepo,
  instanceRepo,
  orgSecretaryId: () => secretaryId,
});
assert(
  lookup.globalTarget(orgId) === undefined,
  'globalTarget() is honest: undefined while nothing addressable is configured (no legacy notifyChatId)',
  lookup.globalTarget(orgId),
);

// An unbound, unconfigured agent must NOT get a fabricated target.
const otherAgent = liveAgents.find((a) => a.id !== secretaryId);
assert(
  lookup.agentTarget(orgId, otherAgent?.id ?? 'agt_none') === undefined,
  'agentTarget() for a real unbound agent is undefined (never invented)',
  otherAgent?.id,
);

// A recording sink — proves what would be sent without needing a live adapter.
const deliveries = [];
const recordingSink = {
  capabilities: (target) => renderCapabilitiesOf(getManifest(target.platform)?.capabilities),
  async send(target, rendered) {
    deliveries.push({ target, text: rendered.text, format: rendered.format });
    return 'm_1';
  },
};

// D1: an approval whose producing agent has NO target must be reported undeliverable.
{
  deliveries.length = 0;
  const dispatcher = new OutboundDispatcher({ lookup, sink: recordingSink, orgId });
  const outcome = await dispatcher.dispatch({
    title: '部署到生产？',
    body: '请批准',
    severity: 'action_required',
    origin: { agentId: otherAgent?.id, taskId: 'tsk_probe' },
  });
  assert(outcome.delivered === false && outcome.reason === 'no-notify-target', 'unconfigured install ⇒ delivered:false (loud, not silent)', outcome);
  assert(deliveries.length === 0, 'nothing was sent through a non-existent target', deliveries.length);
}

// ── Phase E — configure a target on top of the REAL instances, then deliver ──
// This is what G5's UI does; the probe uses the real instance ids so platform
// resolution is exercised against real rows, not invented ones.
const realInstance = realInstances[0];
// The live DB has only a Feishu instance, but the D5 fix is precisely "a
// NON-Feishu platform can carry an approval". So create a real Telegram instance
// row through the REAL repo (a real row in a real DB), and route to it.
let telegramInstance = realInstances.find((r) => r.platform === 'telegram');
let tgInstanceCreated = false;
if (!telegramInstance) {
  telegramInstance = await instanceRepo.create({ orgId, platform: 'telegram', label: 'probe-sales-bot', config: { botToken: 'probe' }, enabled: true });
  tgInstanceCreated = true;
}
const configured = [
  { id: 'probe_notify_secretary', orgId, scope: 'channel', instanceId: realInstance.id, nativeId: 'oc_real_owner', kind: 'notification', agentId: secretaryId },
  { id: 'probe_route_ops', orgId, scope: 'channel', instanceId: realInstance.id, nativeId: 'oc_ops', kind: null, agentId: otherAgent?.id ?? 'agt_none' },
  { id: 'probe_notify_tg', orgId, scope: 'channel', instanceId: telegramInstance.id, nativeId: 'tg_chat_1', kind: 'notification', agentId: 'agt_probe_sales' },
];
const configuredLookup = new RepoNotifyTargetLookup({
  bindingRepo: { listByOrg: () => [...realBindings, ...configured] },
  instanceRepo,
  orgSecretaryId: () => secretaryId,
});

// E1: level 3 now resolves — the Secretary's own channel on the REAL feishu instance.
{
  const target = configuredLookup.globalTarget(orgId);
  assert(!!target && target.instanceId === realInstance.id, 'with a configured Secretary channel, globalTarget() resolves on the REAL instance', target);
  assert(target.platform === realInstance.platform, 'target platform comes from the real instance row', target.platform);
}

// E2: an approval reaches a NON-Feishu platform (the D5 fix) — assert the real
// notification shape, capability degradation, and the instance id flowing out.
{
  deliveries.length = 0;
  const dispatcher = new OutboundDispatcher({
    lookup: configuredLookup,
    sink: recordingSink,
    orgId,
    actionSecret: 'probe-secret',
  });
  const notification = {
    id: 'ntf_1',
    targetUserId: 'all',
    type: 'approval_request',
    title: '部署到生产？',
    body: '请批准',
    priority: 'high',
    metadata: { approvalId: 'apr_real', agentId: 'agt_probe_sales', options: [{ id: 'deploy', label: '部署' }] },
  };
  const outcome = await dispatcher.dispatch(notificationToOutbound(notification, 'probe-secret'));
  assert(outcome.delivered === true && outcome.scope === 'agent', 'approval for a Telegram-bound agent is delivered at the agent level', outcome);
  assert(deliveries[0]?.target.platform === 'telegram', 'a non-Feishu platform received the approval (D5 fixed)', deliveries[0]?.target);
  assert(deliveries[0]?.target.instanceId === telegramInstance.id, 'the real instance id travels with the outbound message', deliveries[0]?.target.instanceId);
  // Capabilities come from the REAL telegram manifest — expected format derived
  // from the manifest declaration (docs/design §7.4: a declaring manifest gets
  // markdown; only a platform with no capability block at all is plain text).
  const tgCaps = getManifest('telegram')?.capabilities;
  const expectFormat = !tgCaps ? 'text' : tgCaps.cards ? 'card' : 'markdown';
  assert(deliveries[0]?.format === expectFormat, 'format matches what the real telegram manifest declares', { format: deliveries[0]?.format, expectFormat, caps: tgCaps });
  assert(!deliveries[0]?.text.includes('apr_real'), 'the internal approval id never appears in the delivered text', deliveries[0]?.text.slice(0, 60));
  const ref = deliveries[0]?.text.split('[部署] ')[1]?.trim();
  const verified = verifyActionRef(ref ?? '', 'probe-secret');
  assert(verified?.approvalId === 'apr_real' && verified?.action === 'deploy', 'the delivered ref verifies back to the real approval (signed round-trip)', verified);
}

// E3: an unbound agent falls through to the Secretary channel — never orphaned.
{
  deliveries.length = 0;
  const dispatcher = new OutboundDispatcher({ lookup: configuredLookup, sink: recordingSink, orgId });
  const strayAgent = liveAgents.find((a) => a.id !== secretaryId && a.id !== otherAgent?.id);
  const outcome = await dispatcher.dispatch({
    title: '构建失败',
    body: 'pipline red',
    severity: 'action_required',
    origin: { agentId: strayAgent?.id ?? 'agt_stray' },
  });
  assert(outcome.delivered === true && outcome.scope === 'global', 'an unbound agent’s notification lands on the global (Secretary) level', outcome);
  assert(deliveries[0]?.target.nativeId === 'oc_real_owner', 'it went to the Secretary’s real configured channel', deliveries[0]?.target.nativeId);
}

// E4: the instance sink resolves on a real instance, and the router sink carries
// the instance id (the gap G2 flagged) — exercised with a stub router.
{
  deliveries.length = 0;
  const calls = [];
  const sink = new RouterOutboundSink({
    router: { sendToChannel: async (platform, channelId, content, instanceId) => { calls.push({ platform, channelId, content, instanceId }); return 'm_2'; } },
    capabilitiesOf: (platform) => renderCapabilitiesOf(getManifest(platform)?.capabilities),
  });
  const dispatched = await sink.send({ platform: realInstance.platform, instanceId: realInstance.id, nativeId: 'oc_real_owner' }, { format: 'text', text: 'hello', hasActions: false });
  assert(dispatched === 'm_2', 'router sink returns the adapter message id');
  assert(calls[0]?.instanceId === realInstance.id, 'RouterOutboundSink forwards the instance id (multi-bot target is exact)', calls[0]);
}

closeSqlite();

console.log('\n' + JSON.stringify({
  liveDb: livePath,
  liveUserVersion: liveVersion,
  orgId,
  realInstances: realInstances.map((r) => ({ id: r.id, platform: r.platform, label: r.label })),
  probeTelegramInstance: { id: telegramInstance.id, createdByProbe: tgInstanceCreated },
  realBindingCount: realBindings.length,
  realBindingScopes: realBindings.map((b) => `${b.scope}:${b.kind ?? 'null'}:${b.instanceId ? 'inst' : '-'}:${b.nativeId ? 'native' : '-'}`),
  secretary: { id: secretaryId, name: secretaryAgent?.name },
  level3ConfiguredToday: addressable.length > 0,
  failures,
}, null, 2));

process.exit(failures.length === 0 ? 0 : 1);
