import { describe, it, expect, vi } from 'vitest';
import { SectionSwitcher } from './section-switcher';

/** A promise whose resolution the test controls. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Lets every queued microtask and timer callback run. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('SectionSwitcher', () => {
  it('a switch starts only after the previous one has finished', async () => {
    const log: string[] = [];
    const gate = deferred();
    const switcher = new SectionSwitcher(async (key) => {
      log.push(`start ${key}`);
      if (key === 'a') await gate.promise;
      log.push(`end ${key}`);
    });

    const a = switcher.request('a');
    await flush();
    const b = switcher.request('b');
    await flush();
    expect(log).toEqual(['start a']);

    gate.resolve();
    await Promise.all([a, b]);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b']);
  });

  it('only the latest request runs when several arrive during a switch', async () => {
    const started: string[] = [];
    const gate = deferred();
    const switcher = new SectionSwitcher(async (key) => {
      started.push(key);
      if (key === 'a') await gate.promise;
    });

    const a = switcher.request('a');
    await flush();
    const pending = [a, switcher.request('b'), switcher.request('c')];
    gate.resolve();
    await Promise.all(pending);
    expect(started).toEqual(['a', 'c']);
  });

  it('requests made in the same tick run only the last one', async () => {
    const started: string[] = [];
    const switcher = new SectionSwitcher(async (key) => { started.push(key); });
    await Promise.all([switcher.request('a'), switcher.request('b')]);
    expect(started).toEqual(['b']);
  });

  it('a switch that throws does not block the next one', async () => {
    const onError = vi.fn();
    const started: string[] = [];
    const switcher = new SectionSwitcher(async (key) => {
      started.push(key);
      if (key === 'a') throw new Error('boom');
    }, onError);

    await switcher.request('a');
    await switcher.request('b');
    expect(started).toEqual(['a', 'b']);
    expect(onError).toHaveBeenCalledWith('a', expect.any(Error));
  });

  it('re-requesting the active section runs it again', async () => {
    const started: string[] = [];
    const switcher = new SectionSwitcher(async (key) => { started.push(key); });
    await switcher.request('a');
    await switcher.request('a');
    expect(started).toEqual(['a', 'a']);
  });
});
