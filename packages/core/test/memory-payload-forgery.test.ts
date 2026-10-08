/**
 * H23 —— 载荷不能再伪造条目边界（in-band 容器族的格式级收口）。
 *
 * 回归背景（见 docs/records/PLATFORM-HARDENING-2026-10.md §19）：
 *
 *   `session-fragments.md` 是**对话分页载荷**，其正文是**任意文本**。实测（真实 Agent 数据）：
 *   一个片段的正文恰好是一份上下文转储，里面逐字包含
 *
 *     ### 团队协调与通信路由
 *     <!-- type: note -->
 *
 *   —— 读取器把它当成条目分隔符，于是**真实片段的尾部被静默切掉 2501 字符**，并在下一次保存时
 *   把截断结果**持久化**（真实数据丢失）。全组织实测：13 个文件、40 处这种载荷伪造边界。
 *
 * 与 H13/H17/H18 同根：容器结构记号处在载荷可生产的空间里，且**没有单一主人**。
 * 修法分两半（互相独立验证）：
 *   · 写入端 `escapeEntryBodyLine` —— 正文里长得像结构（`### ` / `<!-- ` / 前导 `\`）的行加一个
 *     `\` 前缀，载荷从原理上无法再生产结构记号（对任意 id、任意载荷都成立）。
 *   · 片段池读取端锚定 `frag_` —— 片段 id 由存储器独占（只写 `frag_<ts>_<sessionId>`），因此可
 *     无损回收"转义机制出现之前"已损坏的历史文件。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  MemoryStore,
  serializeFragmentRegion,
  serializeObservationBuffer,
  escapeEntryBodyLine,
  decodeEntryBodyLine,
} from '../src/memory/store.js';
import type { MemoryEntry } from '../src/memory/types.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-forgery-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const meta = { sessionId: 'sess_1', tags: [] as string[] };
const frag = (id: string, content: string): MemoryEntry => ({
  id, timestamp: new Date().toISOString(), type: 'conversation_fragment', content, metadata: { ...meta },
});
const note = (id: string, content: string): MemoryEntry => ({
  id, timestamp: new Date().toISOString(), type: 'note', content,
});

const writeFragments = (s: string) => fs.writeFileSync(path.join(dir, 'session-fragments.md'), s, 'utf8');

describe('H23 — 写入端转义（结构记号不可被载荷生产）', () => {
  it('escape/decode 往返恒等：对抗性行逐字还原', () => {
    const lines = [
      '### obs_1',                       // 边界形态
      '<!-- type: note -->',             // meta 形态
      '\\',                              // 前导反斜杠
      '\\### 已转义',                     // 反斜杠 + 边界形态
      '## 二级标题',                       // curated 记号
      '普通正文，含 ### 但不是行首',
      '',
    ];
    for (const line of lines) {
      expect(decodeEntryBodyLine(escapeEntryBodyLine(line))).toBe(line);
    }
  });

  it('正文里逐字包含一条完整条目形态时，落盘即被转义 —— 不再可能被切成条目', () => {
    const body = ['结论如下：', '### obs_999', '<!-- type: note -->', '这段是载荷。'].join('\n');
    const disk = serializeFragmentRegion([frag('frag_1_sess_1', body)]);
    expect(disk).toContain('\\### obs_999');
    expect(disk).toContain('\\<!-- type: note -->');
  });

  it('观察池：正文含条目形态 → 回读为 1 条、内容逐字无损', () => {
    const body = ['第一行。', '### obs_forged', '<!-- type: note -->', '第三行。'].join('\n');
    const obs = note('obs_real_1', body);
    fs.writeFileSync(
      path.join(dir, 'knowledge.md'),
      '## lessons\n\nnoise\n\n' + serializeObservationBuffer([obs]) + '\n',
      'utf8',
    );
    const entries = new MemoryStore(dir).getEntries();
    expect(entries.length).toBe(1);
    expect(entries[0].id).toBe('obs_real_1');
    expect(entries[0].content).toBe(body);
  });
});

describe('H23 — 片段池锚定 frag_，无损回收历史损坏', () => {
  it('历史文件：载荷含未转义的 `### X` + meta —— 整个片段无损读回（修复前尾部被切）', () => {
    const legacy = [
      '## _session_fragments',
      '<!-- platform-managed -->',
      '',
      '### frag_1790841409971_sess_1',
      '<!-- type: conversation_fragment, data-meta: {"sessionId":"sess_1","tags":[]} -->',
      '第一段正文。',
      '### 团队协调与通信路由',        // ← 载荷，不是条目
      '<!-- type: note -->',
      '- 跨团队找对方 manager。',
      '### My',
      '<!-- type: note -->',
      'No active tasks.',
      '',
    ].join('\n');
    writeFragments(legacy);
    const frags = new MemoryStore(dir).getFragments();
    expect(frags.length).toBe(1);                                   // 不伪造幽灵片段
    expect(frags[0].id).toBe('frag_1790841409971_sess_1');
    expect(frags[0].content).toContain('### 团队协调与通信路由');       // 尾部不再被切
    expect(frags[0].content).toContain('- 跨团队找对方 manager。');
    expect(frags[0].content).toContain('No active tasks.');
  });

  it('多个真实片段仍然各自成条（锚定不会把它们并成一条）', () => {
    const disk = serializeFragmentRegion([
      frag('frag_1_sess_1', '一'),
      frag('frag_2_sess_2', '二'),
    ]);
    writeFragments(disk);
    const frags = new MemoryStore(dir).getFragments();
    expect(frags.map(f => f.id).sort()).toEqual(['frag_1_sess_1', 'frag_2_sess_2']);
  });
});
