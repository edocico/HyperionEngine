/**
 * HMR-aware system state helper for Vite hot module replacement.
 *
 * In dev mode (`import.meta.hot` defined), state is saved to `hot.data[name]`
 * on dispose and restored on reload.  Schema evolution is handled via
 * `{ ...initialState(), ...savedState }` — new fields get defaults, removed
 * fields are silently dropped.
 *
 * In production (`hot` is `undefined`), the function returns a plain system
 * with no HMR wiring.
 */

export interface HotSystemConfig<S> {
  initialState: () => S;
  preTick: (state: S, dt: number) => void;
}

interface ViteHotModule {
  data: Record<string, unknown>;
  dispose: (fn: () => void) => void;
}

export function createHotSystem<S extends Record<string, unknown>>(
  name: string,
  hot: ViteHotModule | undefined,
  config: HotSystemConfig<S>,
): { state: S; system: (dt: number) => void } {
  const fresh = config.initialState();

  let state: S;
  if (hot?.data[name]) {
    // Merge saved state over fresh defaults for schema evolution:
    // new fields get their initial values, persisted fields keep theirs.
    state = { ...fresh, ...(hot.data[name] as Partial<S>) };
  } else {
    state = fresh;
  }

  if (hot) {
    hot.dispose(() => {
      hot.data[name] = { ...state };
    });
  }

  const system = (dt: number) => {
    config.preTick(state, dt);
  };

  return { state, system };
}
