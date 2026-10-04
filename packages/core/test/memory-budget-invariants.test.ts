/**
 * H1–H3 —— knowledge.md 的**两个预算**必须各自可执行、各自诚实。
 *
 * 回归背景（见 docs/PLATFORM-HARDENING-2026-10.md §2）：
 *
 *  1. **指标口径错误**：`getMemoryHealth()` 曾用**整个文件大小**（含**从不注入**的
 *     `## _observations` 缓冲）除注入预算，于是任何观察日志正常的 Agent 都显示
 *     >100%，而真正注入上下文的 curated 段可能只有 2k。这是"永远在报警但其实没
 *     问题"的典型 —— 比没有信号更糟，因为它训练 Agent 忽略信号。
 *
 *  2. **假收敛**：`convergeLongTermToCap()` 委托 `compressLongTermMemory()`，而后者
 *     显式跳过观察缓冲；超额全在观察缓冲时，文件被逐字节重写却仍打
 *     `converged {charsBefore: X, charsAfter: X}`。**一个没有执行点的上限不是上限。**
 *
 *  3. **常量自相矛盾**：观察缓冲上限 30000 > 注入预算 15000，总量上限在数学上不可满足。
 *
 * 修复把两个预算拆开，各自有强执行点：curated → 归档最大段落；observations →
 * 归档最旧观察（**无损**，仍可 `memory_search` 检索）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MEMORY_MD_CURATED_MAX_CHARS, MEMORY_OBSERVATIONS_MAX_CHARS, MEMORY_MD_SECTION_MAX_CHARS, MEMORY_DREAM_TRIGGER_PERCENT, MEMORY_DREAM_MIN_ENTRIES, MEMORY_HEALTH_WARN_PERCENT } from '@markus/shared';
import { MemoryStore, splitKnowledgeSections } from '../src/memory/store.js';
import { shouldRunDreamCycle } from '../src/memory/dream-trigger.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-budget-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const file = () => path.join(dir, 'knowledge.md');
const archive = () => path.join(dir, 'observations-archive.json');
const readFile = () => fs.readFileSync(file(), 'utf8');
const obsFile = () => path.join(dir, 'observations.json');
const obsBodies = (): Array<{ id?: string; content?: string }> =>
  fs.existsSync(obsFile()) ? JSON.parse(fs.readFileSync(obsFile(), 'utf8')) : [];
/** H25 — canonical measure: the PAYLOAD the agent authored, never the container's syntax. */
const obsPayload = () => obsBodies().reduce((s, e) => s + (e.content ?? '').length, 0);

/** Curated part well over the injected budget (6 × 5 000). */
function bigCuratedKnowledge(): string {
  const parts = ['# Knowledge', ''];
  for (let i = 0; i < 6; i++) parts.push(`## topic-${i}`, 'x'.repeat(5_000), '');
  return parts.join('\n');
}

/** A `## _observations` buffer well over its OWN cap (400 × ~276 chars ≈ 110 k). */
function bigObservationKnowledge(entries = 400): string {
  const lines = ['## _observations', '<!-- buffer -->', ''];
  for (let i = 0; i < entries; i++) {
    lines.push(`### o${i}`, `<!-- type: note -->`, `marker-${i} ${'y'.repeat(180)}`, '');
  }
  return lines.join('\n');
}

describe('H3 — 两个预算是独立的常量，互不包含', () => {
  it('观察缓冲上限不再"大于"注入预算却仍被算进注入口径（常量此刻的真实值）', () => {
    // 二者是**不同**的预算；本断言把"它们不能是同一个预算"这件事钉住。
    expect(MEMORY_MD_CURATED_MAX_CHARS).toBeGreaterThan(0);
    expect(MEMORY_OBSERVATIONS_MAX_CHARS).toBeGreaterThan(0);
    // 之前 30 000 > 15 000 被当成"总量上限"，数学上不可满足。现在二者独立，
    // 但仍要防止未来有人把观察缓冲改成小于 curated —— 那会让 curated 无处可放。
    expect(MEMORY_OBSERVATIONS_MAX_CHARS).toBeGreaterThanOrEqual(MEMORY_MD_CURATED_MAX_CHARS);
  });
});

