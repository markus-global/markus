import { describe, it, expect } from 'vitest';
import { resolveEntityKeys, deriveMailboxSubject } from '@markus/shared';

/**
 * P3 回归：mailbox item 必须绑定**一等主体**，且**并发锁键与 turn 会话同源**。
 *
 * 现象（问题 C / R1）：`callback_result` 的 turn 会话取自 `payload.extra.originSessionId`
 * （正确），但其**实体锁**走 `entityScopes=['conversation']` → 读 `metadata.sessionId`，
 * 而 `deliverCallback` 从不设 metadata → 解析不出 `conv:` → 退化为 `system:{agentId}`。
 * 结果：回调可能与其来源会话**并发**跑在同一条会话上（同一事实两个写者）。
 *
 * 修复不变量：
 *  - `deriveMailboxSubject` 是主体派生的**唯一入口**（payload.extra / metadata / sessionHint 归一）；
 *  - `resolveEntityKeys` 优先用 item.subject，且 conversation 键能回退到 sessionHint / originSessionId；
 *  - 既有已解析出 conv 键的 item **解析结果不变**（纯加法，向后兼容）。
 */
describe('P3 mailbox 主体绑定', () => {
  it('callback_result 带 originSessionId ⇒ 锁到 conv:（不得退化为 system:）', () => {
    const item = {
      sourceType: 'callback_result' as const,
      payload: {
        summary: 'bg done',
        content: 'done',
        extra: {
          callbackId: 'bg1',
          originSessionId: 'sess_origin_1',
          sessionHint: { kind: 'memory' as const, memorySessionId: 'sess_origin_1' },
        },
      },
    };
    const keys = resolveEntityKeys(item, 'agt_x');
    expect(keys).toContain('conv:sess_origin_1');
    expect(keys).not.toContain('system:agt_x');
  });

  it('metadata 缺失时 conversation 键回退到 sessionHint.memorySessionId', () => {
    const item = {
      sourceType: 'human_chat' as const,
      payload: { summary: 'hi', content: 'hi', extra: { sessionHint: { kind: 'memory' as const, memorySessionId: 'sess_hint' } } },
    };
    expect(resolveEntityKeys(item, 'agt_x')).toContain('conv:sess_hint');
  });

  it('既有行为不变：metadata.dbSessionId 仍优先', () => {
    const item = {
      sourceType: 'human_chat' as const,
      payload: { summary: 'hi', content: 'hi', extra: { originSessionId: 'sess_other' } },
      metadata: { dbSessionId: 'cs_db_1', sessionId: 'sess_mem_2' },
    };
    const keys = resolveEntityKeys(item, 'agt_x');
    expect(keys).toContain('conv:cs_db_1');
    expect(keys).not.toContain('conv:sess_other');
  });

  it('deriveMailboxSubject：无任何会话线索 ⇒ 不含 sessionKey（交回 system 兜底）', () => {
    const s = deriveMailboxSubject({ sourceType: 'heartbeat', payload: { summary: '', content: '' } });
    expect(s.sessionKey).toBeUndefined();
    expect(resolveEntityKeys({ sourceType: 'heartbeat', payload: { summary: '', content: '' } }, 'agt_x')).toEqual(['system:agt_x']);
  });

  it('task / requirement 维度仍从 payload 解析', () => {
    const item = {
      sourceType: 'review_request' as const,
      payload: { summary: 'r', content: 'r', taskId: 'tsk_1', requirementId: 'req_1' },
    };
    const keys = resolveEntityKeys(item, 'agt_x');
    expect(keys).toContain('task:tsk_1');
    expect(keys).toContain('req:req_1');
  });
});
