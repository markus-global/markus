/**
 * 账户弹层「版本号页脚」契约（Owner 2026-11-28 反馈）。
 *
 * 要求：点头像后的弹窗，**最底部**要有当前版本信息。
 *
 * 断言策略（不看 class，咬结构）：
 *  - 版本页脚必须是弹层面板的**最后一个子元素** —— 只要有人把它挪到中间或塞进
 *    某个折叠区，这条就会红（「最底部」是可判定的位置约束，不是样式偏好）。
 *  - 折叠侧栏（只有一个头像）时，弹层里依然看得到版本 —— 折叠态下侧栏那一行
 *    没有位置显示内联版本号，弹层是唯一出口。
 *  - 版本号来自构建期注入的 `__APP_VERSION__`，显示为 `v` + 原值。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../src/api.ts', () => ({
  hubApi: { getUrl: () => 'http://127.0.0.1:1/hub' },
  getHubUser: () => null,
  validateHubSession: async () => null,
  api: { avatars: { upload: vi.fn() } },
}));

vi.mock('../src/hooks/useHubAccount.ts', () => ({
  useHubAccount: () => ({ connected: false, user: null, credits: null, refresh: () => {} }),
}));

const authUser = { id: 'u1', name: 'Alice', email: 'alice@example.com', role: 'owner', orgId: 'o1' };

import { UserAccountMenu } from '../src/components/UserAccountMenu.tsx';

describe('账户弹层 — 版本信息在最底部', () => {
  beforeEach(() => {
    // 构建期常量（vite define）在测试环境不存在，这里显式钉住取值口径。
    vi.stubGlobal('__APP_VERSION__', '9.9.9');
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  function openPopover(collapsed = false) {
    const utils = render(
      <UserAccountMenu authUser={authUser} collapsed={collapsed} onLogout={() => {}} />,
    );
    fireEvent.click(utils.getByTitle('Alice'));
    const footer = document.querySelector('[data-account-version]');
    return { ...utils, footer };
  }

  it('页脚渲染在弹层最底部，并显示 v + 构建版本', () => {
    const { footer } = openPopover();

    expect(footer).not.toBeNull();
    expect(footer!.textContent).toContain('v9.9.9');

    // 「最底部」：版本页脚是弹层面板的最后一个子元素。
    const panel = footer!.parentElement!;
    expect(panel.lastElementChild).toBe(footer);
    // 页脚确实属于弹层（不是页面别处跑出来的副本）。
    expect(panel.className).toContain('fixed');
  });

  it('折叠侧栏（只显示头像）时，版本依然能在弹层里看到', () => {
    const { footer, container } = openPopover(true);

    expect(footer).not.toBeNull();
    expect(footer!.textContent).toContain('v9.9.9');
    // 折叠态侧栏没有内联版本号可看 —— 弹层是唯一出口。
    expect(container.textContent).not.toContain('v9.9.9');
  });
});
