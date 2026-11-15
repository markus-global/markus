import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { maySelfInitiate } from '../src/types/agent.js';

/**
 * A5 守卫：`autonomy` 只有一个**决策点**。
 *
 * 为什么需要这条测试：
 *   「这个 agent 能不能自己开工」这个问题，只要允许被两处回答，两处迟早会分歧 ——
 *   一处判 `observe` 一处判 `act`，症状是同一个 agent 有时巡逻有时不巡逻，
 *   而任何单点测试都还是绿的。所以判据收敛成一个具名纯函数 `maySelfInitiate()`，
 *   并在这里把「调用点数量」钉死。
 *
 * 注意这里断言的不是 `.autonomy` 这个**字段**的读取次数 —— 持久化层（storage
 * 的 `_map` / INSERT / UPDATE、agent-manager 的 create/restore 装配）必须读它，
 * 那是搬运事实，不是做决定。被钉死的是**决定**：谁有权回答「能不能自主开工」。
 */

const REPO_ROOT = resolve(__dirname, '../../..');
const SCAN_ROOTS = ['packages'];

/** 判据自身所在的文件 —— 定义在那里是正常的，不算消费点。 */
const DEFINITION_FILE = join(REPO_ROOT, 'packages/shared/src/types/agent.ts');

function collectFiles(): Array<{ path: string; source: string }> {
  const out: Array<{ path: string; source: string }> = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git' || entry === 'dist-electron') continue;
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry) && !entry.endsWith('.test.ts')) {
        try {
          out.push({ path: full, source: readFileSync(full, 'utf8') });
        } catch {
          /* unreadable: it cannot be a consumer */
        }
      }
    }
  };
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root));
  return out;
}

const FILES = collectFiles();

