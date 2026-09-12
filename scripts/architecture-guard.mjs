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

if (listOnly) process.exit(0);

if (fresh.length) {
  console.error(`\n[guard] ✗ 门禁失败：有 ${fresh.length} 处新违规（未在白名单中）。`);
  console.error('[guard]   no-console     → 改用 log.*（带上下文），或在白名单里写明豁免理由');
  console.error('[guard]   no-empty-catch → 至少 log.warn 说明为什么可以吞；空吞异常会让故障不可观测');
  console.error('[guard]   （确属安全豁免：把它加进 scripts/architecture-allowlist.json 并写理由）\n');
  process.exit(1);
}

console.log(`\n[guard] ✓ 通过：${violations.length} 处命中全部在已登记白名单内。\n`);
