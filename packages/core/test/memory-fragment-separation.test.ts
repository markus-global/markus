/**
 * H16 —— 会话压缩片段（conversation_fragment）必须与 Agent 自撰观察**结构性分离**。
 *
 * 回归背景（见 docs/records/PLATFORM-HARDENING-2026-10.md §12）：
 *
 *   `## _observations` 曾同时承载两类语义完全不同的东西：
 *     • Agent 自撰观察（memory_save）—— 草稿日志，dream 会整理；
 *     • 平台生成的会话压缩片段（compaction 分页载荷）—— 原始历史，按 id 检索。
 *   后果：片段挤占 Agent 的观察预算；dream 把原始对话转储当"观察"喂给 LLM。
 *
 * 修复把片段挪到独立文件 `session-fragments.md`（独立预算），`getObservations()`
 * 不再返回片段，加载时迁移历史片段使 knowledge.md 自愈。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MEMORY_OBSERVATIONS_MAX_CHARS, MEMORY_FRAGMENTS_MAX_CHARS } from '@markus/shared';
import { MemoryStore, splitKnowledgeSections } from '../src/memory/store.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-frag-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const knowledgeFile = () => path.join(dir, 'knowledge.md');
const fragmentFile = () => path.join(dir, 'session-fragments.json');

/** knowledge.md with one agent observation AND one conversation fragment mixed in. */
function mixedKnowledge(): string {
  return [
    '# Knowledge',
    '',
    '## procedures',
    '- keep it short',
    '',
    '## _observations',
    '<!-- buffer -->',
    '',
    '### obs_alpha',
    '<!-- type: note, data-meta: {"tags":["x"]} -->',
    'AGENT_OBSERVATION_ALPHA about widget calibration',
    '',
    '### frag_beta_sess_1',
    '<!-- type: conversation_fragment, data-meta: {"sessionId":"sess_1","agentId":"a","pagedOutCount":3,"first":"hi","last":"bye"} -->',
    'FRAGMENT_BETA raw transcript about widget calibration',
    '',
    '### obs_gamma',
    '<!-- type: insight -->',
    'AGENT_OBSERVATION_GAMMA about something else',
    '',
  ].join('\n');
}

describe('H16 — 片段与观察结构性分离', () => {
  it('加载时把片段从 _observations 迁出，knowledge.md 自愈，Agent 观察不再含片段', () => {
    fs.writeFileSync(knowledgeFile(), mixedKnowledge(), 'utf8');

    const store = new MemoryStore(dir);

    // 1. getObservations() 只含 Agent 自撰观察
    const obs = store.getObservations();
    const ids = obs.map((e) => e.id);
    expect(ids).toContain('obs_alpha');
    expect(ids).toContain('obs_gamma');
    expect(ids.some((i) => i.startsWith('frag_'))).toBe(false);

    // 2. 片段已落到独立文件
    expect(fs.existsSync(fragmentFile())).toBe(true);
    const fragText = fs.readFileSync(fragmentFile(), 'utf8');
    expect(fragText).toContain('frag_beta_sess_1');
    expect(fragText).toContain('FRAGMENT_BETA');

    // 3. H24 — knowledge.md 现在只含 curated：观察与片段都不在里面（各自进了 JSON 记录文件）
    const md = fs.readFileSync(knowledgeFile(), 'utf8');
    expect(splitKnowledgeSections(md).observations).toBe('');   // 观察区已不在文件里
    expect(md).not.toContain('FRAGMENT_BETA');
    expect(md).not.toContain('AGENT_OBSERVATION_ALPHA');
    const obsJson = fs.readFileSync(path.join(dir, 'observations.json'), 'utf8');
    expect(obsJson).toContain('obs_alpha');
    expect(obsJson).toContain('AGENT_OBSERVATION_ALPHA');
    expect(obsJson).not.toContain('FRAGMENT_BETA');
  });

  it('片段可被 retrieveFragments 找回（迁移不破坏检索）', () => {
    fs.writeFileSync(knowledgeFile(), mixedKnowledge(), 'utf8');
    const store = new MemoryStore(dir);

    const hits = store.retrieveFragments('widget calibration', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.id).toBe('frag_beta_sess_1');
    expect(hits[0]!.content).toContain('FRAGMENT_BETA');
  });

  it('独立预算：片段再多也不影响 Agent 的观察健康信号', () => {
    // 10 个大片段（远超观察预算）——但它们是片段，不该进观察预算。
    const lines = ['# Knowledge', '', '## _observations', '<!-- buffer -->', '', '### obs_keep', '<!-- type: note -->', 'tiny observation', ''];
    fs.writeFileSync(knowledgeFile(), lines.join('\n'), 'utf8');

    const store = new MemoryStore(dir);
    for (let i = 0; i < 10; i++) {
      store.addEntry({
        id: `frag_${i}_sess_x`,
        timestamp: new Date().toISOString(),
        type: 'conversation_fragment',
        content: 'F'.repeat(5_000),
        metadata: { sessionId: 'sess_x', agentId: 'a', pagedOutCount: 1 },
      });
    }

    const h = store.getMemoryHealth();
    // 观察缓冲只按 Agent 自撰观察计量 —— 50k 片段不该把它推到高位
    expect(h.observationPercent).toBeLessThan(5);
    expect(h.observationChars).toBeLessThan(MEMORY_OBSERVATIONS_MAX_CHARS);
  });

  it('addEntry 按类型路由：片段只写 session-fragments.md，绝不进 knowledge.md', () => {
    fs.writeFileSync(knowledgeFile(), '# Knowledge\n\n## _observations\n<!-- buffer -->\n', 'utf8');
    const store = new MemoryStore(dir);

    store.addEntry({
      id: 'frag_route_1',
      timestamp: new Date().toISOString(),
      type: 'conversation_fragment',
      content: 'ROUTED_FRAGMENT_BODY',
      metadata: { sessionId: 's1', agentId: 'a', pagedOutCount: 1 },
    });

    const frag = fs.existsSync(fragmentFile()) ? fs.readFileSync(fragmentFile(), 'utf8') : '';
    expect(frag).toContain('ROUTED_FRAGMENT_BODY');
    expect(fs.readFileSync(knowledgeFile(), 'utf8')).not.toContain('ROUTED_FRAGMENT_BODY');
    expect(store.getObservations().some((e) => e.id === 'frag_route_1')).toBe(false);
  });

  it('常量此刻的真实值：片段预算与观察预算是两个独立的正数', () => {
    expect(MEMORY_FRAGMENTS_MAX_CHARS).toBeGreaterThan(0);
    expect(MEMORY_FRAGMENTS_MAX_CHARS).toBeGreaterThanOrEqual(MEMORY_OBSERVATIONS_MAX_CHARS);
  });
});
