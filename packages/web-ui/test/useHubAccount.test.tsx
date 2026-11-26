/**
 * useHubAccount 回归护栏 —— 安全级：登录多用户 token 隔离。
 *
 * 这个 hook 统一了桌面账号 popover 与移动抽屉的 Hub 账户状态。它刚被修过：
 * 此前两处各持一份 validate / focus / hub-auth 逻辑且已经漂移，导致同一账号
 * 显示两个不同余额。这里的断言把几条容易再次踩空的边界钉死：
 *
 *   - 未认证时 credits 必须是 null，绝不渲染假的 0 余额；
 *   - 本地缓存里有 token 不等于「已连接」，陈旧 token 必须被探测纠正；
 *   - 切换登录用户后不得残留上一个用户的 user / credits（核心安全断言）；
 *   - markus:hub-auth 只读缓存、不再 validate（validate→saveHubAuth→hub-auth
 *     历史上是死循环）；focus 才触发 validate；
 *   - 卸载后 window 监听器必须摘干净，不泄漏。
 *
 * api.ts 与 lib/hubCredits.ts 被整体 mock，测试只驱动 hook 的状态机。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../src/api.ts', () => ({
  getHubUser: vi.fn(),
  validateHubSession: vi.fn(),
  hubApi: {
    isAuthenticated: vi.fn(),
    user: { plan: vi.fn() },
  },
}));

vi.mock('../src/lib/hubCredits.ts', () => ({
  resolveCreditSummary: vi.fn(),
}));

import { getHubUser, validateHubSession, hubApi } from '../src/api.ts';
import { resolveCreditSummary } from '../src/lib/hubCredits.ts';
import { useHubAccount } from '../src/hooks/useHubAccount.ts';

const mockIsAuth = vi.mocked(hubApi.isAuthenticated);
const mockGetUser = vi.mocked(getHubUser);
const mockValidate = vi.mocked(validateHubSession);
const mockPlan = vi.mocked(hubApi.user.plan);
const mockResolveSummary = vi.mocked(resolveCreditSummary);

function user(id: string) {
  return { id, username: id };
}

const summary = (total: number) => ({ total, used: 0, remaining: total, pct: 0, personalLimit: false });

/** 排空 hook 里 then 链产生的微任务（validate / plan 各一次 setState）。 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function fire(event: Event): Promise<void> {
  await act(async () => {
    window.dispatchEvent(event);
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * 文件级确定性 localStorage。
 *
 * 为什么必须是文件级：hook 会拿 `markus:hub:credits` 缓存当初始值（「冷启动先显示
 * 上次读数」）。只要某个用例成功跑完一次 plan，它就会把 `summary(0)` 写进缓存；
 * 下一个用例再挂载就**读到上一个用例的余额** —— 「plan 失败时 credits 必须为 null」
 * 于是变成依赖执行顺序与微任务时序的断言：本机绿、CI 红（CI 实测收到 summary(0)）。
 *
 * happy-dom 自带的 localStorage 不可信（连 removeItem 都没有），所以自建 stub；
 * 每个用例前清空 —— 让「缓存为空」是**显式前提**，而不是运气。
 */
const cacheStore = new Map<string, string>();
const storageStub: Storage = {
  getItem: (k: string) => cacheStore.get(k) ?? null,
  setItem: (k: string, v: string) => { cacheStore.set(k, String(v)); },
  removeItem: (k: string) => { cacheStore.delete(k); },
  clear: () => { cacheStore.clear(); },
  key: (i: number) => [...cacheStore.keys()][i] ?? null,
  get length() { return cacheStore.size; },
};

beforeEach(() => {
  vi.resetAllMocks();
  // 默认：未登录、无缓存、探测失败、无 planned 余额。
  cacheStore.clear();
  vi.stubGlobal('localStorage', storageStub);
  mockIsAuth.mockReturnValue(false);
  mockGetUser.mockReturnValue(null);
  mockValidate.mockResolvedValue(false);
  mockPlan.mockResolvedValue({ total: 0 });
  mockResolveSummary.mockReturnValue(summary(0));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useHubAccount — 未认证', () => {
  it('未认证时 connected=false、user=null、credits=null（不得渲染假的 0 余额）', async () => {
    const { result } = renderHook(() => useHubAccount(true));
    await flush();

    expect(result.current.connected).toBe(false);
    expect(result.current.user).toBeNull();
    expect(result.current.credits).toBeNull();
    // 未认证就不该发任何网络请求
    expect(mockValidate).not.toHaveBeenCalled();
    expect(mockPlan).not.toHaveBeenCalled();
    expect(mockResolveSummary).not.toHaveBeenCalled();
  });
});

