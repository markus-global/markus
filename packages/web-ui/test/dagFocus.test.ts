import { describe, it, expect } from 'vitest';
import { resolveDagNodeClick, isRequirementNode, reqNodeId } from '../src/lib/dagFocus.ts';

const REQ_A = reqNodeId('rq_a');
const REQ_B = reqNodeId('rq_b');

describe('依赖图卡片点击：身份只由「任务/需求」决定，不由图的拓扑决定', () => {
  it('任务卡片在概览态只选中，不改变图', () => {
    expect(resolveDagNodeClick('tsk_1', null, null)).toEqual({ type: 'selectTask' });
  });

  it('任务卡片即使无人阻塞它（旧实现里的 topLevel）也只选中', () => {
    // 这是旧实现的真 bug：孤儿任务曾被当成 topLevel，点一下把整张图切成只剩它自己。
    // 断言咬的是"任务卡片永远不换图"，与它有没有上游无关。
    expect(resolveDagNodeClick('tsk_orphan', null, null)).toEqual({ type: 'selectTask' });
  });

  it('任务卡片在聚焦态里也只选中，不会退出聚焦', () => {
    expect(resolveDagNodeClick('tsk_1', REQ_A, 'rq_a')).toEqual({ type: 'selectTask' });
    expect(resolveDagNodeClick('tsk_1', REQ_A, null)).toEqual({ type: 'selectTask' });
  });

  it('概览态点需求卡片 = 进入聚焦', () => {
    expect(resolveDagNodeClick(REQ_A, null, null)).toEqual({ type: 'focus', nodeId: REQ_A });
  });

  it('聚焦 A 时点关联需求 B = 换焦到 B（不是只换右侧面板）', () => {
    expect(resolveDagNodeClick(REQ_B, REQ_A, 'rq_a')).toEqual({ type: 'focus', nodeId: REQ_B });
  });

  it('再点聚焦根 = 退出聚焦，且面板正显示这张需求时一并关闭', () => {
    expect(resolveDagNodeClick(REQ_A, REQ_A, 'rq_a')).toEqual({
      type: 'unfocus',
      closeRequirementPanel: true,
    });
  });

  it('再点聚焦根时，若面板显示的是聚焦内的任务，任务详情保留', () => {
    // 面板此刻没有在展示需求（selectedReqId=null），所以退出聚焦不碰它。
    expect(resolveDagNodeClick(REQ_A, REQ_A, null)).toEqual({
      type: 'unfocus',
      closeRequirementPanel: false,
    });
  });

  it('再点聚焦根时，若面板显示的是另一个需求，也不关它', () => {
    expect(resolveDagNodeClick(REQ_A, REQ_A, 'rq_b')).toEqual({
      type: 'unfocus',
      closeRequirementPanel: false,
    });
  });

  it('节点 id 约定：需求前缀可判定、可往返', () => {
    expect(isRequirementNode(REQ_A)).toBe(true);
    expect(isRequirementNode('tsk_1')).toBe(false);
    expect(REQ_A.slice(4)).toBe('rq_a');
  });
});
