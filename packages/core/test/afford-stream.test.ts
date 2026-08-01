import { ensureAffordablePromptPack } from '../src/afford-guard.js';
import { PROMPT_AFFORD_OUTPUT_RESERVE, PROMPT_AFFORD_SAFETY_MARGIN } from '@markus/shared';

describe('stream afford gate helper (Afford.S1)', () => {
  it('S-stream-afford-reject: rejects when already downgraded and still over afford', () => {
    const systemTokens = 10_000;
    const toolDefTokens = 5_000;
    const fixed = systemTokens + toolDefTokens;
    const afford = fixed; // cannot fit reserve
    const result = ensureAffordablePromptPack({
      systemTokens,
      toolDefTokens,
      afford,
      alreadyDowngraded: true,
    });
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.fixed).toBe(fixed);
      expect(result.needed).toBe(
        fixed + PROMPT_AFFORD_OUTPUT_RESERVE + PROMPT_AFFORD_SAFETY_MARGIN,
      );
    }
  });

  it('S-stream-afford-downgrade: asks for reflex rebuild when over afford and not yet downgraded', () => {
    const result = ensureAffordablePromptPack({
      systemTokens: 12_000,
      toolDefTokens: 6_000,
      afford: 15_000,
      alreadyDowngraded: false,
    });
    expect(result.status).toBe('downgrade_needed');
  });

  it('ok when afford covers fixed + reserves (provider call allowed)', () => {
    const result = ensureAffordablePromptPack({
      systemTokens: 3_000,
      toolDefTokens: 2_000,
      afford: 20_000,
      alreadyDowngraded: false,
    });
    expect(result.status).toBe('ok');
  });

  it('ok when afford is null — no provider gate', () => {
    const result = ensureAffordablePromptPack({
      systemTokens: 99_000,
      toolDefTokens: 20_000,
      afford: null,
    });
    expect(result.status).toBe('ok');
  });
});
