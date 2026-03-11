import { createLogger } from '@markus/shared';

const log = createLogger('security');

export interface SecurityPolicy {
  shellAllowPatterns?: RegExp[];
  shellDenyPatterns?: RegExp[];
  pathAllowlist?: string[];
  pathDenylist?: string[];
  requireApproval?: string[];
  maxFileSize?: number;
}

const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--no-preserve-root)/,
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+\//,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\bchmod\s+777\b/,
  />\s*\/dev\/sd/,
  /\bcurl\b.*\|\s*(bash|sh|zsh)\b/,
  /\bwget\b.*\|\s*(bash|sh|zsh)\b/,
];

const DEFAULT_PATH_DENY = [
  '/etc/passwd', '/etc/shadow', '/etc/sudoers',
  '/.ssh/', '/id_rsa', '/id_ed25519',
];

export class SecurityGuard {
  private policy: SecurityPolicy;
  private pendingApprovals = new Map<string, { command: string; resolve: (approved: boolean) => void }>();

  constructor(policy?: SecurityPolicy) {
    this.policy = policy ?? {};
  }

  validateShellCommand(command: string): { allowed: boolean; reason?: string; needsApproval?: boolean } {
    // Check deny patterns first
    const denyPatterns = [...DANGEROUS_PATTERNS, ...(this.policy.shellDenyPatterns ?? [])];
    for (const pattern of denyPatterns) {
      if (pattern.test(command)) {
        log.warn('Shell command denied by security policy', { command: command.slice(0, 100), pattern: pattern.source });
        return { allowed: false, reason: `Blocked by security policy: matches dangerous pattern` };
      }
    }

    // Check allow patterns if configured (whitelist mode)
    if (this.policy.shellAllowPatterns?.length) {
      const allowed = this.policy.shellAllowPatterns.some((p) => p.test(command));
      if (!allowed) {
        return { allowed: false, reason: 'Command not in allowlist' };
      }
    }

    // Check if approval is needed
    for (const keyword of this.policy.requireApproval ?? []) {
      if (command.includes(keyword)) {
        return { allowed: true, needsApproval: true };
      }
    }

    return { allowed: true };
  }

  validateFilePath(path: string): { allowed: boolean; reason?: string } {
    const denyCheck = this.validateFileReadPath(path);
    if (!denyCheck.allowed) return denyCheck;

    if (this.policy.pathAllowlist?.length) {
      const allowed = this.policy.pathAllowlist.some((p) => path.startsWith(p));
      if (!allowed) {
        return { allowed: false, reason: 'Path not in allowlist' };
      }
    }

    return { allowed: true };
  }

  /**
   * Validate a file path for read-only access.
   * Only checks the denylist (sensitive system files) — does NOT check the allowlist.
   */
  validateFileReadPath(path: string): { allowed: boolean; reason?: string } {
    const denyPaths = [...DEFAULT_PATH_DENY, ...(this.policy.pathDenylist ?? [])];

    for (const deny of denyPaths) {
      if (path.includes(deny)) {
        log.warn('File path denied by security policy', { path });
        return { allowed: false, reason: `Access to ${deny} is blocked` };
      }
    }

    return { allowed: true };
  }

  getPolicy(): SecurityPolicy {
    return { ...this.policy };
  }
}

export const defaultSecurityGuard = new SecurityGuard();