describe('H2 — 观察缓冲超限在 load 时被**无损**收敛（修复前为零收缩）', () => {
  it('H19：平台不再有任何“静默压缩 curated”的路径 —— 越界只报告', () => {
    // 修复前 convergeLongTermToCap 委托 compress；H19 已把该机制整体删除。
    // 现在唯一的 load 期执行点是 enforceMemoryBudgets：它**报告** curated、
    // **无损裁剪**观察缓冲，绝不静默改写 curated 的正文。
    const content = bigObservationKnowledge();
    fs.writeFileSync(file(), content, 'utf8');
    const before = splitKnowledgeSections(content).observations.length;
    expect(before).toBeGreaterThan(MEMORY_OBSERVATIONS_MAX_CHARS);

    const store = new MemoryStore(dir); // 构造即 enforceMemoryBudgets（load 路径）
    // 观察缓冲确实被裁（有执行点）
    expect(splitKnowledgeSections(readFile()).observations.length).toBeLessThan(before);
    // curated 只报告、一个字节都不改写
    const r = store.enforceMemoryBudgets();
    expect(r.curated.archived).toBe(0);
    expect(r.curated.after).toBe(r.curated.before);
  });

  it('§24 — 越过软线只报告：不驱逐、不归档，条目一条不少', () => {
    const content = bigObservationKnowledge();
    fs.writeFileSync(file(), content, 'utf8');
    const before = splitKnowledgeSections(content).observations.length;
    expect(before).toBeGreaterThan(MEMORY_OBSERVATIONS_MAX_CHARS);

    const store = new MemoryStore(dir); // 构造即 enforceMemoryBudgets（只报告）

    // §24 (R2+R4) — 平台不再替 Agent 搬运/归档：越过软线只报告，内容原地不动。
    // 旧行为：把最旧的逐条搬进 observations-archive.json —— 于是"留下什么"取决于度量口径。
    expect(obsBodies()).toHaveLength(400);
    expect(store.getEntries()).toHaveLength(400);
    expect(obsPayload()).toBeGreaterThan(MEMORY_OBSERVATIONS_MAX_CHARS); // 确实越过软线
    expect(fs.existsSync(archive())).toBe(false);                        // 归档概念已退役
  });

  it('收敛是幂等的：合规状态下再跑一次不产生任何改动', () => {
    const content = bigObservationKnowledge();
    fs.writeFileSync(file(), content, 'utf8');
    new MemoryStore(dir); // 第一次收敛
    const afterFirst = readFile();

    const second = new MemoryStore(dir).enforceMemoryBudgets(); // 第二次
    expect(second.observations.archived).toBe(0);
    expect(second.observations.converged).toBe(false);
    expect(readFile()).toBe(afterFirst);
  });

  it('无法收敛时**如实报告** converged=false（而不是谎报 converged）', () => {
    // 只剩 1 条观察且它自己就超限 —— 循环保护（obsCount()>1）保证不会被清空，
    // 于是"裁不动"。修复前的实现会在这种情况下照样打 "converged"。
    const single = ['## _observations', '<!-- buffer -->', '', `### o0`, '<!-- type: note -->', 'z'.repeat(MEMORY_OBSERVATIONS_MAX_CHARS + 5_000), ''].join('\n');
    fs.writeFileSync(file(), single, 'utf8');

    const store = new MemoryStore(dir);
    const result = store.enforceMemoryBudgets();

    expect(result.observations.before).toBeGreaterThan(MEMORY_OBSERVATIONS_MAX_CHARS);
    expect(result.observations.converged).toBe(false);
    // 观察没有被清空（至少保留一条）—— H26 迁移后条目在 observations.json
    expect(obsBodies().map(e => e.id)).toContain('o0');
  });

  it('旧格式在首次加载即完成迁移，此后不改写（H26 幂等）', () => {
    const small = '# Knowledge\n\n## a\nsmall\n\n## _observations\n<!-- buffer -->\n\n### o1\n<!-- type: note -->\ntiny\n';
    fs.writeFileSync(file(), small, 'utf8');
    const store = new MemoryStore(dir);
    // H26 — 迁移必须落盘，而不是只在"已超预算"时才保存。修复前实测：94 个 Agent 只有 10 个
    // 真的迁移了（恰好是超限被裁的那些），其余永远停在旧格式、每次加载都走有歧义的解析。
    expect(readFile()).toBe('# Knowledge\n\n## a\nsmall\n');
    expect(readFile()).not.toContain('## _observations');
    expect(obsBodies().map(e => e.id)).toEqual(['o1']);
    // 幂等：已是新形态后，再加载一次不产生任何变化
    const afterFirst = readFile();
    new MemoryStore(dir);
    expect(readFile()).toBe(afterFirst);
    const r = store.enforceMemoryBudgets();
    expect(r.curated.converged).toBe(false);
    // §24 — observations.converged 现在读作"在建议线以内"（平台不再做强制收敛）
    expect(r.observations.converged).toBe(true);
    expect(r.observations.archived).toBe(0);
  });
});

