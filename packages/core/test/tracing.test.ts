import { startSpan, trace, setTracingProvider, type Span, type TracingProvider } from '../src/tracing.js';

describe('startSpan', () => {
  it('creates a span with name and attributes', () => {
    const span = startSpan('test-op', { agentId: 'a1' });
    expect(span.name).toBe('test-op');
    expect(span.attributes.agentId).toBe('a1');
    expect(span.startTime).toBeLessThanOrEqual(Date.now());
  });

  it('ends span and accepts extra attributes', () => {
    const span = startSpan('end-test');
    span.end({ status: 'ok' });
    expect(span.attributes.status).toBe('ok');
  });

  it('does not end twice', () => {
    const span = startSpan('double-end');
    span.end();
    span.end({ shouldNotApply: true });
    expect(span.attributes.shouldNotApply).toBeUndefined();
  });

  it('records errors via setError', () => {
    const span = startSpan('error-test');
    span.setError(new Error('something broke'));
    expect(span.attributes.error).toBe('something broke');
    expect(span.attributes['error.type']).toBe('Error');
    span.setError('string error');
    expect(span.attributes.error).toBe('string error');
    expect(span.attributes['error.type']).toBe('string');
  });
});

describe('trace', () => {
  it('returns result on success', async () => {
    const result = await trace('async-op', async () => 'done');
    expect(result).toBe('done');
  });

  it('passes span to callback', async () => {
    await trace('with-span', async (span) => {
      span.end({ step: 'complete' });
      expect(span.name).toBe('with-span');
    });
  });

  it('rethrows errors after recording on span', async () => {
    await expect(
      trace('failing-op', async () => {
        throw new Error('fail');
      }),
    ).rejects.toThrow('fail');
  });

  it('handles non-Error throws', async () => {
    await expect(
      trace('string-throw', async () => {
        throw 'oops';
      }),
    ).rejects.toBe('oops');
  });
});

describe('setTracingProvider', () => {
  it('uses custom provider for startSpan', () => {
    const customSpan: Span = {
      name: 'custom',
      startTime: 0,
      attributes: {},
      end: vi.fn(),
      setError: vi.fn(),
    };
    const provider: TracingProvider = {
      startSpan: vi.fn().mockReturnValue(customSpan),
    };

    setTracingProvider(provider);
    const span = startSpan('custom-op', { foo: 'bar' });
    expect(provider.startSpan).toHaveBeenCalledWith('custom-op', { foo: 'bar' });
    expect(span).toBe(customSpan);

    setTracingProvider({
      startSpan: (name, attrs) => ({
        name,
        startTime: Date.now(),
        attributes: attrs ?? {},
        end() {},
        setError() {},
      }),
    });
  });
});
