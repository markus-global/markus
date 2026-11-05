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

// 夹具模式：ROOT 是一个**合成夹具目录**（只含被测规则需要的若干文件）。
//
// 契约不变量（INVARIANT_RULES）断言的是**真实仓库**的属性 ——「必需文件存在，
// 且内部含指定结构」。在合成夹具里这些文件本就不存在，若照跑必然全红，
// 于是自测永远失败、且失败原因与被测规则无关。因此夹具模式下只跑
// 「路径级规则」（no-console / no-empty-catch / session-identity /
// event-reachability / write-gate …），契约不变量交由真实仓库运行（CI / 本地）强制。
//
// 注意：门禁**自检**（selfTestInvariants，用内置 fixtures 字符串验证检测器
// 不误报/不漏报）在夹具模式下仍然执行 —— 那是「门禁永远不该静默失效」的底线，
// 与 ROOT 无关。
const FIXTURE_MODE = Boolean(process.env['MARKUS_GUARD_ROOT']);
const ALLOWLIST_FILE = join(ROOT, 'scripts', 'architecture-allowlist.json');
const SCAN_ROOTS = ['packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', 'out']);

const updateAllowlist = process.argv.includes('--update-allowlist');
const listOnly = process.argv.includes('--list');
// 终态基线只允许**缩小**：该开关删掉已清理的条目，遇到新增违规直接拒绝写盘。
const pruneTerminal = process.argv.includes('--prune-terminal-baseline');

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
 *   3. `dependency-engine` —— 依赖引擎判死语义（对应缺陷 tsk_e991647e313fbe9a3b07a64f / 2026-09-12）：
 *      · 判定收敛到单一函数 `blockerVerdict()`，且区分「可恢复失败 / 终结失败」；
 *      · 不得回归 `cascadeFailDependents`（blocker 一 failed 就无条件级联判死）；
 *      · auto-fail 仅作用于 `blocked` 依赖方（写入前必须重读当前状态）；
 *      · 每次进入 failed 的系统转移都必须带非空 reason；
 *      · auto-fail 必须有自愈路径（依赖恢复后仅还原引擎自己判死的任务）。
 *      **规则组 id 必须稳定为 `dependency-engine`**：报警日志按 id 打标签，一旦这 5 条
 *      被挂到别的规则组（曾误挂 `review-request-protected`），定位时会把依赖缺陷误读成
 *      「与 review_request 无关的报错」，定位成本陡增。
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
  {
    id: 'dependency-engine',
    title: '依赖引擎判死语义（禁「瞬时 failed 即判死」+ 可自愈 + reason 可追溯）',
    checks: [
      {
        file: 'packages/org-manager/src/task-service.ts',
        label: '依赖判定收敛到单一函数 blockerVerdict（且区分可恢复/终结）',
        hint: '判定不再是单一函数、或不再区分 failed-recoverable / failed-terminal → 要么瞬时失败就误杀依赖方，要么永远不释放依赖方（本缺陷两端都会复发）',
        detect: t => /private blockerVerdict\(blockerId: string[\s\S]{0,6000}?'failed-recoverable'[\s\S]{0,1200}?'failed-terminal'/.test(t),
        fixtures: {
          ok: "private blockerVerdict(blockerId: string, now = Date.now()) { const status = blocker.status; if (status !== 'failed') return { kind: 'waiting' }; if (failedForMs < grace) return { kind: 'failed-recoverable' }; return { kind: 'failed-terminal' }; }",
          bad: "private blockerVerdict(blockerId: string) { return this.tasks.get(blockerId)?.status === 'failed' ? { kind: 'dead' } : { kind: 'waiting' }; }",
        },
      },
      {
        file: 'packages/org-manager/src/task-service.ts',
        label: '无「blocker 一 failed 就级联判死」的路径（cascadeFailDependents 不得回归）',
        hint: '无条件级联判死回归 → 瞬时 failed 的 blocker（provider/超时类）会立刻杀掉全部阻塞中的依赖方',
        detect: t => !/cascadeFailDependents/.test(t),
        fixtures: {
          ok: "private checkDependentTasks(cause: Task) { if (task.status === 'blocked') this.evaluateBlockedDependent(task); }",
          bad: "private checkDependentTasks(finishedTask: Task) { if (finishedTask.status === 'failed') { this.cascadeFailDependents(finishedTask); return; } }",
        },
      },
      {
        file: 'packages/org-manager/src/task-service.ts',
        label: 'auto-fail 仅作用于 blocked 依赖方（写入前重读现状）',
        hint: '缺少写入前的 status===\'blocked\' 重读 → 陈旧判定可能落在已 in_progress / review 的依赖方上（2026-09-12 事故的第二种形态）',
        detect: t => /private autoFailBlockedDependent\(task: Task[\s\S]{0,4000}?current\.status !== 'blocked'/.test(t),
        fixtures: {
          ok: "private autoFailBlockedDependent(task: Task, verdict: BlockerVerdict) { const current = this.tasks.get(task.id); if (!current || current.status !== 'blocked') { return; } this.updateTaskStatus(task.id, 'failed', undefined, true, false, 'system', reason); }",
          bad: "private autoFailBlockedDependent(task: Task) { this.updateTaskStatus(task.id, 'failed'); }",
        },
      },
      {
        file: 'packages/org-manager/src/task-service.ts',
        label: '每次进入 failed 的系统转移都带非空 reason（可追溯）',
        hint: '存在不传 reason 的 failed 转移 → 状态史 reason 为空，事后无法从记录复现因果（同一个坑已经踩过一次）',
        detect: t => {
          const slices = [];
          let i = t.indexOf('this.updateTaskStatus(');
          while (i >= 0) {
            slices.push(t.slice(i, i + 420));
            i = t.indexOf('this.updateTaskStatus(', i + 1);
          }
          return slices
            .filter(s => /'failed'/.test(s))
            .every(s => /'system',\s*[^)\s]/.test(s));
        },
        fixtures: {
          ok: "this.updateTaskStatus(taskId, 'failed', undefined, false, false, 'system', `Execution failed: ${reason}`);",
          bad: "this.updateTaskStatus(taskId, 'failed');",
        },
      },
      {
        file: 'packages/org-manager/src/task-service.ts',
        label: 'auto-fail 可自愈（依赖恢复时自动还原，且仅还原引擎自己判死的任务）',
        hint: '缺少自愈路径 → 依赖恢复后依赖方永久滞留 failed，必须人工裁决 + 重启（2026-09-12 的恢复链）',
        detect: t => /recoverAutoFailedDependent\(task: Task\)[\s\S]{0,4000}?isDependencyAutoFailed\(task\)/.test(t)
          && /DEPENDENCY_AUTO_FAIL_MARK[\s\S]{0,400}?DEPENDENCY_AUTO_RECOVER_MARK/.test(t),
        fixtures: {
          ok: "const DEPENDENCY_AUTO_FAIL_MARK = '[dependency-auto-fail]'; const DEPENDENCY_AUTO_RECOVER_MARK = '[dependency-auto-recover]'; private recoverAutoFailedDependent(task: Task) { if (!this.isDependencyAutoFailed(task)) return; }",
          bad: "private recoverAutoFailedDependent(task: Task) { this.updateTaskStatus(task.id, 'in_progress'); }",
        },
      },
    ],
  },
  {
    id: 'thread-presentation-single-source',
    title: 'Thread 展示层单一实现（STAGE_LABEL / ACTION_LABEL / 时间格式化只许一份）',
    checks: [
      {
        file: 'packages/web-ui/src/lib/threadPresentation.ts',
        label: '唯一实现存在（导出 STAGE_LABEL / ACTION_LABEL / formatRelative / formatDuration）',
        hint: '单一实现文件消失 → 各页面会各自长回本地副本，文案与时间口径随即分叉',
        detect: t =>
          /export const STAGE_LABEL/.test(t) &&
          /export const ACTION_LABEL/.test(t) &&
          /export function formatRelative\b/.test(t) &&
          /export function formatDuration\b/.test(t),
        fixtures: {
          ok: "export const STAGE_LABEL = {}; export const ACTION_LABEL = {}; export function formatRelative(ms) {} export function formatDuration(ms) {}",
          bad: "export const STAGE_LABEL = {};",
        },
      },
      // 已知消费方：这些文件曾经各带一份副本，历史上真的分叉过
      // （概览说「等你回话」、Thread 视图说「等你回答」）。
      // 局限：只管这 5 个文件，新增文件不受约束——所以 S3 同时把它们改成 import。
      ...[
        'src/components/InboxCard.tsx',
        'src/pages/ThreadView.tsx',
        'src/pages/RouterDesk.tsx',
        'src/components/HistoryModal.tsx',
        'src/components/ActionCenter.tsx',
      ].map(rel => ({
        file: `packages/web-ui/${rel}`,
        label: `${rel} 不再自带 stage/action/时间副本，改为引用 lib/threadPresentation`,
        hint: '该文件重新长出本地 STAGE_LABEL / relTime / relAge / humanDuration → 第二个写者回来了，文案会再次分叉',
        detect: t =>
          !/const STAGE_LABEL\s*:/.test(t) &&
          !/const ACTION_LABEL\s*:/.test(t) &&
          !/function\s+(relTime|relAge|humanDuration)\s*\(/.test(t) &&
          /from '\.\.\/lib\/threadPresentation\.ts'/.test(t),
        fixtures: {
          ok: "import { stageLabel } from '../lib/threadPresentation.ts';",
          bad: "const STAGE_LABEL: Record<string,string> = { idle: '空闲' };",
        },
      })),
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

/** 在真实源码上执行契约不变量检查。命中 = 违规（无白名单豁免）。
 *  夹具模式（MARKUS_GUARD_ROOT）下跳过：见 FIXTURE_MODE 处说明。 */
function checkInvariants() {
  if (FIXTURE_MODE) return [];
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
  // 键构造点禁时钟：所有包的 src 都可能有缓存键/指纹（web-ui 的 formatSmartTime、
  // org-manager 的 registry 缓存、core 的去重键、shared 的幂等键）。
  'key-constructor-no-clock': () => true,
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

// ─── 规则 6：terminal-status-predicate（P3 · req_410d823e）─────────────────────
/**
 * 背景：`docs/architecture/hardcoded-string-audit.md` §1。P0 已把「这件工作结束了吗？」
 * 的**定义**收敛成一个谓词 —— `@markus/shared#isTerminal()`
 * （web-ui 侧是 `lib/taskStatus.ts#isTerminal` 的投影，写入者仍是 shared）。
 *
 * 但收敛定义 ≠ 收敛调用点：裸写
 *   `status === 'completed' || status === 'failed' || status === 'cancelled'`
 * 会在第三个终态出现时**静默漏判**（`rejected` / `archived` 被当成"还在跑"），
 * 而且十种写法让「还剩多少处」无法被 grep 计数。本规则把它变成提交前的机器约束。
 *
 * 三个设计取舍：
 *
 *  1）**默认拦（default deny）**：扫 `packages/*\/src` 下**全部**文件，只在
 *     「字形相同但不是同一个事实」的文件上按**文件**豁免（下表，每条必须写明它回答的是
 *     哪个问题）。极性不能反过来（只扫白名单文件）：那样新文件天生失明，正是门禁失效
 *     的经典形态 —— 一个只看得见存量、看不见新增的门禁等于没有门禁。
 *
 *  2）**只拦终态字形**：`status === 'running' / 'in_progress' / 'pending' / 'blocked' /
 *     'review'` 一律放行。拦非终态比较是**错的门禁**（它会把「正在跑吗」和「结束了吗」
 *     混成一个问题，然后被人整体关掉）。
 *
 *  3）**双向棘轮基线**：`scripts/terminal-status-baseline.json` 记录存量，每条带 `why`。
 *     多出来的（新增违规）→ 红；少掉的（已清理但基线没删）→ 也红。只有"机器只能缩小、
 *     人必须解释增长"的基线才能让数字**单调下降**；只拦新增的基线会让存量永远躺在那里。
 */
const TERMINAL_STATUS_LITERALS = ['completed', 'failed', 'rejected', 'cancelled', 'archived'];
const TERMINAL_LITERAL_ALT = TERMINAL_STATUS_LITERALS.join('|');
/** 主体：以 `status` / `Status` 结尾的标识符链（`status` / `task.status` / `s?.status`）。 */
const STATUS_SUBJECT = String.raw`(?:[A-Za-z_$][\w$]*\s*(?:\?\.|\.)\s*){0,6}[A-Za-z_$]*[sS]tatus\b`;

/**
 * 「同名但不是同一个事实」的豁免登记表。**每一行都必须回答：这个 status 问的是哪个问题。**
 * 缺理由的豁免会在下面的 checkTerminalStatusPredicate() 里判红（空理由 = 没打算解释）。
 */
const TERMINAL_LITERAL_EXEMPT_FILES = {
  'packages/shared/src/types/task.ts': 'SSOT 本体：TERMINAL_STATUSES 就在这里定义，它就是那个例外',
  'packages/web-ui/src/lib/taskStatus.ts': 'web-ui 侧的**投影本体**：isTerminal/TERMINAL_STATUSES 就在这里，写入者仍是 shared（有镜像测试钉住）',
  'packages/web-ui/src/lib/boardFilters.ts': '看板默认隐藏集（rejected/cancelled/archived）——**视图偏好**，不是「是否已结束」；completed 故意不在里面',
  'packages/core/src/coding-tools/context-injector.ts': 'coding 工具**步骤**状态（created/running/completed），不是任务生命周期',
  'packages/core/src/coding-tools/handlers.ts': 'coding 工具**会话**状态 → 映射成工具返回值 success/error',
  'packages/core/src/coding-tools/runtime.ts': 'coding 工具会话状态（cancelled 是工具被中断，不是任务被判死）',
  'packages/core/src/learning-loop.ts': '学习回路单次运行的 opts.status，不是 ItemStatus',
  'packages/core/src/llm/openai-codex.ts': 'LLM 响应对象的 status（`response.status`），HTTP 语义',
  'packages/core/src/mailbox.ts': 'mailbox item 状态（queued/processing/completed/dropped/merged），投递语义',
  'packages/core/src/tools/result.ts': '工具结果信封的 status（error/denied/deferred），工具语义',
  'packages/core/src/tools/subagent.ts': '子 agent 单次运行状态（running/completed/timeout），不是任务生命周期',
  'packages/core/src/workflow/engine.ts': '工作流**步骤**状态（含 skipped，任务没有这个状态）',
  'packages/org-manager/src/workflow-runner.ts': '工作流**运行**状态（paused/running/completed），与任务卡生命周期正交',
  'packages/org-manager/src/long-task-progress.ts': '长任务**阶段**状态（stage.status），阶段不是卡片',
  'packages/desktop/src/notifications.ts': '桌面通知点击行为按通知类型分流，不读任务终态',
  'packages/web-ui/src/components/CodingToolCard.tsx': 'UI 里的 coding 工具会话状态徽标（同 core/coding-tools）',
  'packages/web-ui/src/components/ExecutionTimeline.tsx': 'UI 里的工具会话时间线（session.status，含 timeout）',
  'packages/web-ui/src/components/NotificationBell.tsx': '**审批**状态（cancelled/expired），不是任务终态',
  'packages/web-ui/src/components/RightPanel.tsx': '分享（share）发布状态：published/pending_review/rejected',
  'packages/web-ui/src/components/DeliverableShareModal.tsx': '分享评审状态（share review），不是任务终态',
  'packages/web-ui/src/pages/Deliverables.tsx': '交付物分享状态（share.review），不是任务终态',
  'packages/web-ui/src/pages/ArtifactDetail.tsx': 'Hub 资产审核状态（moderationStatus），平台审核语义',
  'packages/web-ui/src/pages/AgentBuilder.tsx': 'Hub 资产审核状态（moderationStatus），平台审核语义',
};

/** 比较式：`<subject> === '<terminal>'`（含 `!==` / `==` / `!=`）。 */
const TERMINAL_CMP_RES = [
  new RegExp(String.raw`(?<![\w$.])(${STATUS_SUBJECT})\s*(===|!==|==|!=)\s*(['"])(${TERMINAL_LITERAL_ALT})\3`, 'g'),
  // 反向书写：`'completed' === status`
  new RegExp(String.raw`(['"])(${TERMINAL_LITERAL_ALT})\1\s*(===|!==|==|!=)\s*(${STATUS_SUBJECT})`, 'g'),
];
/** 内联终态数组：`['completed','archived'].includes(task.status)` / `new Set([...]).has(status)`。 */
const TERMINAL_ARRAY_RE = new RegExp(
  String.raw`\[([^\[\]]{0,400})\]\s*\)?\s*\.\s*(?:includes|has|indexOf)\s*\(\s*(${STATUS_SUBJECT})\s*[,)]`,
  'g',
);

/**
 * 把注释替换成等长空白（保留换行）——用**偏移不变**的清洗结果做匹配，
 * 这样行号仍然对得上原文，同时注释里的示例代码（本仓库有若干）不会误报。
 * 字符串内容保留（终态字形本来就住在字符串里）。
 */
function stripCommentsPreservingOffsets(text) {
  const out = text.split('');
  let inBlock = false;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inBlock) {
      if (c === '*' && next === '/') { out[i] = ' '; out[i + 1] = ' '; inBlock = false; i++; continue; }
      if (c !== '\n') out[i] = ' ';
      continue;
    }
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && next === '*') { out[i] = ' '; out[i + 1] = ' '; inBlock = true; i++; continue; }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') { out[i] = ' '; i++; }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
  }
  return out.join('');
}

/**
 * **具名**终态集合的声明：`const A = ['completed', …]` / `new Set([...])`。
 *
 * 为什么必须单独处理：第 4 轮评审的探针 `const NAMED_TERM = ['completed','archived'];
 * NAMED_TERM.includes(s)` 在旧检测器下**完全失明**——因为内联数组检测要求 `[` 紧邻
 * `.includes(`。一行 `const` 就能绕过，「一网打尽」的措辞与「能被一行 const 绕过」不能
 * 同时成立。所以：先收集本文件里含终态字形的具名集合，再匹配对它的 `includes/has/indexOf`。
 *
 * 局限（诚实登记，见报告 §5）：只认同**同一文件**内的声明与使用；跨文件 `import` 进来的
 * 具名集合仍不在检测范围（那需要模块图，成本远超本卡）。
 */
const NAMED_LITERAL_COLLECTION_RE = new RegExp(
  String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]{0,160})?=\s*(?:new\s+Set(?:<[^>\n]{0,80}>)?\s*\(\s*)?\[([^\[\]]{0,600})\]`,
  'g',
);
const LITERAL_LIST_RE = /['"]([a-z_]+)['"]/g;

/** 收集本文件里「值域**全是**终态字形」的具名集合名字。 */
function collectTerminalCollectionNames(clean) {
  const names = new Set();
  for (const m of clean.matchAll(NAMED_LITERAL_COLLECTION_RE)) {
    const literals = [...m[2].matchAll(LITERAL_LIST_RE)].map((x) => x[1]);
    if (!literals.length) continue;
    // 判据是**纯度**：集合里每一个字面量都是终态字形，才算「终态集合」。
    //
    // 为什么不能只要求「含至少一个」：`new Set(['reject','rejected'])`（审批 token）
    // 含 `rejected` 但不是任务终态集合 —— 实测过一次误伤（web-ui/src/api.ts
    // `APPROVAL_REJECT_TOKENS.has(token)`）。英文单词跨域重名，纯「含」判据会把
    // 审批/资产审核之类的集合全拖进来，而**误伤一次，门禁就会被人整体关掉**。
    // 反过来，纯活跃态集合（`['pending','in_progress','review']`）也必须放行 ——
    // 它一个终态字形都没有，问的是「还在流程里吗」。
    if (literals.every((v) => TERMINAL_STATUS_LITERALS.includes(v))) names.add(m[1]);
  }
  return names;
}

/** 找出文件里所有「终态语义的裸比较」。返回 [{ line, value, kind }]。 */
function findTerminalStatusComparisons(text) {
  const clean = stripCommentsPreservingOffsets(text);
  const hits = [];
  const push = (index, value, kind) => {
    hits.push({ line: clean.slice(0, index).split('\n').length, value, kind });
  };
  for (const m of clean.matchAll(TERMINAL_CMP_RES[0])) push(m.index, m[4], 'cmp');
  for (const m of clean.matchAll(TERMINAL_CMP_RES[1])) push(m.index, m[2], 'cmp-rev');
  for (const m of clean.matchAll(TERMINAL_ARRAY_RE)) {
    const literals = [...m[1].matchAll(LITERAL_LIST_RE)].map((x) => x[1]);
    if (literals.some((v) => TERMINAL_STATUS_LITERALS.includes(v))) push(m.index, literals.join('|'), 'array');
  }
  for (const name of collectTerminalCollectionNames(clean)) {
    // 判据是**集合的内容**，不是实参长什么样：一个值域含终态字形的具名集合，
    // 它对任何实参做的 `includes/has/indexOf` 都是在问「是不是某个终态」。
    // 若还要求实参保形如 `x.status`，`const T=[...]; T.includes(s)` 就又能绕过
    // —— 第 4 轮评审那支探针正是这个形态。
    const re = new RegExp(String.raw`\b${name}\s*\??\.\s*(?:includes|has|indexOf)\s*\(`, 'g');
    for (const m of clean.matchAll(re)) push(m.index, name, 'named-collection');
  }
  return hits.sort((a, b) => a.line - b.line);
}

const TERMINAL_BASELINE_FILE = join(ROOT, 'scripts', 'terminal-status-baseline.json');
const TERMINAL_WHY_MIN_LENGTH = 8;

function loadTerminalBaseline() {
  if (!existsSync(TERMINAL_BASELINE_FILE)) return { files: {} };
  try {
    return JSON.parse(readFileSync(TERMINAL_BASELINE_FILE, 'utf-8'));
  } catch (err) {
    console.error(`[guard] 无法解析终态基线 ${TERMINAL_BASELINE_FILE}: ${err}`);
    process.exit(2);
  }
}

/** 存量普查：`Map<relPath, Map<normalizedSnippet, { count, lines }>>`，外加豁免清单的命中计数。 */
function collectTerminalStatusHits() {
  const byFile = new Map();
  let exemptHits = 0;
  let exemptFiles = 0;
  for (const file of collectSources()) {
    const relPath = rel(file);
    const text = readFileSync(file, 'utf-8');
    const hits = findTerminalStatusComparisons(text);
    if (TERMINAL_LITERAL_EXEMPT_FILES[relPath]) {
      if (hits.length) { exemptHits += hits.length; exemptFiles += 1; }
      continue;
    }
    if (!hits.length) continue;
    const lines = text.split('\n');
    const found = new Map();
    for (const h of hits) {
      const snippet = (lines[h.line - 1] ?? '').trim().replace(/\s+/g, ' ').slice(0, 160);
      if (!snippet) continue;
      const cur = found.get(snippet) ?? { count: 0, lines: [] };
      cur.count += 1;
      cur.lines.push(h.line);
      found.set(snippet, cur);
    }
    byFile.set(relPath, found);
  }
  return { byFile, exemptHits, exemptFiles };
}

/**
 * 双向棘轮比对（基线按**文件**记数，每条带 why）。返回：
 *   grew   —— 文件不在基线里，或现状比基线多：必须红（新增违规 / 混进第二种写法）；
 *   shrank —— 基线比现状多：必须红，否则存量数字永远不会下降。
 *
 * 为什么按文件记数而不是按行：按行的基线会在每次无关重排时 churn（人就把它当噪声删掉）；
 * 按文件记数既让「还剩多少处」逐文件可读，又让任何新增处**必然**改变计数 → 必红。
 */
function checkTerminalStatusPredicate() {
  const baseline = loadTerminalBaseline();
  const files = baseline.files ?? {};
  const { byFile: hits, exemptHits, exemptFiles } = collectTerminalStatusHits();
  const grew = [];
  const shrank = [];
  let total = 0;
  for (const [relPath, found] of hits) {
    const lines = [...found.values()].flatMap((v) => v.lines).sort((a, b) => a - b);
    const count = lines.length;
    total += count;
    const entry = files[relPath];
    if (!entry) {
      grew.push({ relPath, lines, count, extra: count, why: null });
      continue;
    }
    if (typeof entry.why !== 'string' || entry.why.trim().length < TERMINAL_WHY_MIN_LENGTH) {
      grew.push({ relPath, lines, count, extra: 0, why: 'MISSING_WHY' });
      continue;
    }
    if (count > entry.count) grew.push({ relPath, lines, count, extra: count - entry.count, why: entry.why });
  }
  for (const [relPath, entry] of Object.entries(files)) {
    const have = [...(hits.get(relPath)?.values() ?? [])].reduce((n, v) => n + v.count, 0);
    if (have < entry.count) shrank.push({ relPath, expected: entry.count, have });
  }
  return { grew, shrank, total, baselineFiles: Object.keys(files).length, exemptHits, exemptFiles };
}

/** `--prune-terminal-baseline`：只允许**缩小**；出现新增违规一律拒绝写盘。 */
function pruneTerminalBaseline() {
  const baseline = loadTerminalBaseline();
  const hits = collectTerminalStatusHits().byFile;
  const next = { version: 1, note: baseline.note, files: {} };
  let removed = 0;
  const unexpected = [];
  for (const [relPath, found] of hits) {
    const count = [...found.values()].reduce((n, v) => n + v.count, 0);
    const entry = baseline.files?.[relPath];
    if (!entry) { unexpected.push({ relPath, count }); continue; }
    // 只允许缩小：现状比基线多 = 新增违规，绝不能借 `--prune` 把数字**改大**洗白。
    if (count > entry.count) { unexpected.push({ relPath, count, baseline: entry.count }); continue; }
    next.files[relPath] = { count, why: entry.why };
  }
  for (const [relPath, entry] of Object.entries(baseline.files ?? {})) {
    if (!hits.has(relPath)) removed += entry.count;
  }
  if (unexpected.length) {
    console.error(`\n[guard] ✗ 拒绝写入终态基线：有 ${unexpected.length} 个文件出现**新**的终态裸比较。`);
    for (const u of unexpected) console.error(`  ✗ ${u.relPath} × ${u.count}`);
    console.error('[guard]   正确动作是二选一：① 改用 isTerminal(status)（推荐，终态判定的唯一入口）；');
    console.error('[guard]   ② 若这确实是「某个具体状态」而非「是否已结束」，手工把该行加进');
    console.error(`[guard]   ${TERMINAL_BASELINE_FILE}，并在 why 里写清楚它回答的是哪个问题。\n`);
    process.exit(1);
  }
  const ordered = {};
  for (const relPath of Object.keys(next.files).sort()) ordered[relPath] = next.files[relPath];
  next.files = ordered;
  writeFileSync(TERMINAL_BASELINE_FILE, JSON.stringify(next, null, 2) + '\n', 'utf-8');
  console.log(`[guard] 终态基线已精简：删除 ${removed} 条已清理条目，剩余 ${Object.values(ordered).reduce((n, f) => n + Object.keys(f).length, 0)} 条。`);
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

// ─── 规则 6：key-constructor-no-clock（P4 · 缓存键/指纹构造函数禁时钟）──────────
/**
 * 键构造点内禁止「时钟 / 随机 / 自增计数」参与**键的构成**。
 *
 * 为什么不能按「同一函数里出现 Date.now()」判：仓库里绝大多数 `Date.now()` 是
 * TTL 记账（`const now = Date.now(); if (now - cached.ts < TTL)`），键本身是常量。
 * 照字面实现会产生大量假阳性，然后有人会去关掉守卫。
 *
 * 判据（语义切片）：
 *   · 时间参与「键的构成」→ 违规（A 类）
 *   · 时间参与「新旧的比较」→ 合法（B 类）
 *
 * 两种键构造点，切片方式不同：
 *   1. **键函数**（名字以 Key / Fingerprint / Hash 结尾）：整个函数体就是键构造器
 *      → 体内（含参数默认值）出现时钟/随机源即违规。
 *   2. **键声明**（名字以 cacheKey / dedupKey / idempotencyKey / fingerprint 结尾，
 *      或右值含 `createHash(`）：只有右值是键构造器 → 对右值做**局部污点分析**：
 *      由时钟/随机源派生的标识符为「脏」，右值引用脏标识符即违规。
 *      B 类因此天然不命中：`now` 是脏的，但它不出现在键右值里。
 *
 * 豁免：行内注释 `key-clock-ok: <理由>`（同一行或上一行）。豁免会被**计数并打印**，
 * 不是静默放行 —— 残余项必须可观测。
 */
const KEY_DECL_NAME_RE = /(?:cacheKey|dedupKey|idempotencyKey|fingerprint)$/i;
// 键函数名：只认「键/指纹」语义的结尾。`createAPIKey` / `validateAPIKey` /
// `isPlaceholderLicensePublicKey` / `normalizeSectionKey` 是密钥生成/校验/普通
// 归一化，不是缓存键构造器 —— 名字里带 Key 不等于键构造点（不靠命名猜）。
// 指纹式 hash 包装另由「函数体含 createHash(」兜住。
const KEY_FN_NAME_RE = /(?:cacheKey|dedupKey|idempotencyKey|fingerprint)$/i;
const CLOCK_SOURCE_RE = /\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)|\bperformance\.now\s*\(|\bMath\.random\s*\(|\brandomUUID\s*\(/;
const HASH_CALL_RE = /\bcreateHash\s*\(/;
const KEY_CLOCK_OK_RE = /key-clock-ok\s*:\s*\S/;

/** 从 openIdx 处的 `{` 起做括号配对，返回匹配的 `}` 下标（跳过字符串/模板/注释）。 */
function matchBrace(text, openIdx) {
  let depth = 0;
  const tplStack = [];
  let mode = null;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (mode === '//') { if (ch === '\n') mode = null; continue; }
    if (mode === '/*') { if (ch === '*' && next === '/') { mode = null; i++; } continue; }
    if (mode === "'" || mode === '"') {
      if (ch === '\\') { i++; continue; }
      if (ch === mode) mode = null;
      continue;
    }
    if (mode === '`') {
      if (ch === '\\') { i++; continue; }
      if (ch === '`') { mode = null; continue; }
      if (ch === '$' && next === '{') { tplStack.push(depth + 1); depth++; mode = null; i++; continue; }
      continue;
    }
    if (ch === '/' && next === '/') { mode = '//'; i++; continue; }
    if (ch === '/' && next === '*') { mode = '/*'; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { mode = ch; continue; }
    if (ch === '{') { depth++; continue; }
    if (ch === '}') {
      // 模板 `${` 的闭合 `}`：回到模板字符串，不算块结束
      if (tplStack.length && depth === tplStack[tplStack.length - 1]) {
        tplStack.pop(); mode = '`'; depth--; continue;
      }
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 从 from 起找函数体的 `{`（跳过参数列表的括号）。 */
function findBodyBrace(text, from) {
  // from 紧跟在参数列表的 `(` 之后，所以初始括号深度是 1
  let paren = 1;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') paren++;
    else if (ch === ')') paren--;
    else if (ch === '{' && paren === 0) return i;
    else if (ch === ';' && paren === 0) return -1;
  }
  return -1;
}

/** 找出所有函数体范围（function 声明 / 箭头函数块体 / 类方法）。 */
function findFunctionRanges(text) {
  const ranges = [];
  const push = (name, namePos, openBraceIdx) => {
    if (openBraceIdx < 0) return;
    const end = matchBrace(text, openBraceIdx);
    if (end > openBraceIdx) ranges.push({ name, namePos, start: openBraceIdx, end });
  };
  for (const m of text.matchAll(/(?:^|[\s;{}])(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/g)) {
    push(m[1], m.index, findBodyBrace(text, m.index + m[0].length));
  }
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=>\s*\{/g)) {
    push(m[1], m.index, text.indexOf('{', m.index + m[0].length - 1));
  }
  for (const m of text.matchAll(/^[ \t]+(?:(?:public|private|protected|static|async|readonly|override)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{;]+)?\{\s*$/gm)) {
    push(m[1], m.index, text.indexOf('{', m.index + m[0].length - 1));
  }
  return ranges;
}

/** 从 from 起找语句结束位置（`;` 或非续行换行），跳过字符串/模板/注释。 */
function findStatementEnd(text, from) {
  let depth = 0;
  const tplStack = [];
  let mode = null;
  const limit = Math.min(text.length, from + 1200);
  for (let i = from; i < limit; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (mode === '//') { if (ch === '\n') { mode = null; if (depth === 0) return i; } continue; }
    if (mode === '/*') { if (ch === '*' && next === '/') { mode = null; i++; } continue; }
    if (mode === "'" || mode === '"') {
      if (ch === '\\') { i++; continue; }
      if (ch === mode) mode = null;
      continue;
    }
    if (mode === '`') {
      if (ch === '\\') { i++; continue; }
      if (ch === '`') { mode = null; continue; }
      if (ch === '$' && next === '{') { tplStack.push(depth + 1); depth++; mode = null; i++; continue; }
      continue;
    }
    if (ch === '/' && next === '/') { mode = '//'; i++; continue; }
    if (ch === '/' && next === '*') { mode = '/*'; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { mode = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (ch === '}' && tplStack.length && depth === tplStack[tplStack.length - 1]) {
        tplStack.pop(); mode = '`'; depth--; continue;
      }
      depth--;
      continue;
    }
    if (ch === ';' && depth === 0) return i;
    if (ch === '\n' && depth === 0) {
      const rest = text.slice(i + 1).match(/^\s*([\s\S])/);
      const c = rest ? rest[1] : '';
      if (!c || !/[.?:+\-*/|&,=><([{`]/.test(c)) return i;
    }
  }
  return limit;
}

/** 收集「名字 ← 右值」绑定：声明 + 赋值（含复合赋值）。 */
function collectBindings(text) {
  const out = [];
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*/g)) {
    const rhsStart = m.index + m[0].length;
    out.push({ name: m[1], pos: m.index, rhs: text.slice(rhsStart, findStatementEnd(text, rhsStart)) });
  }
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*(?:\^=|\|=|&=|\+=|-=|\*=|<<=|>>=|\/=(?!=)|=(?![=>]))\s*/g)) {
    const rhsStart = m.index + m[0].length;
    out.push({ name: m[1], pos: m.index, rhs: text.slice(rhsStart, findStatementEnd(text, rhsStart)) });
  }
  return out;
}

/**
 * 检测一个文件里的「时钟进入键」违规。返回 [{ line, name, why }]。
 * 语义切片见上方规则说明：键函数看整体，键声明只看右值（污点分析）。
 */
function analyzeKeyClock(text) {
  const ranges = findFunctionRanges(text);
  const scopeOfPos = (pos) => {
    let best = null;
    for (const r of ranges) {
      if (pos > r.start && pos < r.end && (!best || r.end - r.start < best.end - best.start)) best = r;
    }
    return best;
  };
  const skey = (s) => (s ? `${s.start}:${s.end}` : 'module');

  const bindings = collectBindings(text);
  // 参数默认值也是绑定：`function f(now = Date.now())`
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*(?:Date\.now\(\)|new Date\(\)|performance\.now\(\)|Math\.random\(\)|randomUUID\()/g)) {
    bindings.push({ name: m[1], pos: m.index, rhs: m[0] });
  }
  for (const b of bindings) b.scope = scopeOfPos(b.pos);

  const tainted = new Map();
  const addTaint = (scope, name) => {
    const k = skey(scope);
    if (!tainted.has(k)) tainted.set(k, new Set());
    const set = tainted.get(k);
    if (set.has(name)) return false;
    set.add(name);
    return true;
  };
  const visible = (scope) => {
    const names = new Set(tainted.get('module') ?? []);
    for (const r of ranges) {
      if (scope && r.start <= scope.start && r.end >= scope.end) {
        for (const n of tainted.get(skey(r)) ?? []) names.add(n);
      }
    }
    return names;
  };
  const refsTainted = (expr, names) => {
    for (const n of names) {
      const re = new RegExp(`(^|[^\\w$])${n.replace(/\$/g, '\\$')}([^\\w$]|$)`);
      if (re.test(expr)) return n;
    }
    return null;
  };

  // 污点传递闭包（声明 + 赋值 + 参数默认值）。
  //
  // 关键收窄：**不穿过对象/数组字面量**。`const item = { id, createdAt: Date.now(), … }`
  // 里的时间戳是**载荷数据**，不是键的构成；若让它把 `item` 标脏，则
  // `const dedupKey = mailboxDedupKey(item)` 会被误报（实测 mailbox.ts:772）。
  // 键的构成只沿标量表达式传播：模板串 / 拼接 / 算术 / 调用 / 成员访问 / 三元。
  const isContainerLiteral = (rhs) => /^\s*[[{]/.test(rhs);
  for (let round = 0; round < 20; round++) {
    let changed = false;
    for (const b of bindings) {
      if (isContainerLiteral(b.rhs)) continue;
      if (CLOCK_SOURCE_RE.test(b.rhs)) { if (addTaint(b.scope, b.name)) changed = true; continue; }
      if (refsTainted(b.rhs, visible(b.scope))) { if (addTaint(b.scope, b.name)) changed = true; }
    }
    if (!changed) break;
  }

  const hits = [];
  // 0) 键**属性**（对象字面量里的 `idempotencyKey: …`）。声明扫描抓不到这种形态，
  //    而它同样是键构造点（实测 `thread-ensure.ts` 的 `idempotencyKey: event.eventId ? … :
  //    \`evt_${Date.now()}…\`` 就藏在这里）。右值按「到行尾/分号」截取。
  const KEY_PROP_RE = /(?:^|[{,\s])(cacheKey|dedupKey|idempotencyKey|fingerprint)\s*:\s*/g;
  for (const m of text.matchAll(KEY_PROP_RE)) {
    const rhsStart = m.index + m[0].length;
    const rhs = text.slice(rhsStart, findStatementEnd(text, rhsStart));
    // 只认**构造出来的值**（模板串 / 拼接 / 调用）。类型签名（`dedupKey: string;`）和
    // 纯字段读取（`dedupKey: r['dedup_key'] as string | null`）没有构造行为，
    // 不是键构造点。属性级**不做污点传播**：作用域推断在真实文件上噪声太大，
    // 误报会让人直接关掉守卫（实测两处假阳性都出在这里）。
    if (!/`|\+|\w\s*\(/.test(rhs)) continue;
    if (CLOCK_SOURCE_RE.test(rhs)) hits.push({ pos: m.index, name: m[1], why: '时钟/随机源直接进入键属性' });
  }
  // 1) 键声明：只看右值。
  //
  // **委派规则**：右值若是「调用一个键函数」（`const cacheKey = smartTimeCacheKey(…)`），
  // 则真正的构造点是那个函数，声明只是调用点 —— 由规则 2 检查该函数即可，此处跳过。
  // 这正是本卡要求的形态：档位作为**显式入参**交给单一纯函数，而不是构造点自己拼时间。
  //    识别不要求 RHS 「以函数名开头」：实测正确形态常包在三元里
  //    （`const cacheKey = raw ? smartTimeCacheKey(…) : null`），只认开头会把它判成违规。
  const delegatesToKeyFn = (rhs) => {
    for (const m of rhs.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (KEY_FN_NAME_RE.test(m[1])) return true;
    }
    return false;
  };
  for (const b of bindings) {
    if (!KEY_DECL_NAME_RE.test(b.name) && !HASH_CALL_RE.test(b.rhs)) continue;
    // 顺序要紧：**直接**读时钟永远违规（哪怕同时委派了键函数），
    // 委派判定只负责放过「键的成分由被调用的纯函数构成」这一形态。
    if (CLOCK_SOURCE_RE.test(b.rhs) && !isContainerLiteral(b.rhs)) {
      hits.push({ pos: b.pos, name: b.name, why: '时钟/随机源直接进入键' });
      continue;
    }
    if (delegatesToKeyFn(b.rhs)) continue;
    const via = refsTainted(b.rhs, visible(b.scope));
    if (via) hits.push({ pos: b.pos, name: b.name, why: `时钟派生变量 ${via} 进入键` });
  }
  // 2) 键函数：整个函数体 + 签名默认值
  for (const r of ranges) {
    if (!KEY_FN_NAME_RE.test(r.name)) continue;
    const body = text.slice(r.start, r.end + 1);
    const sig = text.slice(r.namePos, r.start);
    if (CLOCK_SOURCE_RE.test(body) || CLOCK_SOURCE_RE.test(sig)) {
      hits.push({ pos: r.namePos, name: r.name, why: '键函数体内（含参数默认值）出现时钟/随机源' });
    }
  }

  // 去重 + 行号 + 行内豁免
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    const line = text.slice(0, h.pos).split('\n').length;
    const key = `${line}:${h.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lines = text.split('\n');
    const here = lines[line - 1] ?? '';
    const prev = lines[line - 2] ?? '';
    out.push({ line, name: h.name, why: h.why, exempt: KEY_CLOCK_OK_RE.test(here) || KEY_CLOCK_OK_RE.test(prev) });
  }
  return out;
}

/** 规则 6 的接线：把 analyzeKeyClock 的结果转成统一违规形状。 */
function checkKeyConstructorNoClock(file, text) {
  return analyzeKeyClock(text).map(h => ({
    rule: 'key-constructor-no-clock',
    line: h.line,
    snippet: `${h.name} —— ${h.why}${h.exempt ? '（已用 key-clock-ok 豁免）' : ''}`,
    exempt: h.exempt,
  }));
}

/**
 * 规则 6 自检：门禁每次运行都验证「A 类必红 / B 类必绿 / C 类必绿 / 键函数默认值必红」。
 * 一个永远不红的门禁比没有门禁更危险；一个会误伤 B 类的门禁会被关掉。
 */
function selfTestKeyClock() {
  const failures = [];
  const A_SAMPLE = [
    'const _cache = new Map();',
    'export function formatSmartTime(isoOrLocale, rawCreatedAt) {',
    '  const now = new Date();',
    '  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();',
    '  const cacheKey = rawCreatedAt ? `${rawCreatedAt}|${todayStart}|${isoOrLocale}` : null;',
    '  return cacheKey;',
    '}',
  ].join('\n');
  const B_SAMPLE = [
    'const cache = new Map();',
    'export async function searchSkillHub(query) {',
    "  const cacheKey = 'skillhub-data';",
    '  const now = Date.now();',
    '  const cached = cache.get(cacheKey);',
    '  if (cached && now - cached.ts < 600_000) return cached.data;',
    '  return [];',
    '}',
  ].join('\n');
  const C_SAMPLE = [
    'export function mailboxDedupKey(item) {',
    '  const taskId = item.payload.taskId;',
    '  return `task:${taskId}:${item.sourceType}`;',
    '}',
  ].join('\n');
  const FN_SAMPLE = [
    'export function contentHashIdempotencyKey(kind, subject, windowMs = 60_000, now = Date.now()) {',
    '  const bucket = Math.floor(now / windowMs);',
    '  return `${kind}:hash:${bucket}`;',
    '}',
  ].join('\n');
  const EXEMPT_SAMPLE = [
    'function recordEvent(event) {',
    '  // key-clock-ok: 无稳定 id 时每次调用都是一件新事实，唯一键是刻意的',
    '  const idempotencyKey = `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;',
    '  return idempotencyKey;',
    '}',
  ].join('\n');

  const a = analyzeKeyClock(A_SAMPLE);
  if (a.length === 0) failures.push({ rule: 'key-constructor-no-clock', detail: 'A 类样本（todayStart 折进 cacheKey）未被命中 —— 规则失效' });
  const b = analyzeKeyClock(B_SAMPLE);
  if (b.length !== 0) failures.push({ rule: 'key-constructor-no-clock', detail: `B 类样本（常量键 + now 只做 TTL 比较）被误报 ${b.length} 处 —— 规则过严` });
  const c = analyzeKeyClock(C_SAMPLE);
  if (c.length !== 0) failures.push({ rule: 'key-constructor-no-clock', detail: `C 类样本（结构化字段拼键）被误报 ${c.length} 处` });
  const fn = analyzeKeyClock(FN_SAMPLE);
  if (fn.length === 0) failures.push({ rule: 'key-constructor-no-clock', detail: '键函数参数默认值 Date.now() 未被命中' });
  const ex = analyzeKeyClock(EXEMPT_SAMPLE);
  if (ex.length === 0 || !ex.every(h => h.exempt)) failures.push({ rule: 'key-constructor-no-clock', detail: 'key-clock-ok 行内豁免未生效' });
  // 委派形态（本卡要求的正确形状）：档位作为显式入参交给单一纯函数 → 不得误报
  const DELEGATE_SAMPLE = [
    'export function smartTimeCacheKey(iso, created, dayBucket, label) {',
    '  return `${created}|${dayBucket}|${iso}|${label}`;',
    '}',
    'export function formatSmartTime(iso, created, labels, dayBucket) {',
    '  const now = new Date();',
    '  const bucket = dayBucket ?? dayBucketOf(now);',
    '  const cacheKey = created ? smartTimeCacheKey(iso, created, bucket, labels?.yesterday ?? "") : null;',
    '  return cacheKey;',
    '}',
  ].join('\n');
  const dg = analyzeKeyClock(DELEGATE_SAMPLE);
  if (dg.length !== 0) failures.push({ rule: 'key-constructor-no-clock', detail: `委派形态（显式档位入参 + 单一纯函数）被误报 ${dg.length} 处` });
  return failures;
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

if (pruneTerminal) {
  pruneTerminalBaseline();
  process.exit(0);
}

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
    ...checkKeyConstructorNoClock(file, text),
  ]) {
    if (!(RULE_SCOPE[v.rule]?.(relPath) ?? true)) continue;
    // 行内豁免（key-clock-ok: <理由>）走独立通道：计入 allowed，但**打印时可见**，
    // 不是静默放行 —— 残余项必须可观测。
    const allowed = v.exempt === true || Boolean(allowlist[v.rule]?.[relPath]);
    violations.push({ ...v, file: relPath, allowed });
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

// 终态裸比较（规则 6）：双向棘轮比对基线。
const terminalCheck = checkTerminalStatusPredicate();
const terminalFailures = terminalCheck.grew.length + terminalCheck.shrank.length;
if (terminalCheck.total) {
  console.log(`\n[guard] 终态谓词：扫到 ${terminalCheck.total} 处终态裸比较（已登记 ${terminalCheck.total - terminalCheck.grew.reduce((n, g) => n + Math.max(g.extra, 1), 0)} 处 / 未登记 ${terminalCheck.grew.length} 组 / 待精简 ${terminalCheck.shrank.length} 组）；另有 ${terminalCheck.exemptHits} 处落在 ${terminalCheck.exemptFiles} 个**其它域**豁免文件里（豁免清单见 scripts/architecture-guard.mjs#TERMINAL_LITERAL_EXEMPT_FILES）。`);
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
const selfTestFailures = [...selfTestInvariants(), ...selfTestKeyClock()];
for (const f of selfTestFailures) {
  console.error(`[guard] ✗ 门禁自检失败：${f.rule} —— ${f.detail}`);
}
if (selfTestFailures.length) {
  console.error('[guard] 契约门禁检测器已失效 → 拒绝静默放行（exit 2）。请修复检测器后重试。');
  process.exit(2);
}

const invariantViolations = checkInvariants();

if (listOnly) {
  for (const g of terminalCheck.grew) {
    console.log(`  · [terminal-status-predicate] ${g.relPath}:${g.lines.join(',')}  ${g.snippet}`);
  }
  for (const s of terminalCheck.shrank) {
    console.log(`  · [terminal-status-predicate:stale] ${s.relPath}  基线 ${s.expected} 处 / 现状 ${s.have} 处  ${s.snippet}`);
  }
  console.log(`\n[guard] 终态裸比较：${terminalCheck.total} 处（未登记 ${terminalCheck.grew.length} 组，基线待精简 ${terminalCheck.shrank.length} 组）。\n`);
  for (const v of invariantViolations) console.log(`  ✗ [${v.rule}] ${v.file} —— ${v.label}`);
  console.log(FIXTURE_MODE
    ? `\n[guard] 契约不变量：夹具模式跳过（仅真实仓库强制）。\n`
    : `\n[guard] 契约不变量：${invariantChecksTotal - invariantViolations.length}/${invariantChecksTotal} 满足（--list 不失败）。\n`);
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
  console.error('[guard]   这三类不变量（item 认领唯一性 / review_request 受保护 / 依赖引擎判死语义）是正确性底线：');
  console.error('[guard]   删掉它们会退回「同一评审被多分身重复收口 + 空转让位」「瞬时失败的 blocker 误杀依赖方且永不恢复」的线上事故。\n');
  process.exit(1);
}

if (terminalFailures) {
  if (terminalCheck.grew.length) {
    console.error(`\n[guard] ✗ 终态谓词门禁失败：${terminalCheck.grew.length} 组终态裸比较未登记。`);
    console.error('[guard]   「这件工作结束了吗？」只有一个答案入口：isTerminal(status)');
    console.error('[guard]   （@markus/shared#isTerminal / web-ui lib/taskStatus.ts#isTerminal）。');
    console.error('[guard]   裸写 completed/failed/rejected/cancelled/archived 会在新终态出现时静默漏判。');
    for (const g of terminalCheck.grew) {
      console.error(`  ✗ ${g.relPath}:${g.lines.join(',')}`);
      console.error(`      ${g.snippet}`);
      if (g.why === 'MISSING_WHY') {
        console.error(`      ↳ 基线条目存在但 why 为空：请写清它回答的是哪个问题（≥${TERMINAL_WHY_MIN_LENGTH} 字）。`);
      } else if (g.extra > 0) {
        console.error(`      ↳ 计 ${g.extra} 处，基线只登记了其中一部分。`);
      }
    }
    console.error('[guard]   若这是「某个具体状态」而非「是否已结束」（例：只统计 successfully completed），');
    console.error(`[guard]   请在 ${TERMINAL_BASELINE_FILE} 登记该行并写明 why。\n`);
  }
  if (terminalCheck.shrank.length) {
    console.error(`\n[guard] ✗ 终态基线比现状更宽松：${terminalCheck.shrank.length} 组条目对应的代码已不再裸比较。`);
    console.error('[guard]   基线只允许缩小 —— 已清理的请在同一次提交里删除对应条目，否则存量数字永远不会下降。');
    console.error('[guard]   可执行：node scripts/architecture-guard.mjs --prune-terminal-baseline');
    for (const s of terminalCheck.shrank) {
      console.error(`  · ${s.relPath}  基线 ${s.expected} 处 / 现状 ${s.have} 处  ${s.snippet}`);
    }
    console.error('');
  }
  process.exit(1);
}

console.log(FIXTURE_MODE
  ? `\n[guard] ✓ 通过：${violations.length} 处命中全部在已登记白名单内；契约不变量 跳过（夹具模式，仅真实仓库强制）。\n`
  : `\n[guard] ✓ 通过：${violations.length} 处命中全部在已登记白名单内；契约不变量 ${invariantChecksTotal}/${invariantChecksTotal} 满足。\n`);
