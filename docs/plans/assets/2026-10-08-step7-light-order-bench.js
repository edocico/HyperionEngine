async () => {
  // Round 2026-09-27, step 7 (one light list for every 2D light, and the mix
  // blend): the committed bench of
  // docs/plans/2026-10-08-step7-light-order-mix-plan.md, Task 1. The body of
  // ONE chrome-devtools `evaluate_script` call per task (loaded with fetch +
  // (0, eval) from a local asset server), like
  // docs/plans/assets/2026-09-30-step6-directional-bench.js. Its output goes
  // through docs/plans/assets/2026-10-08-step7/step7-stats.mjs
  // (`order <file>`, `permute <file> [--cull atomic]`, `regress <master>
  // <step7>`). It runs on master and on step 7: a result's `list`, the page's
  // light list (engine.lighting.groups' lightOrder and lightIds), is null on
  // master, which has none.
  //
  // Page: the dev harness with ?bench (no section: an otherwise empty world),
  // "http://localhost:5173/?mode=B&bench" or ?mode=C&bench (every task),
  // ?mode=A&bench (`scene` only), on chrome-devtools-gpu, navigated with
  // ignoreCache and the anti-reload initScript of
  // .claude/skills/gpu-check/SKILL.md §3. Restart the dev server after ANY
  // edit to an app module since it started: Vite then serves the app the
  // edited module as `?t=…`, and this bench's `import('/src/…')` gets a second
  // instance of it, stuck at SHADER_SOURCE '' and the default SUBGROUP_CONFIG:
  // every cull path read there would say 'atomic', and forcing the atomic path
  // would write to a class the graph does not use. In Mode B and C the bench
  // checks this before anything else (CullPass's and LightAccumStage's
  // SHADER_SOURCE, then, wherever it reads or writes the cull path, that the
  // live graph's cull pass is an instance of the CullPass it imported) and
  // throws.
  //
  // Configured by an earlier evaluate_script:
  //   window.__benchOpts = { task: '<task>', label: '<short sha>', ...options }
  // Results accumulate in window.__benchResults, and every call returns all of
  // them: { format, task, label, mode, search, canvas, dpr, adapter, chrome,
  // userAgent, platformVersion, results }. `chrome` is navigator.userAgentData's
  // fullVersionList; `userAgent` is navigator.userAgent (Safari has no
  // userAgentData: its version is only there); `platformVersion` is the macOS
  // version (the Metal compiler changes with the system, not only with
  // Chrome). Each result carries its `task`, its `label` and `lights: [{ id,
  // slot }]`, the slot of each of its lights in the latest render state
  // (engine.bridge.latestRenderState.entityIds.indexOf(id), valid in all three
  // modes), read once the scene settled and before the reads: the
  // precondition step7-stats checks (`permute` and `grow` have them in `first`
  // and `second`). `order`, `permute` and `regress` record `cullPath`, the live
  // cull's path, read from its checked class (SUBGROUP_CONFIG.useSubgroups:
  // 'subgroup' or 'atomic'); `order` with `atomic` also `cullPathRestored`.
  //
  // The clearing rule (Mode B and C): every task first destroys the entities
  // of the previous one (window.__step7Entities), then waits until the GPU
  // rows count zero (SystemViews.entityCount in a frameEnd hook) with nothing
  // queued (engine.stats.overflowCount 0); every spawn comes after that wait.
  // Spawns that reach the engine in the update of a despawn are rotated: the
  // update swap-removes the dead rows in descending slot order after it ran
  // the whole batch, moving the newest rows into the freed slots. `regress`,
  // `order` and `permute` would lose their premise, and step7-stats would
  // refuse the run (exit 3). `scene` clears in its phase 1 only: phases 2 and
  // 3 change the phase-1 entities in place. Mode A runs `scene` only, and its
  // bridge drops empty render states, so zero rows is never seen there: phase
  // 1 must be the first task of a freshly loaded page, phases 2 and 3 never
  // rebuild the scene, and M is never destroyed in the frame of a spawn.
  //
  // Common to every task but `scene`: engine.resize(1920, 1080), the camera at
  // (0, 0), zoom 1, checked with the targetSize of a probe of scene-hdr (the
  // view is x in [-17.78, 17.78], y in [-10, 10]); the ambient [0.06, 0.07,
  // 0.12] at 1, 48 shadow steps and setBackend('lit'); after the spawn, the
  // scene's rows on the GPU, light-groups in renderer.graph.executionOrder and
  // 4 frames. A read is the light buffer of each light group it names
  // (engine.lighting.groups), on a UV 64x36 grid of cell centres (2304
  // points; world points for `grow` and `scene`), retried while the light
  // buffer is not in the live graph, with engine.debug.readEntityTransforms()
  // asked for the same frame: that frame's slots must hold the run's lights
  // where `lights` says, or the bench throws (the scene moved under the
  // reads). Grids are float32 RGBA in base64 ({ encoding: 'f32-rgba-base64',
  // count, data }: step6-stats.mjs decodeGrid).
  //
  // What one grid over N reads proves: the light buffer came out the same in
  // N frames. It shows the cull drew the lights in one order only if a
  // reorder would show in the texels (`permute` calibrates that: two orders of
  // the same overlapping `add` lights round differently in fp16) and only
  // where the cull can reorder at all (lights in distinct cull workgroups, or
  // the atomic path): the slots recorded in `lights` say which.
  //
  // Pieces: the floor (0, 0, -0.5) 40x24, receiving light; a filler (0, -1000),
  // off screen: a row the cull tests and never draws; pointLight(j, k,
  // blend): a point light at ((j - (k - 1) / 2) * 1.5, 0), colour
  // LIGHT_COLORS[j % 4] (exact in fp16), range 6, falloff 0 for mix (full
  // weight in range), 1 for add.
  //
  // Tasks:
  // - regress: add and sub, bit for bit against master. The floor, a receiver
  //   of layer 1 (13, 6, -0.4) 6x6, casters (-4, 2) 0.8x5 and (6, -4) 6x0.8; a
  //   point (-9, 0) range 12 falloff 1.2 shadow 1 layers 0b01, a spot (12, -6)
  //   rotation(2.3) range 18 inner 18 outer 30 shadow 1 layers 0b11, a
  //   directional rotation(-PI/6) range 8 shadow 1 layers 0b01, a global
  //   (500, 500) energy 0.5 layers 0b11 and a sub point (2, 4) range 7 layers
  //   0b01: add or sub, all at z 0 (colours in REGRESS_LIGHTS). After the
  //   clear the floor, the receiver and the casters take slots 0-3 and the
  //   five lights, in id order, slots 4-8, in one cull workgroup: master's
  //   cull order (the slots) and the list's coincide, which step7-stats
  //   checks on the recorded `lights`. Reads `layers` (the two groups). On a
  //   step-7 page it then needs window.__step7OldLightAccum, master's
  //   light-accum.wgsl as a string (it reads visibleIndices), set by an
  //   earlier evaluate_script that pastes the output of
  //   `git show 1d19575:ts/src/shaders/light-accum.wgsl | jq -Rs .`:
  //   engine.recompileShader('light-accum', old), a wait for
  //   LightAccumStage.SHADER_SOURCE === old and a new graph, `oldShaderLayers`,
  //   and step 7's shader put back the same way in a `finally`. On master
  //   (no light list) only `layers` is read.
  // - order { K = 3, apart = 256, blend = 'add', reads = 240, atomic = false }:
  //   whether the cull reorders the lights between frames. The floor (slot 0)
  //   and K pointLight(j, K, blend) with apart - 1 fillers between two
  //   lights: the lights in slots 1, 1 + apart, …, so at apart >= 256 each in
  //   its own cull workgroup, at apart 1 all in the first. `reads` reads of
  //   layer 0, each hashed (FNV-1a of its base64, the data compared too): at
  //   most 8 distinct grids, each with its first read, and `sequence[r]` the
  //   grid of read r (-1 past 8). With `atomic` the live cull must start on
  //   the subgroup path (useSubgroups true: the M2's live configuration; a
  //   second instance holds the default false); then
  //   CullPass.SUBGROUP_CONFIG = { ...before, useSubgroups: false },
  //   recompileShader('cull', <cull.wgsl?raw>) and a new graph. reloadShaders
  //   never skips an equal source, so a new graph alone does not prove the
  //   path changed: `cullPath` is read from the checked class once the new
  //   graph is live. In a `finally` the configuration comes back, the shader
  //   is recompiled, a new graph awaited and useSubgroups checked to be true
  //   again: `cullPathRestored`.
  // - permute: the calibration of the observable. The floor (slot 0), a
  //   filler F (1), three add pointLight(j, 3) (2-4); a read (`first`); F
  //   destroyed: the third light, the last row, moves to slot 1, and the
  //   lights' slot order becomes 3, 1, 2; another read (`second`). Each with
  //   its `lights` and the page's `list`.
  // - grow (step-7 pages only; it throws on master, which has no lightOrder):
  //   the growth of the list's buffer (destroy the old one, create a larger
  //   one, drop the cached bind groups, rebind), which no other scene of the
  //   plan reaches (5 lights at most in view, against a first capacity of 64):
  //   the defect class only the GPU sees (CLAUDE.md's gotcha on growing
  //   texture tiers). The floor and 100 add point lights on a 10x10 grid in
  //   view, x = -13.5 + 3i, y = -8.1 + 1.8j, range 0.4, falloff 0, colour
  //   LIGHT_COLORS[(i + j) % 4]; a read of layer 0 at every centre (expected,
  //   per channel, Math.f16round(Math.f16round(ambient) + colour)) and at the
  //   midpoints between two neighbours (expected the ambient), each within 1
  //   fp16 step; then the first 60 lights (rows j = 0-5) destroyed,
  //   settledAt(41) and the same read: the 40 left unchanged
  //   (`remainingChanged` 0), the centres of the destroyed at the ambient.
  //   Records lightOrder.length (100, then 40) and the worst fp16 steps of
  //   each read (`worstUlps`). A destroyed buffer still bound would make the
  //   probe reject with its validation error; the console (only favicon.ico's
  //   404) is for whoever runs it to read.
  // - scene { phase, resize = false }: the screenshots of Mode A, and the same
  //   scene measured in B and C. Phase 1: the clear in B and C (in Mode A the
  //   page is freshly loaded), the camera at (0, 0), zoom 1,
  //   setAmbient([0.06, 0.07, 0.12], 1), setBackend('lit'), then the wait for
  //   the rows (in Mode A the row of the last entity in
  //   engine.bridge.latestRenderState, then 30 frames), with no resize. It
  //   throws if 10·a <= 12.5, a = floor(clientWidth·dpr) /
  //   floor(clientHeight·dpr), the aspect of the render worker's view
  //   (gpu-check §7; 1920/1080 after `resize: true`, B and C only): the floor
  //   point (-12, -7) must fall in the canvas (a 1200x689 window gives a =
  //   1.57). The floor and four 2D lights at falloff 0: M (-8, 3) mix
  //   [1, 0.5, 0.25] range 2; R (3, -1) depth 0.5 add [0, 0.5, 0] range 5; P
  //   (1.5, -1) depth 1 .transparent() mix [1, 0.25, 0.25] range 3; Q
  //   (4.5, -1) depth 2 mix [0.25, 0.25, 1] range 3. Phase 2 (in place): P's
  //   and Q's depths swapped. Phase 3 (in place): M destroyed (Q, the last
  //   row, moves to its slot), P and Q at depth 1; it throws if slot(Q) >=
  //   slot(P): only with slot(Q) < slot(P) does the screenshot tell the id
  //   rule (Q, the higher id, in front at equal depth) from the slot order.
  //   Returns `points`, the ids, the slots (`lights`) and `expected8`, step
  //   7's rule in 8 bits at each point (the floor is white and the tonemap a
  //   passthrough); in B and C also `measured` (the light buffer at the
  //   points) and `maxDiff`, the largest |255·v - expected8| over their RGB
  //   (v clamped to [0, 1]).
  //
  // A wait on the engine (a frame, a frameEnd hook, a probe) gives up after
  // WAIT_MS (20 s) with 'timed out … waiting for …' instead of hanging when
  // the engine loop stops (a screen that goes dark stops
  // requestAnimationFrame). A cleanup in a `finally` (the cull path, step 7's
  // light-accum.wgsl) that fails is logged with console.error and recorded in
  // the result's `cleanupErrors`: it never replaces the error in flight, and
  // without one it still fails the run.
  const FORMAT = 'hyperion-step7-bench/1';
  const TASKS = ['regress', 'order', 'permute', 'grow', 'scene'];
  const WIDTH = 1920;
  const HEIGHT = 1080;
  const AMBIENT = [0.06, 0.07, 0.12];
  /** LightingQuality.shadowSteps' default: the regress scene's shadows depend on it. */
  const STEPS = 48;
  const WAIT_MS = 20000;
  /** A read's UV grid: 64x36 cell centres. */
  const GRID = [64, 36];
  /** Frames after a scene settled, before its slots and reads (Mode A: before the screenshot, MODE_A_FRAMES). */
  const SETTLE_FRAMES = 4;
  const MODE_A_FRAMES = 30;
  /** The distinct grids an `order` run keeps; a read past them is -1 in `sequence`. */
  const MAX_GRIDS = 8;
  /** MAX_GPU_ENTITIES (ts/src/types.ts): the rows of every GPU buffer. */
  const MAX_ROWS = 100000;
  /** Point-light colours, exact in fp16: a sum of them rounds only where the light buffer does. */
  const LIGHT_COLORS = [[1, 0.375, 0.25], [0.25, 1, 0.375], [0.25, 0.5, 1], [1, 0.875, 0.25]];
  const BLENDS = ['add', 'mix'];
  /** The regress scene: casters as [x, y, width, height]; the lights in spawn (id) order. */
  const REGRESS_RECEIVER = { at: [13, 6, -0.4], size: [6, 6], layers: 0b10 };
  const REGRESS_CASTERS = [[-4, 2, 0.8, 5], [6, -4, 6, 0.8]];
  const REGRESS_LIGHTS = [
    { name: 'point', at: [-9, 0], light: { type: 'point', color: [1, 0.85, 0.6], energy: 1, range: 12, falloff: 1.2, shadowIntensity: 1, layers: 0b01 } },
    { name: 'spot', at: [12, -6], rotation: 2.3, light: { type: 'spot', color: [0.6, 0.8, 1], energy: 1, range: 18, innerAngle: 18, outerAngle: 30, shadowIntensity: 1, layers: 0b11 } },
    { name: 'directional', at: [0, 0], rotation: -Math.PI / 6, light: { type: 'directional', color: [1, 0.95, 0.85], energy: 1, range: 8, shadowIntensity: 1, layers: 0b01 } },
    { name: 'global', at: [500, 500], light: { type: 'global', color: [1, 1, 1], energy: 0.5, layers: 0b11 } },
    { name: 'sub', at: [2, 4], light: { type: 'point', color: [0.5, 0.4, 0.3], energy: 1, range: 7, blend: 'sub', layers: 0b01 } },
  ];
  /** The `grow` grid: n x n lights at (x0 + dx·i, y0 + dy·j); the first `destroyed` (rows j = 0-5) go. */
  const GROW = { n: 10, x0: -13.5, dx: 3, y0: -8.1, dy: 1.8, range: 0.4, destroyed: 60 };
  /** The `scene` lights, in spawn order: 2D, falloff 0. */
  const SCENE_LIGHTS = {
    M: { at: [-8, 3], depth: 0, blend: 'mix', color: [1, 0.5, 0.25], range: 2 },
    R: { at: [3, -1], depth: 0.5, blend: 'add', color: [0, 0.5, 0], range: 5 },
    P: { at: [1.5, -1], depth: 1, transparent: true, blend: 'mix', color: [1, 0.25, 0.25], range: 3 },
    Q: { at: [4.5, -1], depth: 2, blend: 'mix', color: [0.25, 0.25, 1], range: 3 },
  };
  /** The depths of each phase: phase 2 swaps P's and Q's, phase 3 puts both at 1. */
  const SCENE_DEPTHS = { 1: { R: 0.5, P: 1, Q: 2 }, 2: { R: 0.5, P: 2, Q: 1 }, 3: { R: 0.5, P: 1, Q: 1 } };
  const SCENE_POINTS = { floor: [-12, -7], mIn: [-8, 3], pOnly: [0, -1], overlap: [3, -1], qOnly: [6, -1], rOnly: [3, 2.5] };
  /** Step 7's rule at the scene's points, in 8 bits: the ambient, M, P or Q (a full-weight mix replaces), R added. */
  const FLOOR8 = [15, 18, 31];
  const expected8 = (phase) => ({
    floor: FLOOR8,
    mIn: phase === 3 ? FLOOR8 : [255, 128, 64],
    pOnly: [255, 64, 64],
    // Phase 1: P (depth 1) in front of Q (depth 2); then Q, by depth and, at equal depth, by its higher id.
    overlap: phase === 1 ? [255, 64, 64] : [64, 64, 255],
    qOnly: [64, 64, 255],
    rOnly: [15, 145, 31],
  });

  // ── Guards ─────────────────────────────────────────────────────────────
  const engine = window.__hyperion;
  if (!engine) throw new Error('window.__hyperion is missing: open the dev harness (a dev build)');
  if (!new URLSearchParams(location.search).has('bench')) {
    throw new Error('run the bench on a ?bench page: a harness tab adds entities, and its checks probe');
  }
  const opts = window.__benchOpts ?? {};
  const task = opts.task;
  if (!TASKS.includes(task)) throw new Error(`window.__benchOpts.task must be one of ${TASKS.join(', ')}, got ${JSON.stringify(task)}`);
  if (task !== 'scene' && engine.mode !== 'B' && engine.mode !== 'C') {
    throw new Error(`'${task}' reads the light buffer with the probe: Mode B or C, not ${engine.mode}`);
  }
  if (engine.mode !== 'A' && typeof engine.debug?.probe !== 'function') {
    throw new Error('engine.debug.probe is missing: a dev build is needed');
  }
  const renderer = engine.renderer; // null in Mode A: the render worker draws
  let CullPass = null;
  let LightAccumStage = null;
  if (engine.mode !== 'A') {
    if (!renderer) throw new Error(`no main-thread renderer in Mode ${engine.mode}: did WebGPU fail to start? (see the console)`);
    ({ CullPass } = await import('/src/render/passes/cull-pass.ts'));
    ({ LightAccumStage } = await import('/src/render/passes/light-accum-stage.ts'));
    for (const [name, cls] of [['CullPass', CullPass], ['LightAccumStage', LightAccumStage]]) {
      if (!cls.SHADER_SOURCE) {
        throw new Error(`${name}.SHADER_SOURCE is '' in the module this bench imported: a second instance of it, not the app's (Vite serves the app an edited module as ?t=…). Restart the dev server and reload the page`);
      }
    }
  }
  const label = opts.label ?? null;
  const count = (x, what) => {
    if (!Number.isInteger(x) || x < 1) throw new Error(`${what} must be a whole number >= 1, got ${JSON.stringify(x)}`);
    return x;
  };
  const flag = (x, what) => {
    if (typeof x !== 'boolean') throw new Error(`${what} must be true or false, got ${JSON.stringify(x)}`);
    return x;
  };
  const results = (window.__benchResults = window.__benchResults ?? []);
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
   * run would hang instead of failing.
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
   * and recorded in `into.cleanupErrors`, never thrown: thrown from a
   * finally, it would replace the error in flight (a timeout, say). Without
   * an error in flight, the caller throws on `into.cleanupErrors` once past
   * the finally.
   */
  const cleanUp = async (into, what, step) => {
    try {
      await step();
    } catch (err) {
      const message = `${what} failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`step7 bench: ${message}`);
      (into.cleanupErrors ??= []).push(message);
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
  /** The precondition a result carries: where each of its lights sits now. */
  const lightsOf = (handles) => handles.map((h) => ({ id: h.id, slot: slotOf(h) }));
  /** Waits until the latest render state's row of `handle` passes `test(state, slot)`. */
  const untilRow = (what, handle, test) => until(what, () => {
    const slot = slotOf(handle);
    return slot >= 0 && test(engine.bridge.latestRenderState, slot);
  });
  /** A 2D entity's row has z = -depth (Depth::z()). */
  const untilDepth = (handle, depth, name) => untilRow(`depth ${depth} of ${name} (entity ${handle.id}) in the render state`, handle,
    (rs, s) => rs.transforms[16 * s + 14] === Math.fround(0 - depth));
  const untilAmbient = () => until('the ambient light in the render state', () => {
    const [r, g, b, intensity] = engine.lighting.ambient;
    return r === Math.fround(AMBIENT[0]) && g === Math.fround(AMBIENT[1]) && b === Math.fround(AMBIENT[2]) && intensity === 1;
  });
  /** engine.lighting.groups is null until the first render state. */
  const groupsReady = async () => {
    await until('a render state (engine.lighting.groups is null before the first one)', () => engine.lighting.groups !== null);
    return engine.lighting.groups;
  };
  const groupsNow = () => {
    const g = engine.lighting.groups;
    return g ? [g.groups.length, g.sdfSets.length] : null;
  };
  /** The page's light list (round step 7), or null where there is none (master). */
  const listNow = () => {
    const g = engine.lighting.groups;
    return g && g.lightOrder !== undefined && g.lightIds !== undefined
      ? { lightOrder: Array.from(g.lightOrder), lightIds: Array.from(g.lightIds) }
      : null;
  };
  const litLive = () => renderer.graph.executionOrder.includes('light-groups');
  /** The lit graph live (Mode B, C), or the lit backend in the render state the render worker follows (Mode A). */
  const untilLit = () => (renderer
    ? until('the lit render graph to go live', litLive)
    : until('the lit backend in the render state', () => engine.lighting.backend === 'lit'));
  const setBackend = async () => {
    engine.lighting.setBackend('lit');
    await untilLit();
  };
  /**
   * The live graph's cull class, checked to be the CullPass this bench
   * imported: only then is its SUBGROUP_CONFIG the one the graph's cull pass
   * was set up with, to read or to write.
   */
  const liveCullClass = () => {
    const cls = renderer.graph.passes.get('cull')?.constructor;
    if (cls !== CullPass) {
      throw new Error("the live graph's cull pass is not an instance of the CullPass this bench imported: a second instance of cull-pass.ts (restart the dev server and reload the page)");
    }
    return cls;
  };
  /** The live cull's path, from its checked class. */
  const cullPathNow = () => (liveCullClass().SUBGROUP_CONFIG.useSubgroups ? 'subgroup' : 'atomic');
  const uvGrid = (gx, gy) => {
    const uv = [];
    for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) uv.push([(i + 0.5) / gx, (j + 0.5) / gy]);
    return uv;
  };
  /**
   * One read: the light buffer at `points` ({ uv } or { world }) in each light
   * group of `layers`, and the frame's rows (readEntityTransforms), asked for
   * in one turn so the next rendered frame serves them together. Retried
   * while the light buffer is not in the live graph (the lit graph goes live a
   * frame or two after setBackend('lit')). Throws if that frame holds a light
   * of `lights` in another slot than the recorded one. Returns the values per
   * layer, the light buffer's size and the canvas.
   */
  const read = async (points, layers, lights) => {
    if (layers.length === 0) throw new Error('internal: a read of no layer');
    const what = 'a light-buffer probe (only a rendered frame serves one: did the engine loop stop?)';
    const deadline = performance.now() + WAIT_MS;
    for (let tries = 0; ; tries++) {
      // allSettled: no rejection goes unhandled, and a deadline that wins the race leaves none behind.
      const settled = await byDeadline(Promise.allSettled([
        engine.debug.readEntityTransforms(),
        ...layers.map((layer) => engine.debug.probe({ target: 'light-buffer', layer, ...points })),
      ]), deadline, WAIT_MS, what);
      const failed = settled.find((s) => s.status === 'rejected');
      if (failed) {
        if (tries >= 30 || !/not in the live render graph/.test(String(failed.reason))) throw failed.reason;
        await byDeadline(frames(2), deadline, WAIT_MS, what);
        continue;
      }
      const [rows, ...probes] = settled.map((s) => s.value);
      for (const l of lights) {
        const slot = rows.entityIds.indexOf(l.id);
        if (slot !== l.slot) {
          throw new Error(`the frame read holds light ${l.id} in slot ${slot}, not ${l.slot} as recorded: the scene moved under the reads`);
        }
      }
      return { values: probes.map((p) => p.values), lightBuffer: probes[0].targetSize, canvas: probes[0].canvasSize };
    }
  };
  /** A grid's RGBA values as float32 in base64: a 2304-point grid is 49 KB, not 140. */
  const encodeGrid = (values) => {
    const f = new Float32Array(values.length * 4);
    values.forEach((v, i) => f.set(v, 4 * i));
    const bytes = new Uint8Array(f.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { encoding: 'f32-rgba-base64', count: values.length, data: btoa(binary) };
  };
  /** FNV-1a 32 of a text: a grid's base64 (equal grids hash alike) or a shader. */
  const fnv1a = (text) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(16).padStart(8, '0');
  };
  /**
   * The fp16 steps between `a` and `b` (step6-stats.mjs fp16Steps): exact
   * between fp16 values, through zero across signs; Infinity when the two
   * differ and either is not finite.
   */
  const fp16Steps = (a, b) => {
    if (a === b) return 0;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
    const position = (v) => {
      const m = Math.abs(v);
      let p;
      if (m < 2 ** -14) {
        p = m * 2 ** 24;
      } else {
        let e = Math.floor(Math.log2(m));
        if (2 ** e > m) e--;
        else if (2 ** (e + 1) <= m) e++;
        p = 1024 * (e + 15) + (m / 2 ** e - 1) * 1024;
      }
      return v < 0 ? -p : p;
    };
    return Math.abs(position(a) - position(b));
  };

  // ── Shaders: light-accum and cull ──────────────────────────────────────
  /**
   * Makes `source` the live light-accum shader: recompileShader, then wait
   * until LightAccumStage.SHADER_SOURCE (the app's module instance) is
   * `source` and a new graph is live, then 4 frames. A graph is rebuilt only
   * while the lit graph is requested. Returns whether it swapped.
   */
  const swapAccum = async (source, what) => {
    if (LightAccumStage.SHADER_SOURCE === source) return false;
    if (!litLive()) throw new Error('internal: light-accum swapped without the lit graph, which would rebuild no graph');
    const before = renderer.graph;
    engine.recompileShader('light-accum', source);
    await until(`light-accum (${what}) to go live (a shader the GPU rejects keeps the previous source: see the console)`,
      () => LightAccumStage.SHADER_SOURCE === source && renderer.graph !== before);
    await frames(SETTLE_FRAMES);
    return true;
  };
  /**
   * The checked cull class with SUBGROUP_CONFIG `config`, in a new graph:
   * recompileShader('cull', the raw cull.wgsl), which its slot prepares as at
   * startup, then CullPass.setup reads SUBGROUP_CONFIG. Returns once a new lit
   * graph is live and 4 frames ran.
   */
  const rebuildCull = async (config, rawCull, what) => {
    const cls = liveCullClass();
    const before = renderer.graph;
    cls.SUBGROUP_CONFIG = config;
    engine.recompileShader('cull', rawCull);
    await until(`a new render graph with the ${what} cull (a GPU rejection keeps the previous graph: see the console)`,
      () => renderer.graph !== before && litLive());
    await frames(SETTLE_FRAMES);
  };

  // ── Entities and scenes ────────────────────────────────────────────────
  let entities = (window.__step7Entities ??= []);
  const clearEntities = async () => {
    for (const h of entities) h.destroy();
    entities = window.__step7Entities = [];
    await settledAt(0);
  };
  const keep = (h) => {
    entities.push(h);
    return h;
  };
  const spawnFloor = () => keep(engine.spawn().position(0, 0, -0.5).scale(40, 24, 1).receivesLight(true));
  const spawnFiller = () => keep(engine.spawn().position(0, -1000));
  const pointLight = (j, k, blend) => keep(engine.spawn().position((j - (k - 1) / 2) * 1.5, 0)
    .light({ type: 'point', color: LIGHT_COLORS[j % 4], energy: 1, range: 6, falloff: blend === 'mix' ? 0 : 1, blend }));
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
  /** The ambient, 48 shadow steps and the lit backend, each waited for. */
  const lightUp = async () => {
    engine.lighting.setAmbient(AMBIENT, 1);
    engine.lighting.setQuality({ shadowSteps: STEPS });
    await until(`shadowSteps ${STEPS} handed to the renderer`, () => engine.lighting._needsRebuild === false);
    await setBackend();
    await untilAmbient();
  };
  /** The scene's rows on the GPU, the lit graph live, then 4 frames: then its slots, and its reads. */
  const settleScene = async () => {
    await settledAt(entities.filter((h) => h.alive).length);
    await until('light-groups in the live render graph', litLive);
    await frames(SETTLE_FRAMES);
  };

  // ── regress ────────────────────────────────────────────────────────────
  const runRegress = async () => {
    // On a step-7 page the old shader's leg is part of the run: checked before the world is touched.
    const step7Page = (await groupsReady()).lightOrder !== undefined;
    const old = window.__step7OldLightAccum;
    if (step7Page) {
      if (typeof old !== 'string' || old.length === 0) {
        throw new Error("on a step-7 page 'regress' also reads master's shader in step 7's stage: set window.__step7OldLightAccum first, with an evaluate_script that pastes the output of `git show 1d19575:ts/src/shaders/light-accum.wgsl | jq -Rs .`");
      }
      if (!old.includes('visibleIndices') || old === LightAccumStage.SHADER_SOURCE) {
        throw new Error("window.__step7OldLightAccum is not master's light-accum.wgsl (which reads visibleIndices): set it again from 1d19575");
      }
    } else if (old !== undefined) {
      throw new Error('window.__step7OldLightAccum is set on a page without the light list (master): delete it, master reads its own shader only');
    }
    await clearEntities();
    const sceneHdr = await setView();
    await lightUp();
    const lights = [];
    engine.batch(() => {
      spawnFloor();
      const [x, y, z] = REGRESS_RECEIVER.at;
      keep(engine.spawn().position(x, y, z).scale(...REGRESS_RECEIVER.size).receivesLight(true).lightLayers(REGRESS_RECEIVER.layers));
      for (const [cx, cy, w, h] of REGRESS_CASTERS) keep(engine.spawn().position(cx, cy).scale(w, h).castsShadow(true));
      for (const l of REGRESS_LIGHTS) {
        const h = engine.spawn().position(...l.at);
        if (l.rotation !== undefined) h.rotation(l.rotation);
        lights.push(keep(h.light(l.light)));
      }
    });
    await settleScene();
    const live = LightAccumStage.SHADER_SOURCE;
    const result = {
      task: 'regress', label, cullPath: cullPathNow(), lights: lightsOf(lights), list: listNow(), groups: groupsNow(),
      sceneHdr, gridSize: GRID, ambient: AMBIENT, shadowSteps: STEPS,
      scene: { receiver: REGRESS_RECEIVER, casters: REGRESS_CASTERS, lights: REGRESS_LIGHTS },
      shaders: { live: fnv1a(live), ...(step7Page ? { old: fnv1a(old) } : {}) },
    };
    const layers = engine.lighting.groups.groups.map((_, g) => g);
    const uv = uvGrid(...GRID);
    const fresh = await read({ uv }, layers, result.lights);
    result.layers = fresh.values.map(encodeGrid);
    result.lightBuffer = fresh.lightBuffer;
    result.canvas = fresh.canvas;
    if (step7Page) {
      try {
        await swapAccum(old, "master's");
        result.oldShaderLayers = (await read({ uv }, layers, result.lights)).values.map(encodeGrid);
      } finally {
        await cleanUp(result, "restoring step 7's light-accum.wgsl", () => swapAccum(live, "step 7's"));
      }
    }
    // Every read came before the restore: the result stands, with the restore's failure if any.
    results.push(result);
    if (result.cleanupErrors || (step7Page && LightAccumStage.SHADER_SOURCE !== live)) {
      throw new Error(`step 7's light-accum.wgsl did not come back${result.cleanupErrors ? `: ${result.cleanupErrors.join('; ')}` : ''}`);
    }
  };

  // ── order ──────────────────────────────────────────────────────────────
  const runOrder = async () => {
    // Every option checked before the engine is touched.
    const K = count(opts.K ?? 3, 'K');
    const apart = count(opts.apart ?? 256, 'apart');
    const blend = opts.blend ?? 'add';
    if (!BLENDS.includes(blend)) throw new Error(`blend must be one of ${BLENDS.join(', ')}, got ${JSON.stringify(blend)}`);
    const reads = count(opts.reads ?? 240, 'reads');
    const atomic = flag(opts.atomic ?? false, 'atomic');
    const rows = 1 + K + (K - 1) * (apart - 1);
    if (rows > MAX_ROWS) throw new Error(`K ${K} lights ${apart} apart need ${rows} rows, more than the ${MAX_ROWS} of the GPU buffers`);
    const rawCull = atomic ? (await import('/src/shaders/cull.wgsl?raw')).default : null;
    await clearEntities();
    const sceneHdr = await setView();
    await lightUp();
    const result = { task: 'order', label, K, apart, blend, reads, atomic, sceneHdr, gridSize: GRID, ambient: AMBIENT };
    let before = null;
    if (atomic) {
      before = liveCullClass().SUBGROUP_CONFIG;
      if (before.useSubgroups !== true) {
        throw new Error(`'order' with atomic: true forces the atomic path from the subgroup one, but the live cull's useSubgroups is ${before.useSubgroups}: no 32-lane subgroups on this device (Safari has none: its runs are atomic already)`);
      }
    }
    try {
      if (atomic) await rebuildCull({ ...before, useSubgroups: false }, rawCull, 'atomic');
      const lights = [];
      engine.batch(() => {
        spawnFloor();
        for (let j = 0; j < K; j++) {
          lights.push(pointLight(j, K, blend));
          if (j < K - 1) for (let f = 1; f < apart; f++) spawnFiller();
        }
      });
      await settleScene();
      result.cullPath = cullPathNow();
      result.lights = lightsOf(lights);
      result.list = listNow();
      result.groups = groupsNow();
      const uv = uvGrid(...GRID);
      const distinct = [];
      const sequence = [];
      for (let r = 0; r < reads; r++) {
        const got = await read({ uv }, [0], result.lights);
        if (r === 0) {
          result.lightBuffer = got.lightBuffer;
          result.canvas = got.canvas;
        }
        const grid = encodeGrid(got.values[0]);
        const hash = fnv1a(grid.data);
        let k = distinct.findIndex((d) => d.hash === hash && d.grid.data === grid.data);
        if (k < 0 && distinct.length < MAX_GRIDS) {
          distinct.push({ hash, firstRead: r, grid });
          k = distinct.length - 1;
        }
        sequence.push(k);
      }
      result.distinct = distinct;
      result.sequence = sequence;
    } finally {
      if (atomic) {
        result.cullPathRestored = null;
        await cleanUp(result, 'restoring the subgroup cull', async () => {
          await rebuildCull(before, rawCull, 'subgroup');
          const path = cullPathNow();
          if (path !== 'subgroup') throw new Error(`the live cull is on the ${path} path after the restore`);
          result.cullPathRestored = path;
        });
      }
    }
    results.push(result);
    if (result.cleanupErrors) throw new Error(`the subgroup cull did not come back: ${result.cleanupErrors.join('; ')}`);
  };

  // ── permute ────────────────────────────────────────────────────────────
  const runPermute = async () => {
    await clearEntities();
    const sceneHdr = await setView();
    await lightUp();
    let filler = null;
    const lights = [];
    engine.batch(() => {
      spawnFloor();
      filler = spawnFiller();
      for (let j = 0; j < 3; j++) lights.push(pointLight(j, 3, 'add'));
    });
    const uv = uvGrid(...GRID);
    const readNow = async () => {
      await settleScene();
      const at = lightsOf(lights);
      const got = await read({ uv }, [0], at);
      return { grid: encodeGrid(got.values[0]), lights: at, list: listNow(), got };
    };
    const first = await readNow();
    const cullPath = cullPathNow();
    // Below the lights: the last row, the third light, moves into its slot.
    filler.destroy();
    const second = await readNow();
    results.push({
      task: 'permute', label, cullPath, sceneHdr, gridSize: GRID, ambient: AMBIENT, groups: groupsNow(),
      lightBuffer: first.got.lightBuffer, canvas: first.got.canvas,
      first: { grid: first.grid, lights: first.lights, list: first.list },
      second: { grid: second.grid, lights: second.lights, list: second.list },
    });
  };

  // ── grow ───────────────────────────────────────────────────────────────
  const runGrow = async () => {
    if ((await groupsReady()).lightOrder === undefined) {
      throw new Error("'grow' drives the growth of round step 7's light list buffer, but engine.lighting.groups has no lightOrder on this page: master (or any build before step 7) has no light list to grow");
    }
    if (typeof Math.f16round !== 'function') {
      throw new Error("'grow' computes its expected values with Math.f16round: a browser with Float16Array is needed");
    }
    await clearEntities();
    const sceneHdr = await setView();
    await lightUp();
    const cells = [];
    engine.batch(() => {
      spawnFloor();
      for (let j = 0; j < GROW.n; j++) {
        for (let i = 0; i < GROW.n; i++) {
          const x = GROW.x0 + GROW.dx * i;
          const y = GROW.y0 + GROW.dy * j;
          const color = LIGHT_COLORS[(i + j) % 4];
          const handle = keep(engine.spawn().position(x, y).light({ type: 'point', color, energy: 1, range: GROW.range, falloff: 0 }));
          cells.push({ x, y, color, handle });
        }
      }
    });
    // Neighbours along a row, then along a column: every midpoint is out of both lights' range.
    const midpoints = [];
    for (let j = 0; j < GROW.n; j++) for (let i = 0; i + 1 < GROW.n; i++) midpoints.push([GROW.x0 + GROW.dx * (i + 0.5), GROW.y0 + GROW.dy * j]);
    for (let j = 0; j + 1 < GROW.n; j++) for (let i = 0; i < GROW.n; i++) midpoints.push([GROW.x0 + GROW.dx * i, GROW.y0 + GROW.dy * (j + 0.5)]);
    const points = [...cells.map((c) => [c.x, c.y]), ...midpoints];
    const readGrow = async () => {
      await settleScene();
      // The clear: the f32 ambient of the render state, rounded once by the rgba16float light buffer.
      const ambient = engine.lighting.ambient.slice(0, 3).map((v) => Math.f16round(v));
      const lights = lightsOf(cells.filter((c) => c.handle.alive).map((c) => c.handle));
      const list = listNow();
      const got = await read({ world: points }, [0], lights);
      const want = [
        ...cells.map((c) => (c.handle.alive ? ambient.map((a, k) => Math.f16round(a + c.color[k])) : ambient)),
        ...midpoints.map(() => ambient),
      ];
      let worst = null;
      got.values[0].forEach((v, p) => {
        for (let k = 0; k < 3; k++) {
          const ulps = fp16Steps(v[k], want[p][k]);
          if (worst === null || !(ulps <= worst.ulps)) {
            worst = { ulps, point: points[p], kind: p < cells.length ? 'centre' : 'midpoint', channel: k, measured: v[k], expected: want[p][k] };
          }
        }
      });
      return {
        values: got.values[0], lightBuffer: got.lightBuffer, canvas: got.canvas,
        record: { lights, lightOrderLength: list.lightOrder.length, list, worstUlps: worst.ulps, worst, grid: encodeGrid(got.values[0]) },
      };
    };
    const first = await readGrow();
    for (const c of cells.slice(0, GROW.destroyed)) c.handle.destroy();
    const second = await readGrow();
    const same = (a, b) => a.every((x, k) => x === b[k]);
    const remainingChanged = cells.map((_, p) => p).filter((p) => p >= GROW.destroyed && !same(first.values[p], second.values[p])).length;
    results.push({
      task: 'grow', label, sceneHdr, ambient: AMBIENT, grow: GROW, lightColors: LIGHT_COLORS, points: points.length,
      lightBuffer: first.lightBuffer, canvas: first.canvas,
      first: first.record, second: second.record, remainingChanged,
    });
  };

  // ── scene ──────────────────────────────────────────────────────────────
  const runScene = async () => {
    const phase = opts.phase;
    if (![1, 2, 3].includes(phase)) throw new Error(`'scene' needs phase 1, 2 or 3, got ${JSON.stringify(phase)}`);
    const prev = window.__step7Scene ?? null;
    let resize;
    if (phase === 1) {
      resize = flag(opts.resize ?? false, 'resize');
      if (engine.mode === 'A' && resize) {
        throw new Error("in Mode A run 'scene' with resize: false: there is no probe to check the size, and the screenshot keeps the page's canvas (and the render worker's camera, .claude/skills/gpu-check/SKILL.md §7)");
      }
      if (engine.mode === 'A' && (prev !== null || entities.length > 0)) {
        throw new Error("in Mode A 'scene' phase 1 must be the first task of a freshly loaded page: the bridge drops empty render states, so a cleared world is never seen (reload the page)");
      }
    } else {
      if (opts.resize !== undefined) throw new Error('resize is an option of phase 1: phases 2 and 3 change its scene in place');
      if (!prev || prev.phase !== phase - 1) {
        throw new Error(`'scene' phase ${phase} follows phase ${phase - 1} on this page, ${prev ? `not phase ${prev.phase}` : 'and no phase ran here'}`);
      }
      resize = prev.resize;
    }
    // The render worker's view is 20·a x 20 (gpu-check §7), and so is the main
    // thread's after the page's own resize: the floor point must be in it.
    const dpr = window.devicePixelRatio;
    const aspect = resize ? WIDTH / HEIGHT : Math.floor(canvas.clientWidth * dpr) / Math.floor(canvas.clientHeight * dpr);
    if (!(10 * aspect > 12.5)) {
      throw new Error(`the view is ${(20 * aspect).toFixed(2)} x 20 world units (aspect ${aspect.toFixed(3)}): the floor point (-12, -7) needs 10·a > 12.5; widen the window (1200x689 CSS gives a = 1.57)`);
    }
    let s;
    let sceneHdr = null;
    if (phase === 1) {
      if (engine.mode !== 'A') await clearEntities();
      sceneHdr = await setView(resize);
      engine.lighting.setAmbient(AMBIENT, 1);
      engine.lighting.setBackend('lit');
      s = {};
      engine.batch(() => {
        s.floor = spawnFloor();
        for (const [name, l] of Object.entries(SCENE_LIGHTS)) {
          const h = engine.spawn({ mode: '2d' }).position(...l.at).depth(l.depth);
          if (l.transparent) h.transparent();
          s[name] = keep(h.light({ type: 'point', color: l.color, energy: 1, range: l.range, falloff: 0, blend: l.blend }));
        }
      });
      // Phase 0 until this one ends: a later phase refuses to follow a phase 1 that failed.
      window.__step7Scene = { phase: 0, resize, ...s };
    } else {
      s = prev;
      const depths = SCENE_DEPTHS[phase];
      if (phase === 3) s.M.destroy();
      s.P.depth(depths.P);
      s.Q.depth(depths.Q);
    }
    if (engine.mode === 'A') {
      if (phase === 1) await untilRow('the scene in the render state (its last entity)', s.Q, () => true);
      if (phase === 3) {
        await until(`M (entity ${s.M.id}) gone from the render state`, () => !engine.bridge.latestRenderState.entityIds.includes(s.M.id));
      }
    } else {
      await settledAt(phase === 3 ? 4 : 5);
    }
    if (phase === 1) {
      await untilLit();
      await untilAmbient();
    }
    const depths = SCENE_DEPTHS[phase];
    for (const name of ['R', 'P', 'Q']) await untilDepth(s[name], depths[name], name);
    await frames(engine.mode === 'A' ? MODE_A_FRAMES : SETTLE_FRAMES);
    const names = phase === 3 ? ['R', 'P', 'Q'] : ['M', 'R', 'P', 'Q'];
    const lights = lightsOf(names.map((n) => s[n]));
    if (phase === 3) {
      const slot = (n) => lights[names.indexOf(n)].slot;
      if (!(slot('Q') < slot('P'))) {
        throw new Error(`phase 3: slot(Q) ${slot('Q')} >= slot(P) ${slot('P')}: the screenshot could not tell the id rule from the slot order`);
      }
    }
    const result = {
      task: 'scene', label, phase, resize, aspect, sceneHdr,
      ids: { floor: s.floor.id, M: s.M.id, R: s.R.id, P: s.P.id, Q: s.Q.id },
      lights, depths, points: SCENE_POINTS, expected8: expected8(phase),
      list: listNow(), groups: groupsNow(), ambient: AMBIENT, sceneLights: SCENE_LIGHTS,
    };
    if (engine.mode !== 'A') {
      const at = Object.keys(SCENE_POINTS);
      const got = await read({ world: at.map((n) => SCENE_POINTS[n]) }, [0], lights);
      result.measured = Object.fromEntries(at.map((n, p) => [n, got.values[0][p]]));
      result.maxDiff = Math.max(...at.flatMap((n, p) => [0, 1, 2].map((c) =>
        Math.abs(255 * Math.min(Math.max(got.values[0][p][c], 0), 1) - result.expected8[n][c]))));
      result.lightBuffer = got.lightBuffer;
      result.canvas = got.canvas;
    }
    window.__step7Scene.phase = phase;
    results.push(result);
  };

  const run = { regress: runRegress, order: runOrder, permute: runPermute, grow: runGrow, scene: runScene }[task];
  await run();

  let adapter = null;
  try {
    const a = await navigator.gpu?.requestAdapter();
    adapter = a ? { vendor: a.info?.vendor ?? '', architecture: a.info?.architecture ?? '', description: a.info?.description ?? '' } : null;
  } catch {
    adapter = null;
  }
  let chrome = null;
  let platformVersion = null;
  try {
    const high = await navigator.userAgentData?.getHighEntropyValues(['fullVersionList', 'platformVersion']);
    chrome = high?.fullVersionList ?? null;
    platformVersion = high?.platformVersion ?? null;
  } catch {
    chrome = null;
    platformVersion = null;
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
    userAgent: navigator.userAgent,
    platformVersion,
    results,
  };
}
