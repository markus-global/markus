/**
 * Content Filter Middleware - Multi-layer output filtering.
 *
 * Runs AFTER the LLM generates a response, BEFORE it reaches the user.
 * Operates independently from the main LLM — uses pattern matching and
 * optional moderation hooks to ensure no internal information leaks.
 *
 * Layers:
 * 1. Block patterns — completely replace response if matched
 * 2. Strip patterns — redact internal IDs, paths, etc.
 * 3. Information leak detection — catch common disclosure patterns
 * 4. Optional LLM moderation hook — semantic output review
 */
import { createLogger, type ExternalContext, type ContentFilterConfig } from '@markus/shared';
import type { MiddlewareHandler } from './types.js';

const log = createLogger('mw:content-filter');

// Internal identifiers that should never reach external users
const INTERNAL_ID_PATTERNS = [
  /task_[a-f0-9]{16}/g,
  /req_[a-f0-9]{16}/g,
  /agent_[a-f0-9]{16}/g,
  /team_[a-f0-9]{16}/g,
  /org_[a-f0-9]{16}/g,
  /extsvc_[a-f0-9]{16}/g,
  /snap_[a-f0-9_]+/g,
  /gwmsg_\d+_[a-f0-9]+/g,
];

// Patterns that indicate the agent leaked its system prompt or internal info
const INFORMATION_LEAK_PATTERNS = [
  /(?:my|the)\s+system\s+prompt\s+(?:is|says|contains|instructs)/i,
  /(?:I\s+was|I\s+am)\s+(?:instructed|told|configured|programmed)\s+to/i,
  /(?:my|the)\s+(?:internal|system)\s+(?:instructions|configuration|rules)\s+(?:are|state|say)/i,
  /(?:according\s+to|based\s+on)\s+my\s+(?:system\s+)?(?:prompt|instructions|configuration)/i,
  /(?:here(?:'s|\s+is)\s+my\s+(?:system\s+)?prompt|my\s+prompt\s+(?:reads|says|is))/i,
];

// Internal paths that should be redacted
const INTERNAL_PATH_PATTERNS = [
  /\/(?:home|Users)\/\w+\/(?:\.\w+|[a-zA-Z]+\/)/g,
  /(?:packages|node_modules)\/[@\w-]+\/(?:src|dist)\//g,
];

export type OutputModerationHook = (content: string, sessionId: string) => Promise<{
  safe: boolean;
  reason?: string;
  sanitized?: string;
}>;

export interface ContentFilterFullConfig extends ContentFilterConfig {
  /** Optional LLM-based output moderation */
  outputModerationHook?: OutputModerationHook;
}

export function createContentFilterMiddleware(config?: ContentFilterFullConfig): MiddlewareHandler {
  const enabled = config?.enabled ?? true;
  const customStripPatterns = (config?.stripPatterns ?? []).map(p => new RegExp(p, 'g'));
  const customBlockPatterns = (config?.blockPatterns ?? []).map(p => new RegExp(p, 'i'));
  const piiDetection = config?.piiDetection ?? false;
  const moderationHook = config?.outputModerationHook;

  const allStripPatterns = [...INTERNAL_ID_PATTERNS, ...INTERNAL_PATH_PATTERNS, ...customStripPatterns];

  return async (ctx: ExternalContext, next) => {
    await next();

    if (!enabled || !ctx.response?.content) return;

    let content = ctx.response.content;
    let filtered = false;

    // Layer 1: Block patterns — if matched, replace entire response
    for (const pattern of customBlockPatterns) {
      if (pattern.test(content)) {
        ctx.response.content = 'I apologize, but I cannot provide that information.';
        ctx.audit.push({
          timestamp: new Date().toISOString(),
          type: 'content_filter',
          action: 'block_output',
          success: true,
          detail: `Block pattern matched: ${pattern.source}`,
        });
        log.warn('Output blocked by content filter', { sessionId: ctx.session.id, pattern: pattern.source });
        return;
      }
    }

    // Layer 2: Information leak detection
    for (const pattern of INFORMATION_LEAK_PATTERNS) {
      if (pattern.test(content)) {
        ctx.response.content = "I'm here to help you with our service. How can I assist you?";
        ctx.audit.push({
          timestamp: new Date().toISOString(),
          type: 'content_filter',
          action: 'block_leak',
          success: true,
          detail: `Potential prompt disclosure detected`,
        });
        log.warn('Potential information leak blocked', { sessionId: ctx.session.id });
        return;
      }
    }

    // Layer 3: Strip internal identifiers and paths
    for (const pattern of allStripPatterns) {
      const before = content;
      content = content.replace(pattern, '[redacted]');
      if (content !== before) filtered = true;
    }

    // Layer 4: PII detection (basic patterns)
    if (piiDetection) {
      // Credit card numbers
      const ccPattern = /\b(?:\d{4}[\s-]?){3}\d{4}\b/g;
      const ccBefore = content;
      content = content.replace(ccPattern, '[REDACTED-CC]');
      if (content !== ccBefore) filtered = true;

      // SSN-like patterns
      const ssnPattern = /\b\d{3}-\d{2}-\d{4}\b/g;
      const ssnBefore = content;
      content = content.replace(ssnPattern, '[REDACTED-ID]');
      if (content !== ssnBefore) filtered = true;
    }

    if (filtered) {
      ctx.audit.push({
        timestamp: new Date().toISOString(),
        type: 'content_filter',
        action: 'strip_patterns',
        success: true,
      });
      ctx.response.content = content;
    }

    // Layer 5: Optional LLM-based output moderation
    if (moderationHook) {
      try {
        const modResult = await moderationHook(content, ctx.session.id);
        if (!modResult.safe) {
          ctx.response.content = modResult.sanitized ?? "I apologize, but I cannot provide that response.";
          ctx.audit.push({
            timestamp: new Date().toISOString(),
            type: 'content_filter',
            action: 'moderation_block',
            success: true,
            detail: modResult.reason,
          });
          log.warn('Output blocked by LLM moderation', { sessionId: ctx.session.id, reason: modResult.reason });
        }
      } catch (err) {
        log.error('Output moderation hook failed', { error: String(err) });
      }
    }
  };
}
