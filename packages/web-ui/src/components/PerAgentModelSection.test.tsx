/**
 * 设置页给 agent 绑定模型时，必须把 provider 与 modelId **原样**送到服务端。
 *
 * 为什么需要这道守卫：模型 id 本身带斜杠（`qwen/qwen4-max`），而 ModelSelect 回传的
 * 展示键是 `provider/modelId` 拼起来的 `markus/qwen/qwen4-max`。旧实现按**最后一个**
 * 斜杠把它切开，得到 provider=`markus/qwen` —— 路由不认识这个 provider，agent 静默
 * 跑回全局默认，而这个页面仍然显示「已绑定」，用户看不出任何异常。
 *
 * 所以这里用真实形状的模型 id 渲染并点击，断言落库载荷本身；同时钉住「清除」的语义：
 * 必须发 `defaultModel: null`（显式删键），而不是 `undefined`（会被 JSON.stringify 丢掉，
 * 服务端 merge 后旧模型残留，下次翻回 custom 就复活）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PerAgentModelSection } from './PerAgentModelSection.tsx';
import { __resetAgentModelSignalsForTests, onAgentModelChanged } from '../lib/agentModelSignals.ts';

const updateConfig = vi.fn(async () => ({ ok: true }));

vi.mock('../api', () => ({
  api: {
    agents: {
      list: async () => ({ agents: [{ id: 'agt_1', name: 'CTO', teamId: 'team_1' }] }),
      get: async () => ({ config: { llmConfig: { modelMode: 'default', primary: '' } } }),
      updateConfig: (...args: unknown[]) => updateConfig(...(args as [])),
    },
    teams: { list: async () => ({ teams: [{ id: 'team_1', name: '平台队' }] }) },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

// A model id that CONTAINS a slash — the shape that broke the old split.
const PROVIDERS = [
  { name: 'markus', displayName: 'Markus', model: 'qwen/qwen4-max', models: [{ id: 'qwen/qwen4-max', name: 'Qwen4 Max' }] },
];

describe('PerAgentModelSection 绑定载荷', () => {
  beforeEach(() => {
    updateConfig.mockClear();
    __resetAgentModelSignalsForTests();
  });

  it('带斜杠的模型 id 原样落库：provider=markus, defaultModel=qwen/qwen4-max', async () => {
    render(<PerAgentModelSection configuredProviders={PROVIDERS} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Follow global' }));
    fireEvent.click(await screen.findByText('Qwen4 Max'));

    await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1));
    const [agentId, patch] = updateConfig.mock.calls[0] as unknown as [string, { llmConfig: Record<string, unknown> }];
    expect(agentId).toBe('agt_1');
    expect(patch.llmConfig).toEqual({
      modelMode: 'custom',
      primary: 'markus',
      defaultModel: 'qwen/qwen4-max',
    });
  });

  it('绑定成功后广播变更，让同时挂载的输入框重新读取', async () => {
    const seen: string[] = [];
    onAgentModelChanged(id => seen.push(id));

    render(<PerAgentModelSection configuredProviders={PROVIDERS} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Follow global' }));
    fireEvent.click(await screen.findByText('Qwen4 Max'));

    await waitFor(() => expect(seen).toEqual(['agt_1']));
  });

  it('清除时显式发 defaultModel: null（而不是被 JSON 丢掉的 undefined）', async () => {
    // Start already bound, so the Reset button is rendered.
    const { api } = await import('../api');
    const getSpy = vi.spyOn(api.agents, 'get').mockResolvedValue({
      config: { llmConfig: { modelMode: 'custom', primary: 'markus', defaultModel: 'qwen/qwen4-max' } },
    } as never);

    render(<PerAgentModelSection configuredProviders={PROVIDERS} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset' }));

    await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1));
    const [, patch] = updateConfig.mock.calls[0] as unknown as [string, { llmConfig: Record<string, unknown> }];
    expect(patch.llmConfig.modelMode).toBe('default');
    // The key must be PRESENT and null: a missing key cannot delete anything.
    expect(Object.prototype.hasOwnProperty.call(patch.llmConfig, 'defaultModel')).toBe(true);
    expect(patch.llmConfig.defaultModel).toBeNull();
    // And it must survive serialisation — that is where undefined used to vanish.
    expect(JSON.parse(JSON.stringify(patch)).llmConfig.defaultModel).toBeNull();

    getSpy.mockRestore();
  });
});