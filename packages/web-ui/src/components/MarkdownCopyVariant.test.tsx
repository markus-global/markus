/**
 * 卡5 — 复制按钮两档（`inline` / `preview`）的**行为**守卫。
 *
 * ── 这道守卫要防的是什么 ────────────────────────────────────────────────────
 * 需求是「按使用场景分两档，不做一刀切」。这类需求最省力的两种死法都不会
 * 让既有测试变红：
 *
 *   ① **看似有参数，其实没人用**——`copyVariant` 加上了、默认值是 inline，
 *      但 RightPanel 两个预览调用点没传（或 ContentRenderer 没往下转发），
 *      于是两档永远只渲染出 inline：类型检查绿、既有测试全绿、功能等于没做。
 *   ② **档位只活在类名里、活在别人的祖先里**——用 `:has()` / DOM 祖先探测 /
 *      「有没有 pr-8 这个 padding」去猜场景。这种推断在组件被多包一层、
 *      或被塞进 modal 的那天就会静默翻转，而且没有任何断言会响。
 *
 * 所以这里断言三件**可观测**的事：
 *   • 两档的呈现差异（preview 不依赖 hover 类名、带「复制」文字；inline 反之），
 *     断言读的是**渲染出来的 DOM**，不是源码文本；
 *   • 参数是真的从调用点一路走到按钮的（ContentRenderer 集成断言）；
 *   • 复制反馈两档一致（同一 i18n 文案、同一条成功路径），权限/降级路径未回归。
 *
 * ⚠️ 每一条都能因「实现被改坏」而红——本文件的负向对照结果写在
 *    docs/… 证据文档 §4（改 preview 为 hover 显隐、删转发、删文字，逐条实测红）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '../i18n/index.ts';

const copyPlainText = vi.fn(async (_text: string) => true);
const copyAsHtml = vi.fn(async () => ({ ok: true, method: 'html' as const }));

vi.mock('./markdown-copy.ts', () => ({
  copyPlainText: (text: string) => copyPlainText(text),
  copyAsHtml: () => copyAsHtml(),
}));

import { MarkdownMessage } from './MarkdownMessage.tsx';
import { ContentRenderer } from './ContentRenderer.tsx';
import { FilePreviewEditor } from './FilePreviewEditor.tsx';

const SOURCE = '# 预览内容\n\n一段用于复制的中文正文。';

/** 复制按钮的容器：两档唯一的身份标记，且不依赖文案/语言。 */
function copyWrapper(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-copy-variant]');
  if (!el) throw new Error('copy button wrapper missing');
  return el;
}

/** 复制触发器 = 容器里第一个 button（菜单项只在 open 之后才存在）。 */
function copyTrigger(container: HTMLElement): HTMLElement {
  const el = copyWrapper(container).querySelector('button');
  if (!el) throw new Error('copy trigger missing');
  return el;
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  copyPlainText.mockClear();
  copyAsHtml.mockClear();
});

describe('卡5 · preview 档（文件 / 产出物预览）', () => {
  it('常显：容器不带任何 hover 显隐类，且按钮带「复制」文字', () => {
    const { container } = render(<MarkdownMessage content={SOURCE} copyVariant="preview" />);
    const wrapper = copyWrapper(container);

    expect(wrapper.dataset.copyVariant).toBe('preview');
    // 常显 = 不靠 hover 才出现。两条都是「藏起来」的实现方式，任一条回归即红。
    expect(wrapper.className).not.toContain('opacity-0');
    expect(wrapper.className).not.toContain('group-hover');

    // 文字标签是 preview 档的识别特征（inline 档只有图标）。
    expect(copyTrigger(container).textContent).toContain(i18n.t('common:markdown.copy'));
  });

  it('图标放大到 w-4（原 3.5）', () => {
    const { container } = render(<MarkdownMessage content={SOURCE} copyVariant="preview" />);
    const svg = copyTrigger(container).querySelector('svg');
    expect(svg?.getAttribute('class')).toContain('w-4');
    expect(svg?.getAttribute('class')).toContain('h-4');
  });
});