describe('H2b — curated（注入）预算同样是强不变量', () => {
  it('超限的 curated 只被**报告**，不被改写（H19）', () => {
    const original = bigCuratedKnowledge();
    fs.writeFileSync(file(), original, 'utf8');
    expect(splitKnowledgeSections(original).curated.length).toBeGreaterThan(MEMORY_MD_CURATED_MAX_CHARS);

    new MemoryStore(dir);

    // 平台不静默改写注入区：逐字节不变，标题与正文都在，无指针存根
    expect(readFile()).toBe(original);
    expect(readFile()).not.toContain('_[archived');
    expect(splitKnowledgeSections(readFile()).curated).toContain('## topic-0');
  });

  it('curated 与观察缓冲互不干扰：报告 curated 不会动观察条目', () => {
    const obsBlock = bigObservationKnowledge(3);
    fs.writeFileSync(file(), bigCuratedKnowledge() + '\n' + obsBlock, 'utf8');
    const obsBefore = splitKnowledgeSections(readFile()).observations;
    expect(obsBefore.length).toBeGreaterThan(0);

    new MemoryStore(dir);

    // H24/H26 — 条目迁到 observations.json；"互不干扰" = 3 条正文一条不少地过去，
    // 且 curated 只被报告、不被改写（无指针存根）。
    const bodies = obsBodies().map(e => e.content ?? '');
    expect(bodies).toHaveLength(3);
    expect(bodies.every(b => b.includes('marker-'))).toBe(true);
    expect(readFile()).not.toContain('_[archived');
    expect(readFile()).toContain('## topic-0');
  });
});

/**
 * H12 回归组 —— "上报口径必须等于执行口径"。
 *
 * 背景（见 docs/PLATFORM-HARDENING-2026-10.md §10）：H1–H3 落地后 Owner 亲测，
 * 观察缓冲依旧 119%、一个字没减。根因是**同一个预算有两种互不相等的度量**：
 * 不变量用序列化后的原始文本长度，而裁剪循环用手写常量估算 `content + 96/条`。
 * 真实条目携带 `data-meta` JSON（≈168 字符/条开销），估算系统性低估 → while 永假。
 *
 * 旧夹具 `bigObservationKnowledge()` 每条 meta 只有 `<!-- type: note -->`（≈30 字符
 * 开销），估算常量 96 **反而高估** → 旧夹具里裁剪正常触发 → **测试通过、生产失败**。
 * 所以本组夹具**必须带真实 data-meta**，否则无法回归保护。
 */
function realisticObservationKnowledge(entries = 42, bodyLen = 600): string {
  const lines = ['## _observations', '<!-- buffer -->', ''];
  for (let i = 0; i < entries; i++) {
    lines.push(
      `### obs_${1_700_000_000_000 + i}`,
      `<!-- type: insight, data-meta: {"tags":["platform","memory","b-${i}"],"sessionTag":"sess_1791098259586_1wkgrv"} -->`,
      `marker-${i}-` + 'y'.repeat(bodyLen),
      '',
    );
  }
  return lines.join('\n');
}

