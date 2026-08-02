import { evaluatePromptAfford } from '../src/afford-guard.js';
import { PROMPT_AFFORD_OUTPUT_RESERVE, PROMPT_AFFORD_SAFETY_MARGIN } from '@markus/shared';

describe('afford fail-closed (AGENT-RUNTIME §1.1)', () => {
  it('A-afford-downgrade: rejects when fixed + reserve + safety > afford', () => {
    const systemTokens = 10_000;
    const toolDefTokens = 8_000;
    const fixed = systemTokens + toolDefTokens;
    const afford = fixed; // cannot fit reserve
    const result = evaluatePromptAfford({
      systemTokens,
      toolDefTokens,
      promptAffordTokens: afford,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('prompt_pack_rejected');
      expect(result.fixed).toBe(fixed);
      expect(result.needed).toBe(
        fixed + PROMPT_AFFORD_OUTPUT_RESERVE + PROMPT_AFFORD_SAFETY_MARGIN,
      );
    }
  });

  it('allows when afford covers fixed + reserves', () => {
    const result = evaluatePromptAfford({
      systemTokens: 4_000,
      toolDefTokens: 2_000,
      promptAffordTokens: 20_000,
    });
    expect(result.ok).toBe(true);
  });

  it('ok when afford is null (no OR ceiling)', () => {
    const result = evaluatePromptAfford({
      systemTokens: 50_000,
      toolDefTokens: 20_000,
      promptAffordTokens: null,
    });
    expect(result.ok).toBe(true);
  });
});
