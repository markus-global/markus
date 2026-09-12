#!/usr/bin/env node
/**
 * 架构门禁（Architecture Guard）
 * ---------------------------------------------------------------------------
 * 把「工程约束」从口头约定变成**机器可强制**的检查，进 CI 必过。
 *
 * 为什么需要它：这个仓库的问题从来不是「缺人写代码」，而是缺少能自动拦住
 * 「调试残留 / 吞异常」这类持续性腐蚀的门禁。今天实际发生过：
 *   - 12 处 console.error('[HM] ...') 调试打印留在生产代码里，每条消息往 stderr 吐 sessionId；
 *   - 同一个修复被复制粘贴交付两次，守卫代码被写了两遍；
 *   - 只有 `<thinking>` 标签的行「删不掉」这种错误结论，让 1200 行死代码滞留数月。
 *
 * 规则：
 *   1. no-console      生产代码不得直接 console.*（一律走 logger）
 *   2. no-empty-catch  不得吞掉异常（空 catch 块 / 只 return 空的 catch）
 *
 * 用法：
 *   node scripts/architecture-guard.mjs                    # 检查，有违规则 exit 1
 *   node scripts/architecture-guard.mjs --update-allowlist  # 把当前违规写入白名单（基线）
 *   node scripts/architecture-guard.mjs --list              # 只打印，不失败（用于审计）
 *
 * 白名单 `scripts/architecture-allowlist.json` 按**文件**豁免，并且必须写明理由；
 * 新增违规文件不会自动进入白名单 —— 这是本门禁的意义所在。
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// 支持用 MARKUS_GUARD_ROOT 指向夹具目录（供 architecture-guard 自测用）。
const ROOT = process.env['MARKUS_GUARD_ROOT'] ? resolve(process.env['MARKUS_GUARD_ROOT']) : process.cwd();
const ALLOWLIST_FILE = join(ROOT, 'scripts', 'architecture-allowlist.json');
const SCAN_ROOTS = ['packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', 'out']);

const updateAllowlist = process.argv.includes('--update-allowlist');
const listOnly = process.argv.includes('--list');

// ─── 契约级门禁（Invariant Guards）────────────────────────────────────────────
/**
 * 与上面「禁止式」规则（no-console / 空 catch / session-identity）不同，这里检查的是
 * **必须存在**的不变量，对应需求 req_236bca1ab0ca8ed425537bed 的两类回归：
 *
 *   1. `mailbox-claim-uniqueness` —— item 认领唯一性：
 *      「同一 mailbox item 同一时刻只能被一个 worker/实例持有」。它由三件事共同保证，
 *      任何一件被后续重构删掉，都会退回「多分身重复处理 + 空转让位」的线上事故：
 *        · 持久层 `claimItem` 必须是**原子条件更新**（`WHERE status='queued' AND 无有效租约`）；
 *        · 部分唯一索引 `uq_mailbox_agent_dedup` 必须存在（同一 agent+幂等键至多一行）；
 *        · core `dequeue` 必须**委托**持久层认领，而非「本地即胜」。
 *   2. `review-request-protected` —— review_request 受保护：
 *      · `CONSOLIDATION_PROTECTED_TYPES` 含 review_request（否则被预合并吞掉 → 评审永不执行）；
 *      · `UNICAST_WAKE_TYPES` 含 review_request（否则广播唤醒 N 个 worker 争抢同一 item）；
 *      · shared `isStrictStateItem()` 把 review_request 判为 strict-state（停机恢复不得误 drop）。
 *
 * 设计要点：这类规则**不可白名单豁免**（没有 `allowed` 通道，命中即红）—— 并发正确性
 * 的底线不是「可以写理由绕过」的风格问题。并且每条检测器都自带**自检夹具**：门禁每次
 * 运行都会先拿「合规样本 / 违规样本」验证自己仍能命中，避免正则失效后静默放行（一个
 * 永远不会红的门禁比没有门禁更危险）。
 */