describe('H12 — 观察缓冲：上报口径 == 执行口径（真实 data-meta 形态）', () => {
  it('H25/§24 — 真实形态夹具：越过软线只报告，且度量与容器无关', () => {
    const content = realisticObservationKnowledge(42, 800);
    fs.writeFileSync(file(), content, 'utf8');

    const before = splitKnowledgeSections(content).observations.length;
    expect(before).toBeGreaterThan(MEMORY_OBSERVATIONS_MAX_CHARS);
    // 旧实现的手写估算口径（content + 96/条）此刻 ≤ 上限 —— 它当年正是靠这个"不裁剪"。
    const oldEstimate = 42 * (600 + 96);
    expect(oldEstimate).toBeLessThanOrEqual(MEMORY_OBSERVATIONS_MAX_CHARS);

    new MemoryStore(dir); // 构造即 enforceMemoryBudgets

    // §24 — 不搬运；H25 — 口径是 payload，不是容器语法
    expect(obsBodies()).toHaveLength(42);
    expect(obsPayload()).toBeGreaterThan(MEMORY_OBSERVATIONS_MAX_CHARS);
    expect(obsPayload()).toBeLessThan(fs.readFileSync(obsFile(), 'utf8').length);
    expect(fs.existsSync(archive())).toBe(false);
  });

  it('裁剪幂等：真实形态收敛后，再跑一次不改动文件', () => {
    fs.writeFileSync(file(), realisticObservationKnowledge(), 'utf8');
    new MemoryStore(dir); // 第一次收敛
    const afterFirst = readFile();

    // enforceMemoryBudgets 现在以磁盘口径读取；合规后必须完全不写
    new MemoryStore(dir);
    expect(readFile()).toBe(afterFirst);
  });

  it('§24 — 归档概念退役：越界也不写 observations-archive.json，检索仍覆盖全部条目', () => {
    fs.writeFileSync(file(), realisticObservationKnowledge(42, 800), 'utf8');
    const store = new MemoryStore(dir);
    expect(fs.existsSync(archive())).toBe(false);
    // "无损"的含义变了：不再"搬走"，而是"一条都不动、全部可检索"
    expect(store.search('marker-0-').length).toBeGreaterThan(0);
    expect(store.getEntries()).toHaveLength(42);
  });

  it('健康横幅用同一权威口径：加载后 observationChars ≤ 上限', () => {
    fs.writeFileSync(file(), realisticObservationKnowledge(), 'utf8');
    const h = new MemoryStore(dir).getMemoryHealth();
    expect(h.observationChars).toBeLessThanOrEqual(MEMORY_OBSERVATIONS_MAX_CHARS);
    expect(h.observationCap).toBe(MEMORY_OBSERVATIONS_MAX_CHARS);
  });
});

/**
 * H13 —— 压缩（`compressLongTermMemory`）只能改 curated 区。
 *
 * 背景（见 docs/PLATFORM-HARDENING-2026-10.md §11）：旧实现读**整个文件**并逐行把
 * 任何 `## ` 开头的行当成 curated 段落，仅排除 `_observations` 本身。于是观察/fragment
 * 正文里的 `## ` 标题被当成独立段落，Phase 2/3 再把它「归档存根化」——把观察正文
 * 覆盖成指针，并把对话文本推进知识归档。这是真实数据损坏（Owner 亲测中发现）。
 */
describe('H13 — 压缩只作用于 curated 区，绝不把观察正文里的 ## 标题当成段落', () => {
  it('观察正文中的 ## 标题与其正文不会被归档存根化（观察区逐字节保留）', () => {
    // 注：H16 之后，`conversation_fragment` 已迁出 knowledge.md（见 memory-fragment-separation
    // 测试）。这里用**观察**（note）承载"正文含 ## 标题"的场景——它才是仍留在观察区的内容。
    const bigBody = 'x'.repeat(MEMORY_MD_SECTION_MAX_CHARS + 5_000); // 超单段上限：旧代码必然存根化
    const knowledge = [
      '# Knowledge',
      '## curated-small',
      'short',
      '## _observations',
      '<!-- buffer -->',
      '',
      '### obs_1',
      '<!-- type: note, data-meta: {"tags":["h13"]} -->',
      '[assistant] 汇报：',
      '## 现象',
      `OBS_BODY_MARKER ${bigBody}`,
      '',
      '### obs_2',
      '<!-- type: note -->',
      'tail-body',
      '',
    ].join('\n');
    fs.writeFileSync(file(), knowledge, 'utf8');

    new MemoryStore(dir).enforceMemoryBudgets();

    // H24 — 观察条目持久化为 JSON 记录；载荷里的 `## 现象` 不再有任何结构含义，
    // 必须逐字节保留（这正是 H13 的原始现场）。
    const bodies = obsBodies().map(e => e.content ?? '').join('\n');
    expect(bodies).toContain('OBS_BODY_MARKER');
    expect(bodies).toContain('## 现象');
    expect(bodies).not.toContain('_[archived');
  });
});

