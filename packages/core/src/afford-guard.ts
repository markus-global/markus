/**
 * Afford fail-closed packing — AGENT-RUNTIME §1.1 / PROMPT-ENGINEERING §2.4 / Afford.S1
 */
import {
  PROMPT_AFFORD_OUTPUT_RESERVE,
  PROMPT_AFFORD_SAFETY_MARGIN,
} from '@markus/shared';

export type AffordEvaluation =
  | { ok: true; fixed: number }
  | {
      ok: false;
      reason: 'prompt_pack_rejected';
      fixed: number;
      afford: number;
      needed: number;
    };

export function evaluatePromptAfford(opts: {
  systemTokens: number;
  toolDefTokens: number;
  promptAffordTokens: number | null | undefined;
  outputReserve?: number;
  safetyMargin?: number;
}): AffordEvaluation {
  const fixed = Math.max(0, opts.systemTokens) + Math.max(0, opts.toolDefTokens);
  const afford = opts.promptAffordTokens;
  if (afford == null || !(afford > 0)) {
    return { ok: true, fixed };
  }
  const reserve = opts.outputReserve ?? PROMPT_AFFORD_OUTPUT_RESERVE;
  const safety = opts.safetyMargin ?? PROMPT_AFFORD_SAFETY_MARGIN;
  const needed = fixed + reserve + safety;
  if (needed > afford) {
    return {
      ok: false,
      reason: 'prompt_pack_rejected',
      fixed,
      afford,
      needed,
    };
  }
  return { ok: true, fixed };
}

/** Shared stream/non-stream afford gate (Afford.S1). */
export type AffordPackDecision =
  | { status: 'ok'; fixed: number }
  | {
      status: 'downgrade_needed';
      fixed: number;
      afford: number;
      needed: number;
    }
  | {
      status: 'rejected';
      fixed: number;
      afford: number;
      needed: number;
    };

/**
 * Decide whether the assembled pack is affordable.
 * - ok → call provider
 * - downgrade_needed → rebuild with reflex once
 * - rejected → throw prompt_pack_rejected (zero provider calls)
 */
export function ensureAffordablePromptPack(opts: {
  systemTokens: number;
  toolDefTokens: number;
  afford: number | null | undefined;
  alreadyDowngraded?: boolean;
  outputReserve?: number;
  safetyMargin?: number;
}): AffordPackDecision {
  const evaluation = evaluatePromptAfford({
    systemTokens: opts.systemTokens,
    toolDefTokens: opts.toolDefTokens,
    promptAffordTokens: opts.afford,
    outputReserve: opts.outputReserve,
    safetyMargin: opts.safetyMargin,
  });
  if (evaluation.ok) {
    return { status: 'ok', fixed: evaluation.fixed };
  }
  if (!opts.alreadyDowngraded) {
    return {
      status: 'downgrade_needed',
      fixed: evaluation.fixed,
      afford: evaluation.afford,
      needed: evaluation.needed,
    };
  }
  return {
    status: 'rejected',
    fixed: evaluation.fixed,
    afford: evaluation.afford,
    needed: evaluation.needed,
  };
}
