/**
 * Middleware Pipeline - Koa-style compose for external mode.
 *
 * Middlewares wrap in onion layers: pre-processing runs top-down,
 * post-processing runs bottom-up after `next()` returns.
 */
import { createLogger, type ExternalContext, type MiddlewareConfig } from '@markus/shared';
import type { MiddlewareHandler, MiddlewareDefinition } from './types.js';

const log = createLogger('middleware-pipeline');

export class MiddlewarePipeline {
  private registry = new Map<string, MiddlewareHandler>();

  /**
   * Register a middleware handler by name.
   */
  register(name: string, handler: MiddlewareHandler): void {
    this.registry.set(name, handler);
  }

  /**
   * Register multiple middlewares at once.
   */
  registerAll(definitions: MiddlewareDefinition[]): void {
    for (const def of definitions) {
      this.registry.set(def.name, def.handler);
    }
  }

  /**
   * Compose a chain of middlewares from config into a single executable handler.
   * Only enabled middlewares are included, sorted by priority.
   */
  compose(configs: MiddlewareConfig[]): MiddlewareHandler {
    const enabled = configs
      .filter(c => c.enabled)
      .sort((a, b) => a.priority - b.priority);

    const handlers: MiddlewareHandler[] = [];
    for (const config of enabled) {
      const handler = this.registry.get(config.name);
      if (handler) {
        handlers.push(handler);
      } else {
        log.warn('Middleware not found in registry, skipping', { name: config.name });
      }
    }

    return compose(handlers);
  }

  /**
   * Execute the middleware chain against a context.
   */
  async execute(ctx: ExternalContext, configs: MiddlewareConfig[], finalHandler: MiddlewareHandler): Promise<void> {
    const chain = this.compose(configs);

    const wrappedFinal: MiddlewareHandler = async (innerCtx, next) => {
      await finalHandler(innerCtx, next);
    };

    const fullChain = compose([chain, wrappedFinal]);
    await fullChain(ctx, async () => {});
  }

  /**
   * List all registered middleware names.
   */
  listRegistered(): string[] {
    return [...this.registry.keys()];
  }
}

/**
 * Compose multiple middleware handlers into a single handler (Koa-style).
 */
function compose(handlers: MiddlewareHandler[]): MiddlewareHandler {
  return async (ctx: ExternalContext, next: () => Promise<void>) => {
    let index = -1;

    async function dispatch(i: number): Promise<void> {
      if (i <= index) {
        throw new Error('next() called multiple times');
      }
      index = i;

      if (ctx.aborted) return;

      if (i < handlers.length) {
        const handler = handlers[i]!;
        await handler(ctx, () => dispatch(i + 1));
      } else {
        await next();
      }
    }

    await dispatch(0);
  };
}
