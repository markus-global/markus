#!/usr/bin/env node
/**
 * Superagent 机制落地探针 v2 —— CANONICAL-CHECKLIST.md 的完整可执行版本
 *
 * 纪律：**判据由机器给，不由人自评。**
 *
 * 三种状态，只有 🟩 算达标：
 *   🟩 ok      已证明达标
 *   🟥 fail    已证明未达标
 *   🟨 pending 无法静态判定（需运行期 / 真实流量），**同样不算达标**
 *
 * 之所以要有 pending 而不是硬判红：把「不知道」说成「不达标」和把
 * 「不知道」说成「做完了」是同一种谎，只是方向不同。
 *
 * 只读：对生产库只做 SELECT，绝不写。
 *
 * 用法：
 *   node scripts/probe-superagent.mjs                  # 人类可读
 *   node scripts/probe-superagent.mjs --json           # 机器可读
 *   node scripts/probe-superagent.mjs --design <md>    # 校验设计文档（A0 用）
 *   node scripts/probe-superagent.mjs --full           # 额外跑 tsc + 测试（慢）
 *
 * 退出码：0 = 全绿；1 = 存在红项或待判项。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.MARKUS_REPO ?? resolve(HERE, '..');
const DB_PATH = process.env.MARKUS_DB ?? join(homedir(), '.markus', 'data.db');
const UI_SRC = join(REPO, 'packages/web-ui/src');
const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const wantFull = args.includes('--full');
const di = args.indexOf('--design');
const DESIGN_DOC = di >= 0 ? args[di + 1] : null;

// ── 期望覆盖的全部检查项（F1.2 用它自审：少一项就红） ──────────────────────
const EXPECTED_IDS = [
  'A0.1', 'A0.2', 'A0.3',
  'A1.1', 'A1.2', 'A1.3',
  'A2.1', 'A2.2', 'A2.3',
  'A3.1', 'A3.2',
  'A4.1', 'A4.2', 'A4.3',
  'A5.1', 'A5.2',
  'B1.1', 'B1.2',
  'B2.1', 'B2.2', 'B2.3',
  'B3.1', 'B3.2', 'B3.3', 'B3.4', 'B3.5',
  'C1.1', 'C1.2', 'C1.3',
  'C2.1', 'C2.2',
  'D1.1', 'D1.2', 'D1.3', 'D1.4', 'D1.5',
  'D2.1', 'D2.2', 'D2.3',
  'E1.1', 'E1.2', 'E1.3', 'E1.4',
  'E2.1', 'E2.2',
  'F1.1', 'F1.2',
  'F2.1', 'F2.2',
  'G1', 'G2', 'G3', 'G4', 'G5',
];

// ── 收集器 ──────────────────────────────────────────────────────────────────
const results = [];
/**
 * @param {string} id    检查项编号，必须出现在 EXPECTED_IDS
 * @param {string} step  S0–S7，用于按执行序分组输出
 * @param {string} title 一句话说明
 * @param {() => {ok?: boolean, pending?: boolean, detail?: string}} fn
 */
function check(id, step, title, fn) {
  let state = 'fail';
  let detail = '';
  try {
    const r = fn() ?? {};
    state = r.pending ? 'pending' : r.ok ? 'ok' : 'fail';
    detail = r.detail ?? '';
  } catch (e) {
    state = 'fail';
    detail = `探针异常：${String(e).slice(0, 160)}`;
  }
  results.push({ id, step, title, state, detail });
}
const ok = (detail = '') => ({ ok: true, detail });
const fail = (detail = '') => ({ ok: false, detail });
const todo = (detail = '') => ({ pending: true, detail });