/**
 * 剥掉注释再找调用点。
 *
 * 守卫的语义是「谁**执行**了这个判据」——注释不执行。第一次跑这条测试时它抓到了
 * declarations.ts 里一句 ``maySelfInitiate()`` 的说明文字，那不是第二个写者，
 * 是文档。若为了让测试变绿去改注释措辞，守卫就变成「不许写字」而不是「不许分叉」。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // 前面不是 ':' 的 // 才是注释，避免把 https:// 之类当注释截断整行
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('A5 autonomy — 判据行为', () => {
  it("只有 'observe' 会拦下自发起工", () => {
    expect(maySelfInitiate('observe')).toBe(false);
    expect(maySelfInitiate('act')).toBe(true);
  });

  it('缺省 / 未知值 fail-open 到旧行为（历史行不该因新字段突然停摆）', () => {
    expect(maySelfInitiate(undefined)).toBe(true);
    expect(maySelfInitiate('')).toBe(true);
    // 未来若混进四档词汇或脏数据，未显式声明 observe 的一律当 act。
    expect(maySelfInitiate('act-on-assignment')).toBe(true);
    expect(maySelfInitiate('act-proactively')).toBe(true);
    expect(maySelfInitiate('garbage')).toBe(true);
  });
});

describe('A5 autonomy — 单一消费点', () => {
  it('maySelfInitiate() 在定义处之外只被调用一次（新增消费点必须改本测试）', () => {
    const callSites: string[] = [];
    for (const { path, source } of FILES) {
      if (path === DEFINITION_FILE) continue;
      // 匹配 `maySelfInitiate(` 的调用，排除同一行里的函数声明/类型位置。
      const matches = stripComments(source).match(/\bmaySelfInitiate\s*\(/g);
      if (matches) callSites.push(`${path} × ${matches.length}`);
    }

    expect(
      callSites,
      'autonomy 的判据只允许有一个执行点。若你确实需要第二个决策点，' +
        '请先说明为什么它不是「同一个问题两个写者」，再更新本测试。',
    ).toEqual([join(REPO_ROOT, 'packages/core/src/agent.ts') + ' × 1']);
  });

  it("决定点落在心跳 tick —— agent 唯一能「自己醒来」的入口", () => {
    const agent = FILES.find(f => f.path === join(REPO_ROOT, 'packages/core/src/agent.ts'));
    expect(agent, 'agent.ts 必须存在').toBeDefined();
    const src = agent!.source;

    // 消费点必须在 heartbeat:trigger 监听器内，而不是别处随手判一下。
    const listenerStart = src.indexOf("on('heartbeat:trigger'");
    expect(listenerStart, 'heartbeat:trigger 监听器必须存在').toBeGreaterThan(-1);
    const listenerEnd = src.indexOf('this.runHeartbeatPatrol(triggeredAt)', listenerStart);
    expect(listenerEnd, '监听器内应有 runHeartbeatPatrol 调用').toBeGreaterThan(listenerStart);

    const callIdx = src.indexOf('maySelfInitiate(', listenerStart);
    expect(
      callIdx > listenerStart && callIdx < listenerEnd,
      'maySelfInitiate() 的调用必须落在 heartbeat:trigger 监听器内 —— ' +
        '那是 agent 唯一自发起工的入口，判定放在别处就收不住这条路径。',
    ).toBe(true);
  });

  it('observe 分支走 recordHeartbeatSkip，而不是裸 return（否则 UI 上永远像掉线）', () => {
    const agent = FILES.find(f => f.path === join(REPO_ROOT, 'packages/core/src/agent.ts'));
    const src = agent!.source;
    const callIdx = src.indexOf('!maySelfInitiate(');
    expect(callIdx, '应以否定形式拦下，读起来才是「不允许自发起工」').toBeGreaterThan(-1);

    // 判定后紧跟的语句必须是 recordHeartbeatSkip —— 它负责写 last_heartbeat。
    // 裸 return 只掐掉巡逻却不报存活 = 「状态正确 + 可观测面全失明」。
    const after = src.slice(callIdx, callIdx + 400);
    expect(
      after.includes('recordHeartbeatSkip('),
      'observe 分支必须调用 recordHeartbeatSkip 上报存活；直接 return 会让该 agent ' +
        '在 UI 上永远处于「未上报心跳」状态，等于把「只读档」做成「死掉档」。',
    ).toBe(true);
  });
});

describe('A5 autonomy — 持久化兼容读（不动历史数据）', () => {
  it('agents 表新增列带 DEFAULT，历史行无需回填', () => {
    const storage = FILES.find(f =>
      f.path === join(REPO_ROOT, 'packages/storage/src/sqlite-storage.ts'),
    );
    expect(storage, 'sqlite-storage.ts 必须存在').toBeDefined();
    const src = storage!.source;

    // 建表 DDL 与迁移 SQL 都必须带 DEFAULT 'act'。少了它，历史行读出来是 NULL，
    // 于是「加字段」意外变成「改行为」—— 而 Owner 的要求正是「不迁移数据」。
    expect(
      /autonomy TEXT NOT NULL DEFAULT 'act'/.test(src),
      "agents 建表列必须写成 autonomy TEXT NOT NULL DEFAULT 'act'",
    ).toBe(true);
    expect(
      /ALTER TABLE agents ADD COLUMN autonomy TEXT NOT NULL DEFAULT 'act'/.test(src),
      '存量库迁移必须带 DEFAULT，否则历史行读出 NULL',
    ).toBe(true);
  });

  it('读方向对缺失/未知值兜底到 act', () => {
    const storage = FILES.find(f =>
      f.path === join(REPO_ROOT, 'packages/storage/src/sqlite-storage.ts'),
    );
    const src = storage!.source;
    expect(
      /autonomy:\s*\(r\['autonomy'\]\s*as string \| null\)\s*\?\?\s*'act'/.test(src),
      "_map 必须把缺失值兜底成 'act'，与加列前行为一致",
    ).toBe(true);
  });
});
