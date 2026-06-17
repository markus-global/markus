import { EventBus } from '../src/events.js';

describe('EventBus', () => {
  it('subscribes and emits events', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('test', handler);
    bus.emit('test', { value: 42 });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ value: 42 });
  });

  it('supports multiple subscribers', () => {
    const bus = new EventBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    bus.on('multi', handler1);
    bus.on('multi', handler2);
    bus.emit('multi', 'payload');
    expect(handler1).toHaveBeenCalledWith('payload');
    expect(handler2).toHaveBeenCalledWith('payload');
  });

  it('unsubscribes via returned function', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const unsubscribe = bus.on('test', handler);
    unsubscribe();
    bus.emit('test');
    expect(handler).not.toHaveBeenCalled();
  });

  it('unsubscribes via off', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('test', handler);
    bus.off('test', handler);
    bus.emit('test');
    expect(handler).not.toHaveBeenCalled();
  });

  it('once fires only once', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.once('once', handler);
    bus.emit('once', 1);
    bus.emit('once', 2);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(1);
  });

  it('removeAllListeners clears specific event', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('a', handler);
    bus.on('b', vi.fn());
    bus.removeAllListeners('a');
    bus.emit('a');
    bus.emit('b');
    expect(handler).not.toHaveBeenCalled();
  });

  it('removeAllListeners clears all events', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('a', handler);
    bus.on('b', handler);
    bus.removeAllListeners();
    bus.emit('a');
    bus.emit('b');
    expect(handler).not.toHaveBeenCalled();
  });

  it('isolates listener errors', () => {
    const bus = new EventBus();
    const good = vi.fn();
    bus.on('err', () => {
      throw new Error('listener failed');
    });
    bus.on('err', good);
    expect(() => bus.emit('err', 'data')).not.toThrow();
    expect(good).toHaveBeenCalledWith('data');
  });
});
