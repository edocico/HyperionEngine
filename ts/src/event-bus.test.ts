import { describe, it, expect, vi } from 'vitest';
import { EventBus } from './event-bus';

describe('EventBus', () => {
  it('on registers a listener and emit calls it', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.on('test', fn);
    bus.emit('test', { value: 42 });
    expect(fn).toHaveBeenCalledWith({ value: 42 });
  });

  it('off removes a listener', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.on('test', fn);
    bus.off('test', fn);
    bus.emit('test', {});
    expect(fn).not.toHaveBeenCalled();
  });

  it('once fires only once', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.once('test', fn);
    bus.emit('test', {});
    bus.emit('test', {});
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('emit with no listeners does not throw', () => {
    const bus = new EventBus();
    expect(() => bus.emit('nope', {})).not.toThrow();
  });

  it('destroy removes all listeners', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.on('a', fn);
    bus.on('b', fn);
    bus.destroy();
    bus.emit('a', {});
    bus.emit('b', {});
    expect(fn).not.toHaveBeenCalled();
  });
});
