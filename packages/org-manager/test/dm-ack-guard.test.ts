import { describe, it, expect } from 'vitest';
import { isDmPureAcknowledgment, isDmMisdirectedRelay } from '../src/dm-ack-guard.js';

describe('isDmPureAcknowledgment', () => {
  it('matches single ack tokens', () => {
    expect(isDmPureAcknowledgment('收到')).toBe(true);
    expect(isDmPureAcknowledgment('好的。')).toBe(true);
    expect(isDmPureAcknowledgment('OK!')).toBe(true);
    expect(isDmPureAcknowledgment('保持待命')).toBe(true);
  });

  it('matches compound acks that previously escaped the single-token filter', () => {
    expect(isDmPureAcknowledgment('收到，保持待命。')).toBe(true);
    expect(isDmPureAcknowledgment('好的，收到。')).toBe(true);
    expect(isDmPureAcknowledgment('收到，消息已送达。保持待命。')).toBe(true);
  });

  it('does not match substantive content', () => {
    expect(isDmPureAcknowledgment('收到，任务板空了，有新产品随时说。')).toBe(false);
    expect(isDmPureAcknowledgment('老板让我问问你在忙什么？')).toBe(false);
  });
});

describe('isDmMisdirectedRelay', () => {
  it('flags relay paste-backs without a new ask', () => {
    expect(isDmMisdirectedRelay('CTO 回复说：最近没什么事，在待命中。')).toBe(true);
  });

  it('allows relays that still ask the peer something', () => {
    expect(isDmMisdirectedRelay('他回复说待命。你还有空帮我看一眼吗？')).toBe(false);
    expect(isDmMisdirectedRelay('转达：待命中。请你再评估一下方案')).toBe(false);
  });
});
