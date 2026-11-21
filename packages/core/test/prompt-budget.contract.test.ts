import { COLD_CONVERSE_FIXED_MAX, COLD_REFLEX_FIXED_MAX } from '@markus/shared';
import { getReflexAllowlist } from '../src/capability-packs.js';

/**
 * Cold-start fixed-prefix acceptance ceilings (AGENT-RUNTIME §9).
 * Full prompt assembly is covered in context-engine tests; here we assert the
 * resident tool face leaves headroom under the cold-start ceilings.
 *
 * There is no pack tool budget any more (eviction removed, PR #471): the tool
 * face is a FIXED segment, so the contract is "the cold face fits the ceiling",
 * not "a budget caps the face". Context pressure compresses history, never the
 * face. These assertions bite if a ceiling shrinks below the resident prefix or
 * the reflex core grows past its headroom.
 */
const faceTokens = (tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>): number =>
  Math.ceil(JSON.stringify(tools).length / 3.5);

describe('prompt budget contracts (AGENT-RUNTIME §9)', () => {
  it('A-budget-contract-converse: cold converse ceiling leaves headroom over the ROLE soft ceiling', () => {
    // ROLE soft ceiling is 16k tokens; the cold fixed prefix must fit ROLE plus
    // system + resident tools. If the ceiling drops to/below ROLE alone, cold
    // start cannot even assemble ROLE — and the historical headroom was 8k.
    expect(16_000).toBeLessThan(COLD_CONVERSE_FIXED_MAX);
    expect(COLD_CONVERSE_FIXED_MAX - 16_000).toBeGreaterThanOrEqual(8_000);
  });

  it('A-budget-contract-reflex: reflex core face fits under cold reflex max with headroom', () => {
    const tools = [...getReflexAllowlist(false)].map((name) => ({
      name,
      description: `Tool ${name}`,
      inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
    }));
    const toolTok = faceTokens(tools);
    expect(toolTok + 4_000).toBeLessThanOrEqual(COLD_REFLEX_FIXED_MAX);
  });
});
