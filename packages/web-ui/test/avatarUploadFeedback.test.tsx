/**
 * AvatarUpload 反馈回归护栏 —— Team Chat 顶部 Agent 头像设置。
 *
 * 用户报障原话：「仍然要等好几秒才会切换，中间也没有加载中的提示。」
 *
 * 前半句的根因在后端接口开销（GET /api/agents 要为每个 Agent 派生运行时信息），
 * 修法在 Team.tsx：上传成功即乐观写入本地 agents，不等全量刷新。**这里钉的是后半句**
 * ——前端反馈，以及那个乐观写入所依赖的 URL 契约：
 *
 *   - 组件内部的 <img> 显示的是 FileReader 读出的**本地预览**，文件一选就换了，
 *     看起来像「已经传完」，而 POST 其实还在飞。所以上传中必须**强制常显**遮罩 +
 *     转圈；沿用平时那套 `opacity-0 group-hover:opacity-100` 是不行的 —— 鼠标一移开
 *     反馈就消失，等于没有反馈。这是本次最容易改回去的一行。
 *   - onUploaded 必须交出**服务端返回的 URL**（带 ?v= 版本号），而不是本地 dataURL：
 *     乐观写入如果写的是 dataURL，缓存版本号就丢了，直接退回「换头像后列表不刷新」
 *     的老 bug（文件名固定 + 浏览器长缓存命中）。
 *   - title 走 i18n，不再硬编码英文（中文界面里冒出 "Click to set avatar" 是同一个
 *     组件的旧账）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

// 组件只依赖 api / i18n；把两者钉住，测试只驱动「上传中 -> 上传完」这一条状态机。
vi.mock('../src/api.ts', () => ({
  api: { auth: { uploadAvatar: vi.fn() } },
  hubApi: { getUrl: vi.fn(() => null) },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { api } from '../src/api.ts';
import { AvatarUpload } from '../src/components/Avatar.tsx';

const mockUpload = vi.mocked(api.auth.uploadAvatar);

/** 遮罩层：按钮内唯一的 absolute inset-0 覆盖块。 */
function overlay(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('div.absolute.inset-0');
  if (!el) throw new Error('overlay not found');
  return el;
}

function pickFile(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('file input not found');
  const file = new File(['fake-png-bytes'], 'me.png', { type: 'image/png' });
  fireEvent.change(input, { target: { files: [file] } });
}

/** 手动控制挂起/兑现的 promise，用来观察「上传中」这一帧。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('AvatarUpload — 上传中反馈', () => {
  beforeEach(() => {
    mockUpload.mockReset();
  });

  it('上传挂起时常显遮罩（不依赖 hover），让用户看得到「在传」', async () => {
    const d = deferred<{ avatarUrl: string }>();
    mockUpload.mockReturnValue(d.promise);

    const { container } = render(<AvatarUpload targetType="agent" targetId="a1" />);

    // 初始（空闲）态：走 hover 才出现 —— 这是正常的相机提示，不能常显。
    expect(overlay(container).className).toContain('opacity-0');

    pickFile(container);

    // 一旦进入上传中，遮罩必须常显。旧实现这里是 opacity-0 + group-hover，
    // 于是「中间也没有加载中的提示」。
    await waitFor(() => {
      const cls = overlay(container).className;
      expect(cls).toContain('opacity-100');
      expect(cls).not.toContain('opacity-0');
    });

    // 且此时按钮对外声明 busy。
    const button = container.querySelector('button');
    expect(button?.getAttribute('aria-busy')).toBe('true');

    // 收尾，避免 act 警告。
    d.resolve({ avatarUrl: '/api/avatars/agent_a1.png?v=1' });
    await waitFor(() => expect(overlay(container).className).toContain('opacity-0'));
  });

  it('onUploaded 交出服务端 URL（带 ?v= 版本号），不是本地 dataURL', async () => {
    mockUpload.mockResolvedValue({ avatarUrl: '/api/avatars/agent_a1.png?v=1730000000000' });
    const onUploaded = vi.fn();

    const { container } = render(
      <AvatarUpload targetType="agent" targetId="a1" onUploaded={onUploaded} />,
    );
    pickFile(container);

    await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(1));
    expect(onUploaded).toHaveBeenCalledWith('/api/avatars/agent_a1.png?v=1730000000000');
    // 关键：绝不能把 FileReader 的 data: URL 当成结果交出去。
    expect(onUploaded.mock.calls[0]![0]).not.toMatch(/^data:/);
    expect(mockUpload).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/png/), 'agent', 'a1');
  });

  it('title 走 i18n，不硬编码英文', () => {
    const { container } = render(<AvatarUpload targetType="agent" targetId="a1" />);
    // t 被 mock 成回显 key：硬编码英文会得到 "Click to set avatar"。
    expect(container.querySelector('button')?.getAttribute('title')).toBe('clickToSetAvatar');
  });
});
