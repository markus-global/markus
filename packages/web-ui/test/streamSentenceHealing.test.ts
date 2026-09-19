// ChatComponents.tsx 会经 api.ts 读 window；happy-dom 项目里 window 已存在，
// 但这里沿用 ChatComponents.test.ts 的显式桩，避免两个测试文件行为漂移。
vi.hoisted(() => {
  (globalThis as unknown as { window: unknown }).window = {
    __MARKUS_HUB_BASE_URL__: '',
    location: { origin: 'http://localhost' },
  } as unknown as Window & typeof globalThis;
  return true;
});

/**
 * 句子愈合回归护栏 —— 「正文一句话没说完，就插进一个工具调用，后面又接着半句」。
 *
 * 要求（Owner 明确）：过程必须照原样可见（思考 → 正文 → 执行 → 思考），
 * **不能**把所有正文揉成一块。只治一种情况：一段正文明显是上一句的续写时，
 * 把它接回上一句，并把夹在中间的过程行挪到这句话说完之后。
 *
 * 因此下面的断言分两类，两边都不能退化：
 *   ① 续写 → 合并、过程行后移；
 *   ② 句子已说完（句末标点）/ 新段落 → **不合并**，工具行留在原位。
 */
import { describe, it, expect } from 'vitest';

type Seg = Parameters<
  (typeof import('../src/pages/ChatComponents.tsx'))['segmentsToStreamEntries']
>[0];

const T = '2026-09-19T15:18:00.000Z';

function text(content: string, thinking?: string) {
  return { type: 'text' as const, content, ...(thinking ? { thinking } : {}), createdAt: T };
}
function tool(name: string) {
  return { type: 'tool' as const, key: `${name}_0`, tool: name, status: 'done' as const, durationMs: 3, createdAt: T };
}

/** 只取渲染层关心的骨架：正文内容 / 思考行 / 工具名。 */
function shape(entries: Array<{ type: string; content: string; metadata?: { isThinking?: boolean } }>) {
  return entries.map(e => {
    if (e.type === 'tool_start') return `tool:${e.content}`;
    if (e.type === 'tool_end') return `tool_end:${e.content}`;
    return e.metadata?.isThinking ? `think:${e.content}` : `text:${e.content}`;
  });
}

describe('句子愈合：正文不被过程行切开', () => {
  it('续写的半句接回上一句，工具行整体挪到这句说完之后（真实夹具）', async () => {
    const { segmentsToStreamEntries } = await import('../src/pages/ChatComponents.tsx');
    const entries = segmentsToStreamEntries(
      [
        text('Three failures — one is a genuine bug. Fixing the component, then correcting my'),
        tool('file_edit'),
        text(' test expectations.'),
      ] as unknown as Seg,
      'agt_1',
      T,
    );

    expect(shape(entries)).toEqual([
      'text:Three failures — one is a genuine bug. Fixing the component, then correcting my test expectations.',
      'tool:file_edit',
      'tool_end:file_edit',
    ]);
  });

  it('句子已写完（句末标点）→ 不合并，工具行留在原位（过程必须可见）', async () => {
    const { segmentsToStreamEntries } = await import('../src/pages/ChatComponents.tsx');
    const entries = segmentsToStreamEntries(
      [
        text('先看设置页的实现。'),
        tool('shell_execute'),
        text('现在改这个下拉框。'),
      ] as unknown as Seg,
      'agt_1',
      T,
    );

    expect(shape(entries)).toEqual([
      'text:先看设置页的实现。',
      'tool:shell_execute',
      'tool_end:shell_execute',
      'text:现在改这个下拉框。',
    ]);
  });

  it('思考行同样不切句：半句 + 思考 + 工具 + 剩下半句 → 合成一句，过程行依次在后', async () => {
    const { segmentsToStreamEntries } = await import('../src/pages/ChatComponents.tsx');
    const entries = segmentsToStreamEntries(
      [
        text('The stored data is intact, so the split comes from'),
        text('', 'Let me check the renderer'),
        tool('grep_search'),
        text(' the live rendering path.'),
      ] as unknown as Seg,
      'agt_1',
      T,
    );

    expect(shape(entries)).toEqual([
      'text:The stored data is intact, so the split comes from the live rendering path.',
      'think:Let me check the renderer',
      'tool:grep_search',
      'tool_end:grep_search',
    ]);
  });

  it('半句后跟新段落标记（# / - / 换行）→ 不合并', async () => {
    const { segmentsToStreamEntries } = await import('../src/pages/ChatComponents.tsx');
    for (const opener of ['## 修复方案', '- 第一项', '\n\n下一段']) {
      const entries = segmentsToStreamEntries(
        [text('先说结论'), tool('file_write'), text(opener)] as unknown as Seg,
        'agt_1',
        T,
      );
      expect(shape(entries)[0]).toBe('text:先说结论');
      expect(shape(entries)).toContain('tool:file_write');
      expect(shape(entries).filter(s => s.startsWith('text:')).length).toBe(2);
    }
  });

  it('拼接只补原文确实存在的空白，不按字符类型猜', async () => {
    const { joinProse, isSentenceContinuation } = await import('../src/pages/ChatComponents.tsx');
    expect(joinProse('我先看一下代码', '找到问题了')).toBe('我先看一下代码找到问题了');
    // 原文此处没有空白 → 原样相接。（曾被误接成 "w ith" 的就是这一类：分段点在
    // token 边界，而 token 会在词中间断开。）
    expect(joinProse('correcting my', 'test expectations.')).toBe('correcting mytest expectations.');
    // 原文本来有空白、被 trim() 抹掉了 → 补回来（靠 metadata 记账，不靠猜）
    expect(joinProse('correcting my', 'test expectations.', { spaceNeeded: true })).toBe('correcting my test expectations.');
    expect(joinProse('correcting my ', 'test')).toBe('correcting my test');
    expect(isSentenceContinuation('已经写完了。', '下一句')).toBe(false);
    expect(isSentenceContinuation('还没写', '完的半句')).toBe(true);
    expect(isSentenceContinuation('', '续写')).toBe(false);
    expect(isSentenceContinuation('没有标点的半句 ', ' 接着写')).toBe(true);
  });

  it('没有续写时输出顺序与输入完全一致（回归）', async () => {
    const { segmentsToStreamEntries } = await import('../src/pages/ChatComponents.tsx');
    const entries = segmentsToStreamEntries(
      [
        text('第一步。'),
        tool('shell_execute'),
        text('第二步。'),
        tool('file_edit'),
        text('收尾。'),
      ] as unknown as Seg,
      'agt_1',
      T,
    );

    expect(shape(entries)).toEqual([
      'text:第一步。',
      'tool:shell_execute', 'tool_end:shell_execute',
      'text:第二步。',
      'tool:file_edit', 'tool_end:file_edit',
      'text:收尾。',
    ]);
  });
});
