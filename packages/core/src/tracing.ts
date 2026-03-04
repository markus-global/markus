import { createLogger } from '@markus/shared';

const log = createLogger('tracing');

export interface SpanAttributes {
  [key: string]: string | number | boolean | undefined;
}

export interface Span {
  name: string;
  startTime: number;
  attributes: SpanAttributes;
  end(attributes?: SpanAttributes): void;
  setError(error: Error | string): void;
}

export interface TracingProvider {
  startSpan(name: string, attributes?: SpanAttributes): Span;
}

class DefaultSpan implements Span {
  name: string;
  startTime: number;
  attributes: SpanAttributes;
  private ended = false;

  constructor(name: string, attributes?: SpanAttributes) {
    this.name = name;
    this.startTime = Date.now();
    this.attributes = attributes ?? {};
  }

  end(extraAttributes?: SpanAttributes): void {
    if (this.ended) return;
    this.ended = true;
    const durationMs = Date.now() - this.startTime;
    if (extraAttributes) Object.assign(this.attributes, extraAttributes);
    log.debug(`[trace] ${this.name}`, { durationMs, ...this.attributes });
  }

  setError(error: Error | string): void {
    this.attributes['error'] = typeof error === 'string' ? error : error.message;
    this.attributes['error.type'] = typeof error === 'string' ? 'string' : error.constructor.name;
  }
}

class DefaultTracingProvider implements TracingProvider {
  startSpan(name: string, attributes?: SpanAttributes): Span {
    return new DefaultSpan(name, attributes);
  }
}

let activeProvider: TracingProvider = new DefaultTracingProvider();

export function setTracingProvider(provider: TracingProvider): void {
  activeProvider = provider;
}

export function startSpan(name: string, attributes?: SpanAttributes): Span {
  return activeProvider.startSpan(name, attributes);
}

/** Convenience: trace an async operation */
export async function trace<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes?: SpanAttributes
): Promise<T> {
  const span = startSpan(name, attributes);
  try {
    const result = await fn(span);
    span.end();
    return result;
  } catch (error) {
    span.setError(error instanceof Error ? error : String(error));
    span.end();
    throw error;
  }
}
