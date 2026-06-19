import { describe, it, expect } from 'vitest';
import { getTextContent, type LLMContentPart } from '../src/types/llm.js';
import { CognitiveDepth } from '../src/types/cognitive.js';
import { PLAN_LIMITS, ENTERPRISE_FEATURES } from '../src/types/license.js';
import {
  MailboxPriorityLevel,
  PRIORITY_LABELS,
  MAILBOX_TYPE_REGISTRY,
  MAILBOX_CATEGORIES,
  USER_NOTIFICATION_TYPE_REGISTRY,
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

describe('PLAN_LIMITS', () => {
  it('defines free tier limits', () => {
    expect(PLAN_LIMITS.free.maxTeams).toBe(5);
    expect(PLAN_LIMITS.free.maxToolCallsPerDay).toBe(5000);
    expect(PLAN_LIMITS.free.maxUsers).toBe(1);
  });

  it('defines enterprise tier as unlimited', () => {
    expect(PLAN_LIMITS.enterprise.maxTeams).toBe(-1);
    expect(PLAN_LIMITS.enterprise.maxToolCallsPerDay).toBe(-1);
    expect(PLAN_LIMITS.enterprise.maxUsers).toBe(-1);
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
