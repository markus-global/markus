import { createLogger } from '@markus/shared';

const log = createLogger('guardrails');

export interface GuardrailResult {
  passed: boolean;
  reason?: string;
  /** If true, abort the entire interaction (tripwire) */
  tripwire?: boolean;
  /** Modified content (for content-transforming guardrails) */
  transformedContent?: string;
}

export interface InputGuardrail {
  name: string;
  description: string;
  /** Check user input before it reaches the agent */
  check(input: string, context?: { agentId: string; senderId?: string }): Promise<GuardrailResult>;
}

export interface OutputGuardrail {
  name: string;
  description: string;
  /** Check agent output before it's returned to the user */
  check(output: string, context?: { agentId: string; toolCalls?: number }): Promise<GuardrailResult>;
}

export class GuardrailPipeline {
  private inputGuardrails: InputGuardrail[] = [];
  private outputGuardrails: OutputGuardrail[] = [];

  addInputGuardrail(guardrail: InputGuardrail): void {
    this.inputGuardrails.push(guardrail);
    log.info(`Input guardrail registered: ${guardrail.name}`);
  }

  addOutputGuardrail(guardrail: OutputGuardrail): void {
    this.outputGuardrails.push(guardrail);
    log.info(`Output guardrail registered: ${guardrail.name}`);
  }

  async checkInput(input: string, context?: { agentId: string; senderId?: string }): Promise<{ passed: boolean; reason?: string; transformedInput?: string }> {
    let currentInput = input;
    for (const guardrail of this.inputGuardrails) {
      try {
        const result = await guardrail.check(currentInput, context);
        if (!result.passed) {
          log.warn(`Input guardrail "${guardrail.name}" blocked input`, { reason: result.reason });
          if (result.tripwire) {
            return { passed: false, reason: `[Blocked by ${guardrail.name}] ${result.reason}` };
          }
          return { passed: false, reason: result.reason };
        }
        if (result.transformedContent) {
          currentInput = result.transformedContent;
        }
      } catch (error) {
        log.error(`Input guardrail "${guardrail.name}" threw error`, { error: String(error) });
      }
    }
    return { passed: true, transformedInput: currentInput !== input ? currentInput : undefined };
  }

  async checkOutput(output: string, context?: { agentId: string; toolCalls?: number }): Promise<{ passed: boolean; reason?: string; transformedOutput?: string }> {
    let currentOutput = output;
    for (const guardrail of this.outputGuardrails) {
      try {
        const result = await guardrail.check(currentOutput, context);
        if (!result.passed) {
          log.warn(`Output guardrail "${guardrail.name}" blocked output`, { reason: result.reason });
          return { passed: false, reason: result.reason };
        }
        if (result.transformedContent) {
          currentOutput = result.transformedContent;
        }
      } catch (error) {
        log.error(`Output guardrail "${guardrail.name}" threw error`, { error: String(error) });
      }
    }
    return { passed: true, transformedOutput: currentOutput !== output ? currentOutput : undefined };
  }

  getInputGuardrails(): InputGuardrail[] { return [...this.inputGuardrails]; }
  getOutputGuardrails(): OutputGuardrail[] { return [...this.outputGuardrails]; }
}

/** Built-in: blocks prompt injection attempts */
export const promptInjectionGuardrail: InputGuardrail = {
  name: 'prompt-injection-detector',
  description: 'Detects common prompt injection patterns',
  async check(input: string): Promise<GuardrailResult> {
    const patterns = [
      /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions|prompts)/i,
      /you\s+are\s+now\s+(a|an)\s+/i,
      /system\s*:\s*you\s+are/i,
      /\bDAN\b.*\bjailbreak\b/i,
      /pretend\s+you\s+(are|have)\s+no\s+(rules|restrictions|limits)/i,
    ];
    for (const pattern of patterns) {
      if (pattern.test(input)) {
        return { passed: false, reason: 'Potential prompt injection detected', tripwire: true };
      }
    }
    return { passed: true };
  },
};

/** Built-in: limits input length */
export function createMaxLengthGuardrail(maxChars: number): InputGuardrail {
  return {
    name: 'max-input-length',
    description: `Limits input to ${maxChars} characters`,
    async check(input: string): Promise<GuardrailResult> {
      if (input.length > maxChars) {
        return { passed: false, reason: `Input too long (${input.length} chars, max ${maxChars})` };
      }
      return { passed: true };
    },
  };
}

/** Built-in: blocks sensitive data in output */
export const sensitiveDataGuardrail: OutputGuardrail = {
  name: 'sensitive-data-filter',
  description: 'Blocks output containing potential secrets or credentials',
  async check(output: string): Promise<GuardrailResult> {
    const patterns = [
      /(?:api[_-]?key|secret[_-]?key|password|token)\s*[:=]\s*['"][^'"]{8,}['"]/i,
      /(?:sk-|pk_live_|rk_live_|ghp_|gho_)[a-zA-Z0-9]{20,}/,
      /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/,
    ];
    for (const pattern of patterns) {
      if (pattern.test(output)) {
        return { passed: false, reason: 'Output contains potential sensitive data' };
      }
    }
    return { passed: true };
  },
};
