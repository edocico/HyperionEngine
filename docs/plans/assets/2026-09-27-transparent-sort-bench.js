async () => {
  // Phase 5b benchmark scenario (spec §7.3.6): the body of ONE chrome-devtools
  // `evaluate_script` call. Format /1 ran unchanged at steps 0, 1, 3 and 4 on the
  // AMD iGPU (marker profiler); /2 needs the timestampWrites profiler (2026-09-29).
  //
  // Page: the dev harness with ?bench (no section: an otherwise empty world),
  // http://localhost:5173/?mode=B&bench, on a hardware adapter (no adapter
  // initScript on the Mac; format /1 ran on the AMD low-power adapter).
  // A run lasts minutes and a Vite reload kills it: on the Mac navigate with the
  // anti-reload WebSocket initScript (M6 in
  // docs/plans/assets/2026-09-29-mac-m2/README.md; the script text is in
  // docs/plans/2026-09-29-gpu-profiler-timestamp-writes-plan.md, Task 8).
  // Scene: N = 1 000, 10 000 and 100 000 (= CAP, 98 full tiles) 2D quads,
  // .transparent(), 16x16 px, all inside the view of a 1920x1080 target;
  // depth all 0 ('same') or all distinct in [0, 999], in shuffled order
  // ('distinct'). Positions come from a seeded PRNG: every step draws the
  // same scene. Lighting off.
  // Measure: GPU profiler on, the 120-frame rolling mean (averageMs) of every
  // pass, in frames without any readback (nothing here probes). "sort" = the
  // sum of transparent-sort/{gather,upsweep,scan,scatter}: null until step 3.
  // `total` is the GPU frame span (engine.getGpuFrameTiming(): first pass
  // beginning to last pass end). With the marker profiler of steps 0-4 the sum
  // of every pass telescoped to that same span, so `total` stays comparable
  // across machines. `passSum` is the sum of every pass: since 2026-09-29
  // (timestampWrites) each entry is the duration of the passes that carry its
  // name (the sort's upsweep/scan/scatter entries sum 7 passes each), and
  // passSum − total is the overlap minus the gaps between passes, so passSum
  // can exceed total on a GPU that overlaps passes (the Apple M2). With the
  // markers, part of a render pass's fragment work could land in the NEXT
  // bracket (a trial at 100 000 on the AMD iGPU read forward 0.28 ms,
  // fxaa-tonemap 6.9 ms); with pairs it stays in `forward`. Compare `total`
  // between steps and machines.
  // `total` is null if no frame span was read.
  // The `frameTiming` read stays right under the `passes` read, before the
  // `await gpuCount()` in the results literal, so both cover the same frames.
  // Each batch is destroyed, and gone from the GPU rows, before the next one.
  // No 'forward' sample after NO_SAMPLE_FRAMES frames of a case ends the run
  // with an error instead of waiting out TIMEOUT_MS. The guard only aborts: it
  // reads the value the wait already reads, so a run that finishes is measured
  // exactly as before.
  //
  // Optional, set by an earlier evaluate_script:
  //   window.__benchOpts = { label: 'step0 <sha>', sizes: [100000], zModes: ['same'] }
  // Results accumulate in window.__benchResults; every call returns all of
  // them, so a long run can be split into several calls on the same page.
  const WIDTH = 1920;
  const HEIGHT = 1080;
  const QUAD_PX = 16;
  const WINDOW = 120;
  const TIMEOUT_MS = 180000;
  const NO_SAMPLE_FRAMES = 300;
  const STAGES = ['gather', 'upsweep', 'scan', 'scatter'];

  const engine = window.__hyperion;
  if (!engine) throw new Error('window.__hyperion is missing: open the dev harness');
  if (!new URLSearchParams(location.search).has('bench')) {
    throw new Error('run the benchmark on a ?bench page: a harness tab adds entities, and a swapchain probe reconfigures the canvas');
  }
  if (!engine.gpuProfilingSupported) throw new Error('no timestamp-query on this device: no GPU timings');
  if (typeof engine.getGpuFrameTiming !== 'function') {
    throw new Error('engine.getGpuFrameTiming() is missing: this build has the marker profiler, apply the timestampWrites profiler first, or, if it was applied, restart the dev server and reload the page (Vite can serve a stale module)');
  }
  const opts = window.__benchOpts ?? {};
  const sizes = opts.sizes ?? [1000, 10000, 100000];
  const zModes = opts.zModes ?? ['same', 'distinct'];
  const results = (window.__benchResults = window.__benchResults ?? []);

  const frames = (n) => new Promise((resolve) => {
    const step = (left) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(n);
  });
  // Entities on the GPU rows of the current frame (SystemViews of frameEnd).
  const gpuCount = () => new Promise((resolve) => {
    const hook = (_dt, views) => {
      engine.removeHook('frameEnd', hook);
      resolve(views ? views.entityCount : 0);
    };
    engine.addHook('frameEnd', hook);
  });
  const until = async (what, predicate) => {
    const start = performance.now();
    while (!(await predicate())) {
      if (performance.now() - start > TIMEOUT_MS) throw new Error(`timed out after ${TIMEOUT_MS} ms waiting for ${what}`);
      await frames(1);
    }
  };
  const settledAt = (n) => until(`${n} entities on the GPU`, async () => engine.stats.overflowCount === 0 && (await gpuCount()) === n);
  // mulberry32: the same scene at every step.
  const prng = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  let adapter = null;
  try {
    const a = await navigator.gpu?.requestAdapter();
    adapter = a ? { vendor: a.info?.vendor ?? '', architecture: a.info?.architecture ?? '', description: a.info?.description ?? '' } : null;
  } catch {
    adapter = null;
  }

  engine.lighting.setBackend('off');
  engine.resize(WIDTH, HEIGHT);
  engine.cam.position(0, 0, 0);
  engine.cam.zoom(1);
  await settledAt(0);
  await frames(4);
  const vp = engine.cam.viewProjection;
  const halfW = 1 / vp[0];
  const halfH = 1 / vp[5];
  const size = (QUAD_PX * 2 * halfW) / WIDTH;
  const spanX = halfW - size / 2;
  const spanY = halfH - size / 2;

  for (const n of sizes) {
    for (const zMode of zModes) {
      const rand = prng(n * 2 + (zMode === 'distinct' ? 1 : 0));
      const depths = new Float64Array(n);
      if (zMode === 'distinct') {
        const order = Array.from({ length: n }, (_, i) => i);
        for (let i = n - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
        for (let i = 0; i < n; i++) depths[i] = n === 1 ? 0 : (order[i] * 999) / (n - 1);
      }
      const handles = [];
      engine.batch(() => {
        for (let i = 0; i < n; i++) {
          const h = engine.spawn({ mode: '2d' })
            .position((rand() * 2 - 1) * spanX, (rand() * 2 - 1) * spanY)
            .scale(size, size)
            .transparent();
          if (zMode === 'distinct') h.depth(depths[i]);
          handles.push(h);
        }
      });
      await settledAt(n);
      await frames(8);
      if (!engine.enableGpuProfiling()) throw new Error('enableGpuProfiling() returned false');
      const forwardSamples = () => engine.getGpuTimings().find((t) => t.name === 'forward')?.sampleCount ?? 0;
      // `until` calls the predicate once, then once per frame: `noSample` counts
      // the frames without any sample. Same single read of forwardSamples() and
      // same result as before, except that it can throw.
      let noSample = 0;
      await until(`the ${WINDOW}-frame window`, async () => {
        const got = forwardSamples();
        if (got >= WINDOW) return true;
        if (got === 0 && noSample++ >= NO_SAMPLE_FRAMES) {
          throw new Error(`no GPU timing sample for 'forward' after ${NO_SAMPLE_FRAMES} frames (N=${n}, ${zMode}): the profiler kept none (it warns in the console when it discards frames in a row, naming the reason), or the engine is not rendering. The quads stay spawned and the profiler stays on: reload the page before running again`);
        }
        return false;
      });
      const passes = Object.fromEntries(engine.getGpuTimings().map((t) => [t.name, t.averageMs]));
      const frameTiming = engine.getGpuFrameTiming();
      const stages = Object.fromEntries(STAGES.map((s) => [s, passes[`transparent-sort/${s}`] ?? null]));
      const sort = STAGES.every((s) => stages[s] !== null) ? STAGES.reduce((sum, s) => sum + stages[s], 0) : null;
      results.push({
        N: n,
        zMode,
        gpuEntityCount: await gpuCount(),
        samples: forwardSamples(),
        stages,
        sort,
        forward: passes.forward,
        total: frameTiming?.averageMs ?? null,
        passSum: Object.values(passes).reduce((sum, ms) => sum + ms, 0),
        passes,
        fps: engine.stats.fps,
      });
      engine.disableGpuProfiling();
      for (const h of handles) h.destroy();
      await settledAt(0);
      await frames(4);
    }
  }

  return {
    format: 'hyperion-5b-bench/2',
    label: opts.label ?? null,
    mode: engine.mode,
    search: location.search,
    canvas: [document.getElementById('canvas').width, document.getElementById('canvas').height],
    dpr: window.devicePixelRatio,
    adapter,
    quadPx: QUAD_PX,
    window: WINDOW,
    results,
  };
}