describe('useHubAccount — 缓存 token 必须经探测确认', () => {
  it('本地有缓存 token 但探测失败时，不能算已连接', async () => {
    mockIsAuth.mockReturnValue(true);
    mockGetUser.mockReturnValue(user('A'));

    let resolveProbe!: (v: boolean) => void;
    mockValidate.mockReturnValue(new Promise<boolean>(r => { resolveProbe = r; }));

    const { result } = renderHook(() => useHubAccount(false));
    await flush();
    // 挂载即发出探测（缓存里有 token，不能只凭缓存就宣布已连接）
    expect(mockValidate).toHaveBeenCalledTimes(1);

    // 探测判定陈旧 token 无效 → connected 必须翻回 false
    await act(async () => { resolveProbe(false); await Promise.resolve(); });
    expect(result.current.connected).toBe(false);
  });
});

describe('useHubAccount — refresh 的 validate 语义', () => {
  it('refresh({validate:false}) 只读本地缓存、不发探测；{validate:true} 才发探测', async () => {
    mockIsAuth.mockReturnValue(true);
    mockGetUser.mockReturnValue(user('A'));
    mockValidate.mockResolvedValue(true);

    const { result } = renderHook(() => useHubAccount(false));
    await flush();
    const base = mockValidate.mock.calls.length; // 挂载时的 1 次
    expect(base).toBe(1);

    act(() => { result.current.refresh({ validate: false }); });
    await flush();
    expect(mockValidate.mock.calls.length).toBe(base); // 不发探测
    expect(result.current.connected).toBe(true);
    expect(result.current.user).toEqual(user('A'));

    act(() => { result.current.refresh({ validate: true }); });
    await flush();
    expect(mockValidate.mock.calls.length).toBe(base + 1); // 发探测
  });
});

describe('useHubAccount — credits 取值', () => {
  it('plan 接口失败时 credits 保持 null（而不是 0）', async () => {
    mockIsAuth.mockReturnValue(true);
    mockGetUser.mockReturnValue(user('A'));
    mockValidate.mockResolvedValue(true);
    mockPlan.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useHubAccount(true));
    await flush();

    expect(mockPlan).toHaveBeenCalledTimes(1);
    expect(result.current.credits).toBeNull();
    expect(mockResolveSummary).not.toHaveBeenCalled();
  });

  it('缓存属于同一账号时，plan 失败保留上次读数（既不造假 0，也不抹成 null）', async () => {
    // 钉住 hook 的既有契约（useHubAccount.ts 的 catch 注释）：一次失败的刷新不该把
    // 「仍然是最好的答案」抹掉。与上一条的区别**只在缓存**，两条一起把这条边界说清楚：
    // 空缓存 → null（不渲染假 0）；有同账号缓存 → 保留（不用空白替换可信旧值）。
    cacheStore.set('markus:hub:credits', JSON.stringify({
      userId: 'A',
      credits: { total: 42, used: 0, remaining: 42, pct: 0, personalLimit: false },
    }));
    mockIsAuth.mockReturnValue(true);
    mockGetUser.mockReturnValue(user('A'));
    mockValidate.mockResolvedValue(true);
    mockPlan.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useHubAccount(true));
    await flush();

    expect(result.current.credits?.remaining).toBe(42);
  });

  it('plan 成功时 credits 来自 resolveCreditSummary（唯一真源）', async () => {
    mockIsAuth.mockReturnValue(true);
    mockGetUser.mockReturnValue(user('A'));
    mockValidate.mockResolvedValue(true);
    const plan = { total: 123 };
    mockPlan.mockResolvedValue(plan);
    mockResolveSummary.mockReturnValue(summary(123));

    const { result } = renderHook(() => useHubAccount(true));
    await flush();

    expect(mockResolveSummary).toHaveBeenCalledWith(plan);
    expect(result.current.credits).toEqual(summary(123));
  });
});

