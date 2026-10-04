/**
 * H13/H20/H21 —— 旧「整文件压缩」bug 遗留的**存量数据**一次性自动迁移。
 *
 * 旧 `compressLongTermMemory` 扫整个知识文件，把观察/片段正文里的 `## ` 标题当成 curated
 * 段落：正文被**复制**进 `knowledge-archive.md`，原位只留一行指针存根。内容没丢，但条目
 * 出现了一个洞。H21 把修复扩到 **curated 区**（每轮注入 prompt 的那部分）——存根留在那里，
 * Agent 的实时知识就会显示一个空段落。
 *
 * 迁移规则（保守、确定性、幂等）：
 *   • 存根上方的标题名，在归档里**唯一**匹配到一节 → 回填该正文；
 *   • 重名（歧义）/找不到 → 原样保留，**绝不猜**，并如实上报；
 *   • 归档副本保留（copy-back 而非 move，不可能丢数据）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryStore } from '../src/memory/store.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h13-repair-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const kFile = () => path.join(dir, 'knowledge.md');
const aFile = () => path.join(dir, 'knowledge-archive.md');
const fFile = () => path.join(dir, 'session-fragments.md');
const STUB = '_[archived → knowledge-archive.md；正文已无损归档，可用 memory_search 检索]_';
/** H24/H27 — 观察条目持久化为 observations.json：修复必须落在权威容器里。 */
const obsText = () => {
  const p = path.join(dir, 'observations.json');
  if (!fs.existsSync(p)) return '';
  return (JSON.parse(fs.readFileSync(p, 'utf8')) as Array<{ content?: string }>)
    .map(e => e.content ?? '').join('\n');
};
const read = (p: string) => fs.readFileSync(p, 'utf8');

function knowledgeWithStub(bodyHeading = '现象'): string {
  return [
    '# Knowledge',
    '',
    '## _observations',
    '<!-- buffer -->',
    '',
    '### obs_1',
    '<!-- type: note -->',
    `## ${bodyHeading}`,
    STUB,
    '',
  ].join('\n');
}

describe('H13 存量迁移 — 唯一匹配才回填，歧义不猜，幂等', () => {
  it('归档里唯一匹配 → 存根被替换成原正文，内容回来了', () => {
    fs.writeFileSync(kFile(), knowledgeWithStub(), 'utf8');
    fs.writeFileSync(aFile(), '## 现象\nTHE_REAL_BODY_LINE\n', 'utf8');

    new MemoryStore(dir);

    // H24/H27 — 条目在 observations.json；修复必须落在**权威容器**里。旧实现把修复结果
    // 写回已退役的 knowledge.md 观察区，下次加载被 JSON 覆盖 → 静默丢弃（两份事实）。
    const text = obsText();
    expect(text).toContain('THE_REAL_BODY_LINE');
    expect(text).not.toContain(STUB);
    expect(read(kFile())).not.toContain('## _observations'); // 不再复活退役容器
  });

  it('归档里重名（歧义）→ 原样保留，绝不猜', () => {
    fs.writeFileSync(kFile(), knowledgeWithStub(), 'utf8');
    fs.writeFileSync(aFile(), '## 现象\nBODY_A\n\n## 现象\nBODY_B\n', 'utf8');

    new MemoryStore(dir);

    const text = obsText();
    expect(text).toContain(STUB);          // 未动
    expect(text).not.toContain('BODY_A');
    expect(text).not.toContain('BODY_B');
  });

  it('归档里找不到同名 → 原样保留', () => {
    fs.writeFileSync(kFile(), knowledgeWithStub('没有这一节'), 'utf8');
    fs.writeFileSync(aFile(), '## 别的东西\nX\n', 'utf8');

    new MemoryStore(dir);

    expect(obsText()).toContain(STUB);
  });

  it('幂等：迁移后再构造一次，文件不再变化', () => {
    fs.writeFileSync(kFile(), knowledgeWithStub(), 'utf8');
    fs.writeFileSync(aFile(), '## 现象\nTHE_REAL_BODY_LINE\n', 'utf8');

    new MemoryStore(dir);
    const afterFirst = read(kFile());
    new MemoryStore(dir);                   // 第二次
    expect(read(kFile())).toBe(afterFirst);
  });

  it('session-fragments.md 里的存根同样被迁移（H24：片段持久化为 session-fragments.json）', () => {
    fs.writeFileSync(
      fFile(),
      ['## _session_fragments', '<!-- header -->', '', '### frag_1_sess_x', '<!-- type: conversation_fragment -->', '## 根因', STUB, ''].join('\n'),
      'utf8',
    );
    fs.writeFileSync(aFile(), '## 根因\nFRAGMENT_REAL_BODY\n', 'utf8');

    const store = new MemoryStore(dir);

    // 片段现在持久化为 JSON 记录；存根已被归档正文回填
    const frag = store.getFragments().find((e) => e.id === 'frag_1_sess_x');
    expect(frag).toBeTruthy();
    expect(frag!.content).toContain('FRAGMENT_REAL_BODY');
    expect(frag!.content).not.toContain(STUB);
    // 磁盘上同样是 JSON（旧 .md 已在迁移后被消费）
    const disk = fs.readFileSync(path.join(dir, 'session-fragments.json'), 'utf8');
    expect(disk).toContain('FRAGMENT_REAL_BODY');
    expect(disk).not.toContain(STUB);
  });

  it('没有归档文件时是安全 no-op', () => {
    fs.writeFileSync(kFile(), knowledgeWithStub(), 'utf8');
    new MemoryStore(dir);
    expect(obsText()).toContain(STUB); // 无从回填，保持原样
  });
});

