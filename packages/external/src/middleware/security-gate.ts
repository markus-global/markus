/**
 * Security Gate Middleware - Multi-layered input validation and injection detection.
 *
 * This is the primary security boundary for external mode. It operates
 * INDEPENDENTLY from the LLM pipeline — all checks happen before any
 * content reaches the model.
 *
 * Layers:
 * 1. Basic validation (length, encoding, empty)
 * 2. Unicode normalization & hidden character detection
 * 3. Prompt injection pattern matching (multi-language)
 * 4. Structural attack detection (delimiters, role spoofing)
 * 5. Optional LLM-based semantic moderation (async hook)
 */
import { createLogger, type ExternalContext, type InputValidationConfig } from '@markus/shared';
import type { MiddlewareHandler } from './types.js';

const log = createLogger('mw:security-gate');

const DEFAULT_MAX_LENGTH = 4000;

// ─── Layer 2: Hidden/Invisible Characters ────────────────────────────────────

const INVISIBLE_CHARS = /[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF\u00AD\u034F\u061C\u180E]/g;
const EXCESSIVE_WHITESPACE = /\s{50,}/;
const SUSPICIOUS_ENCODING = /(?:%[0-9a-f]{2}){10,}/i;

// ─── Layer 3: Prompt Injection Patterns (Multi-language) ─────────────────────

const INJECTION_PATTERNS_EN = [
  /ignore\s+(?:all\s+)?(?:previous|above|prior|earlier)\s+(?:instructions|context|rules|directives)/i,
  /(?:disregard|forget|override|bypass)\s+(?:all\s+)?(?:previous|your|the|above)\s+(?:instructions|rules|guidelines|constraints)/i,
  /you\s+are\s+now\s+(?:a|an|no\s+longer)\s+/i,
  /(?:new|updated|revised|real)\s+(?:system\s+)?(?:instructions?|prompt|rules?|role)\s*[:=]/i,
  /(?:actually|secretly|really),?\s+(?:you\s+(?:are|should|must|need\s+to)|your\s+(?:real|true|actual))/i,
  /pretend\s+(?:you\s+(?:are|have|were)|that|to\s+be)/i,
  /(?:act|behave|respond|function)\s+as\s+(?:if|though)\s+you\s+(?:are|were|have)/i,
  /(?:from\s+now\s+on|henceforth|going\s+forward),?\s+(?:you|your|ignore|disregard)/i,
  /(?:reveal|show|display|output|print|repeat)\s+(?:your|the)\s+(?:system\s+)?(?:prompt|instructions|rules|context)/i,
  /what\s+(?:are|is|were)\s+your\s+(?:system\s+)?(?:instructions|prompt|rules|guidelines|constraints|directives)/i,
  /(?:jailbreak|DAN|do\s+anything\s+now|developer\s+mode|god\s+mode)/i,
  /\bsudo\s+(?:mode|access|enable|grant|override)\b/i,
];

const INJECTION_PATTERNS_ZH = [
  /忽略(?:所有|之前的?|上面的?|先前的?)(?:指令|规则|约束|提示|说明)/,
  /(?:无视|抛弃|覆盖|绕过|取消)(?:之前|你的|上述)?(?:指令|规则|限制|约束)/,
  /你(?:现在|不再)是/,
  /(?:新的|更新的|真正的|实际的)(?:系统)?(?:指令|提示|角色|规则)\s*[:：=]/,
  /(?:假装|扮演|模拟|充当|伪装成)/,
  /(?:揭示|显示|输出|打印|重复)你的(?:系统)?(?:提示|指令|规则)/,
  /你的(?:系统)?(?:提示|指令|规则|设定)是什么/,
  /从现在开始(?:你|忽略|无视)/,
  /(?:越狱|开发者模式|无限制模式|上帝模式)/,
];

// ─── Layer 4: Structural Attack Patterns ─────────────────────────────────────