describe('卡5 · inline 档（聊天消息，默认值）', () => {
  it('不传参数就是 inline：保持 hover 显隐，且只有图标没有文字', () => {
    const { container } = render(<MarkdownMessage content={SOURCE} />);
    const wrapper = copyWrapper(container);

    // 默认值必须真的是 inline —— 把默认值改成 preview 即红。
    expect(wrapper.dataset.copyVariant).toBe('inline');
    expect(wrapper.className).toContain('opacity-0');
    expect(wrapper.className).toContain('group-hover/md:opacity-100');

    // 聊天里每条消息都挂一个「复制」字样太吵：inline 档不得出现文字标签。
    expect(copyTrigger(container).textContent?.trim()).toBe('');
  });

  it('图标同样放大到 w-4（原 3.5）', () => {
    const { container } = render(<MarkdownMessage content={SOURCE} />);
    const svg = copyTrigger(container).querySelector('svg');
    expect(svg?.getAttribute('class')).toContain('w-4');
    expect(svg?.getAttribute('class')).toContain('h-4');
  });
});

describe('卡5 · 两档共享同一条复制路径（反馈不因档位分叉）', () => {
  it.each(['inline', 'preview'] as const)('%s 档：复制 Markdown 原文成功 → 同一句 i18n 成功文案', async (variant) => {
    const user = userEvent.setup();
    const { container } = render(<MarkdownMessage content={SOURCE} copyVariant={variant} />);

    await user.click(copyTrigger(container));
    await user.click(screen.getByRole('button', { name: new RegExp(i18n.t('common:markdown.copyMdSource')) }));

    expect(copyPlainText).toHaveBeenCalledTimes(1);
    expect(copyPlainText).toHaveBeenCalledWith(SOURCE);
    expect(await screen.findByText(i18n.t('common:markdown.copied'))).toBeTruthy();
  });

  it('失败路径不因档位改变：copyPlainText 返回 false → 同一句失败文案', async () => {
    copyPlainText.mockResolvedValueOnce(false);
    const user = userEvent.setup();
    const { container } = render(<MarkdownMessage content={SOURCE} copyVariant="preview" />);

    await user.click(copyTrigger(container));
    await user.click(screen.getByRole('button', { name: new RegExp(i18n.t('common:markdown.copyMdSource')) }));

    expect(await screen.findByText(i18n.t('common:markdown.failed'))).toBeTruthy();
  });
});

describe('卡5 · 调用点接线（参数必须真的走到按钮）', () => {
  it('ContentRenderer 默认仍是 inline —— 任何预览面板之外的地方不会被顺带改掉', async () => {
    const { container } = render(<ContentRenderer content={SOURCE} format="markdown" />);
    const wrapper = await vi.waitFor(() => copyWrapper(container));
    expect(wrapper.dataset.copyVariant).toBe('inline');
  });

  it('ContentRenderer copyVariant="preview" 能一路转发到 MarkdownMessage', async () => {
    const { container } = render(<ContentRenderer content={SOURCE} format="markdown" copyVariant="preview" />);
    const wrapper = await vi.waitFor(() => copyWrapper(container));
    expect(wrapper.dataset.copyVariant).toBe('preview');
    expect(wrapper.className).not.toContain('opacity-0');
  });

  // 验收返修（tsk_35cdf44b）：可编辑文件的预览走 FilePreviewEditor → ContentRenderer，
  // 这条链路上漏转发过一次，于是弹层里的 .md 预览落到 inline 档。断言行为，不读源码。
  it('FilePreviewEditor 把 copyVariant 转发到预览分支（含「复制」文字、不依赖 hover）', async () => {
    const { container } = render(
      <FilePreviewEditor path="/tmp/demo.md" content={SOURCE} format="markdown" copyVariant="preview" />,
    );
    const wrapper = await vi.waitFor(() => copyWrapper(container));
    expect(wrapper.dataset.copyVariant).toBe('preview');
    expect(wrapper.className).not.toContain('opacity-0');
    expect(wrapper.textContent).toContain(i18n.t('common:markdown.copy'));
  });

  it('FilePreviewEditor 不传档位时保持 inline —— 不把预览档外溢到别的场景', async () => {
    const { container } = render(
      <FilePreviewEditor path="/tmp/demo.md" content={SOURCE} format="markdown" />,
    );
    const wrapper = await vi.waitFor(() => copyWrapper(container));
    expect(wrapper.dataset.copyVariant).toBe('inline');
  });
});
