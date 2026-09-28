import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PieceReloadCollector, assertPiecesNotEmpty, type PieceReloadTimers } from './piece-reload-collector';
import { PRIMITIVE_LIBRARIES, type PrimitivePieces } from './primitive-shaders';

type Entries = Array<{ name: string; code: string }>;

/** Timers the test fires by hand; `armed` shows what is waiting and for how long. */
function manualTimers() {
  const armed = new Map<number, { fn: () => void; ms: number }>();
  let ids = 0;
  const timers: PieceReloadTimers = {
    set: (fn, ms) => {
      armed.set(++ids, { fn, ms });
      return ids;
    },
    clear: (handle) => {
      armed.delete(handle as number);
    },
  };
  return {
    timers,
    armed,
    fire(): void {
      const due = [...armed.values()];
      armed.clear();
      for (const t of due) t.fn();
    },
  };
}

function collector(delayMs?: number) {
  const t = manualTimers();
  const apply = vi.fn((_entries: Entries) => Promise.resolve());
  const c = new PieceReloadCollector(apply, delayMs, t.timers);
  return { c, apply, ...t };
}

describe('PieceReloadCollector', () => {
  it('waits 50 ms after the LAST offer: every offer restarts the timer', () => {
    const { c, apply, armed, fire } = collector();
    c.offer('prelude', 'p1');
    expect([...armed.values()].map((t) => t.ms)).toEqual([50]);
    c.offer('quad', 'q1');
    expect(armed.size).toBe(1);
    expect(apply).not.toHaveBeenCalled();

    fire();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith([{ name: 'prelude', code: 'p1' }, { name: 'quad', code: 'q1' }]);
  });

  it('keeps the last text per name', () => {
    const { c, apply, fire } = collector();
    c.offer('quad', 'q1');
    c.offer('quad', 'q2');
    fire();
    expect(apply).toHaveBeenCalledWith([{ name: 'quad', code: 'q2' }]);
  });

  it('never lets an empty save replace a candidate waiting in the window', () => {
    const { c, apply, fire } = collector();
    c.offer('quad', 'q1');
    c.offer('quad', '');
    c.offer('quad', '  \n\t');
    fire();
    expect(apply).toHaveBeenCalledWith([{ name: 'quad', code: 'q1' }]);
  });

  it('an empty save before the content (the editor truncating) does not hold it back', () => {
    const { c, apply, fire } = collector();
    c.offer('quad', '');
    c.offer('quad', 'q1');
    fire();
    expect(apply).toHaveBeenCalledWith([{ name: 'quad', code: 'q1' }]);
  });

  it('a window of only empty saves sends nothing', () => {
    const { c, apply, armed, fire } = collector();
    c.offer('quad', '');
    c.offer('line', '');
    expect(armed.size).toBe(1);
    fire();
    expect(apply).not.toHaveBeenCalled();
  });

  it('a flush empties the window: the next offers form a new one', () => {
    const { c, apply, fire } = collector();
    c.offer('quad', 'q1');
    fire();
    c.offer('line', 'l1');
    fire();
    expect(apply.mock.calls).toEqual([
      [[{ name: 'quad', code: 'q1' }]],
      [[{ name: 'line', code: 'l1' }]],
    ]);
  });

  it('flushNow sends at once and cancels the timer', () => {
    const { c, apply, armed } = collector();
    c.offer('quad', 'q1');
    c.flushNow();
    expect(apply).toHaveBeenCalledWith([{ name: 'quad', code: 'q1' }]);
    expect(armed.size).toBe(0);
  });

  it('waits the delay it is given', () => {
    const { c, armed } = collector(120);
    c.offer('quad', 'q1');
    expect([...armed.values()].map((t) => t.ms)).toEqual([120]);
  });

  it('logs an apply that rejects instead of leaving the rejection unhandled', async () => {
    const t = manualTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('boom');
    const c = new PieceReloadCollector(() => Promise.reject(boom), 50, t.timers);
    c.offer('quad', 'q1');
    t.fire();
    await new Promise((r) => setTimeout(r, 0));
    expect(error).toHaveBeenCalledWith('[Hyperion] Piece hot-reload failed:', boom);
    error.mockRestore();
  });

  it('logs an apply that throws synchronously', async () => {
    const t = manualTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('boom');
    const c = new PieceReloadCollector(() => { throw boom; }, 50, t.timers);
    c.offer('quad', 'q1');
    expect(() => t.fire()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(error).toHaveBeenCalledWith('[Hyperion] Piece hot-reload failed:', boom);
    error.mockRestore();
  });

  it('uses setTimeout when no timers are given', () => {
    vi.useFakeTimers();
    try {
      const apply = vi.fn((_entries: Entries) => Promise.resolve());
      const c = new PieceReloadCollector(apply);
      c.offer('quad', 'q1');
      vi.advanceTimersByTime(49);
      expect(apply).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(apply).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('assertPiecesNotEmpty — the guard on the RAW pieces', () => {
  const full = (): PrimitivePieces => ({
    prelude: '// prelude',
    libraries: Object.fromEntries(PRIMITIVE_LIBRARIES.map((lib) => [lib.type, `// ${lib.name}`])),
  });

  it('passes when every piece has text', () => {
    expect(() => assertPiecesNotEmpty(full())).not.toThrow();
  });

  it.each(['', '  \n\t'])('names an empty prelude (%j)', (text) => {
    expect(() => assertPiecesNotEmpty({ ...full(), prelude: text })).toThrow('Shader piece "prelude" is empty');
  });

  it.each(PRIMITIVE_LIBRARIES.map((lib) => [lib.name, lib.type] as const))('names an empty library: %s', (name, type) => {
    const pieces = full();
    pieces.libraries[type] = ' ';
    expect(() => assertPiecesNotEmpty(pieces)).toThrow(`Shader piece "${name}" is empty`);
  });
});

// Vite's hot.accept(dep) works only in the module that imports dep, so the
// wiring lives in renderer.ts and is checked on its text.
describe('renderer.ts — every primitive piece reaches the collector', () => {
  const renderer = readFileSync(new URL('../renderer.ts', import.meta.url), 'utf8');
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const PIECES = ['prelude', ...PRIMITIVE_LIBRARIES.map((lib) => lib.name)];

  it.each(PIECES)('%s: imported ?raw, accepted, and offered under its slot name', (piece) => {
    const path = `./shaders/primitives/${piece}.wgsl?raw`;
    expect(renderer).toContain(`from '${path}';`);
    expect(renderer).toMatch(new RegExp(
      String.raw`import\.meta\.hot\.accept\('${escape(path)}', \(mod\) => \{\s*if \(mod\) pieceReloads\.offer\('${piece}', mod\.default\);\s*\}\);`,
    ));
  });

  it('no piece accept bypasses the collector', () => {
    expect(renderer).not.toMatch(/accept\('\.\/shaders\/primitives\/[\w-]+\.wgsl\?raw',[^;]*recompileShader/);
  });

  it('the collector feeds GraphRequests.reloadShaders', () => {
    expect(renderer).toContain('new PieceReloadCollector((entries) => requests.reloadShaders(entries))');
  });

  it('the piece probe guards the RAW pieces, before compiling', () => {
    expect(renderer).toMatch(/assertPiecesNotEmpty\(primitivePieces\);\s*compilePrimitives\(\);/);
  });

  it("'basic' is an alias of the 'quad' slot, not a slot of its own", () => {
    expect(renderer).toContain("requests.reloadShader(passName === 'basic' ? 'quad' : passName, shaderCode)");
    expect(renderer).not.toMatch(/^\s+basic: /m);
  });
});