const INVARIANT_RULES = [
  {
    id: 'mailbox-claim-uniqueness',
    title: 'item 认领唯一性（原子条件更新 + 幂等唯一键 + core 委托认领）',
    checks: [
      {
        file: 'packages/storage/src/sqlite-storage.ts',
        label: 'claimItem = 「status=queued 且无有效租约」保护的原子条件更新',
        hint: '认领不再是原子条件更新 → 多个 worker / 实例可同时持有同一 item（重复处理、重复收口）',
        detect: t => /claimItem\([\s\S]{0,800}?SET\s+status\s*=\s*'processing'[\s\S]{0,400}?AND\s+status\s*=\s*'queued'/.test(t),
        fixtures: {
          ok: "claimItem(id, ownerId, leaseUntil, nowIso) { UPDATE mailbox_items SET status='processing', claimed_by=? WHERE id=? AND status='queued' AND (claimed_by IS NULL OR lease_until < ?) }",
          bad: "claimItem(id, ownerId) { UPDATE mailbox_items SET status='processing', claimed_by=? WHERE id=? }",
        },
      },
      {
        file: 'packages/storage/src/sqlite-storage.ts',
        label: 'items 幂等唯一键 uq_mailbox_agent_dedup 存在（部分唯一索引）',
        hint: '缺唯一键 → 重复投递会落第二行，「同一 (agent, task, round) 至多一条」被破坏',
        detect: t => /CREATE UNIQUE INDEX IF NOT EXISTS uq_mailbox_agent_dedup/.test(t),
        fixtures: {
          ok: 'CREATE UNIQUE INDEX IF NOT EXISTS uq_mailbox_agent_dedup ON mailbox_items(agent_id, dedup_key) WHERE dedup_key IS NOT NULL;',
          bad: 'CREATE INDEX IF NOT EXISTS idx_mailbox_agent ON mailbox_items(agent_id);',
        },
      },
      {
        file: 'packages/core/src/mailbox.ts',
        label: 'dequeue 认领委托持久层 claimItem（> 本地即胜），败者必须让位',
        hint: '取件不再委托原子认领 → 各分身「本地即胜」，同一 item 被重复处理',
        detect: t => /if\s*\(!this\.persistence\?\.claimItem\)/.test(t)
          && /this\.tryClaim\(/.test(t)
          && /claimContested/.test(t),
        fixtures: {
          ok: "if (!this.persistence?.claimItem) { /* 旧路径：本地即胜 */ } if (!this.tryClaim(candidate)) { log.info('x', { event: MAILBOX_OBSERVABILITY_EVENTS.claimContested }); continue; }",
          bad: 'const [item] = this.queue.splice(idx, 1); item.status = "processing"; return item;',
        },
      },
    ],
  },
  {
    id: 'review-request-protected',
    title: 'review_request 受保护（禁预合并 + 单播唤醒 + strict-state 判定一致）',
    checks: [
      {
        file: 'packages/core/src/mailbox.ts',
        label: 'CONSOLIDATION_PROTECTED_TYPES 含 review_request',
        hint: 'review_request 被移出受保护集合 → 会被 consolidateGroup 合并进 informational item，评审可能永不执行',
        detect: t => /CONSOLIDATION_PROTECTED_TYPES[^;]*=\s*new Set(?:<[^>]*>)?\s*\(\[[\s\S]{0,300}?['"]review_request['"]/.test(t),
        fixtures: {
          ok: "private static readonly CONSOLIDATION_PROTECTED_TYPES = new Set(['human_chat', 'review_request']);",
          bad: "private static readonly CONSOLIDATION_PROTECTED_TYPES = new Set(['human_chat']);",
        },
      },
      {
        file: 'packages/core/src/mailbox.ts',
        label: 'UNICAST_WAKE_TYPES 含 review_request（单播唤醒，不广播）',
        hint: '单播唤醒缺失 → 广播唤醒 N 个 worker 争抢同一 item，败者让位空转',
        detect: t => /UNICAST_WAKE_TYPES[^=]*=\s*new Set(?:<[^>]*>)?\s*\(\[[\s\S]{0,300}?['"]review_request['"]/.test(t),
        fixtures: {
          ok: "const UNICAST_WAKE_TYPES: ReadonlySet<MailboxItemType> = new Set<MailboxItemType>(['review_request']);",
          bad: 'const UNICAST_WAKE_TYPES: ReadonlySet<MailboxItemType> = new Set<MailboxItemType>([]);',
        },
      },
      {
        file: 'packages/shared/src/types/mailbox.ts',
        label: 'isStrictStateItem() 把 review_request 判为 strict-state',
        hint: 'shared strict-state 语义与 core 受保护集合不一致 → 停机恢复会误 drop 未完成的评审请求',
        detect: t => /isStrictStateItem[\s\S]{0,900}?['"]review_request['"]/.test(t),
        fixtures: {
          ok: "export function isStrictStateItem(item) { const strict = new Set(['review_request', 'task_execution']); return strict.has(item.sourceType); }",
          bad: 'export function isStrictStateItem(item) { return item.sourceType === "task_execution"; }',
        },
      },
    ],
  },
];

/** 门禁自检：每条检测器都必须「命中违规样本、放过合规样本」。 */
function selfTestInvariants() {
  const failures = [];
  for (const rule of INVARIANT_RULES) {
    for (const c of rule.checks) {
      if (typeof c.detect !== 'function' || !c.fixtures) {
        failures.push({ rule: rule.id, detail: `${c.file} 的检测器缺少 detect/fixtures` });
        continue;
      }
      if (!c.detect(c.fixtures.ok)) {
        failures.push({ rule: rule.id, detail: `${c.label} —— 检测器误报合规样本（规则过严，会误红）` });
      }
      if (c.detect(c.fixtures.bad)) {
        failures.push({ rule: rule.id, detail: `${c.label} —— 检测器漏过违规样本（规则失效，会静默放行）` });
      }
    }
  }
  return failures;
}

/** 在真实源码上执行契约不变量检查。命中 = 违规（无白名单豁免）。 */
function checkInvariants() {
  const out = [];
  for (const rule of INVARIANT_RULES) {
    for (const c of rule.checks) {
      const abs = join(ROOT, c.file);
      if (!existsSync(abs)) {
        out.push({ rule: rule.id, file: c.file, label: c.label, hint: `必需文件缺失：${c.file}` });
        continue;
      }
      if (!c.detect(readFileSync(abs, 'utf-8'))) {
        out.push({ rule: rule.id, file: c.file, label: c.label, hint: c.hint });
      }
    }
  }
  return out;
}

const invariantChecksTotal = INVARIANT_RULES.reduce((n, r) => n + r.checks.length, 0);

/**
 * 每条规则的作用域。
 *
 * 关键决策：`no-empty-catch` 只在**服务端**（core / org-manager）强制。
 * UI（web-ui）里大量 `catch { /* ignore *\/ }` 是渲染/请求的兜底，吞掉它不会
 * 让生产故障变得不可排查；而服务端静默吞错正是今天「会话失忆」能潜伏数月的根因，
 * 所以只在那里设硬门禁——**规则要打在真正出事的地方**，否则只会被白名单稀释。
 */
const RULE_SCOPE = {
  // 服务端运行时必须走 logger：一条漏下的 console.error 只在服务端才是事故
  // （本次实际抓到 12 处 [HM]/[PMC] 调试打印）。CLI / 浏览器扩展的 console 是
  // 面向用户的输出通道，不属于违规。
  'no-console': (relPath) => /^packages\/(core|org-manager)\//.test(relPath),
  'no-empty-catch': (relPath) => /^packages\/(core|org-manager)\//.test(relPath),
  // 会话身份契约只在「服务端入口层」强制（core/org-manager 的 src）。
  'session-identity': (relPath) => /^packages\/(core|org-manager)\/src\//.test(relPath),
  // 事件可达性：所有服务端 src 都可能订阅 agent 级事件（cli 广播 / org-manager 自愈）。
  'event-reachability': (relPath) => /^packages\/(core|org-manager|cli|a2a|comms)\/src\//.test(relPath),
  // 写门禁：只针对 shell 工具的接线点。
  'write-gate': (relPath) => relPath === 'packages/core/src/tools/shell.ts',
};

/** 递归收集 packages/<pkg>/src/** 下的源码文件（只看 src，不看测试）。 */
function collectSources() {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        // 只扫各包的 src 目录
        if (entry.name === 'src' || full.includes(`${join('packages')}`)) walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(ts|tsx|mts|cts)$/.test(entry.name)) continue;
      if (/\.d\.ts$/.test(entry.name)) continue;
      if (/packages\/[^/]+\/src\//.test(relative(ROOT, full).split(process.platform === 'win32' ? '\\' : '/').join('/'))) {
        files.push(full);
      }
    }
  };
  for (const root of SCAN_ROOTS) walk(join(ROOT, root));
  return files;
}

/**
 * 规则 3：入口必须显式表态会话身份（第 0 步「会话身份契约」的静态门禁）。
 *
 * 背景：「同一会话后续请求看不到历史」反复出现的根因是——**入口没带会话身份**，
 * agent 于是静默开一个新会话。运行期已经有 unknown 告警，但那是事后；这里把它提前
 * 到提交前：调用 sendMessage / sendMessageStream / enqueueToMailbox 时，调用的
 * 参数里（含后续十几行，容许多行书写）必须出现会话身份字段之一：
 *   sessionHint | sessionId | dbSessionId | sessionRestore | channelKey
 *
 * 白名单按文件豁免（存量系统消息调用经人工确认后登记）；**新增的裸调用会被拦住**。
 */
const IDENTITY_CALL_RE = /\.(sendMessage|sendMessageStream|enqueueToMailbox|sendTaskExecution)\s*\(/;
const IDENTITY_TOKEN_RE = /sessionHint|sessionId|dbSessionId|sessionRestore|channelKey/;
function checkSessionIdentity(file, text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!IDENTITY_CALL_RE.test(lines[i])) continue;
    const window = lines.slice(i, Math.min(lines.length, i + 14)).join('\n');
    if (IDENTITY_TOKEN_RE.test(window)) continue;
    out.push({ rule: 'session-identity', line: i + 1, snippet: lines[i].trim().slice(0, 120) });
  }
  return out;
}

/**
 * 规则 4：event-reachability —— agent 私有 bus 事件必须先登记转发白名单（P0-1 类，P1-6 / G2）。
 *
 * 背景：`agent:incomplete` 在 agent 私有 bus 上 emit，唯一消费者订阅在 manager bus 上，
 * 转发白名单 `AGENT_FORWARDED_EVENTS` 漏登 → 该自愈路径从引入至今不可达，任务永久卡住。
 *
 * 判据（静态、可复核）：
 *   emit 域 ＝ 在「agent 私有 bus 发射者」文件中出现 `.emit('X'` 的事件名；
 *   订阅域 ＝ 上述文件**之外**、各包 src 中出现 `.on('X'` 的事件名；
 *   要求：X 必须出现在 AGENT_FORWARDED_EVENTS 白名单里。
 * 通用 EventEmitter 名（error/close/data/…）已排除，避免误报。
 */
const AGENT_BUS_EMITTER_FILES = new Set([
  'packages/core/src/agent.ts',
  'packages/core/src/attention.ts',
  'packages/core/src/mailbox.ts',
]);
const GENERIC_EMITTER_EVENTS = new Set([
  'error', 'close', 'data', 'end', 'exit', 'open', 'message', 'text', 'status', 'connection',
]);
const WHITELIST_SOURCE = 'packages/core/src/agent-manager.ts';
const EMIT_NAME_RE = /\.?emit\(\s*['"]([^'"]+)['"]/g;
const ON_NAME_RE = /\.on\(\s*['"]([^'"]+)['"]/g;

function collectAgentBusEmittedEvents() {
  const names = new Set();
  for (const relPath of AGENT_BUS_EMITTER_FILES) {
    const abs = join(ROOT, relPath);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf-8');
    for (const m of text.matchAll(EMIT_NAME_RE)) names.add(m[1]);
  }
  return names;
}

function loadForwardedEvents() {
  const abs = join(ROOT, WHITELIST_SOURCE);
  if (!existsSync(abs)) return null;
  const text = readFileSync(abs, 'utf-8');
  const block = text.match(/AGENT_FORWARDED_EVENTS\s*=\s*\[([\s\S]*?)\]\s*as const/);
  if (!block) return null;
  return new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

const AGENT_BUS_EVENTS = collectAgentBusEmittedEvents();
const FORWARDED_EVENTS = loadForwardedEvents();

function checkEventReachability(file, text) {
  const relPath = rel(file);
  if (AGENT_BUS_EMITTER_FILES.has(relPath)) return [];
  if (!FORWARDED_EVENTS) return []; // 白名单源缺失 → 不误报
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(ON_NAME_RE)) {
      const name = m[1];
      if (GENERIC_EMITTER_EVENTS.has(name)) continue;
      if (!AGENT_BUS_EVENTS.has(name)) continue;
      if (FORWARDED_EVENTS.has(name)) continue;
      out.push({ rule: 'event-reachability', line: i + 1, snippet: ".on('" + name + "') 未登记 AGENT_FORWARDED_EVENTS，订阅方永远收不到" });
    }
  }
  return out;
}

/**
 * 规则 5：write-gate —— shell 工具必须接入单一写门禁（P0-2 / G1）。
 * 若有人删掉 `assertShellWriteAllowed(` 调用，shell 重定向即可再次绕过写门禁。
 */
function checkShellWriteGate(file, text) {
  if (rel(file) !== 'packages/core/src/tools/shell.ts') return [];
  if (text.includes('assertShellWriteAllowed(')) return [];
  return [{ rule: 'write-gate', line: 1, snippet: 'shell_execute 未接入 assertShellWriteAllowed —— 写门禁可被 shell 绕过' }];
}

/** 规则 1：禁止 console.*（除白名单文件）。 */
function checkNoConsole(file, text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/\bconsole\.(log|error|warn|info|debug|trace)\s*\(/.test(lines[i])) {
      out.push({ rule: 'no-console', line: i + 1, snippet: lines[i].trim().slice(0, 120) });
    }
  }
  return out;
}

/**
 * 规则 2：禁止**说不出理由的**空 catch（连注释都没有）。
 *
 * 关键设计：吞异常本身不总是错（“best effort”确实存在），错的是**默默吞**。
 * 所以规则是「空 catch 且无任何注释」才违规：想吞，就得写清楚为什么可以吞。
 * 这样门禁既不会逼着大家往白名单里塞脏数据，也把“静默降级”变成显式选择。
 */
function checkBareEmptyCatch(file, text) {
  const out = [];
  const re = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const line = text.slice(0, m.index).split('\n').length;
    out.push({ rule: 'no-empty-catch', line, snippet: m[0].replace(/\s+/g, ' ').slice(0, 120) });
  }
  return out;
}

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_FILE)) return { 'no-console': {}, 'no-empty-catch': {}, 'session-identity': {} };
  try {
    return JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf-8'));
  } catch (err) {
    console.error(`[guard] 无法解析白名单 ${ALLOWLIST_FILE}: ${err}`);
    process.exit(2);
  }
}

const rel = (abs) => relative(ROOT, abs).split(process.platform === 'win32' ? '\\' : '/').join('/');

const allowlist = loadAllowlist();
const violations = [];
for (const file of collectSources()) {
  const text = readFileSync(file, 'utf-8');
  const relPath = rel(file);
  for (const v of [
    ...checkNoConsole(file, text),
    ...checkBareEmptyCatch(file, text),
    ...checkSessionIdentity(file, text),
    ...checkEventReachability(file, text),
    ...checkShellWriteGate(file, text),
  ]) {
    if (!(RULE_SCOPE[v.rule]?.(relPath) ?? true)) continue;
    violations.push({ ...v, file: relPath, allowed: Boolean(allowlist[v.rule]?.[relPath]) });
  }
}

if (updateAllowlist) {
  const next = { 'no-console': { ...(allowlist['no-console'] ?? {}) }, 'no-empty-catch': { ...(allowlist['no-empty-catch'] ?? {}) } };
  for (const v of violations) {
    if (!next[v.rule][v.file]) next[v.rule][v.file] = 'TODO: 基线（人工复核后写清理由，或改为 logger / 加 log.warn）';
  }
  writeFileSync(ALLOWLIST_FILE, JSON.stringify(next, null, 2) + '\n', 'utf-8');
  console.log(`[guard] 已更新白名单：${ALLOWLIST_FILE}`);
  console.log(`[guard] 现有违规文件 ${new Set(violations.map(v => `${v.rule}:${v.file}`)).size} 条`);
  process.exit(0);
}

const fresh = violations.filter(v => !v.allowed);
if (violations.length) {
  console.log(`\n[guard] 扫描到 ${violations.length} 处命中（白名单内 ${violations.length - fresh.length} 处）：`);
  for (const v of violations) {
    console.log(`  ${v.allowed ? '·' : '✗'} ${v.file}:${v.line}  [${v.rule}]  ${v.snippet}`);
  }
}

// 契约门禁自检：每次运行都做。门禁自身的检测器一旦失效（正则不再命中真实违规形态），
// 必须**拒绝静默放行** —— 一个永远不红的门禁比没有门禁更危险。
const selfTestFailures = selfTestInvariants();
for (const f of selfTestFailures) {
  console.error(`[guard] ✗ 门禁自检失败：${f.rule} —— ${f.detail}`);
}
if (selfTestFailures.length) {
  console.error('[guard] 契约门禁检测器已失效 → 拒绝静默放行（exit 2）。请修复检测器后重试。');
  process.exit(2);
}

const invariantViolations = checkInvariants();

if (listOnly) {
  for (const v of invariantViolations) console.log(`  ✗ [${v.rule}] ${v.file} —— ${v.label}`);
  console.log(`\n[guard] 契约不变量：${invariantChecksTotal - invariantViolations.length}/${invariantChecksTotal} 满足（--list 不失败）。\n`);
  process.exit(0);
}

if (fresh.length) {
  console.error(`\n[guard] ✗ 门禁失败：有 ${fresh.length} 处新违规（未在白名单中）。`);
  console.error('[guard]   no-console     → 改用 log.*（带上下文），或在白名单里写明豁免理由');
  console.error('[guard]   no-empty-catch → 至少 log.warn 说明为什么可以吞；空吞异常会让故障不可观测');
  console.error('[guard]   （确属安全豁免：把它加进 scripts/architecture-allowlist.json 并写理由）\n');
  process.exit(1);
}

if (invariantViolations.length) {
  console.error(`\n[guard] ✗ 契约门禁失败：${invariantViolations.length} 条不变量被破坏（不可白名单豁免）。`);
  for (const v of invariantViolations) {
    console.error(`  ✗ [${v.rule}] ${v.file} —— ${v.label}`);
    console.error(`      ↳ ${v.hint}`);
  }
  console.error('[guard]   这两类不变量（item 认领唯一性 / review_request 受保护）是并发正确性底线：');
  console.error('[guard]   删掉它们会退回「同一评审被多分身重复收口 + 空转让位」的线上事故。\n');
  process.exit(1);
}

console.log(`\n[guard] ✓ 通过：${violations.length} 处命中全部在已登记白名单内；契约不变量 ${invariantChecksTotal}/${invariantChecksTotal} 满足。\n`);
