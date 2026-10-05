async () => {
  // Round 2026-09-27, step 6 (directional shadows): the committed bench of
  // docs/plans/2026-09-30-step6-directional-shadows-plan.md, Task 6. The body
  // of ONE chrome-devtools `evaluate_script` call per task, like
  // docs/plans/assets/2026-09-27-transparent-sort-bench.js. Its output goes
  // through docs/plans/assets/2026-09-30-step6/step6-stats.mjs
  // (`node step6-stats.mjs <cost|penumbra|regress|edgepop> <file.json>`).
  //
  // Page: the dev harness with ?bench (no section: an otherwise empty world),
  // "http://localhost:5173/?mode=B&bench" (?mode=C&bench works for every task
  // but `cost`; ?mode=A&bench for `scene` only), on chrome-devtools-gpu, the
  // server whose timestamps are not quantized, navigated with ignoreCache and
  // the anti-reload initScript of .claude/skills/gpu-check/SKILL.md §3: a run
  // lasts minutes, and a Vite reload kills it. Restart the dev server after a
  // checkout that rewrote a shader.
  //
  // Configured by an earlier evaluate_script:
  //   window.__benchOpts = { task: '<task>', label: '<short sha>', ...options }
  // Results accumulate in window.__benchResults, and every call returns all of
  // them: { format, task, label, mode, search, canvas, dpr, adapter, chrome,
  // results }, `chrome` being navigator.userAgentData's fullVersionList. Each
  // result carries its `task` and `label`.
  //
  // Every task first destroys the entities of the previous one
  // (window.__step6Entities), and leaves its own alive for a screenshot.
  // Every task draws at 1920x1080 (engine.resize, checked with a probe of
  // scene-hdr, never of the swapchain: a swapchain probe reconfigures the
  // canvas, and the GPU timings with it) with the camera at (0, 0), zoom 1:
  // the view is x in [-17.78, 17.78], y in [-10, 10]. Only `scene` with
  // `resize: false` keeps the page's canvas, and skips the check. The light
  // buffer is read with engine.debug.probe, layer 0 (the one light group of
  // every scene here). The ambient is the Lighting tab's, [0.06, 0.07, 0.12];
  // the sun is [1, 0.95, 0.85] at energy 1.
  //
  // Tasks:
  // - scene { sunRotation = 0, pointShadow = 1, sunShadow = 1, resize = true }:
  //   the static, deterministic scene of the cost and of the screenshots. A
  //   floor (0, 0, -0.5) 40x24 receiving light; casters: walls (-12, -1) 0.6x5,
  //   (-2, -4) 0.6x4 and (9, 5) 0.6x4, platforms parallel to the rays (-4, 6.5)
  //   10x0.5 and (6, -6.5) 12x0.5, boxes (-8, -6) and (13, -1) 1.5x1.5; a point
  //   light (-13, -3) '#ffd9a0', energy 1.2, range 5, shadow pointShadow; the
  //   sun at rotation(sunRotation), range 100, shadow sunShadow; shadowSteps 48.
  //   Returns the ids, the groups [light groups, SDF sets] and `probePoints`:
  //   per wall, the points 3 units past its downwind and its upwind face along
  //   the sun, for .claude/skills/gpu-check/scripts/pixels.py. Runs in Mode A
  //   too, with resize: false (no probe there).
  // - regress: point and spot lights unchanged by step 6. Needs
  //   window.__step6OldLightAccum, the shader of 2f43e42 as a string, set by an
  //   earlier evaluate_script that pastes the output of
  //   `git show 2f43e42:ts/src/shaders/light-accum.wgsl | jq -Rs .`. A scene
  //   without a sun: the floor, walls (-6, 2) 0.8x5 and (5, -3) 6x0.8, a box
  //   (10, 5) 1.5x1.5; a point (-9, 0) range 12 falloff 1.2, a spot (12, -6)
  //   rotation(2.3) range 18 inner 18 outer 30, and a point whose centre is off
  //   screen, (-21, 4) range 8, all with shadow 1 (sub-decision 3 (a): it marches
  //   as before). Reads the light buffer on a 64x36 UV grid of cell centres
  //   (2304 points) with HEAD's shader, then with the old one (hot-reloaded:
  //   recompileShader, then wait for LightAccumStage.SHADER_SOURCE and a new
  //   graph, then 4 frames), then puts HEAD's back the same way and checks it.
  //   The old shader runs on the new layout: binding 5 visible to more stages
  //   does not invalidate a shader that uses it in the fragment stage only.
  // - penumbra: the A/B of the sun's penumbra angle. The scene: the floor, a
  //   wall (-12, -4) 0.6x6, a platform (0, 5) 24x0.5 parallel to the rays, the
  //   sun at rotation(0), range `range` (default 100), the only shadowed light,
  //   so its rays run to the SDF's exit. One of:
  //   { angle }: light-accum.wgsl with sunShadow's u.sourceFraction replaced by
  //     the literal `angle` (exactly one occurrence, ANGLE_LINE below); at
  //     shadowSteps 48 and `refSteps` (default 1024) reads, in one probe each,
  //     the wall's profiles across the upper edge of its shadow band (y = -1)
  //     at d = 2, 12 and 26 past its face, 41 points for y in [-2, 0], with the
  //     platform's profiles above its top face at D = 2, 6, 9.5, 16 and 22 from
  //     its upwind end, 25 heights from 0.02 to 0.98; then the same platform
  //     profiles with the sun at -20 degrees (the diagonal). Leaves 48 steps
  //     and the patched shader live for the screenshot.
  //   { convergence: true }: the same profiles at `refSteps` and `convSteps`
  //     (default 2048), HEAD's shader (0.02 rad) unless `angle` is given.
  //   { grid: true }: the `scene` scene, point shadow 0 (so only the sun
  //     depends on the budget) and sun shadow 1; for rotation(0),
  //     rotation(-PI/2) and rotation(-PI/6), the whole light buffer on a
  //     128x72 UV grid of cell centres (9216 points, one probe) at shadowSteps
  //     48, 96, 192, `refSteps` and `convSteps`; HEAD's shader unless `angle`
  //     is given. The grids are float32 RGBA in base64 (step6-stats.mjs
  //     decodeGrid).
  //   { fadeStart, range: 12 }: SUN_FADE_START replaced by the float literal
  //     `fadeStart` (FADE_LINE below), for the screenshot of the fade; no read.
  //   { restore: true }: HEAD's shader and 48 steps back, checked.
  // - edgepop { ranges = [100, 30, 10] }: the pop of a caster entering from the
  //   sun's side, for step 8c. Check 3 of the Lighting tab around the origin:
  //   W_out (xL - 0.55, 3) wholly off screen and W_in (xL + 0.2, 8), both
  //   0.6x2; rows y = 3 (along W_out), 8 (along W_in) and 5.5 (no caster) at
  //   xL + d for d from 0.5 to W - 0.5 in steps of 0.5, and E (xL + 1, 6.6).
  //   The sun at rotation(0); for each range (sent again with light(), then
  //   wait for it), one probe. Returns the raw rows, W, the zoom, the canvas
  //   and the light buffer's size.
  // - cost { pairs: [<pair>], blocks, n, quadPx, environment }: Mode B, GPU
  //   frame spans (getGpuFrameTiming) of ABBA blocks [ON, OFF, OFF, ON], 8
  //   blocks by default (4 for pointspot). Pairs:
  //   march: `scene`, ON point 1 sun 1, OFF point 1 sun 0 (the SDF set stays:
  //     the sun's march alone);
  //   set: `scene`, ON point 0 sun 1, OFF point 0 sun 0 (the sun's set too);
  //   pointspot (outside the criterion): the regress scene without the
  //     off-screen point, ON HEAD's light-accum.wgsl, OFF 2f43e42's (needs
  //     window.__step6OldLightAccum): what the new terms of the shared march
  //     cost point and spot lights;
  //   uber (outside the criterion; design 5b §11, the Chrome leg of the A/B
  //     without code): the 5b bench's scene, `n` (10000) 2D .transparent()
  //     quads of `quadPx` (16) pixels, positions from its seeded PRNG, depth
  //     0, lighting off; ON the committed libraries, OFF the five libraries
  //     other than the quad replaced by stubs (engine.recompileShader); the
  //     uber module with the stubs must compile without a message first.
  //   Per window: the life signal (every frame, up to 60), 30 frames, the
  //   profiler restarted, then rAF until getGpuFrameTiming().sampleCount
  //   reaches 120 (20 s at most), everything read in that same synchronous
  //   turn. A window is valid with 120 samples, no new discarded frame, fps
  //   at least 0.95 x the cadence measured over 60 frames at the start of the
  //   task, a 1920x1080 canvas, and the condition and the graph unchanged. A
  //   block with an invalid window is redone at the end of the queue (its
  //   windows stay in the JSON, with their reasons), at most 4 times per pair.
  //   Spans quantized to 65 536 ns stop the run after the first window.
  //   `environment` (pmset, browser, sampler: filled in by whoever runs it)
  //   goes into the result as it is.
  //
  // Shared options: refSteps (1024) and convSteps (2048), the A/B's reference
  // budget and its check; if they differ by more than 0.01 sun, run again with
  // refSteps: 4096 (the plan's rule).
  //
  // Every budget here is a LightingQuality.shadowSteps value. HEAD's
  // light-accum.wgsl marches a sun 4x it (sunShadow, sub-decision 2 (b)), so
  // shadowSteps 48 is the sun's 192 steps; the angle A/B and the grid of
  // 795b066 (docs/plans/assets/2026-09-30-step6/penumbra-ab-m2.json) were read
  // with the shader of before that rule, where a sun marched shadowSteps.
  // Every penumbra result records the multiplier of the shader it was read
  // with, `sunStepMultiplier` (sunStepMultiplier below): step6-stats reports
  // the sun's steps (budget x multiplier) and judges sub-decision 2 only on a
  // grid read at x1.
  //
  // A wait on the engine (a frame, a frameEnd hook, a probe) gives up after
  // WAIT_MS (20 s) with 'timed out … waiting for …' instead of hanging when
  // the engine loop stops. A cleanup in a `finally` (HEAD's shader, the
  // committed libraries, the profiler) that fails is logged with
  // console.error and, where the task has a result, recorded in its
  // `cleanupErrors`: it never replaces the error in flight, and without one it
  // still fails the run.
  const FORMAT = 'hyperion-step6-bench/1';
  const TASKS = ['scene', 'regress', 'penumbra', 'edgepop', 'cost'];
  const PAIRS = ['march', 'set', 'pointspot', 'uber'];
  const WIDTH = 1920;
  const HEIGHT = 1080;
  const AMBIENT = [0.06, 0.07, 0.12];
  const SUN_COLOR = [1, 0.95, 0.85];
  /** LightingQuality.shadowSteps' default: the budget that ships. */
  const STEPS = 48;
  /**
   * The grid's shadowSteps below the reference. 192 was the sun's x4 budget of
   * sub-decision 2 (b) while a sun marched shadowSteps; with HEAD's shader, 48 is.
   */
  const GRID_BUDGETS = [48, 96, 192];
  const WAIT_MS = 20000;
  const LIFE_FRAMES = 60;
  const SETTLE_FRAMES = 30;
  const WINDOW = 120;
  const MAX_REDOS = 4;
  /** Chrome rounds timestamps to 65 536 ns without --enable-webgpu-developer-features. */
  const QUANTUM_MS = 0.065536;
  // The texts the A/B patches in light-accum.wgsl, each exactly once:
  // sunShadow's last line (the angle) and the fade constant. A commit that
  // changes either line in the shader changes it here too.
  const ANGLE_LINE = 'return shadow(origin, ray.xy, travel, u.sourceFraction, ray.z, 4u * u.shadowSteps);';
  const FADE_LINE = 'const SUN_FADE_START: f32 = 0.75;';
  const STUB_MARK = '// step6-uber-stub';
  /** Casters as [x, y, width, height]. */
  const SCENE_WALLS = [[-12, -1, 0.6, 5], [-2, -4, 0.6, 4], [9, 5, 0.6, 4]];
  const SCENE_PLATFORMS = [[-4, 6.5, 10, 0.5], [6, -6.5, 12, 0.5]];
  const SCENE_BOXES = [[-8, -6, 1.5, 1.5], [13, -1, 1.5, 1.5]];
  const REGRESS_CASTERS = [[-6, 2, 0.8, 5], [5, -3, 6, 0.8], [10, 5, 1.5, 1.5]];
  const PENUMBRA_WALL = [-12, -4, 0.6, 6];
  const PENUMBRA_PLATFORM = [0, 5, 24, 0.5];
  /** The wall's far face (the sun at rotation(0) shines to +x), the platform's top face and upwind end. */
  const WALL_FACE = -12 + 0.3;
  const PLATFORM_TOP = 5 + 0.25;
  const PLATFORM_UPWIND = -12;
  const DIAGONAL = (-20 * Math.PI) / 180;
  const GRID_SUNS = [['rotation(0)', 0], ['rotation(-PI/2)', -Math.PI / 2], ['rotation(-PI/6)', -Math.PI / 6]];
  /** The live condition of each cost pair, ON and OFF. */
  const CONDITIONS = {
    march: { on: { point: 1, sun: 1, sdfSets: 1 }, off: { point: 1, sun: 0, sdfSets: 1 } },
    set: { on: { point: 0, sun: 1, sdfSets: 1 }, off: { point: 0, sun: 0, sdfSets: 0 } },
    pointspot: { on: { accum: 'HEAD', sdfSets: 1 }, off: { accum: '2f43e42', sdfSets: 1 } },
    uber: { on: { stubs: 0 }, off: { stubs: 5 } },
  };
  const ORDER = ['on', 'off', 'off', 'on'];

  // ── Guards ─────────────────────────────────────────────────────────────
  const engine = window.__hyperion;
  if (!engine) throw new Error('window.__hyperion is missing: open the dev harness (a dev build)');
  if (!new URLSearchParams(location.search).has('bench')) {
    throw new Error('run the bench on a ?bench page: a harness tab adds entities, and its checks probe');
  }
  const opts = window.__benchOpts ?? {};
  const task = opts.task;
  if (!TASKS.includes(task)) throw new Error(`window.__benchOpts.task must be one of ${TASKS.join(', ')}, got ${JSON.stringify(task)}`);
  if (['regress', 'penumbra', 'edgepop'].includes(task)) {
    if (engine.mode !== 'B' && engine.mode !== 'C') throw new Error(`'${task}' reads the light buffer with the probe: Mode B or C, not ${engine.mode}`);
  }
  if (task === 'cost') {
    if (engine.mode !== 'B') throw new Error(`'cost' runs in Mode B (the M9 conditions), not ${engine.mode}`);
    if (!engine.gpuProfilingSupported) throw new Error('no timestamp-query on this device: no GPU timings');
    if (typeof engine.getGpuFrameTiming !== 'function') {
      throw new Error('engine.getGpuFrameTiming() is missing: restart the dev server and reload the page (Vite can serve a stale module)');
    }
  }
  // Every task but `scene` with resize: false checks the size with a probe.
  if (!(task === 'scene' && opts.resize === false) && typeof engine.debug?.probe !== 'function') {
    throw new Error('engine.debug.probe is missing: a dev build is needed');
  }
  const label = opts.label ?? null;
  const finite = (x, what) => {
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`${what} must be a finite number, got ${JSON.stringify(x)}`);
    return x;
  };
  const count = (x, what) => {
    if (!Number.isInteger(x) || x < 1) throw new Error(`${what} must be a whole number >= 1, got ${JSON.stringify(x)}`);
    return x;
  };
  const REF_STEPS = count(opts.refSteps ?? 1024, 'refSteps');
  const CONV_STEPS = count(opts.convSteps ?? 2048, 'convSteps');
  const results = (window.__benchResults = window.__benchResults ?? []);
  const renderer = engine.renderer; // null in Mode A: the render worker draws
  const canvas = document.getElementById('canvas');

  // ── Helpers ────────────────────────────────────────────────────────────
  const frames = (n) => new Promise((resolve) => {
    const step = (left) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(n);
  });
  /**
   * `promise`, or the error 'timed out after `timeoutMs` ms waiting for
   * `what`' once `deadline` (a performance.now() time) passes. An engine whose
   * loop stopped never runs a frameEnd hook nor serves a probe: unraced, the
   * run would hang instead of failing (the harness's pixelCheck times its
   * probes out for the same reason).
   */
  const byDeadline = (promise, deadline, timeoutMs, what) => {
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)),
        Math.max(0, deadline - performance.now()));
    });
    return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
  };
  const until = async (what, predicate, timeoutMs = WAIT_MS) => {
    const deadline = performance.now() + timeoutMs;
    while (!(await byDeadline(Promise.resolve(predicate()), deadline, timeoutMs, what))) {
      if (performance.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
      await byDeadline(frames(1), deadline, timeoutMs, what);
    }
  };
  /**
   * The cleanup of a `finally` block. A failure is logged with console.error
   * and recorded in `into.cleanupErrors` (`into` null: logged only), never
   * thrown: thrown from a finally, it would replace the error in flight (a
   * mandated stop, a timeout). Without an error in flight, the caller throws
   * on `into.cleanupErrors` once past the finally.
   */
  const cleanUp = async (into, what, step) => {
    try {
      await step();
    } catch (err) {
      const message = `${what} failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`step6 bench: ${message}`);
      if (into) (into.cleanupErrors ??= []).push(message);
    }
  };
  // Entities on the GPU rows of the current frame (SystemViews of frameEnd).
  const gpuCount = () => new Promise((resolve) => {
    const hook = (_dt, views) => {
      engine.removeHook('frameEnd', hook);
      resolve(views ? views.entityCount : 0);
    };
    engine.addHook('frameEnd', hook);
  });
  const settledAt = (n) => until(
    `${n} entities on the GPU rows (the bench wants a world of its own entities only: reload the page if something else is in it)`,
    async () => engine.stats.overflowCount === 0 && (await gpuCount()) === n,
  );
  /** The slot of `handle` in the latest render state, or -1. */
  const slotOf = (handle) => {
    const ids = engine.bridge.latestRenderState?.entityIds;
    return ids ? ids.indexOf(handle.id) : -1;
  };
  /** Waits until the latest render state's row of `handle` passes `test(state, slot)`. */
  const untilRow = (what, handle, test) => until(what, () => {
    const slot = slotOf(handle);
    return slot >= 0 && test(engine.bridge.latestRenderState, slot);
  });
  /** A light's axis is column 0 of its world matrix: (cos, sin) at scale 1. */
  const untilRotation = (handle, angle) => untilRow(`rotation ${angle.toFixed(4)} of entity ${handle.id} in the render state`, handle,
    (rs, s) => Math.abs(rs.transforms[16 * s] - Math.cos(angle)) < 1e-5 && Math.abs(rs.transforms[16 * s + 1] - Math.sin(angle)) < 1e-5);
  const untilParam = (handle, k, value) => untilRow(`primParams[${k}] = ${value} of entity ${handle.id} in the render state`, handle,
    (rs, s) => rs.primParams[8 * s + k] === Math.fround(value));
  /** shadowIntensity (primParams slot 7) of `handle` in the latest render state, or null. */
  const slot7 = (handle) => {
    const slot = slotOf(handle);
    return slot < 0 ? null : engine.bridge.latestRenderState.primParams[8 * slot + 7];
  };
  const untilAmbient = () => until('the ambient light in the render state', () => {
    const [r, g, b, intensity] = engine.lighting.ambient;
    return r === Math.fround(AMBIENT[0]) && g === Math.fround(AMBIENT[1]) && b === Math.fround(AMBIENT[2]) && intensity === 1;
  });
  const groupsNow = () => {
    const g = engine.lighting.groups;
    return g ? [g.groups.length, g.sdfSets.length] : null;
  };
  const litLive = () => renderer.graph.executionOrder.includes('light-groups');
  const setBackend = async (lit) => {
    engine.lighting.setBackend(lit ? 'lit' : 'off');
    if (renderer) await until(`the ${lit ? 'lit' : 'unlit'} render graph to go live`, () => litLive() === lit);
  };
  const setSteps = async (steps) => {
    engine.lighting.setQuality({ shadowSteps: steps });
    await until(`shadowSteps ${steps} handed to the renderer`, () => engine.lighting._needsRebuild === false);
    await frames(4);
  };
  const uvGrid = (gx, gy) => {
    const uv = [];
    for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) uv.push([(i + 0.5) / gx, (j + 0.5) / gy]);
    return uv;
  };
  /** The light buffer, layer 0, at the next rendered frame. */
  const readLight = async (request) => {
    const what = 'a light-buffer probe (only a rendered frame serves one: did the engine loop stop?)';
    const deadline = performance.now() + WAIT_MS;
    // The lit graph goes live a frame or two after setBackend('lit'), once the GPU validated it.
    for (let tries = 0; ; tries++) {
      try {
        return await byDeadline(engine.debug.probe({ target: 'light-buffer', layer: 0, ...request }), deadline, WAIT_MS, what);
      } catch (err) {
        if (tries >= 30 || !/not in the live render graph/.test(String(err))) throw err;
        await byDeadline(frames(2), deadline, WAIT_MS, what);
      }
    }
  };
  /** A grid's RGBA values as float32 in base64: a 9216-point grid is 197 KB, not 550. */
  const encodeGrid = (values) => {
    const f = new Float32Array(values.length * 4);
    values.forEach((v, i) => f.set(v, 4 * i));
    const bytes = new Uint8Array(f.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { encoding: 'f32-rgba-base64', count: values.length, data: btoa(binary) };
  };
  /** FNV-1a 32 of a text, to name the shader a result was read with. */
  const fnv1a = (text) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(16).padStart(8, '0');
  };
  // mulberry32: the PRNG of the 5b bench, for its scene.
  const prng = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // ── The light-accum shader: HEAD's, 2f43e42's, patched ─────────────────
  const accum = renderer ? (await import('/src/render/passes/light-accum-stage.ts')).LightAccumStage : null;
  const HEAD_ACCUM = renderer ? (await import('/src/shaders/light-accum.wgsl?raw')).default : null;
  const oldAccum = () => {
    const old = window.__step6OldLightAccum;
    if (typeof old !== 'string' || old.length === 0) {
      throw new Error('window.__step6OldLightAccum is missing: set it first with an evaluate_script that pastes the output of `git show 2f43e42:ts/src/shaders/light-accum.wgsl | jq -Rs .`');
    }
    if (old === HEAD_ACCUM || old.includes('fn sunShadow')) throw new Error('window.__step6OldLightAccum is not the shader of 2f43e42: it has sunShadow (step 6)');
    return old;
  };
  const wgslFloat = (x) => {
    const s = String(finite(x, 'a WGSL literal'));
    return /[.eE]/.test(s) ? s : `${s}.0`;
  };
  const replaceOnce = (source, text, by) => {
    const parts = source.split(text);
    if (parts.length !== 2) {
      throw new Error(`light-accum.wgsl holds ${parts.length - 1} occurrences of \`${text}\`, want exactly 1: update the bench with the shader`);
    }
    return parts.join(by);
  };
  /**
   * The sun's step multiplier of `source`, a light-accum.wgsl: the N of
   * `Nu * u.shadowSteps` in sunShadow's `return shadow(…)`, 4 at HEAD
   * (sub-decision 2 (b)); 1 where it hands shadow() u.shadowSteps itself or
   * no step count (the text of before 7e7be7d, whose march read
   * u.shadowSteps). Recorded with every penumbra result as
   * `sunStepMultiplier`: step6-stats reads a grid's budgets as the sun's own
   * only at 1. Self-contained: step6-stats.test.mjs evaluates this definition.
   */
  const sunStepMultiplier = (source) => {
    const start = source.indexOf('fn sunShadow(');
    const call = start < 0 ? null : /return shadow\(([^;]*)\);/.exec(source.slice(start));
    if (!call) throw new Error('light-accum.wgsl has no `return shadow(…);` in fn sunShadow: update the bench with the shader');
    const args = call[1].split(',').map((a) => a.trim());
    if (args.length === 5) return 1;
    const steps = args.length === 6 ? /^(?:(\d+)u\s*\*\s*)?u\.shadowSteps$/.exec(args[5]) : null;
    if (!steps) throw new Error(`sunShadow hands shadow() \`${call[1]}\`: update the bench with the shader`);
    return steps[1] === undefined ? 1 : Number(steps[1]);
  };
  /** HEAD's light-accum.wgsl with the sun's angle and/or the fade's start replaced by literals. */
  const patchAccum = ({ angle, fadeStart }) => {
    let source = HEAD_ACCUM;
    if (angle !== undefined) source = replaceOnce(source, ANGLE_LINE, `return shadow(origin, ray.xy, travel, ${wgslFloat(angle)}, ray.z, 4u * u.shadowSteps);`);
    if (fadeStart !== undefined) source = replaceOnce(source, FADE_LINE, `const SUN_FADE_START: f32 = ${wgslFloat(fadeStart)};`);
    return source;
  };
  /**
   * Makes `source` the live light-accum shader: recompileShader, then wait
   * until LightAccumStage.SHADER_SOURCE (the app's module instance) is
   * `source` and a new graph is live, then 4 frames. A graph is rebuilt only
   * while the lit graph is requested: call it after setBackend(true), with no
   * other graph change pending. Returns whether it swapped.
   */
  const swapAccum = async (source, what) => {
    if (accum.SHADER_SOURCE === source) return false;
    if (!litLive()) throw new Error('internal: light-accum swapped without the lit graph, which would rebuild no graph');
    const before = renderer.graph;
    engine.recompileShader('light-accum', source);
    await until(`light-accum (${what}) to go live (a shader the GPU rejects keeps the previous source: see the console)`,
      () => accum.SHADER_SOURCE === source && renderer.graph !== before);
    await frames(4);
    return true;
  };

  // ── Entities and scenes ────────────────────────────────────────────────
  let entities = [];
  const clearEntities = async () => {
    for (const h of window.__step6Entities ?? []) h.destroy();
    entities = window.__step6Entities = [];
    if (engine.mode !== 'A') await settledAt(0);
  };
  const keep = (h) => {
    entities.push(h);
    return h;
  };
  const spawnCaster = ([x, y, w, h]) => keep(engine.spawn().position(x, y).scale(w, h).castsShadow(true));
  const spawnFloor = () => keep(engine.spawn().position(0, 0, -0.5).scale(40, 24).receivesLight(true));
  const sunLight = (shadow, range = 100) => ({ type: 'directional', color: SUN_COLOR, energy: 1, range, shadowIntensity: shadow });
  /** 1920x1080 (checked with a probe of scene-hdr), the camera at (0, 0), zoom 1. */
  const setView = async (resize = true) => {
    if (resize) engine.resize(WIDTH, HEIGHT);
    engine.cam.position(0, 0, 0);
    engine.cam.zoom(1);
    if (!resize) return null;
    const r = await byDeadline(engine.debug.probe({ target: 'scene-hdr', uv: [[0.5, 0.5]] }), performance.now() + WAIT_MS, WAIT_MS,
      'the scene-hdr probe of the view check (only a rendered frame serves one: did the engine loop stop?)');
    if (r.targetSize[0] !== WIDTH || r.targetSize[1] !== HEIGHT) {
      throw new Error(`scene-hdr is ${r.targetSize.join('x')}, want ${WIDTH}x${HEIGHT}: does the page resize the canvas behind engine.resize?`);
    }
    return r.targetSize;
  };
  /** Ambient, the lit backend and 48 steps; the scene's entities on the GPU; HEAD's shader (unless `shader`). */
  const lightUp = async (scene, shader = HEAD_ACCUM, what = 'HEAD') => {
    engine.lighting.setAmbient(AMBIENT, 1);
    engine.lighting.setQuality({ shadowSteps: STEPS });
    if (engine.mode === 'A') {
      await untilRow('the scene in the render state', scene.last, () => true);
    } else {
      await settledAt(entities.length);
    }
    await setBackend(true);
    if (renderer) await swapAccum(shader, what);
    await setSteps(STEPS);
    await untilAmbient();
  };
  const buildScene = ({ sunRotation, pointShadow, sunShadow }) => {
    const s = {};
    engine.batch(() => {
      s.floor = spawnFloor();
      s.walls = SCENE_WALLS.map(spawnCaster);
      s.platforms = SCENE_PLATFORMS.map(spawnCaster);
      s.boxes = SCENE_BOXES.map(spawnCaster);
      s.point = keep(engine.spawn().position(-13, -3)
        .light({ type: 'point', color: '#ffd9a0', energy: 1.2, range: 5, shadowIntensity: pointShadow }));
      s.sun = keep(engine.spawn().rotation(sunRotation).light(sunLight(sunShadow)));
    });
    s.last = s.sun;
    return s;
  };
  const REGRESS_LIGHTS = {
    point: { at: [-9, 0], light: { type: 'point', color: [1, 0.85, 0.6], energy: 1, range: 12, falloff: 1.2, shadowIntensity: 1 } },
    spot: { at: [12, -6], rotation: 2.3, light: { type: 'spot', color: [0.6, 0.8, 1], energy: 1, range: 18, innerAngle: 18, outerAngle: 30, shadowIntensity: 1 } },
    offscreen: { at: [-21, 4], light: { type: 'point', color: [0.9, 0.6, 1], energy: 1, range: 8, shadowIntensity: 1 } },
  };
  /** The regress scene; `offscreen`: with the point whose centre is off screen. */
  const buildRegress = (offscreen) => {
    const s = {};
    engine.batch(() => {
      s.floor = spawnFloor();
      s.casters = REGRESS_CASTERS.map(spawnCaster);
      for (const name of offscreen ? ['point', 'spot', 'offscreen'] : ['point', 'spot']) {
        const l = REGRESS_LIGHTS[name];
        const h = engine.spawn().position(...l.at);
        if (l.rotation !== undefined) h.rotation(l.rotation);
        s[name] = keep(h.light(l.light));
        s.last = s[name];
      }
    });
    return s;
  };
  const buildPenumbra = (range) => {
    const s = {};
    engine.batch(() => {
      s.floor = spawnFloor();
      s.wall = spawnCaster(PENUMBRA_WALL);
      s.platform = spawnCaster(PENUMBRA_PLATFORM);
      s.sun = keep(engine.spawn().rotation(0).light(sunLight(1, range)));
    });
    s.last = s.sun;
    return s;
  };

  // ── scene ──────────────────────────────────────────────────────────────
  const runScene = async () => {
    const resize = opts.resize ?? true;
    if (engine.mode === 'A' && resize) {
      throw new Error("in Mode A run 'scene' with resize: false: there is no probe to check the size, and the screenshot keeps the page's canvas (and the render worker's camera, .claude/skills/gpu-check/SKILL.md §7)");
    }
    const options = {
      sunRotation: finite(opts.sunRotation ?? 0, 'sunRotation'),
      pointShadow: finite(opts.pointShadow ?? 1, 'pointShadow'),
      sunShadow: finite(opts.sunShadow ?? 1, 'sunShadow'),
    };
    await clearEntities();
    const size = await setView(resize);
    const s = buildScene(options);
    await lightUp(s);
    const [dx, dy] = [Math.cos(options.sunRotation), Math.sin(options.sunRotation)];
    const probePoints = SCENE_WALLS.map(([x, y, w, h]) => {
      // 3 units past the face: the wall's extent along the sun, plus 3.
      const reach = (w / 2) * Math.abs(dx) + (h / 2) * Math.abs(dy) + 3;
      return { wall: [x, y], downwind: [x + dx * reach, y + dy * reach], upwind: [x - dx * reach, y - dy * reach] };
    });
    results.push({
      task: 'scene', label, options: { ...options, resize }, sceneHdr: size,
      ids: {
        floor: s.floor.id, walls: s.walls.map((h) => h.id), platforms: s.platforms.map((h) => h.id),
        boxes: s.boxes.map((h) => h.id), point: s.point.id, sun: s.sun.id,
      },
      groups: groupsNow(),
      probePoints,
      viewProjection: Array.from(engine.cam.viewProjection),
    });
  };

  // ── regress ────────────────────────────────────────────────────────────
  const runRegress = async () => {
    const old = oldAccum();
    await clearEntities();
    const size = await setView();
    const s = buildRegress(true);
    await lightUp(s);
    const uv = uvGrid(64, 36);
    const failures = {};
    let fresh;
    let before;
    try {
      fresh = await readLight({ uv });
      await swapAccum(old, 'the shader of 2f43e42');
      before = await readLight({ uv });
    } finally {
      await cleanUp(failures, "restoring HEAD's light-accum.wgsl", () => swapAccum(HEAD_ACCUM, 'HEAD'));
    }
    // Both reads came before the restore: the result stands, with the restore's failure if any.
    results.push({
      task: 'regress', label, sceneHdr: size, gridSize: [64, 36],
      shaders: { old: fnv1a(old), new: fnv1a(HEAD_ACCUM) },
      lights: REGRESS_LIGHTS, casters: REGRESS_CASTERS, ambient: AMBIENT, shadowSteps: STEPS, groups: groupsNow(),
      lightBuffer: fresh.targetSize, canvas: fresh.canvasSize,
      old: encodeGrid(before.values), new: encodeGrid(fresh.values),
      ...failures,
    });
    if (failures.cleanupErrors || accum.SHADER_SOURCE !== HEAD_ACCUM) {
      throw new Error(`HEAD's light-accum.wgsl did not come back${failures.cleanupErrors ? `: ${failures.cleanupErrors.join('; ')}` : ''}`);
    }
  };

  // ── penumbra ───────────────────────────────────────────────────────────
  const wallProfiles = () => [2, 12, 26].map((d) => ({
    kind: 'wall', d, points: Array.from({ length: 41 }, (_, k) => [WALL_FACE + d, -2 + 0.05 * k]),
  }));
  const HEIGHTS = Array.from({ length: 25 }, (_, k) => 0.02 + 0.04 * k);
  const platformProfiles = (kind) => [2, 6, 9.5, 16, 22].map((D) => ({
    kind, D, face: PLATFORM_TOP, heights: HEIGHTS, ...(kind === 'diagonal' ? { rotation: DIAGONAL } : {}),
    points: HEIGHTS.map((h) => [PLATFORM_UPWIND + D, PLATFORM_TOP + h]),
  }));
  /** The wall and platform profiles (sun at 0) and the diagonal (sun at -20 degrees), one probe each, at every budget. */
  const readProfiles = async (sun, budgets) => {
    const straight = [...wallProfiles(), ...platformProfiles('platform')];
    const diagonal = platformProfiles('diagonal');
    for (const p of [...straight, ...diagonal]) p.values = {};
    let read = null;
    for (const steps of budgets) {
      await setSteps(steps);
      for (const [profiles, angle] of [[straight, 0], [diagonal, DIAGONAL]]) {
        sun.rotation(angle);
        await untilRotation(sun, angle);
        await frames(4);
        read = await readLight({ world: profiles.flatMap((p) => p.points) });
        let k = 0;
        for (const p of profiles) {
          p.values[String(steps)] = read.values.slice(k, k + p.points.length);
          k += p.points.length;
        }
      }
    }
    sun.rotation(0);
    await untilRotation(sun, 0);
    await setSteps(STEPS);
    return { profiles: [...straight, ...diagonal], lightBuffer: read.targetSize, canvas: read.canvasSize };
  };
  const runPenumbra = async () => {
    const kinds = ['restore', 'grid', 'convergence', 'fadeStart'].filter((k) => opts[k] !== undefined && opts[k] !== false);
    if (kinds.length > 1) throw new Error(`'penumbra' takes one of restore, grid, convergence, fadeStart; got ${kinds.join(', ')}`);
    const kind = kinds[0] === 'fadeStart' ? 'fade' : kinds[0] ?? 'profiles';
    const angle = opts.angle === undefined ? undefined : finite(opts.angle, 'angle');
    if (angle !== undefined && !(angle > 0)) throw new Error(`angle must be > 0 rad, got ${angle}`);
    if (kind === 'profiles' && angle === undefined) throw new Error("'penumbra' needs one of: angle, convergence, grid, fadeStart, restore");
    const fadeStart = opts.fadeStart === undefined ? undefined : finite(opts.fadeStart, 'fadeStart');
    if (fadeStart !== undefined && !(fadeStart >= 0 && fadeStart < 1)) throw new Error(`fadeStart must be in [0, 1), got ${fadeStart}`);
    const range = finite(opts.range ?? 100, 'range');
    const shader = patchAccum({ angle, fadeStart });
    const what = angle === undefined && fadeStart === undefined ? 'HEAD' : `angle ${angle ?? 'HEAD'}, fade start ${fadeStart ?? 'HEAD'}`;
    const common = {
      task: 'penumbra', kind, label, angle: angle ?? 0.02, patched: shader !== HEAD_ACCUM, shader: fnv1a(shader),
      sunStepMultiplier: sunStepMultiplier(shader),
    };
    await clearEntities();

    if (kind === 'restore') {
      await setBackend(true);
      await swapAccum(HEAD_ACCUM, 'HEAD');
      await setSteps(STEPS);
      if (accum.SHADER_SOURCE !== HEAD_ACCUM || engine.lighting.quality.shadowSteps !== STEPS) {
        throw new Error("restore failed: HEAD's light-accum.wgsl or 48 steps did not come back");
      }
      results.push({
        ...common, angle: 0.02, patched: false, shader: fnv1a(HEAD_ACCUM), sunStepMultiplier: sunStepMultiplier(HEAD_ACCUM), shadowSteps: STEPS,
      });
      return;
    }

    const size = await setView();
    if (kind === 'grid') {
      const s = buildScene({ sunRotation: 0, pointShadow: 0, sunShadow: 1 });
      await lightUp(s, shader, what);
      const budgets = [...new Set([...GRID_BUDGETS, REF_STEPS, CONV_STEPS])].sort((a, b) => a - b);
      const uv = uvGrid(128, 72);
      const suns = [];
      let read = null;
      for (const [name, rotation] of GRID_SUNS) {
        s.sun.rotation(rotation);
        await untilRotation(s.sun, rotation);
        const grids = {};
        for (const steps of budgets) {
          await setSteps(steps);
          read = await readLight({ uv });
          grids[String(steps)] = encodeGrid(read.values);
        }
        suns.push({ name, rotation, grids });
      }
      s.sun.rotation(0);
      await untilRotation(s.sun, 0);
      await setSteps(STEPS);
      results.push({
        ...common, ref: REF_STEPS, conv: CONV_STEPS, budgets, gridSize: [128, 72], suns, sceneHdr: size,
        sun: { color: SUN_COLOR, energy: 1, range: 100 }, pointShadow: 0, ambient: AMBIENT,
        groups: groupsNow(), lightBuffer: read.targetSize, canvas: read.canvasSize,
      });
      return;
    }

    const s = buildPenumbra(range);
    await lightUp(s, shader, what);
    if (kind === 'fade') {
      // For the screenshot of the fade only: nothing is read.
      results.push({ ...common, fadeStart, range, sceneHdr: size, groups: groupsNow() });
      return;
    }
    const budgets = kind === 'convergence' ? [REF_STEPS, CONV_STEPS] : [STEPS, REF_STEPS];
    const { profiles, lightBuffer, canvas: probed } = await readProfiles(s.sun, budgets);
    results.push({
      ...common, ref: REF_STEPS, ...(kind === 'convergence' ? { conv: CONV_STEPS } : {}), budgets, profiles, sceneHdr: size,
      sun: { color: SUN_COLOR, energy: 1, range }, ambient: AMBIENT, groups: groupsNow(), lightBuffer, canvas: probed,
    });
  };

  // ── edgepop ────────────────────────────────────────────────────────────
  const runEdgepop = async () => {
    const ranges = opts.ranges ?? [100, 30, 10];
    if (!Array.isArray(ranges) || ranges.length === 0 || !ranges.every((r) => finite(r, 'a range') > 0)) {
      throw new Error(`ranges must be positive numbers, got ${JSON.stringify(ranges)}`);
    }
    await clearEntities();
    const size = await setView();
    // probe-checks.ts viewBounds: the world rectangle of the orthographic view.
    const vp = engine.cam.viewProjection;
    const xL = (-1 - vp[12]) / vp[0];
    const W = (1 - vp[12]) / vp[0] - xL;
    const s = {};
    engine.batch(() => {
      s.floor = spawnFloor();
      s.wOut = spawnCaster([xL - 0.55, 3, 0.6, 2]);
      s.wIn = spawnCaster([xL + 0.2, 8, 0.6, 2]);
      s.sun = keep(engine.spawn().rotation(0).light(sunLight(1, ranges[0])));
    });
    s.last = s.sun;
    await lightUp(s);
    const ds = Array.from({ length: Math.floor((W - 0.5) / 0.5) }, (_, i) => 0.5 * (i + 1));
    const row = (y) => ds.map((d) => [xL + d, y]);
    const points = [...row(3), ...row(8), ...row(5.5), [xL + 1, 6.6]];
    const n = ds.length;
    const rows = [];
    let read = null;
    for (const range of ranges) {
      s.sun.light(sunLight(1, range));
      await untilParam(s.sun, 3, range);
      await frames(4);
      read = await readLight({ world: points });
      rows.push({ range, out: read.values.slice(0, n), inn: read.values.slice(n, 2 * n), ref: read.values.slice(2 * n, 3 * n), e: read.values[3 * n] });
    }
    results.push({
      task: 'edgepop', label, W, xL, ds, rows, sceneHdr: size,
      casters: { out: [xL - 0.55, 3], in: [xL + 0.2, 8], size: [0.6, 2] }, e: [xL + 1, 6.6],
      sun: { color: SUN_COLOR, energy: 1, rotation: 0 }, ambient: AMBIENT, shadowSteps: STEPS,
      zoom: engine.cam.zoomLevel, groups: groupsNow(), canvas: read.canvasSize, lightBuffer: read.targetSize,
    });
  };

  // ── cost ───────────────────────────────────────────────────────────────
  /** The display's cadence: 60 frame intervals of the emptied world, at the task's start. */
  const measureCadence = () => new Promise((resolve) => {
    const stamps = [];
    const step = (now) => {
      stamps.push(now);
      if (stamps.length > 60) resolve((60 * 1000) / (stamps[60] - stamps[0]));
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

  /** The uber pair's libraries: the five other than the quad, their committed text, their stubs. */
  const uberLibraries = async () => {
    const { ForwardPass } = await import('/src/render/passes/forward-pass.ts');
    const { PRIMITIVE_LIBRARIES, pieceMarker } = await import('/src/render/primitive-shaders.ts');
    const others = PRIMITIVE_LIBRARIES.filter((l) => l.name !== 'quad');
    if (others.length !== CONDITIONS.uber.off.stubs) throw new Error(`${others.length} libraries other than the quad, the bench stubs ${CONDITIONS.uber.off.stubs}`);
    const committed = {};
    for (const l of others) committed[l.name] = (await import(`/src/shaders/primitives/${l.name}.wgsl?raw`)).default;
    // The three functions the composer calls, and nothing else: the type draws nothing.
    const stub = (p) => [
      STUB_MARK,
      `fn ${p}vs(position: vec3f, entityIdx: u32) -> VertexOutput {`,
      '    return culledVertex();',
      '}',
      `fn ${p}fs(in: VertexOutput) -> vec4f {`,
      '    return vec4f(0.0);',
      '}',
      `fn ${p}occluder(in: VertexOutput) -> vec4f {`,
      '    return vec4f(0.0);',
      '}',
      '',
    ].join('\n');
    // The uber module holds every library under its piece marker.
    const holds = (l, text) => ForwardPass.UBER_SOURCE.includes(`${pieceMarker(l.name)}\n${text}`);
    const stubCount = () => ForwardPass.UBER_SOURCE.split(STUB_MARK).length - 1;
    /** Every library stubbed, or every library committed: one recompileShader per piece, each waited for. */
    const setLibraries = async (stubbed) => {
      let swapped = false;
      for (const l of others) {
        const text = stubbed ? stub(l.prefix) : committed[l.name];
        if (holds(l, text)) continue;
        const before = renderer.graph;
        engine.recompileShader(l.name, text);
        await until(`the ${stubbed ? 'stub' : 'committed text'} of '${l.name}' to go live (a GPU rejection keeps the previous source: see the console)`,
          () => holds(l, text) && renderer.graph !== before);
        swapped = true;
      }
      if (swapped) await frames(4);
      return swapped;
    };
    return { ForwardPass, others: others.map((l) => l.name), stubCount, setLibraries };
  };
  /** getCompilationInfo on a throwaway device (never left alive next to the engine's), as the gate of Task 2. */
  const compileMessages = async (code) => {
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    try {
      const info = await device.createShaderModule({ code }).getCompilationInfo();
      return info.messages.map((m) => `${m.type} ${m.lineNum}:${m.linePos} ${m.message}`);
    } finally {
      await cleanUp(null, 'destroying the throwaway device', () => device.destroy());
    }
  };

  /** What the life signal checks, now; an empty list when the condition is live. */
  const lifeSignal = (pair, condition, ctx, swappedFrom) => {
    const want = CONDITIONS[pair][condition];
    const problems = [];
    if (engine.lighting._needsRebuild !== false) problems.push('the lighting quality is not handed to the renderer yet');
    if (pair === 'uber') {
      if (litLive()) problems.push('light-groups is in the live graph: the uber pair runs with lighting off');
      const stubs = ctx.uber.stubCount();
      if (stubs !== want.stubs) problems.push(`${stubs} stubbed libraries in ForwardPass.UBER_SOURCE, want ${want.stubs}`);
    } else {
      if (!litLive()) problems.push('light-groups is not in the live graph');
      const sets = engine.lighting.groups?.sdfSets.length ?? null;
      if (sets !== want.sdfSets) problems.push(`${sets} SDF sets, want ${want.sdfSets}`);
    }
    if (pair === 'march' || pair === 'set') {
      const point = slot7(ctx.scene.point);
      const sun = slot7(ctx.scene.sun);
      if (point !== want.point || sun !== want.sun) problems.push(`shadowIntensity point ${point}, sun ${sun} in the render state, want ${want.point}, ${want.sun}`);
    }
    if (pair === 'pointspot' && accum.SHADER_SOURCE !== (condition === 'on' ? HEAD_ACCUM : ctx.old)) {
      problems.push(`LightAccumStage.SHADER_SOURCE is not the shader of ${want.accum}`);
    }
    if (swappedFrom && renderer.graph === swappedFrom) problems.push('the render graph did not change after the swap');
    return problems;
  };
  /** The condition as the engine shows it, for "unchanged from the start of a window to its end". */
  const conditionState = (pair, ctx) => JSON.stringify({
    lit: litLive(),
    sdfSets: engine.lighting.groups?.sdfSets.length ?? null,
    shadows: pair === 'march' || pair === 'set' ? [slot7(ctx.scene.point), slot7(ctx.scene.sun)] : null,
    accum: pair === 'pointspot' ? (accum.SHADER_SOURCE === HEAD_ACCUM ? 'HEAD' : accum.SHADER_SOURCE === ctx.old ? '2f43e42' : 'other') : null,
    stubs: pair === 'uber' ? ctx.uber.stubCount() : null,
  });
  /** Puts the condition in place (a shader swap waits for its graph), then the life signal, every frame up to 60. */
  const applyCondition = async (pair, condition, ctx) => {
    const before = renderer.graph;
    let swapped = false;
    if (pair === 'march' || pair === 'set') {
      const c = CONDITIONS[pair][condition];
      ctx.scene.point.shadows(c.point);
      ctx.scene.sun.shadows(c.sun);
    } else if (pair === 'pointspot') {
      swapped = await swapAccum(condition === 'on' ? HEAD_ACCUM : ctx.old, condition === 'on' ? 'HEAD' : 'the shader of 2f43e42');
    } else {
      swapped = await ctx.uber.setLibraries(condition === 'off');
    }
    let problems = [];
    for (let f = 0; f < LIFE_FRAMES; f++) {
      problems = lifeSignal(pair, condition, ctx, swapped ? before : null);
      if (problems.length === 0) return problems;
      await frames(1);
    }
    return problems;
  };
  const measureWindow = async (pair, condition, ctx, cadenceHz, meta) => {
    const w = { ...meta, condition, valid: false, reasons: [] };
    const problems = await applyCondition(pair, condition, ctx);
    if (problems.length > 0) {
      w.reasons.push(`no life signal within ${LIFE_FRAMES} frames: ${problems.join('; ')}`);
      return w;
    }
    await frames(SETTLE_FRAMES);
    engine.disableGpuProfiling();
    if (!engine.enableGpuProfiling()) throw new Error('enableGpuProfiling() returned false');
    const graph = renderer.graph;
    const profiler = graph.profiler;
    const discards = { ...profiler.discardReasons };
    const state = conditionState(pair, ctx);
    const stamps = [];
    const started = performance.now();
    const end = await new Promise((resolve) => {
      const step = (now) => {
        stamps.push(now);
        const frame = engine.getGpuFrameTiming();
        if (frame && frame.sampleCount >= WINDOW) {
          // One synchronous turn: every value read here describes the same frames.
          resolve({
            frame: { ...frame },
            timings: engine.getGpuTimings().map((t) => ({ ...t })),
            spans: [...profiler.window.spans],
            discardReasons: { ...profiler.discardReasons },
            skippedFrames: profiler.skippedFrames,
            canvas: [canvas.width, canvas.height],
            groups: groupsNow(),
            graph: renderer.graph,
            state: conditionState(pair, ctx),
            life: lifeSignal(pair, condition, ctx, null),
          });
        } else if (now - started > WAIT_MS) {
          resolve(null);
        } else {
          requestAnimationFrame(step);
        }
      };
      requestAnimationFrame(step);
    });
    w.frames = stamps.length;
    w.durationMs = performance.now() - started;
    if (!end) {
      w.reasons.push(`timed out after ${WAIT_MS} ms with ${engine.getGpuFrameTiming()?.sampleCount ?? 0} of ${WINDOW} samples`);
      return w;
    }
    w.spanMs = end.frame.averageMs;
    w.sampleCount = end.frame.sampleCount;
    w.fps = stamps.length > 1 ? ((stamps.length - 1) * 1000) / (stamps[stamps.length - 1] - stamps[0]) : 0;
    w.newDiscards = Object.fromEntries(Object.entries(end.discardReasons).map(([k, v]) => [k, v - (discards[k] ?? 0)]));
    w.skippedFrames = end.skippedFrames;
    w.canvas = end.canvas;
    w.groups = end.groups;
    w.timings = end.timings;
    w.spans = end.spans;
    const discarded = Object.values(w.newDiscards).reduce((sum, x) => sum + x, 0);
    if (w.sampleCount < WINDOW) w.reasons.push(`${w.sampleCount} samples, want ${WINDOW}`);
    if (discarded > 0) w.reasons.push(`${discarded} frames discarded (${JSON.stringify(w.newDiscards)})`);
    if (!(w.fps >= 0.95 * cadenceHz)) w.reasons.push(`${w.fps.toFixed(1)} fps, below 0.95 x the cadence of ${cadenceHz.toFixed(1)} Hz`);
    if (end.canvas[0] !== WIDTH || end.canvas[1] !== HEIGHT) w.reasons.push(`canvas ${end.canvas.join('x')}, want ${WIDTH}x${HEIGHT}`);
    if (end.graph !== graph) w.reasons.push('the render graph changed during the window');
    if (end.state !== state) w.reasons.push(`the condition changed during the window: ${state} -> ${end.state}`);
    if (end.life.length > 0) w.reasons.push(`the life signal failed at the end: ${end.life.join('; ')}`);
    w.valid = w.reasons.length === 0;
    return w;
  };

  const runPair = async (pair, cadenceHz, options) => {
    const record = {
      task: 'cost', pair, label, outsideCriterion: pair === 'pointspot' || pair === 'uber',
      blockCount: options.blocks ?? (pair === 'pointspot' ? 4 : 8),
      cadenceHz, conditions: CONDITIONS[pair], environment: opts.environment ?? null,
      windows: [], blocks: [], redos: 0, stopped: null,
    };
    await clearEntities();
    record.sceneHdr = await setView();
    const ctx = {};
    if (pair === 'march' || pair === 'set') {
      const on = CONDITIONS[pair].on;
      ctx.scene = buildScene({ sunRotation: 0, pointShadow: on.point, sunShadow: on.sun });
      await lightUp(ctx.scene);
    } else if (pair === 'pointspot') {
      ctx.old = oldAccum();
      record.shaders = { on: fnv1a(HEAD_ACCUM), off: fnv1a(ctx.old) };
      ctx.scene = buildRegress(false);
      await lightUp(ctx.scene);
    } else {
      record.n = options.n;
      record.quadPx = options.quadPx;
      await setBackend(false);
      // The 5b bench's scene ('same' depths): its seed, its spans, its order of draws.
      const vp = engine.cam.viewProjection;
      const halfW = 1 / vp[0];
      const halfH = 1 / vp[5];
      const size = (record.quadPx * 2 * halfW) / WIDTH;
      const rand = prng(record.n * 2);
      engine.batch(() => {
        for (let i = 0; i < record.n; i++) {
          keep(engine.spawn({ mode: '2d' })
            .position((rand() * 2 - 1) * (halfW - size / 2), (rand() * 2 - 1) * (halfH - size / 2))
            .scale(size, size)
            .transparent());
        }
      });
      await settledAt(record.n);
      ctx.uber = await uberLibraries();
      record.stubbed = ctx.uber.others;
      // The uber module with the stubs compiles without a message, before the
      // run; the committed libraries come back whatever happens.
      await ctx.uber.setLibraries(false);
      try {
        await ctx.uber.setLibraries(true);
        record.stubCompile = await compileMessages(ctx.uber.ForwardPass.UBER_SOURCE);
      } catch (err) {
        record.stopped = `error: ${err instanceof Error ? err.message : String(err)}`;
        throw err;
      } finally {
        await cleanUp(record, 'restoring the committed libraries', () => ctx.uber.setLibraries(false));
        if (record.cleanupErrors) {
          // The stubs may still be live: the run ends, and its record, not in the results yet, says why.
          record.stopped ??= record.cleanupErrors.join('; ');
          results.push(record);
        }
      }
      if (record.cleanupErrors) throw new Error(record.stopped);
      if (record.stubCompile.length > 0) {
        throw new Error(`the uber module with the stubs does not compile cleanly: ${record.stubCompile.join('; ')}`);
      }
    }
    // In the results now: a run that stops keeps the windows it measured.
    results.push(record);
    const queue = Array.from({ length: record.blockCount }, (_, b) => b);
    const attempts = new Map();
    let checkedQuantization = false;
    try {
      while (queue.length > 0) {
        const block = queue.shift();
        const attempt = (attempts.get(block) ?? 0) + 1;
        attempts.set(block, attempt);
        const spans = [];
        for (let slot = 0; slot < ORDER.length; slot++) {
          const w = await measureWindow(pair, ORDER[slot], ctx, cadenceHz, { block, attempt, slot });
          record.windows.push(w);
          if (!checkedQuantization && w.spans?.length > 0) {
            checkedQuantization = true;
            if (w.spans.every((s) => Math.abs(s - Math.round(s / QUANTUM_MS) * QUANTUM_MS) <= 1e-6)) {
              record.stopped = 'quantized timestamps: run on chrome-devtools-gpu';
              throw new Error(record.stopped);
            }
          }
          if (!w.valid) break;
          spans.push(w.spanMs);
        }
        if (spans.length === ORDER.length) {
          record.blocks.push({ block, attempt, on1: spans[0], off1: spans[1], off2: spans[2], on2: spans[3] });
        } else if (record.redos < MAX_REDOS) {
          record.redos++;
          queue.push(block);
        } else {
          record.stopped = `block ${block} failed again after ${MAX_REDOS} redos: ${record.windows[record.windows.length - 1].reasons.join('; ')}`;
          break;
        }
      }
    } catch (err) {
      record.stopped ??= `error: ${err instanceof Error ? err.message : String(err)}`;
      throw err;
    } finally {
      // HEAD's shader and the committed libraries come back whatever happened.
      // Nothing here throws: it would replace the error in flight (the
      // quantized-timestamps stop, say); a failure is logged and recorded.
      await cleanUp(record, 'disabling GPU profiling', () => engine.disableGpuProfiling());
      if (pair === 'pointspot') await cleanUp(record, "restoring HEAD's light-accum.wgsl", () => swapAccum(HEAD_ACCUM, 'HEAD'));
      if (pair === 'uber') await cleanUp(record, 'restoring the committed libraries', () => ctx.uber.setLibraries(false));
    }
    // Reached without an error in flight: a failed cleanup still ends the run.
    if (record.cleanupErrors) {
      record.stopped ??= record.cleanupErrors.join('; ');
      throw new Error(record.cleanupErrors.join('; '));
    }
    return record;
  };

  const runCost = async () => {
    const pairs = opts.pairs;
    if (!Array.isArray(pairs) || pairs.length === 0 || !pairs.every((p) => PAIRS.includes(p))) {
      throw new Error(`pairs must list some of ${PAIRS.join(', ')}, got ${JSON.stringify(pairs)}`);
    }
    // Every option checked before the engine is touched.
    const options = {
      blocks: opts.blocks === undefined ? undefined : count(opts.blocks, 'blocks'),
      n: count(opts.n ?? 10000, 'n'),
      quadPx: finite(opts.quadPx ?? 16, 'quadPx'),
    };
    if (!(options.quadPx > 0)) throw new Error(`quadPx must be > 0, got ${options.quadPx}`);
    if (pairs.includes('pointspot')) oldAccum();
    await clearEntities();
    const cadenceHz = await measureCadence();
    for (const pair of pairs) {
      // A pair that stopped (more than 4 redos) ends the run: its report is the result.
      if ((await runPair(pair, cadenceHz, options)).stopped) break;
    }
  };

  const run = { scene: runScene, regress: runRegress, penumbra: runPenumbra, edgepop: runEdgepop, cost: runCost }[task];
  await run();

  let adapter = null;
  try {
    const a = await navigator.gpu?.requestAdapter();
    adapter = a ? { vendor: a.info?.vendor ?? '', architecture: a.info?.architecture ?? '', description: a.info?.description ?? '' } : null;
  } catch {
    adapter = null;
  }
  let chrome = null;
  try {
    chrome = (await navigator.userAgentData?.getHighEntropyValues(['fullVersionList']))?.fullVersionList ?? null;
  } catch {
    chrome = null;
  }
  return {
    format: FORMAT,
    task,
    label,
    mode: engine.mode,
    search: location.search,
    canvas: [canvas.width, canvas.height],
    dpr: window.devicePixelRatio,
    adapter,
    chrome,
    results,
  };
}