describe('useHubAccount — 多用户切换隔离（核心安全断言）', () => {
  it('切换登录用户后不得残留上一个用户的 user / credits', async () => {
    // 用户 A 已登录
    mockIsAuth.mockReturnValue(true);
    mockGetUser.mockReturnValue(user('A'));
    mockValidate.mockResolvedValue(true);
    mockPlan
      .mockResolvedValueOnce({ total: 111 })
      .mockResolvedValueOnce({ total: 222 });
    mockResolveSummary.mockImplementation((p: { total?: number }) => summary(p.total ?? 0));

    const { result } = renderHook(() => useHubAccount(true));
    await flush();
    expect(result.current.user?.id).toBe('A');
    expect(result.current.credits?.total).toBe(111);

    // 登出：本地缓存被清空，clearHubAuth() 会派发 markus:hub-auth。
    mockIsAuth.mockReturnValue(false);
    mockGetUser.mockReturnValue(null);
    await fire(new CustomEvent('markus:hub-auth'));
    expect(result.current.connected).toBe(false);
    expect(result.current.user).toBeNull();
    expect(result.current.credits).toBeNull();

    // 换用户 B 登录：saveHubAuth() 也会派发 markus:hub-auth。
    mockIsAuth.mockReturnValue(true);
    mockGetUser.mockReturnValue(user('B'));
    await fire(new CustomEvent('markus:hub-auth'));
    await flush();

    expect(result.current.user?.id).toBe('B');
    expect(result.current.connected).toBe(true);
    // 关键：不能还是 A 的 111
    expect(result.current.credits?.total).toBe(222);
    expect(result.current.credits?.total).not.toBe(111);
  });
});

describe('useHubAccount — active 开关', () => {
  it('挂载即请求 plan（徽章不等弹窗）；active=true 时再刷新一次', async () => {
    mockIsAuth.mockReturnValue(true);
    mockGetUser.mockReturnValue(user('A'));
    mockValidate.mockResolvedValue(true);

    const { rerender } = renderHook(({ active }: { active: boolean }) => useHubAccount(active), {
      initialProps: { active: false },
    });
    await flush();
    // The balance is shown in the sidebar, so it must exist before any interaction.
    // Gating this on `active` left the badge blank until the menu had been opened once.
    expect(mockPlan).toHaveBeenCalledTimes(1);

    rerender({ active: true });
    await flush();
    // Opening the popover re-checks the number.
    expect(mockPlan).toHaveBeenCalledTimes(2);
  });

  it('未认证时不请求 plan（无 token 拉不到，白跑一次请求）', async () => {
    mockIsAuth.mockReturnValue(false);

    renderHook(() => useHubAccount(false));
    await flush();
    expect(mockPlan).not.toHaveBeenCalled();
  });
});

describe('useHubAccount — 事件语义（hub-auth vs focus）', () => {
  it('markus:hub-auth 读缓存、不再 validate；focus 触发 validate', async () => {
    mockIsAuth.mockReturnValue(true);
    mockGetUser.mockReturnValue(user('A'));
    mockValidate.mockResolvedValue(true);

    const { result } = renderHook(() => useHubAccount(false));
    await flush();
    const baseValidate = mockValidate.mock.calls.length; // 1
    const baseGetUser = mockGetUser.mock.calls.length;

    // 缓存换了（新用户 B），hub-auth 只应重读缓存
    mockGetUser.mockReturnValue(user('B'));
    await fire(new CustomEvent('markus:hub-auth'));
    expect(mockValidate.mock.calls.length).toBe(baseValidate); // 不再探测（防死循环）
    expect(mockGetUser.mock.calls.length).toBeGreaterThan(baseGetUser);
    expect(result.current.user?.id).toBe('B');

    // focus 才触发 validate
    await fire(new Event('focus'));
    expect(mockValidate.mock.calls.length).toBe(baseValidate + 1);
  });
});

