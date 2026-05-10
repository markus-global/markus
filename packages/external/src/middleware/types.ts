/**
 * Middleware types for the external mode pipeline.
 */
import type { ExternalContext } from '@markus/shared';

export type MiddlewareNext = () => Promise<void>;
export type MiddlewareHandler = (ctx: ExternalContext, next: MiddlewareNext) => Promise<void>;

export interface MiddlewareDefinition {
  name: string;
  handler: MiddlewareHandler;
}
