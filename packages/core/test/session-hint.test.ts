/**
 * session-hint（会话身份契约）单元测试
 * ---------------------------------------------------------------------------
 * 这是「会话身份契约」主线的核心纯函数模块：全仓 20+ 个入口都要靠它把
 * 「显式 hint / 零散旧字段」归一成**唯一**的一轮会话身份。此前 0 处测试引用，
 * 一旦优先级链或 unknown 语义被改错，症状是「同一会话后续请求看不到历史」
 * 这类最难排查的静默问题，所以这里要把契约逐条钉死。
 *
 * 覆盖点：
 *   1. normalizeTurnSessionHint 的完整优先级链：
 *      显式 hint > sessionRestore > channelKey > sourceType > dbSessionId > sessionId；
 *      全空 → unknown，且 **unknown 必须携带 reason**。
 *   2. looksLikeDbSessionId（cs_* 前缀识别）。
 *   3. 四种 kind（new / existing / system / unknown）的归一化结果。
 *   4. 关键边界：把 DB id（cs_*）当内存会话 key 的误用是否被识别；
 *      sessionId 在「流式/非流式」两条路径下的语义差异。
 *   5. 其余导出（describeTurnSessionHint / hintCarriesDbIdentity）与常量映射。
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeTurnSessionHint,
  looksLikeDbSessionId,
  describeTurnSessionHint,
  hintCarriesDbIdentity,
  type TurnSessionHint,
} from '../src/session-hint.js';

describe('normalizeTurnSessionHint — 优先级链', () => {
  it('显式 sessionHint 最优先，完全覆盖所有旧字段', () => {
    const explicit: TurnSessionHint = { kind: 'system', role: 'heartbeat' };
    const hint = normalizeTurnSessionHint({
      sessionHint: explicit,
      // 下面这些旧字段都更强不了，必须被忽略
      sessionRestore: { dbSessionId: 'cs_restore', messages: [] },
      dbSessionId: 'cs_db',
      sessionId: 'cs_sid',
      channelKey: 'group:1',
      sourceType: 'human_chat',
    });
    expect(hint).toEqual(explicit);
  });

  it('sessionRestore 为对象 → existing，并映射消息/重试/首选内存会话', () => {
    const hint = normalizeTurnSessionHint({
      sessionRestore: {
        dbSessionId: 'cs_1',
        messages: [{ role: 'user', content: 'hi' }],
        isRetry: true,
        preferredMemorySessionId: 'mem_9',
      },
      dbSessionId: 'cs_ignored',
      channelKey: 'group:ignored',
    });
    expect(hint).toEqual({
      kind: 'existing',
      dbSessionId: 'cs_1',
      preferredMemorySessionId: 'mem_9',
      messages: [{ role: 'user', content: 'hi' }],
      isRetry: true,
    });
  });

  it('sessionRestore 缺省 preferredMemorySessionId 时归一为 null（不是 undefined）', () => {
    const hint = normalizeTurnSessionHint({
      sessionRestore: { dbSessionId: 'cs_1', messages: [] },
    });
    expect(hint).toHaveProperty('preferredMemorySessionId', null);
  });

  it('sessionRestore === null → 显式新对话（new），且 null 优先于 channelKey', () => {
    const hint = normalizeTurnSessionHint({
      sessionRestore: null,
      channelKey: 'group:1',
      dbSessionId: 'cs_db',
    });
    expect(hint).toEqual({ kind: 'new', dbSessionId: 'cs_db' });
  });

  it('注意 undefined 不等同于 null：sessionRestore 未传时不会走「新对话」分支', () => {
    const hint = normalizeTurnSessionHint({ sessionRestore: undefined, dbSessionId: 'cs_db' });
    expect(hint).toEqual({ kind: 'existing', dbSessionId: 'cs_db' });
  });

  it('channelKey → system/channel，并把 channelKey 作为 key', () => {
    const hint = normalizeTurnSessionHint({ channelKey: 'group:abc' });
    expect(hint).toEqual({ kind: 'system', role: 'channel', key: 'group:abc' });
  });

  it('channelKey 优先于 dbSessionId / sessionId', () => {
    const hint = normalizeTurnSessionHint({
      channelKey: 'group:abc',
      dbSessionId: 'cs_db',
      sessionId: 'cs_sid',
    });
    expect(hint).toEqual({ kind: 'system', role: 'channel', key: 'group:abc' });
  });

  it('dbSessionId → existing（不带 messages / preferred）', () => {
    const hint = normalizeTurnSessionHint({ dbSessionId: 'cs_42' });
    expect(hint).toEqual({ kind: 'existing', dbSessionId: 'cs_42' });
  });

  it('sessionId 形如 cs_* → 被识别为 DB 身份，归为 existing', () => {
    const hint = normalizeTurnSessionHint({ sessionId: 'cs_42' });
    expect(hint).toEqual({ kind: 'existing', dbSessionId: 'cs_42' });
  });

  it('dbSessionId 优先于 sessionId', () => {
    const hint = normalizeTurnSessionHint({ dbSessionId: 'cs_db', sessionId: 'cs_sid' });
    expect(hint).toEqual({ kind: 'existing', dbSessionId: 'cs_db' });
  });

  it('sourceType 优先于 dbSessionId（系统入口压过零散 DB 身份）', () => {
    const hint = normalizeTurnSessionHint({ sourceType: 'heartbeat', dbSessionId: 'cs_db' });
    expect(hint).toEqual({ kind: 'system', role: 'heartbeat' });
  });

  it('全空 → unknown，且 reason 非空', () => {
    const hint = normalizeTurnSessionHint({});
    expect(hint.kind).toBe('unknown');
    if (hint.kind === 'unknown') {
      expect(hint.reason).toBe('未提供任何会话身份');
      expect(hint.reason.length).toBeGreaterThan(0);
    }
  });

  it('仅有未被映射的 sourceType → 仍为 unknown，且 reason 带上 sourceType（便于定位漏表态的入口）', () => {
    const hint = normalizeTurnSessionHint({ sourceType: 'human_chat' });
    expect(hint).toEqual({ kind: 'unknown', reason: 'sourceType=human_chat 未提供任何会话身份' });
  });

  it('完全 undefined 的输入（入口什么都没传）也必须是 unknown', () => {
    const hint = normalizeTurnSessionHint({ sessionId: undefined, dbSessionId: undefined });
    expect(hint.kind).toBe('unknown');
  });
});

describe('sourceType → 系统会话角色映射', () => {
  const cases: Array<[string, Extract<TurnSessionHint, { kind: 'system' }>['role']]> = [
    ['heartbeat', 'heartbeat'],
    ['task_status_update', 'task'],
    ['task_comment', 'task'],
    ['review_request', 'task'],
    ['requirement_update', 'task'],
    ['requirement_comment', 'task'],
    ['system_event', 'announce'],
    ['workflow_update', 'workflow'],
    ['a2a_message', 'a2a'],
  ];

  it.each(cases)('sourceType=%s → system/%s', (sourceType, role) => {
    expect(normalizeTurnSessionHint({ sourceType })).toEqual({ kind: 'system', role });
  });

  it('a2a_message 是对照映射之外的显式特例（走 a2a 而非未映射）', () => {
    expect(normalizeTurnSessionHint({ sourceType: 'a2a_message' })).toEqual({
      kind: 'system',
      role: 'a2a',
    });
  });
});

describe('looksLikeDbSessionId — cs_* 前缀识别', () => {
  it('cs_ 前缀为真（含只有前缀的退化值）', () => {
    expect(looksLikeDbSessionId('cs_42')).toBe(true);
    expect(looksLikeDbSessionId('cs_')).toBe(true);
  });

  it('undefined / 空串为假', () => {
    expect(looksLikeDbSessionId(undefined)).toBe(false);
    expect(looksLikeDbSessionId('')).toBe(false);
  });

  it('内存会话 key 等其它前缀为假', () => {
    expect(looksLikeDbSessionId('mem_42')).toBe(false);
    expect(looksLikeDbSessionId('session_42')).toBe(false);
    expect(looksLikeDbSessionId('cs42')).toBe(false); // 少了下划线
  });

  it('前缀匹配区分大小写', () => {
    expect(looksLikeDbSessionId('CS_42')).toBe(false);
    expect(looksLikeDbSessionId('Cs_42')).toBe(false);
  });
});

describe('关键边界：把 DB id 当内存会话 key 的误用', () => {
  it('sessionId 传 cs_* 会被识别为 DB 身份（而非内存 key）→ existing', () => {
    // 这就是「误用探测器」：入口本该用 dbSessionId，却把 cs_* 塞进了 sessionId。
    const sessionId = 'cs_misused';
    expect(looksLikeDbSessionId(sessionId)).toBe(true);
    expect(normalizeTurnSessionHint({ sessionId })).toEqual({
      kind: 'existing',
      dbSessionId: 'cs_misused',
    });
  });

  it('sessionId 传内存 key（非 cs_*）不会被当成会话身份 → unknown', () => {
    // 非流式路径把 sessionId 当内存会话 key；它没有 DB 身份，不应凭空造出 existing。
    const sessionId = 'mem_session_key';
    expect(looksLikeDbSessionId(sessionId)).toBe(false);
    expect(normalizeTurnSessionHint({ sessionId })).toEqual({
      kind: 'unknown',
      reason: '未提供任何会话身份',
    });
  });

  it('流式/非流式语义差异：同一个 cs_* sessionId，在 sessionRestore 缺省下按 DB 身份归一', () => {
    // 流式路径把 sessionId 当 DB 提示；这里钉死归一结果，防止两侧再各自拼接。
    expect(normalizeTurnSessionHint({ sessionId: 'cs_stream' })).toEqual({
      kind: 'existing',
      dbSessionId: 'cs_stream',
    });
  });

  it('首轮新对话：DB 身份常常只出现在 sessionId 里，必须兼容', () => {
    // api-server 是先 persist 拿到 cs_* 再发消息，sessionRestore === null 时
    // 若不从 sessionId 兜底，首轮就会落不下 DB→内存绑定。
    const hint = normalizeTurnSessionHint({ sessionRestore: null, sessionId: 'cs_first_round' });
    expect(hint).toEqual({ kind: 'new', dbSessionId: 'cs_first_round' });
  });

  it('首轮新对话 + 非 cs_ 的 sessionId → new，但 dbSessionId 为 undefined', () => {
    const hint = normalizeTurnSessionHint({ sessionRestore: null, sessionId: 'mem_key' });
    expect(hint).toEqual({ kind: 'new', dbSessionId: undefined });
  });

  it('首轮新对话时显式 dbSessionId 优先于 sessionId 兜底', () => {
    const hint = normalizeTurnSessionHint({
      sessionRestore: null,
      dbSessionId: 'cs_explicit',
      sessionId: 'cs_from_session',
    });
    expect(hint).toEqual({ kind: 'new', dbSessionId: 'cs_explicit' });
  });
});

describe('hintCarriesDbIdentity — 是否需要写 DB→内存绑定', () => {
  it('new 且带非空 dbSessionId → true', () => {
    expect(hintCarriesDbIdentity({ kind: 'new', dbSessionId: 'cs_1' })).toBe(true);
  });

  it('existing 且带非空 dbSessionId → true', () => {
    expect(hintCarriesDbIdentity({ kind: 'existing', dbSessionId: 'cs_1' })).toBe(true);
  });

  it('new 但缺少 dbSessionId → false', () => {
    expect(hintCarriesDbIdentity({ kind: 'new' })).toBe(false);
  });

  it('new 但 dbSessionId 为空串 → false', () => {
    expect(hintCarriesDbIdentity({ kind: 'new', dbSessionId: '' })).toBe(false);
  });

  it('system / unknown → false（这两类不写绑定）', () => {
    expect(hintCarriesDbIdentity({ kind: 'system', role: 'heartbeat' })).toBe(false);
    expect(hintCarriesDbIdentity({ kind: 'unknown', reason: 'x' })).toBe(false);
  });
});

describe('describeTurnSessionHint — 人类可读的一句话', () => {
  it('new：无 db 显示 -，有 db 显示 id', () => {
    expect(describeTurnSessionHint({ kind: 'new' })).toBe('new(db=-)');
    expect(describeTurnSessionHint({ kind: 'new', dbSessionId: 'cs_1' })).toBe('new(db=cs_1)');
  });

  it('existing：带 preferred，缺省显示 -', () => {
    expect(describeTurnSessionHint({ kind: 'existing', dbSessionId: 'cs_1' })).toBe(
      'existing(db=cs_1, preferred=-)',
    );
    expect(
      describeTurnSessionHint({ kind: 'existing', dbSessionId: 'cs_1', preferredMemorySessionId: 'mem_2' }),
    ).toBe('existing(db=cs_1, preferred=mem_2)');
  });

  it('system：带 key 才追加 ,key=', () => {
    expect(describeTurnSessionHint({ kind: 'system', role: 'heartbeat' })).toBe('system(heartbeat)');
    expect(describeTurnSessionHint({ kind: 'system', role: 'channel', key: 'group:1' })).toBe(
      'system(channel,key=group:1)',
    );
  });

  it('unknown：把 reason 原样带出，便于告警定位', () => {
    expect(describeTurnSessionHint({ kind: 'unknown', reason: '未提供任何会话身份' })).toBe(
      'unknown(未提供任何会话身份)',
    );
  });
});