describe('useHubAccount — 卸载清理', () => {
  it('卸载时移除 window 监听器，且之后不再响应事件', async () => {
    mockIsAuth.mockReturnValue(true);
    mockGetUser.mockReturnValue(user('A'));
    mockValidate.mockResolvedValue(true);

    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const { unmount } = renderHook(() => useHubAccount(false));
    await flush();

    const authHandler = addSpy.mock.calls.find(c => c[0] === 'markus:hub-auth')?.[1];
    const focusHandler = addSpy.mock.calls.find(c => c[0] === 'focus')?.[1];
    expect(typeof authHandler).toBe('function');
    expect(typeof focusHandler).toBe('function');

    unmount();

    // 用同一个 handler 引用移除（证明不是「注册了一套、移除了另一套」）
    expect(removeSpy).toHaveBeenCalledWith('markus:hub-auth', authHandler);
    expect(removeSpy).toHaveBeenCalledWith('focus', focusHandler);

    // 行为层面：卸载后再派发事件不应再触发任何读取 / 探测
    const vBefore = mockValidate.mock.calls.length;
    const gBefore = mockGetUser.mock.calls.length;
    window.dispatchEvent(new CustomEvent('markus:hub-auth'));
    window.dispatchEvent(new Event('focus'));
    expect(mockValidate.mock.calls.length).toBe(vBefore);
    expect(mockGetUser.mock.calls.length).toBe(gBefore);
  });
});

/**
 * 冷启动的「先给旧值、后台刷新」契约。
 *
 * 曾经的症状：打开侧栏账号弹窗，可用积分先显示 `—`，过一会才变成数字。请求早已
 * 提到挂载时发起（上一轮修过），但 `credits` 初始恒为 null —— 冷启动永远没有旧值
 * 可显示，只能干等网络。这组断言钉住：有缓存就能立刻出数，且缓存绝不跨账号。
 *
 * 关键手法：`plan` 返回一个永不 resolve 的 Promise。这样屏幕上出现的任何数字都
 * 只可能来自缓存 —— 若把初始值改回 null，这些用例必红。
 */
describe('useHubAccount — 冷启动先显示上次读数', () => {
  // 存储桩是**文件级**的（见上方 cacheStore）：这里不再自建第二份，
  // 只负责把想要的上次读数种进去。
  const CACHE_KEY = 'markus:hub:credits';

  const seed = (userId: string, total: number) =>
    localStorage.setItem(CACHE_KEY, JSON.stringify({ userId, credits: summary(total) }));

  it('有缓存且账号匹配时，plan 尚未返回就先给出余额', () => {
    mockIsAuth.mockReturnValue(true);
    mockGetUser.mockReturnValue(user('u1'));
    seed('u1', 500);
    mockPlan.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() => useHubAccount(false));

    expect(result.current.credits?.remaining).toBe(500);
  });

  it('缓存属于另一个账号时不显示（宁可空，也不给错数）', () => {
    mockIsAuth.mockReturnValue(true);
    mockGetUser.mockReturnValue(user('u2'));
    seed('u1', 500);
    mockPlan.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() => useHubAccount(false));

    expect(result.current.credits).toBeNull();
  });

  it('plan 成功后把读数写回缓存，供下次冷启动直接显示', async () => {
    mockIsAuth.mockReturnValue(true);
    mockGetUser.mockReturnValue(user('u1'));
    mockPlan.mockResolvedValue({ total: 42 });
    mockResolveSummary.mockReturnValue(summary(42));

    renderHook(() => useHubAccount(false));
    await flush();

    const raw = localStorage.getItem(CACHE_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).userId).toBe('u1');
    expect(JSON.parse(raw as string).credits.remaining).toBe(42);
  });

  it('刷新失败不抹掉缓存里的数字（旧值仍是最优答案）', async () => {
    mockIsAuth.mockReturnValue(true);
    mockGetUser.mockReturnValue(user('u1'));
    seed('u1', 500);
    mockPlan.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useHubAccount(false));
    await flush();

    expect(result.current.credits?.remaining).toBe(500);
  });

  it('登出后清掉缓存，下一个账号不会看到它', async () => {
    seed('u1', 500);
    mockIsAuth.mockReturnValue(false);
    mockGetUser.mockReturnValue(null);

    renderHook(() => useHubAccount(false));
    await flush();

    expect(localStorage.getItem(CACHE_KEY)).toBeNull();
  });
});
