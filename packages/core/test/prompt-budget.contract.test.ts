import { COLD_CONVERSE_FIXED_MAX, COLD_REFLEX_FIXED_MAX } from '@markus/shared';
import { estimateToolDefTokens, packToolDefBudget, getReflexAllowlist } from '../src/capability-packs.js';

/**
 * Golden contract stubs for cold-start fixed prefix (AGENT-RUNTIME §9).
 * Full prompt assembly is covered in context-engine tests; here we assert
 * pack budgets themselves leave headroom under acceptance ceilings.
 */
describe('prompt budget contracts (AGENT-RUNTIME §9)', () => {
  it('A-budget-contract-converse: converse tool budget << cold max', () => {
    expect(packToolDefBudget('converse')).toBeLessThan(COLD_CONVERSE_FIXED_MAX);
    // ROLE soft ceiling + converse system budget must fit cold-start acceptance
    expect(packToolDefBudget('converse') + 16_000).toBeLessThanOrEqual(COLD_CONVERSE_FIXED_MAX);
  });

  it('A-budget-contract-reflex: reflex core fits under cold reflex max', () => {
    const tools = [...getReflexAllowlist(false)].map((name) => ({
      name,
      description: `Tool ${name}`,
      inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
    }));
    const toolTok = estimateToolDefTokens(tools);
    expect(toolTok).toBeLessThanOrEqual(packToolDefBudget('reflex'));
    expect(toolTok + 4_000).toBeLessThanOrEqual(COLD_REFLEX_FIXED_MAX);
  });
});
