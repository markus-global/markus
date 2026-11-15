/**
 * C9-C · DOM 级取证：断言/撤销事实后，**阶段徽章文字**按预期变化。
 *
 * 这里不用 mock repo —— 组件拿到的就是服务端响应里那个闭集值（`threadStage` 字段）。
 * 三种输入对应验收要求的三步：缺证据 → 待核验 → 已收口；再撤掉验证值 → 回到待核验。
 * 同时锁「凭什么说做完了」折叠区：默认折叠、可展开、`source_refs` 可点。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { ThreadStageBadge, EvidenceFold } from './ThreadStage.tsx';
import zhCommon from '../locales/zh-CN/common.json';

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    lng: 'zh-CN',
    fallbackLng: 'zh-CN',
    defaultNS: 'common',
    ns: ['common'],
    resources: { 'zh-CN': { common: zhCommon } },
    interpolation: { escapeValue: false },
  });
});

afterAll(() => {
  // i18next is a module singleton shared with other suites in this worker.
  void i18next.changeLanguage('zh-CN');
});

function evidence(over: Partial<React.ComponentProps<typeof EvidenceFold>['evidence'][number]> = {}) {
  return {
    factId: 'fact_1',
    predicate: 'task.completion_evidence',
    value: { summary: '事实层与阶段派生已落地', evidence_refs: ['dlv_9'] },
    assertedBy: 'agt_worker',
    sourceRefs: ['dlv_9', 'cmt_3'],
    verification: { result: 'pass' as const, verifiedBy: 'agt_reviewer' },
    createdAt: '2026-11-15T01:00:00.000Z',
    ...over,
  };
}

describe('ThreadStageBadge', () => {
  it('renders the human wording for each stage of the closed set', () => {
    const cases: Array<[string, string]> = [
      ['waiting_human', '需要你'],
      ['running', '执行中'],
      ['needs_evidence', '缺证据'],
      ['in_verification', '待核验'],
      ['done', '已收口'],
      ['blocked_deps', '等依赖'],
      ['failed', '已终止'],
    ];
    for (const [stage, label] of cases) {
      const { unmount } = render(<ThreadStageBadge stage={stage} />);
      expect(screen.getByText(label)).toBeTruthy();
      unmount();
    }
  });

  it('renders nothing for a value it does not understand (never invents a stage)', () => {
    const { container } = render(<ThreadStageBadge stage="almost_done" />);
    expect(container.textContent).toBe('');
  });

  it('changes the wording when the asserted facts change (needs_evidence → in_verification → done)', () => {
    // The three payloads the server produces as facts are asserted / verified:
    //   no evidence fact  → needs_evidence
    //   evidence, no pass → in_verification
    //   evidence + pass   → done
    const stages = ['needs_evidence', 'in_verification', 'done'];
    const expected = ['缺证据', '待核验', '已收口'];
    const { container, rerender } = render(<ThreadStageBadge stage={stages[0]} />);
    expect(container.textContent).toBe(expected[0]);
    rerender(<ThreadStageBadge stage={stages[1]} />);
    expect(container.textContent).toBe(expected[1]);
    rerender(<ThreadStageBadge stage={stages[2]} />);
    expect(container.textContent).toBe(expected[2]);
    // Revoking the verification fact falls back — never stays at "done".
    rerender(<ThreadStageBadge stage={stages[1]} />);
    expect(container.textContent).toBe(expected[1]);
  });
});

describe('EvidenceFold — "凭什么说做完了"', () => {
  it('is collapsed by default and expands on click', () => {
    render(<EvidenceFold evidence={[evidence()]} />);
    expect(screen.queryByText('事实层与阶段派生已落地')).toBeNull();
    fireEvent.click(screen.getByText(/凭什么说做完了/));
    expect(screen.getByText('事实层与阶段派生已落地')).toBeTruthy();
    expect(screen.getByText('已验证')).toBeTruthy();
  });

  it('shows a stable empty form instead of hiding the section', () => {
    render(<EvidenceFold evidence={[]} />);
    fireEvent.click(screen.getByText(/凭什么说做完了/));
    expect(screen.getByText('还没有证据事实')).toBeTruthy();
  });

  it('opens the original record behind each pointer', () => {
    const onOpenSource = vi.fn();
    render(<EvidenceFold evidence={[evidence()]} onOpenSource={onOpenSource} />);
    fireEvent.click(screen.getByText(/凭什么说做完了/));
    fireEvent.click(screen.getByText('交付物'));
    expect(onOpenSource).toHaveBeenCalledWith('dlv_9');
    fireEvent.click(screen.getByText('评论'));
    expect(onOpenSource).toHaveBeenCalledWith('cmt_3');
  });

  it('never shows a bare i18n key — all three pointer kinds resolve to copy', () => {
    // 这条用例是冲着「断言正例挡不住回归」来的：只断言「交付物」渲染出来，第 3 类
    // （inPlace）拼错键时照样绿。三种指针各渲染一次，直接扫整棵树的可见文本，
    // 只要冒出 `threadStage.` 或 `common:` 就说明有键没解析。
    const { container } = render(
      <EvidenceFold
        evidence={[evidence({ sourceRefs: ['dlv_9', 'cmt_3', 'fact_7'] })]}
        onOpenSource={() => {}}
      />,
    );
    fireEvent.click(screen.getByText(/凭什么说做完了/));
    const text = container.textContent ?? '';
    expect(text).not.toContain('threadStage.');
    expect(text).not.toContain('common:');
    expect(text).toContain('交付物');
    expect(text).toContain('评论');
    expect(text).toContain('原始记录');
  });

  it('never dumps raw JSON at the reader', () => {
    render(<EvidenceFold evidence={[evidence({ value: { evidence_refs: ['dlv_9'] } })]} />);
    fireEvent.click(screen.getByText(/凭什么说做完了/));
    expect(screen.queryByText(/"evidence_refs"/)).toBeNull();
  });
});