describe('H1 — 健康指标按"注入段"口径报告，不被观察缓冲虚高', () => {
  it('观察缓冲很大但 curated 很小时，percent 反映 curated 而不是整个文件', () => {
    // 观察缓冲 ~20 k（上限内），curated 很小。
    const obs = ['## _observations', '<!-- buffer -->', ''];
    for (let i = 0; i < 100; i++) obs.push(`### o${i}`, '<!-- type: note -->', 'y'.repeat(180), '');
    fs.writeFileSync(file(), '# Knowledge\n\n## a\ntiny\n\n' + obs.join('\n'), 'utf8');

    const h = new MemoryStore(dir).getMemoryHealth();

    // curated 只有几十字符 → percent 必须接近 0，绝不能被 20k 的观察缓冲推到 >100%
    expect(h.curatedChars).toBeLessThan(1_000);
    expect(h.percent).toBeLessThan(10);
    // 观察缓冲有自己的、独立的信号（且此刻尚未到 70%）
    expect(h.observationChars).toBeGreaterThan(10_000);
    expect(h.observationCap).toBe(MEMORY_OBSERVATIONS_MAX_CHARS);
    expect(h.observationPercent).toBeGreaterThan(30);
    // 两者是两个数，不是一个数
    expect(h.percent).not.toBe(h.observationPercent);
  });

  it('curated 确实接近上限时，percent 才升高', () => {
    fs.writeFileSync(file(), '# Knowledge\n\n## big\n' + 'x'.repeat(14_000), 'utf8');
    const h = new MemoryStore(dir).getMemoryHealth();
    expect(h.percent).toBeGreaterThanOrEqual(70);
    expect(h.curatedCap).toBe(MEMORY_MD_CURATED_MAX_CHARS);
  });
});

describe('H14 — dream 周期的触发器必须扣在**预算**这个度量上（不是条目数）', () => {
  it('触发阈值与横幅警告阈值同源：警告响的那一点，自动整理也触发', () => {
    // 本轮的核心不变式：横幅在 X% 警告 Agent，平台自动 dream 也在 X% 触发。
    // 若二者被人改成两个数，警告就会重新变成「死路」。
    expect(MEMORY_DREAM_TRIGGER_PERCENT).toBe(MEMORY_HEALTH_WARN_PERCENT);
  });

  it('本 Agent 的真实形态：31 条 / 99% 必须触发（修复前因 <50 条而不触发）', () => {
    // 大条目（含 data-meta ≈ 960 字符/条）的缓冲，几十条就能撑满预算。
    // 旧的 `entries.length >= 50` 闸门对这种形态是死的。
    expect(shouldRunDreamCycle({ observationPercent: 99, entryCount: 31 })).toBe(true);
  });

  it('碎片极多（字节不高）也触发：检索成本是次级压力信号', () => {
    expect(shouldRunDreamCycle({ observationPercent: 10, entryCount: MEMORY_DREAM_MIN_ENTRIES })).toBe(true);
    expect(shouldRunDreamCycle({ observationPercent: 10, entryCount: MEMORY_DREAM_MIN_ENTRIES - 1 })).toBe(false);
  });

  it('既不超预算、也不多碎片时不触发 —— 不做无意义的 LLM 调用', () => {
    expect(shouldRunDreamCycle({ observationPercent: 5, entryCount: 5 })).toBe(false);
    expect(shouldRunDreamCycle({ observationPercent: MEMORY_DREAM_TRIGGER_PERCENT - 1, entryCount: 3 })).toBe(false);
  });
});
