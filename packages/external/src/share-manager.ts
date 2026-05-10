/**
 * ShareManager - Generates and validates share tokens for external access.
 *
 * Tokens are HMAC-signed, time-limited, and track usage counts.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createLogger, type ShareToken, type SharePermissions } from '@markus/shared';

const log = createLogger('share-manager');

export interface ShareManagerConfig {
  signingSecret: string;
  defaultExpiryMs: number;
  defaultMaxUses?: number;
}

export interface ShareTokenStore {
  create(data: {
    token: string;
    serviceId: string;
    agentId: string;
    createdBy: string;
    permissions: SharePermissions;
    maxUses?: number;
    expiresAt?: string;
  }): ShareToken;
  findByToken(token: string): ShareToken | undefined;
  findById(id: string): ShareToken | undefined;
  listByService(serviceId: string): ShareToken[];
  incrementUsage(token: string): void;
  revoke(id: string): void;
  isValid(token: ShareToken): boolean;
}

export class ShareManager {
  constructor(
    private config: ShareManagerConfig,
    private store: ShareTokenStore,
  ) {}

  /**
   * Generate a new share link token for a service.
   */
  generate(opts: {
    serviceId: string;
    agentId: string;
    createdBy: string;
    permissions?: Partial<SharePermissions>;
    maxUses?: number;
    expiryMs?: number;
  }): ShareToken {
    const rawToken = randomBytes(32).toString('base64url');
    const signature = this.sign(rawToken);
    const signedToken = `${rawToken}.${signature}`;

    const expiryMs = opts.expiryMs ?? this.config.defaultExpiryMs;
    const expiresAt = expiryMs > 0
      ? new Date(Date.now() + expiryMs).toISOString()
      : undefined;

    const permissions: SharePermissions = {
      canChat: true,
      canUploadFiles: false,
      ...opts.permissions,
    };

    const token = this.store.create({
      token: signedToken,
      serviceId: opts.serviceId,
      agentId: opts.agentId,
      createdBy: opts.createdBy,
      permissions,
      maxUses: opts.maxUses ?? this.config.defaultMaxUses,
      expiresAt,
    });

    log.info('Share token generated', {
      tokenId: token.id,
      serviceId: opts.serviceId,
      agentId: opts.agentId,
      expiresAt,
      maxUses: token.maxUses,
    });

    return token;
  }

  /**
   * Validate a share token string. Returns the token record if valid.
   */
  validate(tokenString: string): { valid: boolean; token?: ShareToken; error?: string } {
    const parts = tokenString.split('.');
    if (parts.length !== 2) {
      return { valid: false, error: 'Invalid token format' };
    }

    const [rawToken, signature] = parts;
    const expectedSig = this.sign(rawToken!);

    try {
      if (!timingSafeEqual(Buffer.from(signature!, 'base64url'), Buffer.from(expectedSig, 'base64url'))) {
        return { valid: false, error: 'Invalid token signature' };
      }
    } catch {
      return { valid: false, error: 'Invalid token signature' };
    }

    const token = this.store.findByToken(tokenString);
    if (!token) {
      return { valid: false, error: 'Token not found' };
    }

    if (!this.store.isValid(token)) {
      if (token.status === 'revoked') {
        return { valid: false, error: 'Token has been revoked' };
      }
      if (token.expiresAt && new Date(token.expiresAt) < new Date()) {
        return { valid: false, error: 'Token has expired' };
      }
      if (token.maxUses && token.usageCount >= token.maxUses) {
        return { valid: false, error: 'Token has reached maximum usage' };
      }
      return { valid: false, error: 'Token is invalid' };
    }

    return { valid: true, token };
  }

  /**
   * Record a usage of the token (e.g., new session created).
   */
  recordUsage(tokenString: string): void {
    this.store.incrementUsage(tokenString);
  }

  /**
   * Revoke a share token by ID.
   */
  revoke(tokenId: string): void {
    this.store.revoke(tokenId);
    log.info('Share token revoked', { tokenId });
  }

  /**
   * List all tokens for a service.
   */
  listTokens(serviceId: string): ShareToken[] {
    return this.store.listByService(serviceId);
  }

  /**
   * Build the share URL from a token.
   */
  buildShareUrl(baseUrl: string, tokenString: string): string {
    return `${baseUrl}/ext/${encodeURIComponent(tokenString)}`;
  }

  private sign(data: string): string {
    return createHmac('sha256', this.config.signingSecret)
      .update(data)
      .digest('base64url');
  }
}
