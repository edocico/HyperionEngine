import { describe, it, expect, vi } from 'vitest';
import { createHotSystem } from './hot-system';

describe('createHotSystem', () => {
  it('returns initial state when hot is undefined (production)', () => {
    const { state, system } = createHotSystem('test', undefined, {
      initialState: () => ({ count: 0, name: 'default' }),
      preTick: (s, _dt) => { s.count++; },
    });
    expect(state.count).toBe(0);
    expect(state.name).toBe('default');
    expect(typeof system).toBe('function');
  });

  it('system function mutates state', () => {
    const { state, system } = createHotSystem('test', undefined, {
      initialState: () => ({ count: 0 }),
      preTick: (s) => { s.count++; },
    });
    system(1 / 60);
    expect(state.count).toBe(1);
  });

  it('restores state from HMR data', () => {
    const hot = { data: { test: { count: 42 } }, dispose: vi.fn() };
    const { state } = createHotSystem('test', hot as any, {
      initialState: () => ({ count: 0 }),
      preTick: () => {},
    });
    expect(state.count).toBe(42);
  });

  it('merges schema evolution (new fields get defaults)', () => {
    const hot = { data: { test: { count: 42 } }, dispose: vi.fn() };
    const { state } = createHotSystem('test', hot as any, {
      initialState: () => ({ count: 0, name: 'default' }),
      preTick: () => {},
    });
    expect(state.count).toBe(42);
    expect(state.name).toBe('default');
  });

  it('registers dispose callback that saves state', () => {
    const disposeFns: Function[] = [];
    const hot = {
      data: {} as any,
      dispose: (fn: Function) => disposeFns.push(fn),
    };
    const { state } = createHotSystem('test', hot as any, {
      initialState: () => ({ count: 0 }),
      preTick: () => {},
    });
    state.count = 99;
    disposeFns[0]();
    expect(hot.data.test).toEqual({ count: 99 });
  });

  it('does not register dispose when hot is undefined', () => {
    const { state } = createHotSystem('test', undefined, {
      initialState: () => ({ count: 0 }),
      preTick: () => {},
    });
    expect(state.count).toBe(0);
  });
});
