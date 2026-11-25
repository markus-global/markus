/**
 * FeedbackModal 的挂载位置。
 *
 * 真实病因（Owner 2026-11-25 反馈）：反馈弹窗被"关"在聊天框里，右侧栏打开时
 * 挤在左边。原因不是 CSS 值写错，而是 `fixed inset-0` 的定位基准是**最近的带
 * transform / will-change / backdrop-filter / contain 的祖先**，不是视口；聊天
 * 面板就是这种容器。
 *
 * 所以断言不能看 className（换个 class 就失效），要看**节点挂在谁下面**：
 * 这个弹窗必须是 `document.body` 的直接子节点，与该容器无关。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { FeedbackModal } from '../src/components/FeedbackModal.tsx';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// 只 mock 组件真正用到的那几个成员：多补少补都会让测试在无关的地方红。
vi.mock('../src/api.ts', () => ({
  hubApi: {
    isAuthenticated: () => false,
    uploadImage: vi.fn(),
    feedback: { create: vi.fn() },
  },
}));

vi.mock('../src/hooks/useNativeBrowserOverlay.ts', () => ({
  useNativeBrowserOverlay: () => {},
}));

describe('FeedbackModal — 挂载位置', () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  it('挂在 document.body 下，不被渲染进聊天容器', () => {
    const chatContainer = document.createElement('div');
    // 这一行就是真实环境：聊天面板里存在 transform 祖先，fixed 会被它困住。
    chatContainer.style.transform = 'translateZ(0)';
    document.body.appendChild(chatContainer);

    render(<FeedbackModal onClose={() => {}} />, { container: chatContainer });

    // 咬人的两条：去掉 portal 后第一条立刻变红（节点会出现在容器里），
    // 第二条钉住"必须直接挂在 body"，防止被塞进某个 body 内的中间层。
    expect(chatContainer.querySelector('[data-testid="feedback-modal"]')).toBeNull();
    const modal = document.body.querySelector('[data-testid="feedback-modal"]');
    expect(modal).not.toBeNull();
    expect(modal!.parentElement).toBe(document.body);
  });
});
