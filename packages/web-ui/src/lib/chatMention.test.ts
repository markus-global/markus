import { describe, expect, it } from 'vitest';
import { removeMentionTrigger } from './chatMention.ts';

describe('removeMentionTrigger — 选中 @ 项后不残留前缀', () => {
  it('按记录的触发位置删除 @ + 前缀（光标已失焦也不受影响）', () => {
    // 这条守的就是生产现象：点下拉项时 textarea 已失焦，用光标反推会算错区间。
    expect(removeMentionTrigger('看看 @交付 这个', { at: 3, fragment: '交付' }, 0)).toBe('看看  这个');
  });

  it('前缀后面还有正文时只删触发片段，正文原样保留', () => {
    expect(removeMentionTrigger('a @work 后面的话', { at: 2, fragment: 'work' }, 0)).toBe('a  后面的话');
  });

  it('文本被改过（记录的片段不再匹配）→ 回退到光标前最后一个 @', () => {
    expect(removeMentionTrigger('x @abc y', { at: 2, fragment: 'zzz' }, 6)).toBe('x  y');
  });

  it('没有 @ 时原样返回，不吞字符', () => {
    expect(removeMentionTrigger('hello', null, 5)).toBe('hello');
  });

  it('光标越界被夹紧，不抛错', () => {
    expect(removeMentionTrigger('@abc', null, 999)).toBe('');
  });
});
