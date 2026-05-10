/**
 * Payment Middleware - Integration hooks for monetized agent services.
 *
 * Supports pre-session payment (pay to start), per-message billing,
 * and post-session settlement patterns.
 */
import { createLogger, type ExternalContext } from '@markus/shared';
import type { MiddlewareHandler } from './types.js';

const log = createLogger('mw:payment');

export type PaymentMode = 'pre_session' | 'per_message' | 'post_session';

export interface PaymentProvider {
  checkBalance(userId: string): Promise<{ sufficient: boolean; balance: number }>;
  charge(userId: string, amount: number, metadata: Record<string, unknown>): Promise<{ success: boolean; transactionId?: string; error?: string }>;
  refund(transactionId: string): Promise<boolean>;
}

export interface PaymentConfig {
  mode: PaymentMode;
  amountPerMessage?: number;
  amountPerSession?: number;
  currency: string;
  provider: PaymentProvider;
}

export function createPaymentMiddleware(config: PaymentConfig): MiddlewareHandler {
  return async (ctx: ExternalContext, next) => {
    const userId = ctx.session.participantId;

    if (config.mode === 'per_message') {
      const amount = config.amountPerMessage ?? 0;
      if (amount > 0) {
        const balance = await config.provider.checkBalance(userId);
        if (!balance.sufficient) {
          ctx.aborted = true;
          ctx.abortReason = 'Insufficient balance. Please top up to continue.';
          ctx.audit.push({ timestamp: new Date().toISOString(), type: 'custom', action: 'payment_insufficient', success: false, metadata: { balance: balance.balance, required: amount } });
          return;
        }

        const charge = await config.provider.charge(userId, amount, {
          sessionId: ctx.session.id,
          messageContent: ctx.message.content.slice(0, 50),
        });

        if (!charge.success) {
          ctx.aborted = true;
          ctx.abortReason = 'Payment failed. Please try again.';
          ctx.audit.push({ timestamp: new Date().toISOString(), type: 'custom', action: 'payment_failed', success: false, detail: charge.error });
          return;
        }

        ctx.state['paymentTransactionId'] = charge.transactionId;
        ctx.audit.push({ timestamp: new Date().toISOString(), type: 'custom', action: 'payment_charged', success: true, metadata: { amount, transactionId: charge.transactionId } });
      }
    }

    await next();

    if (config.mode === 'per_message' && ctx.aborted && ctx.state['paymentTransactionId']) {
      const txId = ctx.state['paymentTransactionId'] as string;
      await config.provider.refund(txId);
      log.info('Payment refunded due to processing failure', { transactionId: txId, sessionId: ctx.session.id });
    }
  };
}
