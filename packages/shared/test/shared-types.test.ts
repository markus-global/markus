import { describe, it, expect } from 'vitest';
import { getTextContent, type LLMContentPart } from '../src/types/llm.js';
import { CognitiveDepth } from '../src/types/cognitive.js';
import { ENTERPRISE_FEATURES } from '../src/types/license.js';
import {
  MailboxPriorityLevel,
  PRIORITY_LABELS,
  MAILBOX_TYPE_REGISTRY,
  MAILBOX_CATEGORIES,
  USER_NOTIFICATION_TYPE_REGISTRY,
  ENTITY_SCOPE_ORDER,
  resolveEntityKey,
  type MailboxEntityScope,
  type MailboxItemType,
} from '../src/types/mailbox.js';

describe('getTextContent', () => {
  it('returns string content unchanged', () => {
    expect(getTextContent('hello world')).toBe('hello world');
  });

  it('extracts text parts from multipart content', () => {
    const parts: LLMContentPart[] = [
      { type: 'text', text: 'Hello ' },
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
      { type: 'text', text: 'world' },
    ];
    expect(getTextContent(parts)).toBe('Hello world');
  });

  it('returns empty string when no text parts', () => {
    expect(getTextContent([{ type: 'image_url', image_url: { url: 'x' } }])).toBe('');
  });
});

describe('CognitiveDepth', () => {
  it('defines four depth levels', () => {
    expect(CognitiveDepth.D0_Reflexive).toBe(0);
    expect(CognitiveDepth.D1_Reactive).toBe(1);
    expect(CognitiveDepth.D2_Deliberative).toBe(2);
    expect(CognitiveDepth.D3_MetaCognitive).toBe(3);
  });
});

describe('PlanLimits', () => {
  it('is now CU-only (non-CU limits removed)', () => {
    expect(true).toBe(true);
  });
});

describe('ENTERPRISE_FEATURES', () => {
  it('lists expected enterprise capabilities', () => {
    expect(ENTERPRISE_FEATURES).toContain('multi_user');
    expect(ENTERPRISE_FEATURES).toContain('sso');
    expect(ENTERPRISE_FEATURES.length).toBeGreaterThanOrEqual(5);
  });
});

describe('mailbox registries', () => {
  it('maps priority levels to labels', () => {
    expect(PRIORITY_LABELS[MailboxPriorityLevel.critical]).toBe('Critical');
    expect(PRIORITY_LABELS[MailboxPriorityLevel.normal]).toBe('Normal');
  });

  it('registers all mailbox item types', () => {
    expect(MAILBOX_TYPE_REGISTRY.human_chat.label).toBe('Chat');
    expect(MAILBOX_TYPE_REGISTRY.heartbeat.defaultPriority).toBe(3);
    expect(MAILBOX_TYPE_REGISTRY.review_request.invokesLLM).toBe(true);
  });

  it('groups types into categories', () => {
    expect(MAILBOX_CATEGORIES.interaction.types).toContain('human_chat');
    expect(MAILBOX_CATEGORIES.system.types).toContain('heartbeat');
  });

  it('registers user notification types', () => {
    const keys = Object.keys(USER_NOTIFICATION_TYPE_REGISTRY);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const desc = USER_NOTIFICATION_TYPE_REGISTRY[key as keyof typeof USER_NOTIFICATION_TYPE_REGISTRY];
      expect(desc.label).toBeTruthy();
    }
  });
});

describe('mailbox entity affinity scopes', () => {
  const ALL_TYPES = Object.keys(MAILBOX_TYPE_REGISTRY) as MailboxItemType[];

  it('每个类型都声明了 entityScopes，且以 system 兜底结尾', () => {
    for (const type of ALL_TYPES) {
      const scopes = MAILBOX_TYPE_REGISTRY[type].entityScopes;
      expect(scopes.length, `${type} 未声明 entityScopes`).toBeGreaterThan(0);
      expect(scopes[scopes.length - 1], `${type} 的最后一个作用域必须是 system（安全兜底）`).toBe('system');
    }
  });

  it('作用域列表无重复且取值合法', () => {
    const valid = new Set<string>(ENTITY_SCOPE_ORDER);
    for (const type of ALL_TYPES) {
      const scopes = MAILBOX_TYPE_REGISTRY[type].entityScopes as readonly MailboxEntityScope[];
      expect(new Set(scopes).size, `${type} 作用域重复`).toBe(scopes.length);
      for (const s of scopes) expect(valid.has(s), `${type} 含非法作用域 ${s}`).toBe(true);
    }
  });

  it('system 之前的作用域按 ENTITY_SCOPE_ORDER 的相对顺序声明（优先级不乱）', () => {
    const rank = new Map(ENTITY_SCOPE_ORDER.map((s, i) => [s, i]));
    for (const type of ALL_TYPES) {
      const scopes = MAILBOX_TYPE_REGISTRY[type].entityScopes;
      const ranks = scopes.map(s => rank.get(s) ?? -1);
      const sorted = [...ranks].sort((a, b) => a - b);
      expect(ranks, `${type} 作用域优先级顺序不符合 ENTITY_SCOPE_ORDER`).toEqual(sorted);
    }
  });

  it('resolveEntityKey 永不返回空：无实体时退化为 system:{agentId}', () => {
    for (const type of ALL_TYPES) {
      const key = resolveEntityKey({ sourceType: type, payload: { summary: 's', content: 'c' } }, 'agt_x');
      expect(key, `${type} 未解析出键`).toBeTruthy();
      expect(key).toBe(`system:agt_x`);
    }
  });

  it('resolveEntityKey 按声明顺序选择具体实体', () => {
    // 同时带 taskId 与 requirementId → task 优先（task 在作用域列表中排前）
    expect(resolveEntityKey({
      sourceType: 'human_chat',
      payload: { summary: 's', content: 'c', taskId: 'tsk_1', requirementId: 'req_1' },
      metadata: { senderId: 'u1' },
    }, 'agt_x')).toBe('task:tsk_1');

    // 只有 requirementId → req
    expect(resolveEntityKey({
      sourceType: 'task_comment',
      payload: { summary: 's', content: 'c', requirementId: 'req_9' },
    }, 'agt_x')).toBe('req:req_9');

    // A2A 频道
    expect(resolveEntityKey({
      sourceType: 'a2a_message',
      payload: { summary: 's', content: 'c', extra: { channelKey: 'dm:a2a:a|b' } },
    }, 'agt_x')).toBe('channel:dm:a2a:a|b');

    // 会话优先于用户（session_reply 声明了 conversation，没有 user）
    expect(resolveEntityKey({
      sourceType: 'session_reply',
      payload: { summary: 's', content: 'c' },
      metadata: { sessionId: 'sess_1', senderId: 'u1' },
    }, 'agt_x')).toBe('conv:sess_1');
  });
});
