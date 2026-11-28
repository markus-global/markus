/**
 * 右侧栏「分割线纪律」（Owner 2026-11-28）：
 *
 *   ① 右栏与聊天区之间**只**有一条竖直分割线，且常显（不再靠 hover 才出现）；
 *   ② 顶部图标行（tab 栏）与主体之间**没有**横向分割线；
 *   ③ 终端（命令行）页面**没有**自己的外框（否则右栏里套一层框，边界出现两份）。
 *
 * happy-dom 没有布局引擎、也不加载 Tailwind CSS，所以这里钉的是**结构承诺**
 * （哪个节点带/不带哪条线类）。纯视觉的最终观感仍需真浏览器确认，但「有人把线加
 * 回来」这种回归会被这几条咬住。
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // DirectoryPreview 会 import 到 src/i18n/index.ts，那里 .use(initReactI18next)；
  // 缺这个成员会让整个测试文件在 import 阶段就挂掉（不是断言失败）。
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('../src/api.ts', () => ({
  api: {
    files: {
      preview: async () => ({ type: 'text', name: 'a.txt', path: '/tmp/a.txt', content: '' }),
      stat: async () => ({ exists: true, path: '/tmp/a.txt', mtimeMs: 1, size: 1 }),
      check: async () => ({ results: {} }),
      reveal: async () => ({}),
      streamUrl: (p: string) => `/api/files/stream?path=${encodeURIComponent(p)}`,
    },
    browser: { tabOwnership: async () => ({ ownership: [] }) },
    terminal: { sessionOwnership: async () => ({ ownership: [] }) },
    deliverables: { update: async () => ({}) },
  },
  wsClient: { on: () => () => {} },
  getHubToken: async () => null,
  hubApi: { getUrl: () => 'http://127.0.0.1:1/hub' },
}));

// 终端宿主只需要挂载，不需要真的跑 xterm。
vi.mock('@xterm/xterm', () => ({ Terminal: class { open() {} write() {} dispose() {} loadAddon() {} onData() { return { dispose() {} }; } } }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { activate() {} dispose() {} fit() {} } }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { activate() {} } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class { activate() {} } }));

import { RightPanel } from '../src/components/RightPanel.tsx';
import { EmbeddedTerminal } from '../src/components/EmbeddedTerminal.tsx';

const PANEL = {
  payload: { kind: 'file' as const, path: '/tmp/a.txt', title: 'a.txt' },
  onClose: () => {},
  width: 480,
  onResizeStart: () => {},
};

describe('右栏分割线 — 只留左栏那条竖直的', () => {
  it('顶部图标行与主体之间没有横向分割线', () => {
    const { container } = render(<RightPanel {...PANEL} />);
    const header = container.querySelector('header')!;
    expect(header).not.toBeNull();
    expect(header.className).not.toContain('border-b');
  });

  it('右栏与聊天区之间那条线常显（不靠 hover 才出现）', () => {
    const { container } = render(<RightPanel {...PANEL} />);
    const handle = container.querySelector('[data-panel-divider]') as HTMLElement;
    expect(handle).not.toBeNull();

    const line = handle.firstElementChild as HTMLElement;
    // 常量线：有实体颜色，且不再用「透明边框 + hover 才上色」的老写法。
    expect(line.className).toContain('bg-border-default');
    expect(line.className).not.toContain('border-transparent');
    expect(line.className).not.toContain('border-dashed');
  });
});

describe('终端宿主 — 不套外框', () => {
  it('命令行页面的容器没有 border / 圆角卡片外壳', () => {
    const { container } = render(<EmbeddedTerminal terminalId="term_test" title="Terminal" active />);
    const host = container.querySelector('[data-terminal-host]') as HTMLElement;
    expect(host).not.toBeNull();
    expect(host.className).not.toContain('border ');
    expect(host.className).not.toContain('rounded-lg');
  });
});