const STRUCTURAL_ATTACKS = [
  /system\s*:\s*/i,
  /\[\s*(?:INST|SYS|SYSTEM)\s*\]/i,
  /<\|(?:im_start|system|user|assistant|endoftext)\|>/i,
  /```\s*(?:system|instructions?|prompt|config)\b/i,
  /---+\s*(?:system|instructions?|prompt|new\s+role)\s*---+/i,
  /#{1,3}\s*(?:system\s+prompt|instructions|new\s+role|override)/i,
  /\[(?:system|instructions?|hidden|private|internal)\]/i,
  /<(?:system|instructions?|hidden|prompt|override)[^>]*>/i,
  /\bHuman:\s*$|^Assistant:\s*/im,
  /\bUSER:\s*$|^ASSISTANT:\s*/im,
];

// ─── Composite Detection ─────────────────────────────────────────────────────

interface SecurityCheckResult {
  passed: boolean;
  failReason?: string;
  failCategory?: 'empty' | 'length' | 'encoding' | 'injection' | 'structural' | 'blocked' | 'moderation';
  riskScore: number;
  detail?: string;
}

function runSecurityChecks(content: string, maxLength: number, blockedPatterns: RegExp[]): SecurityCheckResult {
  // Layer 1: Basic validation
  if (!content || content.trim().length === 0) {
    return { passed: false, failReason: 'Empty message', failCategory: 'empty', riskScore: 0 };
  }

  if (content.length > maxLength) {
    return { passed: false, failReason: `Message too long (max ${maxLength} characters)`, failCategory: 'length', riskScore: 0.1, detail: `${content.length} chars` };
  }

  // Layer 2: Hidden characters and encoding tricks
  const invisibleMatches = content.match(INVISIBLE_CHARS);
  if (invisibleMatches && invisibleMatches.length > 3) {
    return { passed: false, failReason: 'Message contains suspicious hidden characters', failCategory: 'encoding', riskScore: 0.8, detail: `${invisibleMatches.length} invisible chars` };
  }

  if (EXCESSIVE_WHITESPACE.test(content)) {
    return { passed: false, failReason: 'Message contains suspicious whitespace patterns', failCategory: 'encoding', riskScore: 0.6 };
  }

  if (SUSPICIOUS_ENCODING.test(content)) {
    return { passed: false, failReason: 'Message contains suspicious encoded content', failCategory: 'encoding', riskScore: 0.7 };
  }

  // Normalize for pattern matching (strip invisible chars, collapse whitespace)
  const normalized = content
    .replace(INVISIBLE_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Layer 3: Prompt injection (English)
  for (const pattern of INJECTION_PATTERNS_EN) {
    if (pattern.test(normalized)) {
      return { passed: false, failReason: 'Message rejected by security filter', failCategory: 'injection', riskScore: 0.9, detail: pattern.source };
    }
  }

  // Layer 3: Prompt injection (Chinese)
  for (const pattern of INJECTION_PATTERNS_ZH) {
    if (pattern.test(normalized)) {
      return { passed: false, failReason: 'Message rejected by security filter', failCategory: 'injection', riskScore: 0.9, detail: pattern.source };
    }
  }

  // Layer 4: Structural attacks
  for (const pattern of STRUCTURAL_ATTACKS) {
    if (pattern.test(content)) {
      return { passed: false, failReason: 'Message rejected by security filter', failCategory: 'structural', riskScore: 0.85, detail: pattern.source };
    }
  }

  // Layer 5: Custom blocked patterns
  for (const pattern of blockedPatterns) {
    if (pattern.test(content)) {
      return { passed: false, failReason: 'Message contains blocked content', failCategory: 'blocked', riskScore: 0.5, detail: pattern.source };
    }
  }

  return { passed: true, riskScore: 0 };
}

// ─── LLM-based Moderation Hook ───────────────────────────────────────────────

/**
 * Optional async moderation function using a separate LLM call.
 * This runs INDEPENDENTLY from the main agent LLM — it uses a fast
 * classifier model to detect sophisticated attacks that bypass regex.
 */
export type ModerationHook = (content: string, sessionId: string) => Promise<{
  safe: boolean;
  reason?: string;
  category?: string;
  confidence: number;
}>;

export interface SecurityGateConfig extends Partial<InputValidationConfig> {
  /** Optional LLM-based moderation for sophisticated attack detection */
  moderationHook?: ModerationHook;
  /** Whether to run moderation async (non-blocking) or sync (blocking) */
  moderationMode?: 'sync' | 'async';
  /** Risk score threshold (0-1) below which to skip LLM moderation */
  moderationThreshold?: number;
  /** Dynamic resolver for per-service config (overrides static values) */
  configResolver?: (serviceId: string) => Partial<InputValidationConfig> | undefined;
}

// ─── Middleware Factory ──────────────────────────────────────────────────────

export function createSecurityGateMiddleware(config?: SecurityGateConfig): MiddlewareHandler {
  const defaultMaxLength = config?.maxMessageLength ?? DEFAULT_MAX_LENGTH;
  const defaultBlockedPatterns = (config?.blockedPatterns ?? []).map(p => new RegExp(p, 'i'));
  const moderationHook = config?.moderationHook;
  const moderationMode = config?.moderationMode ?? 'sync';
  const configResolver = config?.configResolver;

  return async (ctx: ExternalContext, next) => {
    const content = ctx.message.content;
    const ts = () => new Date().toISOString();

    const resolved = configResolver?.(ctx.session.serviceId);
    const maxLength = resolved?.maxMessageLength ?? defaultMaxLength;
    const blockedPatterns = resolved?.blockedPatterns
      ? resolved.blockedPatterns.map(p => new RegExp(p, 'i'))
      : defaultBlockedPatterns;

    const result = runSecurityChecks(content, maxLength, blockedPatterns);

    if (!result.passed) {
      ctx.aborted = true;
      ctx.abortReason = result.failReason;
      ctx.audit.push({
        timestamp: ts(),
        type: 'input_validation',
        action: `reject_${result.failCategory}`,
        success: false,
        detail: result.detail,
        metadata: { riskScore: result.riskScore },
      });
      log.warn('Security gate blocked message', {
        sessionId: ctx.session.id,
        category: result.failCategory,
        riskScore: result.riskScore,
      });
      return;
    }

    // Run LLM-based moderation if configured
    if (moderationHook) {
      if (moderationMode === 'sync') {
        try {
          const modResult = await moderationHook(content, ctx.session.id);
          if (!modResult.safe) {
            ctx.aborted = true;
            ctx.abortReason = 'Message rejected by content moderation';
            ctx.audit.push({
              timestamp: ts(),
              type: 'input_validation',
              action: 'reject_moderation',
              success: false,
              detail: modResult.reason,
              metadata: { category: modResult.category, confidence: modResult.confidence },
            });
            log.warn('LLM moderation blocked message', {
              sessionId: ctx.session.id,
              reason: modResult.reason,
              confidence: modResult.confidence,
            });
            return;
          }
        } catch (err) {
          log.error('LLM moderation failed, allowing message through', { error: String(err) });
          ctx.audit.push({
            timestamp: ts(),
            type: 'input_validation',
            action: 'moderation_error',
            success: true,
            detail: `Moderation unavailable: ${String(err)}`,
          });
        }
      } else {
        // Async mode: fire-and-forget, log but don't block
        moderationHook(content, ctx.session.id).then(modResult => {
          if (!modResult.safe) {
            log.warn('Async moderation flagged message (post-hoc)', {
              sessionId: ctx.session.id,
              reason: modResult.reason,
            });
          }
        }).catch(() => {});
      }
    }

    ctx.audit.push({ timestamp: ts(), type: 'input_validation', action: 'pass', success: true, metadata: { riskScore: result.riskScore } });
    await next();
  };
}

/**
 * Standalone check function for use outside the middleware pipeline
 * (e.g., in API validation or testing).
 */
export function checkInputSafety(content: string, maxLength = DEFAULT_MAX_LENGTH): SecurityCheckResult {
  return runSecurityChecks(content, maxLength, []);
}
