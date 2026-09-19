// ChatComponents.tsx 会经 api.ts 读 window；happy-dom 项目里 window 已存在，
// 但这里沿用 streamSentenceHealing.test.ts 的显式桩，避免测试文件之间行为漂移。
vi.hoisted(() => {
  (globalThis as unknown as { window: unknown }).window = {
    __MARKUS_HUB_BASE_URL__: '',
    location: { origin: 'http://localhost' },
  } as unknown as Window & typeof globalThis;
  return true;
});

/**
 * 拼接正文时的空白纪律 —— 「半句 → 工具 → 剩下半句」接回来之后，中间多了个空格。
 *
 * 根因：分段发生在 **token 边界**，而 token 会在词中间断开（`w` + `ith`）——此时
 * 原文两边都没有空白，正确做法是原样相接。旧实现按「拉丁字母交界就补空格」去猜，
 * 于是把一个词接成了 `w ith`。
 *
 * 现在改为记账制：`emitText` 把**原文真实存在**的首尾空白记进 metadata
 * （trailingSpace / leadingSpace / paragraphAfter），拼接只补那些被 `trim()`
 * 抹掉的空白，绝不凭空插入。下面正反两个方向都必须锁住：
 *   ① 原文此处没有空白 → 不插空格（w + ith = with）
 *   ② 原文此处本来有空白 → 补回来（…my + test = …my test）
 */
import { describe, it, expect } from 'vitest';

type Seg = Parameters<
  (typeof import('../src/pages/ChatComponents.tsx'))['segmentsToStreamEntries']
>[0];

const T = '2026-09-19T15:18:00.000Z';

function text(content: string) {
  return { type: 'text' as const, content, createdAt: T };
}
function tool(name: string) {
  return { type: 'tool' as const, key: `${name}_0`, tool: name, status: 'done' as const, durationMs: 3, createdAt: T };
}

describe('正文拼接：只补原文确实存在的那个空格', () => {
  it('被切开的一个词原样接回：w + ith → with（绝不凭空插空格）', async () => {
    const { segmentsToStreamEntries } = await import('../src/pages/ChatComponents.tsx');
    const entries = segmentsToStreamEntries(
      [
        text('The helper is w'),
        tool('file_edit'),
        text('ith a regression test.'),
      ] as unknown as Seg,
      'agt_1',
      T,
    );

    expect(entries.map(e => e.content)).toContain('The helper is with a regression test.');
    // 反向断言：旧的「补空格」行为绝不能回来
    expect(entries.map(e => e.content)).not.toContain('The helper is w ith a regression test.');
  });

  it('原文此处本来有空白 → 补回来（trim() 抹掉的那个）', async () => {
    const { segmentsToStreamEntries } = await import('../src/pages/ChatComponents.tsx');
    const entries = segmentsToStreamEntries(
      [
        text('Fixing the component, then correcting my '), // ← 原文行尾本来有空格
        tool('file_edit'),
        text('test expectations.'),
      ] as unknown as Seg,
      'agt_1',
      T,
    );

    expect(entries.map(e => e.content)).toContain(
      'Fixing the component, then correcting my test expectations.',
    );
  });

  it('原文以空行收尾 = 这句已经说完 → 不合并、工具留在原位', async () => {
    const { segmentsToStreamEntries } = await import('../src/pages/ChatComponents.tsx');
    const entries = segmentsToStreamEntries(
      [
        text('第一段写完了。\n\n'),
        tool('file_read'),
        text('第二段另起一段。'),
      ] as unknown as Seg,
      'agt_1',
      T,
    );

    const contents = entries.map(e => e.content);
    expect(contents).toContain('第一段写完了。');
    expect(contents).toContain('第二段另起一段。');
    // 中间的过程行仍在两者之间（没有被并掉）
    expect(entries.map(e => e.type).indexOf('tool_start')).toBeGreaterThan(
      entries.findIndex(e => e.content === '第一段写完了。'),
    );
  });

  it('joinProse 不再按字符类型猜空格', async () => {
    const { joinProse } = await import('../src/pages/ChatComponents.tsx');

    expect(joinProse('w', 'ith')).toBe('with');                                  // 词中间断开
    expect(joinProse('my', 'test', { spaceNeeded: true })).toBe('my test');      // 原文有空白
    expect(joinProse('word ', 'next')).toBe('word next');                        // 自带空白
    expect(joinProse('中文', '继续')).toBe('中文继续');                            // CJK 不留缝
    expect(joinProse('done。', 'Next')).toBe('done。Next');                       // 无原文空白就不插
  });

  it('空行开头的分段（模型自己另起一段）仍然不接上一句', async () => {
    const { segmentsToStreamEntries } = await import('../src/pages/ChatComponents.tsx');
    const entries = segmentsToStreamEntries(
      [
        text('上面这段没有结束标点'),
        tool('grep_search'),
        text('\n- 新的一段列表项'),
      ] as unknown as Seg,
      'agt_1',
      T,
    );

    const contents = entries.map(e => e.content);
    expect(contents).toContain('上面这段没有结束标点');
    expect(contents).toContain('- 新的一段列表项');
  });
});
