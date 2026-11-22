/**
 * 输入框模型菜单的读写契约守卫。
 *
 * 事故（2026-11-22，Owner 实测）：给 agent 绑定模型后重启，直接打开 Team Chat，
 * 输入框显示全局默认模型，且设置页里的绑定**也被持久覆写**成「跟随全局」。
 * 根因：菜单把「绑定模型不在当前已加载目录里」当成「绑定永久失效」，在挂载期
 * 调用 onSelect(fallback, 'global', { resetCurrentAgent: true }) 把用户绑定写掉。
 * 而目录是最终一致的（启动冷窗口 / Hub 刷新返回部分目录，实测 739→66→0 波动），
 * 读侧缓存未命中绝不能触发对事实源的写。先开设置页会 force 刷新共享缓存，
 * 恰好掩盖了这个窗口 —— 所以「先开设置页就正常」。
 *
 * 契约：
 *  1. 读路径永不写：目录缺失/部分加载时，不得调用 onSelect，不得改全局路由。
 *  2. 标签显示权威绑定（GET /api/agents/:id 的 effectiveModel），不受目录成员资格 gating。
 *  3. 只有用户显式选择才写（agent / global 两个 scope 的载荷形状钉死）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ChatModelMenu, applyChatModelSelection, type ChatModelSelection } from './ChatModelMenu.tsx';
import { __resetAgentModelSignalsForTests, onAgentModelChanged } from '../lib/agentModelSignals.ts';

const updateConfig = vi.fn(async () => ({ ok: true }));
const updateRouting = vi.fn(async () => ({ ok: true }));
const fetchLlmSettings = vi.fn();
const invalidateLlmSettings = vi.fn();

vi.mock('../api', () => ({
  api: {
    agents: { updateConfig: (...args: unknown[]) => updateConfig(...(args as [])) },
    settings: { updateRouting: (...args: unknown[]) => updateRouting(...(args as [])) },
  },
}));
vi.mock('../lib/llmSettingsCache', () => ({
  fetchLlmSettings: (...args: unknown[]) => fetchLlmSettings(...(args as [])),
  invalidateLlmSettings: () => invalidateLlmSettings(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

const BOUND: ChatModelSelection = { provider: 'markus', model: 'qwen/qwen4-max' };
const GLOBAL: ChatModelSelection = { provider: 'markus', model: 'deepseek/deepseek-v4-flash' };

/** 部分目录：markus 只有 deepseek，没有 agent 绑定的 qwen —— 冷窗口真实形状。 */
const PARTIAL_CATALOG = {
  defaultProvider: 'markus',
  routingDefaultModel: GLOBAL,
  providers: {
    markus: {
      displayName: 'Markus', enabled: true, configured: true,
      model: GLOBAL.model,
      models: [{ id: GLOBAL.model, name: 'DeepSeek V4 Flash' }],
    },
  },
};
const FULL_CATALOG = {
  ...PARTIAL_CATALOG,
  providers: {
    markus: {
      ...PARTIAL_CATALOG.providers.markus,
      models: [
        { id: GLOBAL.model, name: 'DeepSeek V4 Flash' },
        { id: BOUND.model, name: 'Qwen4 Max' },
      ],
    },
  },
};

/** fetchLlmSettings 返回的目录快照，用例可在挂载前改写。
 * 必须立即 resolve：打开菜单会再次触发 loadModels，悬挂 Promise 会把菜单冻在 Loading。 */
let catalogPayload: unknown = PARTIAL_CATALOG;

beforeEach(() => {
  vi.clearAllMocks();
  __resetAgentModelSignalsForTests();
  catalogPayload = PARTIAL_CATALOG;
  fetchLlmSettings.mockImplementation(() => Promise.resolve(catalogPayload));
});

/** 挂载并 flush loadModels 的微任务与全部派生效应。 */
async function mountAndLoad(props: Partial<Parameters<typeof ChatModelMenu>[0]> = {}) {
  const onSelect = vi.fn();
  render(<ChatModelMenu value={BOUND} agentId="agt_1" onSelect={onSelect} {...props} />);
  await act(async () => {});
  await act(async () => {});
  return onSelect;
}

describe('ChatModelMenu 读路径永不写（事故回归）', () => {
  it('绑定模型不在部分目录里：不得重置绑定，标签仍显示权威绑定', async () => {
    const onSelect = await mountAndLoad();
    expect(onSelect).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
    expect(updateRouting).not.toHaveBeenCalled();
    // 标签 = 绑定本身（short id），不是全局默认
    expect(screen.getByRole('button', { name: 'qwen4-max' })).toBeTruthy();
  });

  it('value=null（跟随全局）：标签显示全局默认，且无写', async () => {
    const onSelect = await mountAndLoad({ value: null });
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'deepseek-v4-flash' })).toBeTruthy();
  });

  it('绑定模型在完整目录里：正常显示，无写', async () => {
    catalogPayload = FULL_CATALOG;
    const onSelect = vi.fn();
    render(<ChatModelMenu value={BOUND} agentId="agt_1" onSelect={onSelect} />);
    await act(async () => {});
    await act(async () => {});
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'qwen4-max' })).toBeTruthy();
  });

  it('sticky 全局默认不在目录里：读路径不得改写全局路由（后端 GET 独占 healing）', async () => {
    catalogPayload = {
      ...PARTIAL_CATALOG,
      routingDefaultModel: { provider: 'markus', model: 'ghost/removed-model' },
    };
    const onSelect = vi.fn();
    render(<ChatModelMenu value={null} agentId="agt_1" onSelect={onSelect} />);
    await act(async () => {});
    await act(async () => {});
    expect(updateRouting).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('ChatModelMenu 显式用户选择仍是唯一写入口', () => {
  it('agent scope（默认）：点击模型行恰好触发一次 onSelect(sel, agent)', async () => {
    const onSelect = await mountAndLoad();
    fireEvent.click(screen.getByRole('button', { name: 'qwen4-max' })); // 打开菜单
    fireEvent.click(await screen.findByText(GLOBAL.model));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(GLOBAL, 'agent');
  });

  it('global scope：拨动开关后点击，onSelect(sel, global)', async () => {
    const onSelect = await mountAndLoad();
    fireEvent.click(screen.getByRole('button', { name: 'qwen4-max' }));
    fireEvent.click(await screen.findByRole('switch', { name: 'Apply to global' }));
    fireEvent.click(await screen.findByText(GLOBAL.model));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(GLOBAL, 'global');
  });
});

describe('applyChatModelSelection 载荷形状', () => {
  it('agent scope：custom 绑定原样落库并广播变更', async () => {
    const seen: string[] = [];
    onAgentModelChanged(id => seen.push(id));
    await applyChatModelSelection(BOUND, 'agent', 'agt_1');
    expect(updateConfig).toHaveBeenCalledWith('agt_1', {
      llmConfig: { modelMode: 'custom', primary: 'markus', defaultModel: 'qwen/qwen4-max' },
    });
    expect(seen).toEqual(['agt_1']);
  });

  it('global scope：显式清绑定必须发 defaultModel:null（不是 undefined），并更新全局路由', async () => {
    await applyChatModelSelection(GLOBAL, 'global', 'agt_1');
    expect(updateConfig).toHaveBeenCalledWith('agt_1', {
      llmConfig: { modelMode: 'default', primary: '', defaultModel: null },
    });
    expect(updateRouting).toHaveBeenCalledWith({
      defaultProvider: 'markus',
      routingDefaultModel: GLOBAL,
    });
    expect(invalidateLlmSettings).toHaveBeenCalled();
  });
});