// ── 源码检索（grep 封装；命中返回 [文件:行:内容]） ─────────────────────────
const SRC_DIRS = [
  'packages/core/src',
  'packages/org-manager/src',
  'packages/shared/src',
  'packages/web-ui/src',
  'packages/cli/src',
];
function grep(pattern, dirs = SRC_DIRS) {
  const hits = [];
  for (const d of dirs) {
    const abs = join(REPO, d);
    if (!existsSync(abs)) continue;
    try {
      const out = execSync(`grep -rEn ${JSON.stringify(pattern)} ${JSON.stringify(abs)} 2>/dev/null || true`, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      for (const line of out.split('\n')) {
        if (!line) continue;
        // 排除构建产物与依赖
        if (line.includes('/node_modules/') || line.includes('/dist/')) continue;
        hits.push(line);
      }
    } catch {
      /* 目录不可读则跳过 */
    }
  }
  return hits;
}
const grepCount = (pattern, dirs) => grep(pattern, dirs).length;

// ── 假绿防线：注释行与定义行不得被当成「调用点」 ───────────────────────
// 教训：首版探针把 `export function autonomyNeedsApproval` 和 `import ...` 都算成了调用点，
// 于是 B1.2「不再只在声明路径」被误报为绿；「红线机制」也把两行注释当成了机制。
// 探针自己不防假绿，它凭什么替别人把关？
function isCommentLine(line) {
  const parts = line.split(':');
  const content = parts.slice(2).join(':').trim();
  return content.startsWith('//') || content.startsWith('*') || content.startsWith('/*');
}
/** 只看代码行：去掉注释、去掉测试文件 */
function codeHits(pattern, dirs = SRC_DIRS) {
  return grep(pattern, dirs).filter((l) => !isCommentLine(l) && !l.includes('.test.'));
}
/** 只看真实调用表达式：去掉 import / 定义 */
function callSites(name, dirs = SRC_DIRS) {
  return codeHits(`${name}\\(`, dirs).filter(
    (l) => !/^\s*[^:]+:\d+:\s*import\b/.test(l) && !/(export )?function\s+\w+$/.test(l.split(':').slice(2).join(':').trim()),
  );
}
const SHARED_THREAD_DEF = 'shared/src/types/thread.ts';
const isDefFile = (l) => l.includes(SHARED_THREAD_DEF);

// ── 运行时真判据 ────────────────────────────────────────────────────────────
// 教训：文本 grep 只能证明「有人写了这个词」，证不了「这个机制会工作」。
// 首版 B1.1/B1.2 grep 的是 `autonomyNeedsApproval`（授权闸门），而设计里
// 执行前闸门是 `gateAction` —— 探针测错了函数，于是「已接线」和「没接线」
// 在输出上长得一模一样。第三种假绿。
//
// 修法不是换个词继续 grep，而是**把已构建的产物加载进来跑真函数**：
// 判据由机器执行给出，不由源码里出现过某个字符串给出。
//
// 本文件是 ESM，直接顶层 await import 即可 —— 不走子进程、不拼引号。
// （首版用 execSync(`node -e ...`) 拼脚本，被多层转义害得永远返回 null，
//   而 null 又被判成 fail，看起来像「机制没做」，其实只是探针自己写坏了。）
const SHARED_DIST = join(REPO, 'packages/shared/dist/index.js');
let SHARED = null;
if (existsSync(SHARED_DIST)) {
  try {
    SHARED = await import(pathToFileURL(SHARED_DIST).href);
  } catch {
    SHARED = null;
  }
}

/** 跑一个测试文件，true = 全绿；无 node_modules 时返回 null（无法判定）。 */
function runTestFile(relPath) {
  if (!existsSync(join(REPO, 'node_modules'))) return null;
  if (!existsSync(join(REPO, relPath))) return null;
  try {
    execSync(`npx vitest run ${JSON.stringify(relPath)} --reporter=dot`, {
      cwd: REPO, stdio: 'ignore', timeout: 240_000,
    });
    return true;
  } catch {
    return false;
  }
}

/** 这三个是「删除 / 支付 / 对外发布」的代表样本 —— 红线判据的最小充分集。 */
const RED_LINE_SAMPLES = {
  // 删除：数据消失
  delete: ['delete_project', 'workflow_delete', 'task_cleanup_duplicates', 'delete_bucket', 'purge_cache'],
  // 支付：钱离开
  pay: ['pay_invoice', 'refund_order', 'transfer_money', 'purchase_item', 'charge_card'],
  // 对外发布：内容到了外面的世界
  publish: ['publish_article', 'publish_to_xhs', 'deploy_prod', 'release_version'],
};
// 实现文档路径由设计文档推导（A0/G5 要同时看两篇）
const IMPL_DOC = DESIGN_DOC ? DESIGN_DOC.replace('01-分析与目标设计', '02-实现方案与开发计划') : null;

// ── 数据库（只读） ──────────────────────────────────────────────────────────
const db = existsSync(DB_PATH) ? new DatabaseSync(DB_PATH, { readOnly: true }) : null;
function cnt(sql, ...params) {
  if (!db) return 0;
  try {
    const row = db.prepare(sql).get(...params);
    return Number(Object.values(row ?? {})[0] ?? 0);
  } catch {
    return 0;
  }
}
const hasTable = (name) => cnt(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, name) > 0;
const hasText = (path, needle) => {
  if (!path || !existsSync(path)) return false;
  try {
    return readFileSync(path, 'utf8').includes(needle);
  } catch {
    return false;
  }
};

// ══ S0 · 验收门禁先立 ══════════════════════════════════════════════════════

check('F1.1', 'S0', '`pnpm conformance` 可跑', () => {
  const pkgPath = join(REPO, 'package.json');
  if (!existsSync(pkgPath)) return fail('根 package.json 不存在');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const has = !!pkg.scripts?.conformance;
  return has
    ? ok(`scripts.conformance = ${pkg.scripts.conformance}`)
    : fail('根 package.json 无 conformance 脚本 → 「完成与否」仍由人自评');
});

check('F1.2', 'S0', '每条判据都有对应检查（覆盖自审）', () => ({
  // 不能在注册阶段算：那时后面的检查还没注册。汇总时重算（见文件末尾）。
  ok: false,
  detail: '汇总时计算',
}));

// ══ S1 · 设计补丁：threads 的唯一写者 ═══════════════════════════════════════

const designOk = () => !!DESIGN_DOC && existsSync(DESIGN_DOC);

check('A0.1', 'S1', '设计文档写明 threads 的唯一写入入口', () => {
  if (!designOk()) return todo('未提供 --design <path>，无法校验设计文档');
  const hasEntry = hasText(DESIGN_DOC, '唯一写入入口') && hasText(DESIGN_DOC, 'ensure');
  return hasEntry
    ? ok('设计文档含「唯一写入入口」+ ensure')
    : fail('设计文档未写明唯一写入入口');
});

check('A0.2', 'S1', '三条日常链路的调用点各自明确', () => {
  if (!designOk()) return todo('未提供 --design <path>');
  const t = ['persistChatTurn', 'createTask'].filter((n) => hasText(DESIGN_DOC, n));
  const a2a = hasText(DESIGN_DOC, 'a2a') || hasText(DESIGN_DOC, 'A2A');
  return t.length === 2 && a2a
    ? ok('chat / task / a2a 三个调用点均已写明')
    : fail(`缺失调用点：${['persistChatTurn', 'createTask'].filter((n) => !hasText(DESIGN_DOC, n)).join(', ')}${a2a ? '' : ', a2a'}`);
});

check('A0.3', 'S1', '写明「谁不写」（防止长出第二写者）', () => {
  if (!designOk()) return todo('未提供 --design <path>');
  return hasText(DESIGN_DOC, '谁不写')
    ? ok('设计文档含「谁不写」约束')
    : fail('设计文档未列出禁止写入的路径');
});

// ══ S2 · Trigger 身份与幂等（必须在第一次写之前） ═══════════════════════════

check('A4.1', 'S2', 'triggers 表存在且有幂等唯一约束', () => {
  if (!hasTable('triggers')) return fail('triggers 表不存在 → 幂等无载体');
  // `UNIQUE(...)` 生成的是 sqlite_autoindex，其 sqlite_master.sql 为 NULL，
  // 所以 `sql LIKE '%idempotency%'` 在约束**存在时也永远报红**（假红，和假绿一样坏）。
  // 正确做法：PRAGMA index_list → 取 unique 索引 → index_info 看列名。
  try {
    const list = db.prepare('PRAGMA index_list(triggers)').all();
    for (const idx of list) {
      if (!idx.unique) continue;
      const cols = db.prepare(`PRAGMA index_info(${idx.name})`).all().map((c) => c.name);
      if (cols.length === 1 && cols[0] === 'idempotency_key') {
        return ok(`唯一约束：${idx.name}(idempotency_key)`);
      }
    }
    return fail('triggers 表存在，但 idempotency_key 上没有唯一约束');
  } catch (e) {
    return fail(`无法读取索引信息：${String(e).slice(0, 80)}`);
  }
});

check('A4.2', 'S2', '真实触发写入 trigger 并关联 thread', () => {
  if (!hasTable('triggers')) return fail('triggers 表不存在');
  const n = cnt('SELECT COUNT(*) FROM triggers');
  return n > 0 ? ok(`triggers 行数 = ${n}`) : fail('triggers 行数 = 0 → 从未有真实触发走这条路');
});

check('A4.3', 'S2', '重复触发（同 key）返回既有 trigger', () => {
  if (!hasTable('triggers')) return fail('triggers 表不存在');
  const total = cnt('SELECT COUNT(*) FROM triggers');
  // 空表上「无重复」是真空真，和 A1.3 同一个坑
  if (total === 0) return fail('triggers 为空 → 空表上无重复可言，幂等未被验证');
  const dup = cnt(
    `SELECT COUNT(*) FROM (SELECT idempotency_key FROM triggers GROUP BY idempotency_key HAVING COUNT(*) > 1)`,
  );
  return dup === 0 ? ok(`${total} 行，无重复 key`) : fail(`发现 ${dup} 个重复 key`);
});

// ══ S3 · 主干接通：日常流量写 Thread（+ 单一写者伴随约束） ═════════════════

const threadsReady = () => hasTable('threads');
const threadCount = (like) =>
  threadsReady() ? cnt(`SELECT COUNT(*) FROM threads WHERE ref LIKE ?`, like) : 0;

check('A1.1', 'S3', '聊天消息进入 Thread（threads 出现 cs_* 行）', () => {
  if (!threadsReady()) return fail('threads 表不存在');
  const n = threadCount('cs_%');
  return n > 0 ? ok(`cs_* 流数量 = ${n}`) : fail('cs_* 流数量 = 0 → 聊天链路未写 Thread');
});

check('A1.2', 'S3', 'stage 由 deriveStage 派生，且读路径真的用它', () => {
  const defs = codeHits('function deriveStage|const deriveStage');
  if (defs.length === 0) return fail('源码中不存在 deriveStage 定义');
  const calls = callSites('deriveStage').filter((l) => !isDefFile(l));
  if (calls.length === 0) return fail('有定义但生产代码零调用');
  // stage 的合理调用点是**读路径**（/api/threads 组装视图时派生），不是写路径。
  // 首版把判据写成「必须在 api-server/task-service 里」——那是把写和读搞混了，属于假红。
  const readPath = calls.filter((l) => /event-routes|api-server|thread-view|threads/.test(l));
  if (readPath.length === 0) {
    const where = calls.map((l) => l.split(':')[0].split('/').pop()).join(', ');
    return fail(`deriveStage 只在这些地方被调：${where}（不是读路径）`);
  }
  // 没有流时「stage 派生正确」是真空真
  if (!threadsReady()) return fail('threads 表不存在');
  const total = cnt('SELECT COUNT(*) FROM threads');
  if (total === 0) return fail('threads 为空 → 没有东西可派生，stage 未被验证');
  return ok(`读路径调用 ${readPath.length} 处，threads ${total} 行`);
});

check('A1.3', 'S3', '同一消息重复投递不产生第二行', () => {
  if (!threadsReady()) return fail('threads 表不存在');
  const total = cnt('SELECT COUNT(*) FROM threads');
  // 空表上「无重复」是真空真——不能算通过
  if (total === 0) return fail('threads 为空 → 空表上无重复可言，幂等未被验证');
  const dup = cnt(`SELECT COUNT(*) FROM (SELECT ref FROM threads GROUP BY ref HAVING COUNT(*) > 1)`);
  return dup === 0 ? ok(`${total} 行，ref 无重复`) : fail(`${dup} 个 ref 出现多行 → 幂等失效`);
});

check('A2.1', 'S3', '任务进入 Thread（threads 出现 tsk_* 行）', () => {
  if (!threadsReady()) return fail('threads 表不存在');
  const n = threadCount('tsk_%');
  return n > 0 ? ok(`tsk_* 流数量 = ${n}`) : fail('tsk_* 流数量 = 0 → 任务链路未写 Thread');
});

check('A2.2', 'S3', '任务状态变化后该 thread 的 stage 随之变化', () => {
  if (threadCount('tsk_%') === 0) return fail('前置未满足：无 tsk_* 流，无从观察变化');
  return todo('需运行期对比：同一任务状态变更前后的 stage 输出');
});

check('A2.3', 'S3', '任务完成/取消后 stage 变为 idle（不再出现在「等你处理」）', () => {
  if (threadCount('tsk_%') === 0) return fail('前置未满足：无 tsk_* 流');
  return todo('需运行期验证：完成一条任务后，该 ref 是否从概览行动台消失');
});

check('A3.1', 'S3', 'A2A 消息进入 Thread（threads 出现 a2a_* 行）', () => {
  if (!threadsReady()) return fail('threads 表不存在');
  const n = threadCount('a2a_%');
  return n > 0 ? ok(`a2a_* 流数量 = ${n}`) : fail('a2a_* 流数量 = 0 → A2A 链路未写 Thread');
});

check('A3.2', 'S3', '同一条 A2A 消息不产生两个 thread', () => {
  if (threadCount('a2a_%') === 0) return fail('前置未满足：无 a2a_* 流');
  return todo('需运行期验证：同一消息 id 重投后 ref 不新增');
});

check('A5.1', 'S3', '`/api/threads` 返回条数 > 0（真实流量，非种子）', () => {
  if (!threadsReady()) return fail('threads 表不存在');
  const n = cnt('SELECT COUNT(*) FROM threads');
  return n > 0 ? ok(`threads 总行数 = ${n}`) : fail('threads 总行数 = 0');
});

check('A5.2', 'S3', 'Thread 视图首屏 ≥3 条流，且含 tsk_ 与 cs_ 各至少一条', () => {
  if (!threadsReady()) return fail('threads 表不存在');
  const total = cnt('SELECT COUNT(*) FROM threads');
  const tsk = threadCount('tsk_%');
  const cs = threadCount('cs_%');
  return total >= 3 && tsk > 0 && cs > 0
    ? ok(`总 ${total} 条（tsk ${tsk} / cs ${cs}）`)
    : fail(`总 ${total} 条（tsk ${tsk} / cs ${cs}）→ 不足 3 条或缺某一类`);
});

// ── E. 单一写者（贯穿约束，不是阶段） ──────────────────────────────────────

const PRESENTATION = join(UI_SRC, 'lib/threadPresentation.ts');

check('E1.1', 'S3', '`lib/threadPresentation.ts` 单一实现存在', () =>
  existsSync(PRESENTATION) ? ok('文件存在') : fail('不存在 → 文案/时间格式化仍是多份副本'),
);

check('E1.2', 'S3', '除该文件外无 STAGE_LABEL / ACTION_LABEL 定义副本', () => {
  // 判据纠偏：原版查「person:approval 字面量 0 处」，但那会把业务比较
  // （`if (th.stage === 'person:approval')`）误判为副本。
  // 第二个写者的定义是「又定义了一份表」，不是「读了一次这个值」。
  const hits = codeHits('const (STAGE_LABEL|ACTION_LABEL)\\s*:', ['packages/web-ui/src']).filter(
    (l) => !l.includes('lib/threadPresentation.ts'),
  );
  return hits.length === 0
    ? ok('0 处副本定义')
    : fail(`${hits.length} 处副本：${hits[0]?.slice(0, 120)}`);
});

check('E1.3', 'S3', '除该文件外 `relTime|relAge|humanDuration` 0 处', () => {
  const hits = grep('function (relTime|relAge|humanDuration)', ['packages/web-ui/src']).filter(
    (l) => !l.includes('lib/threadPresentation.ts'),
  );
  return hits.length === 0 ? ok('0 处重复实现') : fail(`${hits.length} 份重复实现`);
});

check('E1.4', 'S3', '已分叉文案统一（两套说法不同时存在于**代码**里）', () => {
  // 判据纠偏：原版数的是全文本，连注释也算 → 单一实现自己在注释里解释历史分叉
  // （「曾有两套说法……」）反而把判据弄红了。注释里提到旧文案不是第二个写者。
  // 真正要拦的是：两套说法同时出现在会被渲染的代码里。
  const pairs = [
    ['等你回话', '等你回答'],
    ['等你解锁', '等你解阻'],
  ];
  const live = (s) =>
    codeHits(s, ['packages/web-ui/src']).filter((l) => !l.includes('lib/threadPresentation.ts'));
  const bad = [];
  for (const [a, b] of pairs) {
    if (live(a).length > 0 && live(b).length > 0) bad.push(`${a} / ${b}`);
  }
  return bad.length === 0 ? ok('无分叉（代码层）') : fail(`两套说法并存：${bad.join('、')}`);
});

check('E2.1', 'S3', '`architecture-guard` 有防回流规则', () => {
  const gp = join(REPO, 'scripts/architecture-guard.mjs');
  if (!existsSync(gp)) return fail('architecture-guard.mjs 不存在');
  const txt = readFileSync(gp, 'utf8');
  const has = txt.includes('threadPresentation') || txt.includes('person:approval');
  return has ? ok('守卫已含单一写者规则') : fail('守卫未盯「同一语义常量重复定义」');
});

check('E2.2', 'S3', '故意造一份副本时守卫会变红（证明它真会咬）', () =>
  todo('需变更测试：临时写入副本 → 跑守卫 → 断言非零退出'),
);

// ══ S4 · 安全闸门覆盖真实动作（必须先于主动性） ═══════════════════════════

const dispositionsReady = () => hasTable('thread_dispositions');

check('B2.1', 'S4', 'observe 档位的真实不可逆动作被拦下', () => {
  if (!dispositionsReady()) return fail('thread_dispositions 表不存在');
  const n = cnt(
    `SELECT COUNT(*) FROM thread_dispositions WHERE reason LIKE '%autonomy%' OR reason LIKE '%observe%'`,
  );
  return n > 0
    ? ok(`被 autonomy 拦下的记录 = ${n}`)
    : fail('0 条 → 要么从未真正拦过，要么从未有 publish 尝试过');
});

check('B2.2', 'S4', '拒绝时留 disposition 且 reason 非空', () => {
  if (!dispositionsReady()) return fail('thread_dispositions 表不存在');
  const bad = cnt(`SELECT COUNT(*) FROM thread_dispositions WHERE reason IS NULL OR reason = ''`);
  const total = cnt('SELECT COUNT(*) FROM thread_dispositions');
  if (total === 0) return fail('dispositions 为空 → 无审计事实');
  return bad === 0 ? ok(`${total} 条记录全部带 reason`) : fail(`${bad} 条记录 reason 为空`);
});

check('B2.3', 'S4', '`auto` 档位同一动作放行并记录', () =>
  todo('需运行期验证：同一动作在 observe 被拒、auto 放行，两种结果各留一条 disposition'),
);

// ══ S5 · 主动性：rest 工具与等待语义 ═══════════════════════════════════════

check('C1.1', 'S5', '`rest` 工具已注册进 agent 工具表', () => {
  // 「注册」在本仓库发生在两处（schedule_wakeup 是同一个结构）：
  //   tool-selector.ts 的 pushUnique → 模型看得到 schema
  //   agent.ts 的 toolCall.name 分支 → 调用能落地
  // 只查 packages/core/src/tools/ 会漏掉这两个真实位置；
  // 原判据还多传了一个 [] 把默认目录覆盖空，于是永远搜不到（误报红）。
  const schema = grep("name:\\s*['\"]rest['\"]", ['packages/core/src/tool-selector.ts']);
  const handler = grep("toolCall\\.name === ['\"]rest['\"]", ['packages/core/src/agent.ts']);
  const n = schema.length + handler.length;
  if (schema.length === 0) return fail('tool-selector.ts 无 rest schema — 模型看不到这个工具');
  if (handler.length === 0) return fail('agent.ts 无 rest 执行分支 — 调用了也不会落地');
  return ok(`rest 已注册（schema ${schema.length} 处 + 执行 ${handler.length} 处）`);
});

check('C1.2', 'S5', '调用 rest 返回结构化结果（不是空实现）', () => {
  // 静态可验的部分：返回值必须带结构化字段，而不能是一句成功文案。
  // 真正的行为保证在 rest-plan.test.ts（17 项），这里只防「退化成空实现」。
  const fields = ['rest_id', 'wake_at', 'bounded_ms', 'fallback_timeout_added', 'rest_streak'];
  const missing = fields.filter(f => grep(f, ['packages/core/src/agent.ts']).length === 0);
  if (missing.length > 0) return fail(`返回值缺字段: ${missing.join(', ')}`);
  const t = existsSync(join(REPO, 'packages/core/test/rest-plan.test.ts'));
  return t
    ? ok('结构化返回 + rest-plan.test.ts 行为测试在')
    : fail('缺 rest-plan.test.ts — 边界无行为测试守');
});

check('C1.3', 'S5', 'rest 后 agent 不空转（心跳期间无 LLM 调用）', () => {
  // 判据：心跳触发路径必须存在「正在 rest 就跳过」的分支。
  // 无法静态证明运行时确实零 LLM（需真实心跳观察），但可以证明闸门接上了——
  // 接不上是这一项最典型的失败形态（工具建了、心跳照跑）。
  const hasFn = grep('hasActiveRest\\(\\)', ['packages/core/src/agent.ts']);
  if (hasFn.length < 2) return fail('hasActiveRest 未定义或在心跳路径未被调用');
  return ok('心跳在 hasActiveRest() 时跳过（运行时零 LLM 需真实观察）');
});

check('C2.1', 'S5', 'router 在该 thread 有新事件时唤醒 agent', () => {
  // 判据：事件路由完成 → 命中条件 → 取走等待者，三段必须都存在且相接。
  // 不断言端到端唤醒：ThreadService.route() 目前没有生产调用方（ingress 缺口），
  // 写成 todo 会让「通路不存在」和「通路在、没人调」看起来一样——这两件事
  // 的负责人和修法完全不同，必须分开表达。
  const hasMatcher = grep('restConditionMatches', ['packages/core/src/rest-wake.ts']).length > 0;
  const hasTake = grep('takeRestMatches', ['packages/core/src/pending-callback.ts']).length > 0;
  const hasHook = grep('notifyWake', ['packages/core/src/thread-service.ts']).length >= 2;
  const missing = [!hasMatcher && 'restConditionMatches', !hasTake && 'takeRestMatches', !hasHook && 'ThreadService.notifyWake']
    .filter(Boolean);
  if (missing.length) return fail(`通路缺段：${missing.join(' / ')}`);
  return ok('匹配→取走→通知三段已接；ingress（谁调 route）待接');
});

check('C2.2', 'S5', '唤醒后拿到「新事件摘要」而非重读全部历史', () => {
  // 判据：唤醒载荷必须是「摘要」而不是「历史正文」。
  // 这里验的是构造函数的实际行为——一旦有人往载荷里塞整段对话，rest 就退化
  // 成「醒了再读一遍」，省下的 token 全还回去了。
  const p = 'packages/core/src/rest-wake.ts';
  const hasBuilder = grep('buildWakePayload', [p]).length > 0;
  if (!hasBuilder) return fail('缺 buildWakePayload — 唤醒载荷无构造点');
  const saysNoReplay = grep('不需要重读全部历史', [p]).length > 0;
  if (!saysNoReplay) return fail('载荷未声明「不需重读历史」— 唤醒语义未固化为契约');
  const testFile = 'packages/core/test/rest-wake.test.ts';
  const testsPayload = grep('buildWakePayload', [testFile]).length >= 2;
  if (!testsPayload) return fail('载荷构造无行为测试守');
  return ok('载荷只含摘要 + 契约声明 + 行为测试在');
});

// ══ S6 · Thread 事件时间线（读模型，必须最后） ════════════════════════════

check('D1.1', 'S6', '`thread_events` 表存在', () =>
  hasTable('thread_events')
    ? ok('表已存在')
    : fail('表不存在 → 会话/评论/A2A 正文时间线无数据源'),
);

const eventCount = (kind) =>
  hasTable('thread_events') ? cnt('SELECT COUNT(*) FROM thread_events WHERE kind = ?', kind) : 0;

for (const [id, kind, title] of [
  ['D1.2', 'chat', '会话消息写入 event'],
  ['D1.3', 'comment', '任务评论写入 event'],
  ['D1.4', 'a2a', 'A2A DM 写入 event'],
]) {
  check(id, 'S6', title, () => {
    if (!hasTable('thread_events')) return fail('thread_events 表不存在');
    const n = eventCount(kind);
    return n > 0 ? ok(`${kind} 事件 ${n} 条`) : fail(`${kind} 事件 0 条`);
  });
}

check('D1.5', 'S6', 'event 只追加、不可改（无 UPDATE 路径）', () => {
  // 表不存在时「无 UPDATE」是真空真——空无不能当通过
  if (!hasTable('thread_events')) return fail('thread_events 表不存在 → 「只追加」无从谈起');
  const upd = grep('UPDATE thread_events', SRC_DIRS).length;
  return upd === 0 ? ok('表存在且源码中无 UPDATE thread_events') : fail(`发现 ${upd} 处 UPDATE`);
});

check('D2.1', 'S6', 'Thread 视图按时间渲染「真实事件 + 决定 + 当前状态」三类不混', () =>
  todo('需浏览器验证：打开一条流，检查三类节点是否分区且带时间戳'),
);

check('D2.2', 'S6', '页面顶部「诚实边界」告示已被删除', () => {
  const hits = grepCount('诚实边界', ['packages/web-ui/src']);
  return hits === 0 ? ok('告示已移除（说明不再有边界）') : fail(`仍有 ${hits} 处「诚实边界」告示`);
});

check('D2.3', 'S6', '一条真实流能看到 ≥3 个带时间戳的节点', () => {
  // 判据必须走完「有数据 → 能查到 → 页面渲染」三段。
  //
  // 为什么不能只查数据库（实测踩到，2026-11-02）：
  // thread_events 里确实有 41 条挂着同一条流，但读取端当时拿业务 ref（tsk_xxx）
  // 去查内部 thread_id（thr_xxx）→ 接口恒返回 []，页面一片空白，**且不报错**。
  // 只断言「表里有 ≥3 行」会把这个 bug 判成绿 —— 数据在、但没人看得到。
  if (!hasTable('thread_events')) return fail('thread_events 表不存在');

  const rich = cnt(
    `SELECT COUNT(*) FROM (
       SELECT thread_id FROM thread_events
       WHERE created_at IS NOT NULL
       GROUP BY thread_id HAVING COUNT(*) >= 3
     )`,
  );
  if (rich === 0) return fail('没有任何一条流攒到 ≥3 个带时间戳的事件');

  // 读取端必须做身份解析 —— id 与 ref 都要能落到同一条流。
  // 缺了它，上面那批数据对 Thread 视图等于不存在。
  if (grep('resolveThreadId', ['packages/org-manager/src/event-routes.ts']).length === 0) {
    return fail(`${rich} 条流有数据，但读取端未做身份解析（ref 查不到 → 页面空白）`);
  }

  // ── 第三段：仓储必须真的接进读取路径（2026-11-02 浏览器实测抓到的漏）──
  // 上一版探针只查到「解析函数存在」就放行了，于是漏掉了真正的断点：
  // `api-server` 往 `handleEventRoutes` 传 repos 时**没带 threadEventRepo**，
  // 读取端拿到 undefined 就回 `{ events: [] }`（那是有意的降级），
  // 结果 41 条事件在库、接口恒空、页面空白，**全程不报错**。
  // 教训：判「函数存在」不等于判「数据能流到页面」。缺的是接线，就得查接线。
  const wired = codeHits('threadEventRepo:\\s*this\\.storage\\.threadEventRepo', ['packages/org-manager/src'])
    .filter((l) => l.includes('api-server.ts'));
  if (wired.length === 0) {
    return fail(`${rich} 条流有数据、解析函数也在，但 api-server 未把 threadEventRepo 接进 repos → 接口恒返回 []、页面空白且不报错`);
  }
  // 而且它必须是**必填**：曾经是 `threadEventRepo?: any`，漏传不报类型错，
  // 于是同一个漏可以再犯一次。已改成必填，这里防回退。
  const optional = codeHits('threadEventRepo\\?\s*:', ['packages/org-manager/src'])
    .filter((l) => l.includes('event-routes.ts'));
  if (optional.length > 0) {
    return fail('EventRouteDeps.threadEventRepo 又变回可选了 → 漏传将再次静默');
  }

  // 前端必须把事件合流进时间线，而不是各自渲染成孤立区块。
  const merges = grep('events.map', ['packages/web-ui/src/pages/ThreadView.tsx']).length > 0;
  if (!merges) return fail('ThreadView 未把事件合流进时间线');

  return ok(`${rich} 条流有 ≥3 个带时间戳节点；解析 + 仓储接线（必填）+ 前端合流三段均在`);
});

// ══ S7 · 闸门位置 + 四档语义 + 真实端到端 + 回归 ══════════════════════════

check('B1.1', 'S7', '存在统一动作前闸门，被 publish/delete/pay 调用', () => {
  // 三段判据，缺一不合：
  //   ① 判据函数真的存在于产物里（不是源码里出现过这个词）
  //   ② 三类红线样本真的被判为不可自主（运行期求值，不是 grep）
  //   ③ 这个判据真的装在了唯一工具收口上（executeTool 里调用 enforceRedLine）
  // 教训：首版 grep `autonomyNeedsApproval` —— 那是**授权闸门**，不是执行闸门，
  // 于是「已接线」与「没接线」在输出上长得一模一样。
  const gateFile = join(REPO, 'packages/core/src/action-gate.ts');
  if (!existsSync(gateFile)) return fail('缺少 action-gate.ts：动作前闸门不存在');
  if (!SHARED || typeof SHARED.isRedLineAction !== 'function') {
    return fail('shared 产物里没有 isRedLineAction（未构建，或分级器未导出）');
  }

  const leaked = [];
  for (const [kind, tools] of Object.entries(RED_LINE_SAMPLES)) {
    for (const n of tools) {
      if (!SHARED.isRedLineAction(n)) leaked.push(`${n}(${kind})`);
    }
  }
  if (leaked.length > 0) return fail(`这些红线样本未被判为不可自主：${leaked.join(', ')}`);

  // 装在哪里才算数：必须在 executeTool（所有 loop 的唯一收口）里被调用。
  const wired = codeHits('this\\.enforceRedLine\\(', ['packages/core/src'])
    .filter((l) => l.includes('agent.ts'));
  if (wired.length === 0) return fail('闸门存在但未接入 executeTool → 真实动作仍裸奔');

  return ok(`删除/支付/发布共 ${Object.values(RED_LINE_SAMPLES).flat().length} 个样本全部判为不可自主，且已接入 executeTool`);
});

check('B1.2', 'S7', '`resource_bind` 不再是唯一闸门调用点', () => {
  // 不再用「某个函数名出现在几个文件里」当判据 —— 那测的是措辞。
  // 改为问：**除声明路径外，还有没有谁真的会因为它而被拦住？**
  //   ① 执行闸门在工具收口被调用（agent.ts）
  //   ② 动作分级在 shared 里是唯一事实源（不是各工具各写一份）
  //   ③ 行为测试证明「拦住」而不只是「调用过」
  const wired = codeHits('this\\.enforceRedLine\\(', ['packages/core/src']).filter((l) => l.includes('agent.ts'));
  const classifier = join(REPO, 'packages/shared/src/types/action-class.ts');
  if (!existsSync(classifier)) return fail('缺少 action-class.ts：动作分级没有唯一事实源');
  if (wired.length === 0) return fail('闸门仅存在于声明路径（resource-tools），真实动作未覆盖');

  const behavior = runTestFile('packages/core/test/action-gate.test.ts');
  if (behavior === null) return todo('已接入 executeTool，但无法运行行为测试（未安装依赖）');
  if (!behavior) return fail('行为测试未通过：闸门「调用了」但没真的拦住');
  return ok(`resource-tools 之外 ${wired.length} 处真实拦截点，行为测试全绿（拒绝 + 工具未执行）`);
});

const AUTONOMY_CASES = [
  ['B3.1', 'off → 直接拒绝且不记录判断', 'off', 'drop'],
  ['B3.2', 'observe → 记录判断，不执行', 'observe', 'record-only'],
  ['B3.3', 'auto → 执行，事后登记', 'auto', 'deliver'],
  ['B3.4', 'trusted → 执行，不逐次登记', 'trusted', 'deliver'],
];
for (const [id, title, level, expected] of AUTONOMY_CASES) {
  check(id, 'S7', title, () => {
    // 首版只 grep `'off'` 这种字面量 —— 它证明的是「这个词出现过」，
    // 证不了「这个档位会被读」。而真实死法恰恰是：autonomy 存在绑定表里、
    // gateVerdict 从不读它，于是 observe 档的 agent 照样被叫醒。
    // 现在问三件事：档位存在、投影正确、路由真的消费它。
    const defined = grep(`'${level}'`, SRC_DIRS).filter((l) => !l.includes('.test.'));
    if (defined.length === 0) return fail(`源码中不存在 '${level}' 档位`);
    if (!SHARED || typeof SHARED.deliveryFor !== 'function') {
      return fail('shared 产物里没有 deliveryFor（四档投影未导出）');
    }

    const actual = SHARED.deliveryFor(level);
    if (actual !== expected) {
      return fail(`档位 '${level}' 应投射为 ${expected}，实际 ${actual}`);
    }

    const wire = codeHits('deliveryForOwner\\(', ['packages/core/src'])
      .filter((l) => l.includes('thread-service.ts'));
    if (wire.length === 0) return fail(`档位 '${level}' 有定义但路由不读它 → 机制存在、没有消费方`);

    const behavior = runTestFile('packages/core/test/autonomy-routing.test.ts');
    if (behavior === null) return todo(`档位 '${level}' 投影为 ${expected}，但无法运行行为测试（未安装依赖）`);
    if (!behavior) return fail(`档位 '${level}' 行为测试未通过：投影对但路由没照做`);
    return ok(`档位 '${level}' → ${expected}，路由已消费，行为测试全绿`);
  });
}

check('B3.5', 'S7', '红线动作（删除/支付/对外发布）在 trusted 档仍被拦', () => {
  // 首版 grep「红线」二字，把 web-ui 文案和注释都当成了机制 —— 假绿的第二种。
  // 现在直接问运行期：**给定 trusted（最高档），这些动作还拦不拦得住？**
  // 反证法：若有人给 admin 开口子、或红线改由档位参数决定，这里立刻红。
  if (!SHARED || typeof SHARED.classifyToolAction !== 'function') {
    return fail('shared 产物里没有 classifyToolAction（未构建，或分级器未导出）');
  }
  const samples = Object.values(RED_LINE_SAMPLES).flat();
  const through = [];
  for (const n of samples) {
    const scope = SHARED.classifyToolAction(n).scope;
    if (SHARED.gateAction(scope, 'trusted') !== 'deny') through.push(`${n}(${scope})`);
  }
  if (through.length > 0) return fail(`trusted 档下仍可执行：${through.join(', ')}`);
  return ok(`${samples.length} 个删除/支付/发布样本在 trusted 档全部被拦（红线是平台不变量，不是档位参数）`);
});

check('F2.1', 'S7', '内容 agent 在一次对话内走完「声明负责 → 收信号 → 提下一步」，全程无人点 UI', () =>
  todo('需真实端到端演练（设计原文判据，未执行过）'),
);

check('F2.2', 'S7', '该过程在 threads / dispositions / thread_events 三张表都留痕', () => {
  if (!threadsReady()) return fail('threads 表不存在');
  const t = cnt('SELECT COUNT(*) FROM threads');
  const d = dispositionsReady() ? cnt('SELECT COUNT(*) FROM thread_dispositions') : 0;
  const e = hasTable('thread_events') ? cnt('SELECT COUNT(*) FROM thread_events') : 0;

  // 这一段以前只数生产库的行数，把两件完全不同的事压成了一句「至少一张为空」：
  //   ① 机制坏了 —— 真 bug，必须红
  //   ② 功能还没被真实用过 —— 不是 bug，不该报红
  // 生产库里 event_sources / bindings / subscriptions / triggers / dispositions
  // 全是 0 行，说明这条链路从未被走过。此时报「红」等于把「没用过」说成「坏了」，
  // 和把「不知道」说成「做完了」是同一种谎。
  //
  // 所以先验机制（真 SQLite 端到端），再分开陈述真实流量。
  const mechanism = runTestFile('packages/org-manager/test/thread-e2e-autonomy.test.ts');
  if (mechanism === false) {
    return fail(`机制坏了：真库端到端测试未通过（threads ${t} / dispositions ${d} / events ${e}）`);
  }
  if (mechanism === null) {
    return todo(`无法运行端到端测试（未安装依赖）；生产库 threads ${t} / dispositions ${d} / events ${e}`);
  }

  if (t > 0 && d > 0 && e > 0) {
    return ok(`机制已验证 + 生产已有真实流量：threads ${t} / dispositions ${d} / events ${e}`);
  }
  return todo(
    `机制已验证（真库端到端三表均能留痕），但生产尚无真实流量：`
    + `threads ${t} / dispositions ${d} / events ${e} —— 需一次真实的「声明负责 → 收信号」演练`,
  );
});

// ── G. 回归与诚实性 ────────────────────────────────────────────────────────

function run(cmd) {
  try {
    execSync(cmd, { cwd: REPO, encoding: 'utf8', stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
    return { okRun: true, out: '' };
  } catch (e) {
    return { okRun: false, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
}

check('G1', 'S7', '前后端 tsc 全绿', () => {
  if (!wantFull) return todo('未带 --full，跳过（慢）');
  const r = run('pnpm -s exec tsc -b');
  return r.okRun ? ok('tsc -b 通过') : fail(`tsc 失败：${r.out.slice(-300)}`);
});

check('G2', 'S7', '全量测试绿', () => {
  if (!wantFull) return todo('未带 --full，跳过（慢）');
  const r = run('pnpm -s vitest run --project node');
  return r.okRun ? ok('全量测试通过') : fail(`测试失败：${r.out.slice(-300)}`);
});

check('G3', 'S7', '探针跑在真实数据库上（不是夹具）', () => {
  if (!db) return fail(`真实库不可读：${DB_PATH}`);
  if (!DB_PATH.includes('.markus')) return fail(`当前库路径不像生产库：${DB_PATH}`);
  const size = (statSync(DB_PATH).size / 1024 ** 3).toFixed(1);
  return ok(`${DB_PATH}（${size} GB，只读打开）`);
});

check('G4', 'S7', '最终状态无红项、无待判项', () => ({ ok: false, detail: '汇总时计算' }));

check('G5', 'S7', '残余项明确写成「设计取舍」并说明理由', () => {
  const docs = [DESIGN_DOC, IMPL_DOC].filter((d) => d && existsSync(d));
  if (docs.length === 0) return todo('未提供 --design <path>');
  const hit = docs.find((d) => hasText(d, '残余') || hasText(d, '设计取舍'));
  return hit ? ok(`声明在 ${hit.split('/').pop()}`) : fail('两篇文档都未声明残余/取舍');
});

// ══ 汇总 ═══════════════════════════════════════════════════════════════════

// F1.2 是派生项：覆盖自审必须在所有检查注册完之后算
const f12 = results.find((r) => r.id === 'F1.2');
const registeredIds = new Set(results.map((r) => r.id));
const missingIds = EXPECTED_IDS.filter((id) => !registeredIds.has(id));
if (f12) {
  f12.state = missingIds.length === 0 ? 'ok' : 'fail';
  f12.detail =
    missingIds.length === 0
      ? `已注册 ${EXPECTED_IDS.length} / ${EXPECTED_IDS.length} 项检查`
      : `缺 ${missingIds.length} 项：${missingIds.join(', ')}`;
}

// G4 是派生项：所有其它项全绿才算绿
const others = results.filter((r) => r.id !== 'G4');
const g4 = results.find((r) => r.id === 'G4');
const notGreen = others.filter((r) => r.state !== 'ok');
if (g4) {
  g4.state = notGreen.length === 0 ? 'ok' : 'fail';
  g4.detail =
    notGreen.length === 0
      ? '全部检查达标'
      : `仍有 ${notGreen.length} 项未达标（${notGreen.slice(0, 8).map((r) => r.id).join(', ')}${notGreen.length > 8 ? ' …' : ''}）`;
}

const byState = (s) => results.filter((r) => r.state === s);
const green = byState('ok').length;
const red = byState('fail').length;
const pending = byState('pending').length;
const ICON = { ok: '🟩', fail: '🟥', pending: '🟨' };
const STEPS = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'];

if (wantJson) {
  console.log(
    JSON.stringify(
      { dbPath: DB_PATH, repo: REPO, design: DESIGN_DOC, green, red, pending, results },
      null,
      2,
    ),
  );
} else {
  const size = db ? (statSync(DB_PATH).size / 1024 ** 3).toFixed(1) : '?';
  console.log(`\n探针目标库：${DB_PATH}（${size} GB，只读）`);
  console.log(`探针仓库：${REPO}`);
  console.log(`设计文档：${DESIGN_DOC ?? '（未提供 --design）'}\n`);
  for (const step of STEPS) {
    const rows = results.filter((r) => r.step === step);
    if (rows.length === 0) continue;
    const g = rows.filter((r) => r.state === 'ok').length;
    const p = rows.filter((r) => r.state === 'pending').length;
    console.log(`── ${step}  🟩${g} / 🟨${p} / 🟥${rows.length - g - p} ──`);
    for (const r of rows) {
      console.log(`${ICON[r.state]} ${r.id}  ${r.title}`);
      if (r.detail) console.log(`        ${r.detail}`);
    }
    console.log('');
  }
  console.log(`合计：🟩 ${green} / 🟨 ${pending} / 🟥 ${red}（覆盖 ${results.length} / ${EXPECTED_IDS.length} 项）`);
  console.log('只有 🟩 算达标。🟨 表示「无法静态判定」，同样不算完成。\n');
}

db?.close();
process.exit(red > 0 || pending > 0 ? 1 : 0);