describe('H21 — curated 区（每轮注入）也必须被修复', () => {
  it('curated 段落里的存根 → 回填正文（H20 遗漏的区域）', () => {
    fs.writeFileSync(kFile(), [
      '# Knowledge',
      '',
      '## 任务与需求管理规范',
      STUB,
      '',
      '## _observations',
      '<!-- buffer -->',
      '',
      '### obs_1',
      '<!-- type: note -->',
      'keep me',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(aFile(), '## 任务与需求管理规范\nREAL_TASK_RULES\n', 'utf8');

    new MemoryStore(dir);

    const text = read(kFile());
    expect(text).toContain('REAL_TASK_RULES');
    expect(text).not.toContain(STUB);
  });

  it('curated 段落歧义 → 原样保留，并如实上报（不猜）', () => {
    fs.writeFileSync(kFile(), [
      '# Knowledge', '', '## procedures', STUB, '', '## _observations', '### obs_1', '<!-- type: note -->', 'x', '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(aFile(), '## procedures\nA\n\n## procedures\nB\n', 'utf8');

    const store = new MemoryStore(dir);
    const report = store.repairStubResidue();

    expect(read(kFile())).toContain(STUB);
    expect(report.ambiguous).toContainEqual({ name: 'procedures', candidates: 2 });
  });

  it('curated + 观察区可同时回填（curated 留 knowledge.md，观察条目进 observations.json）', () => {
    fs.writeFileSync(kFile(), [
      '# Knowledge', '', '## 核心原则', STUB, '', '## _observations', '<!-- buffer -->', '',
      '### obs_1', '<!-- type: note -->', '## 现象', STUB, '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(aFile(), '## 核心原则\nCURATED_BODY\n\n## 现象\nOBS_BODY\n', 'utf8');

    new MemoryStore(dir);

    // curated 仍是 markdown（那部分要注入 prompt）→ 落在 knowledge.md
    const text = read(kFile());
    expect(text).toContain('CURATED_BODY');
    expect(text).not.toContain(STUB);
    expect(text).not.toContain('## _observations'); // 退役容器不再复活
    // 观察条目 → observations.json（H24/H26/H27 的单一权威容器）
    expect(obsText()).toContain('OBS_BODY');
    expect(obsText()).not.toContain(STUB);
  });
});

describe('H21 — 条目内的 meta 行不再阻断回填', () => {
  it('标题与存根之间隔着 `<!-- type: … -->` 时仍能唯一定位标题（旧实现会漏）', () => {
    // 真实形态：条目正文里合法地含有一个 `## ` 标题，其下再出现一行与 meta 同形的注释。
    // 旧实现取“正上方那一行”当标题名 → 拿到 `<!-- type: note -->` → 匹配失败，永远修不到。
    fs.writeFileSync(kFile(), [
      '# Knowledge', '', '## _observations', '<!-- buffer -->', '',
      '### obs_1',
      '<!-- type: note -->',
      '## 团队协调与通信路由',
      '<!-- type: note -->',
      STUB,
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(aFile(), '## 团队协调与通信路由\nROUTE_RULES\n', 'utf8');

    new MemoryStore(dir);

    const text = obsText();
    expect(text).toContain('ROUTE_RULES');
    expect(text).not.toContain(STUB);
  });
});

describe('H21 — 归档写入不再制造重名（歧义的源头）', () => {
  it('同名不同正文 → 第二个自动加序号，绝不产生重复 `## name`', () => {
    fs.writeFileSync(kFile(), ['# Knowledge', '', '## _observations', '### obs_1', '<!-- type: note -->', 'x', ''].join('\n'), 'utf8');
    const store = new MemoryStore(dir);
    const archiveSection = (store as unknown as { archiveSection(n: string, b: string): number }).archiveSection.bind(store);

    archiveSection('验证', 'FIRST_BODY');
    archiveSection('验证', 'SECOND_BODY');
    archiveSection('验证', 'FIRST_BODY');   // 完全重复 → 幂等，不新增

    // §27 — 归档写入 JSON 记录了（载荷无法再伪造 `## ` 边界）。
    const recs = JSON.parse(read(path.join(dir, 'knowledge-archive.json'))) as Array<{ content: string; metadata: { name: string } }>;
    const names = recs.map((r) => r.metadata.name);
    expect(names.filter((n) => n === '验证').length).toBe(1);
    expect(names).toContain('验证 (2)');
    const all = recs.map((r) => r.content).join('\n');
    expect(all).toContain('FIRST_BODY');
    expect(all).toContain('SECOND_BODY');
  });
});
