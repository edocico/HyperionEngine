async () => {
  // Mac M2 handoff, test M5 (docs/handoff/2026-09-29-mac-m2-handoff.md §4):
  // does cull.wgsl's subgroup path file every visible entity in the right
  // bucket on this GPU, index by index? Paste this whole file as the
  // `function` of chrome-devtools evaluate_script on
  // http://localhost:5173/?mode=B&bench (served by `npm run dev`: the dynamic
  // imports below resolve through Vite), with filePath
  // docs/plans/assets/2026-09-29-mac-m2/cull-subgroup-check.json. It returns a
  // small summary whose `ok` is the M5 verdict. It takes seconds; a 60 s
  // budget stops it early, and then `ok` is false.
  //
  // Why index sets and not counts: under a lane mapping other than the one
  // the shader assumes (sg_id = lid / 32, cull.wgsl:132-134), the per-bucket
  // COUNTS stay right while the INDICES land in the wrong places, duplicates
  // and holes, with no error (CLAUDE.md, "correct ONLY at exactly 32 lanes").
  // The live renderer's buffers cannot be read back (visible-indices is
  // STORAGE only, indirect-args has no COPY_SRC), so everything here is built
  // on a FRESH adapter and device with 'subgroups': window.__hyperion, the
  // live device, CullPass.SHADER_SOURCE and CullPass.SUBGROUP_CONFIG are
  // never touched, every buffer is this script's and is destroyed at the end.
  //
  // 1. Lane probes. The handoff's WGSL: each subgroup must be 32 contiguous
  //    invocations, o[l] = (l & ~31) * 1000 + (l | 31). Then which invocation
  //    subgroupElect() picks, since cull.wgsl phase 1 writes each subgroup's
  //    counts through it: WGSL elects the lowest subgroup_invocation_id and
  //    leaves where that sits in l open. laneProbe.firstLaneLowest says
  //    whether it is l % 32 == 0 in every subgroup.
  // 2. Five pipelines from the cull.wgsl on disk, entry cull_main, on the
  //    6-binding layout of cull-pass.ts:167-176; constants are
  //    {USE_SUBGROUPS, SUBGROUP_SIZE, USE_SUBGROUP_ID}:
  //    - live: prepareShaderSource(src, true, true), {1, 32, 1}: exactly what
  //      the live renderer runs on an adapter with subgroups 32-32 and the
  //      'subgroup_id' language feature (this Mac, M0). report.liveConfig
  //      re-derives that choice on this adapter with the renderer's own
  //      predicates (capabilities.ts: detectSubgroupSupport,
  //      subgroupCullSupported), so the label is checked, not assumed;
  //    - handoff: prepareShaderSource(src, true), {1, 32, 0};
  //    - atomic: prepareShaderSource(src, false), {0, 32, 0}: every other adapter;
  //    - wrongWidth, negative control: prepareShaderSource(src, true), {1, 16, 0},
  //      a lane mapping this hardware does not have. It MUST fail, or the
  //      check has no teeth and the verdict is void;
  //    - wrongWidthMax16, negative control: the same with MAX_SUBGROUPS
  //      patched from 8 to 16, so that no workgroup array overflows. That is
  //      the AMD failure class itself: every count right, the sets wrong
  //      (controls.wrongWidthMax16CountsRight records whether the GPU showed
  //      exactly that; it is not part of `ok`). It fails only when the elected
  //      invocation is in the first half of its 32: the second half then adds
  //      the whole subgroup's count to its prefix. With one in the second half
  //      elected (the last, say) it computes the right answer, so it is
  //      required to fail only when firstLaneLowest
  //      (controls.wrongWidthMax16Required).
  //    The controls write only output buffers of their own: their inputs are
  //    read-only bindings, and robustness clamps a stray write into its binding.
  // 3. Cases: N in {1000, 99937, 100000} x seeds 1-10 x 4 scenarios: 'mixed'
  //    (centres in [-20,20]^2, ~30% visible), 'half' (~50%), 'all' (100%) and
  //    'runs' (runs of 1-96 entities sharing visibility and bucket, which
  //    cross subgroup and workgroup edges). Frustum: the box |x|, |y| <= 10,
  //    |z| <= 1000, planes (±1,0,0,10), (0,±1,0,10), (0,0,±1,1000); radius 0.5.
  //    Every coordinate is a multiple of 1/64, so every plane distance is
  //    exact in f32 and the CPU reference cannot differ from the GPU through
  //    rounding or FMA. One entity in 16 sits on a plane: exactly at
  //    dist == -radius (VISIBLE: the test is a strict <), one 1/64 outside, or
  //    one 1/64 inside. renderMeta[2i+1]: type 0-7, now and then 8-255 (7 and
  //    up are clamped to 6), bit 8 random, bits 9-31 random; texIndices: tier
  //    0 or 1-7, bit 31 random, bits 19-30 and the layer random. Two visible
  //    entities per slot are forced, so all 28 slots are populated every time.
  //    M (maxEntitiesPerType, the region size) = MAX_GPU_ENTITIES (100000)
  //    for every N, as CullPass.prepare writes it (uniform word 25 and
  //    firstInstance = slot * M); at N = 100000 it is also the handoff's M = N.
  // 4. Per case, pipeline and slot b: indexCount, firstIndex, baseVertex and
  //    firstInstance untouched (6, 0, 0, b * M); instanceCount == the CPU
  //    count; the window visible[b*M, b*M + count) holds exactly the CPU set
  //    (every entry a member of it and none twice, hence no hole); the rest
  //    of the region still holds the 0xFFFFFFFF it was filled with.
  // 5. Comparator self-test, the other negative control, on a passing
  //    readback. Three injections keep every count right: one duplicate +
  //    hole, one index moved to another slot, two indices swapped between
  //    slots. Three more are each visible to ONE criterion of item 4 only, so
  //    that each is shown to fire on its own: instanceCount + 1 (the count),
  //    a copy of an index just past a window (the tail), firstInstance + 1
  //    (the args left untouched). Each of the six must fail.
  //
  // ok = both lane probes ran clean and the lanes are 32 contiguous &&
  // liveConfig says the renderer runs 'live' on this adapter && live, handoff
  // and atomic pass every case with no compile or scope error && the
  // controls fail on the comparison with no GPU error (wrongWidth always,
  // wrongWidthMax16 when it is required) && the self-test passes && the
  // matrix ran in full with the coverage it claims (exact values, ties, near
  // misses, every slot populated, 'all' fully visible) && no set-up or
  // per-case upload raised a GPU error.
  const t0 = performance.now();
  const BUDGET_MS = 60000;
  const SIZES = [1000, 99937, 100000];
  const SEEDS = 10;
  const SCENARIOS = ['mixed', 'half', 'all', 'runs'];
  const Q = 64;         // coordinates are multiples of 1/Q
  const RADIUS = 0.5;
  const XY = 10;        // planes (±1,0,0,XY), (0,±1,0,XY)
  const ZW = 1000;      // planes (0,0,±1,ZW)
  const SLOTS = 28;
  const WG = 256;
  const SENTINEL = 0xFFFFFFFF;
  const MAX_FAILURES = 5;
  const MAX_SAMPLES = 4;
  const MAX_MESSAGES = 5;

  const cullPass = await import('/src/render/passes/cull-pass.ts');
  const { MAX_GPU_ENTITIES } = await import('/src/types.ts');
  const { detectSubgroupSupport, subgroupCullSupported } = await import('/src/capabilities.ts');
  const src = (await import('/src/shaders/cull.wgsl?raw')).default;
  // slotOf below is written from cull.wgsl: stop if the bucket layout moved.
  if (cullPass.TOTAL_DRAW_BUCKETS !== SLOTS || cullPass.OPAQUE_DRAW_BUCKETS !== 14 || cullPass.NUM_PRIM_TYPES !== 7
    || !src.includes('const NUM_PRIM_TYPES: u32 = 7u;')) {
    throw new Error('the cull bucket layout changed (cull-pass.ts / cull.wgsl): update slotOf and SLOTS here');
  }
  const { prepareShaderSource } = cullPass;
  const M = MAX_GPU_ENTITIES;
  const ARGS_WORDS = SLOTS * 5;
  const ARGS_BYTES = ARGS_WORDS * 4;
  const VIS_BYTES = SLOTS * M * 4;

  // The bucket of a visible entity (cull.wgsl:92-103 and 137-138 / 196-197).
  const slotOf = (meta1, tex) => ((meta1 & 0x100) !== 0 ? 14 : 0) + Math.min(meta1 & 0xFF, 6) * 2
    + ((((tex >>> 16) & 7) > 0 || (tex >>> 31) !== 0) ? 1 : 0);

  // ---- Data -----------------------------------------------------------
  const mulberry32 = (seed) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), a | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (t ^ (t >>> 14)) >>> 0;
    };
  };
  const below = (rng, n) => Math.floor((rng() / 4294967296) * n);
  const grid = (rng, lo, hi) => (lo * Q + below(rng, (hi - lo) * Q + 1)) / Q;
  const sign = (rng) => ((rng() & 1) !== 0 ? 1 : -1);
  const caseSeedOf = (seed, N, sc) =>
    (Math.imul(seed, 0x9E3779B1) ^ Math.imul(N, 0x85EBCA6B) ^ Math.imul(sc + 1, 0xC2B2AE35)) >>> 0;

  const bounds = new Float32Array(M * 4);
  const meta = new Uint32Array(M * 2);
  const tex = new Uint32Array(M);
  const expSlot = new Uint8Array(M);      // 255 = not visible
  const texWord = (tier, ovf, rng) => ((ovf << 31) | (rng() & 0x7FF80000) | (tier << 16) | (rng() & 0xFFFF)) >>> 0;
  const randomMeta1 = (rng) => {
    const type = below(rng, 32) === 0 ? 8 + below(rng, 248) : below(rng, 8);
    return ((rng() & 0xFFFFFE00) | ((rng() & 1) << 8) | type) >>> 0;
  };
  const randomTex = (rng) => texWord((rng() & 1) !== 0 ? 0 : 1 + below(rng, 7), below(rng, 4) === 0 ? 1 : 0, rng);
  // Attributes that land in slot s (types 6 and 7 both clamp to 6).
  const slotMeta1 = (rng, s) => {
    const prim = (s % 14) >> 1;
    const type = prim === 6 ? 6 + (rng() & 1) : prim;
    return ((rng() & 0xFFFFFE00) | ((s >= 14 ? 1 : 0) << 8) | type) >>> 0;
  };
  const slotTex = (rng, s) => {
    if (((s % 14) & 1) === 0) return texWord(0, 0, rng);
    return (rng() & 1) !== 0 ? texWord(1 + below(rng, 7), rng() & 1, rng) : texWord(0, 1, rng);
  };
  const place = (i, x, y, z) => { bounds[4 * i] = x; bounds[4 * i + 1] = y; bounds[4 * i + 2] = z; };
  // An entity whose visibility one plane decides: offset 0 = the tie
  // (dist == -radius, visible), +1 = one quantum outside, -1 = one inside.
  const ANY = [0, 1, -1];
  const KEEP_VISIBLE = [0, -1];
  const OUTSIDE = [1];
  const onPlane = (rng, i, offsets) => {
    const axis = below(rng, 3);
    const p = [grid(rng, -XY, XY), grid(rng, -XY, XY), 0];
    p[axis] = sign(rng) * ((axis === 2 ? ZW : XY) + RADIUS + offsets[below(rng, offsets.length)] / Q);
    place(i, p[0], p[1], p[2]);
  };
  const generate = (scenario, N, rng) => {
    for (let i = 0; i < N; i++) { bounds[4 * i + 3] = RADIUS; meta[2 * i] = rng(); }
    if (scenario === 'runs') {
      for (let i = 0; i < N;) {
        const end = Math.min(N, i + 1 + below(rng, 96));
        const visible = (rng() & 1) !== 0;
        const m1 = randomMeta1(rng);
        const tx = randomTex(rng);
        for (; i < end; i++) {
          meta[2 * i + 1] = m1;
          tex[i] = tx;
          if (below(rng, 16) === 0) onPlane(rng, i, visible ? KEEP_VISIBLE : OUTSIDE);
          else if (visible) place(i, grid(rng, -XY, XY), grid(rng, -XY, XY), 0);
          else place(i, sign(rng) * grid(rng, XY + 1, 2 * XY), grid(rng, -2 * XY, 2 * XY), 0);
        }
      }
    } else {
      const [xr, yr] = scenario === 'mixed' ? [2 * XY, 2 * XY]
        : scenario === 'half' ? [XY + RADIUS, 2 * XY + 1] : [XY + RADIUS, XY + RADIUS];
      const offsets = scenario === 'all' ? KEEP_VISIBLE : ANY;
      for (let i = 0; i < N; i++) {
        meta[2 * i + 1] = randomMeta1(rng);
        tex[i] = randomTex(rng);
        if (below(rng, 16) === 0) onPlane(rng, i, offsets);
        else place(i, grid(rng, -xr, xr), grid(rng, -yr, yr), below(rng, 8) === 0 ? grid(rng, -1, 1) : 0);
      }
    }
    const taken = new Set();
    for (let j = 0; j < 2 * SLOTS; j++) {
      let i;
      do { i = below(rng, N); } while (taken.has(i));
      taken.add(i);
      place(i, grid(rng, -XY, XY), grid(rng, -XY, XY), 0);
      meta[2 * i + 1] = slotMeta1(rng, j % SLOTS);
      tex[i] = slotTex(rng, j % SLOTS);
    }
  };

  // CPU reference, from the same f32 arrays the GPU reads.
  const planes = new Float32Array([1, 0, 0, XY, -1, 0, 0, XY, 0, 1, 0, XY, 0, -1, 0, XY, 0, 0, 1, ZW, 0, 0, -1, ZW]);
  const reference = (N) => {
    const counts = new Uint32Array(SLOTS);
    let visible = 0;
    let ties = 0;
    let nearOut = 0;
    let exact = true;
    for (let i = 0; i < N; i++) {
      const x = bounds[4 * i];
      const y = bounds[4 * i + 1];
      const z = bounds[4 * i + 2];
      const r = bounds[4 * i + 3];
      if (!Number.isInteger(x * Q) || !Number.isInteger(y * Q) || !Number.isInteger(z * Q)
        || Math.abs(x) + Math.abs(y) + Math.abs(z) > 2048) exact = false;
      let vis = true;
      let tie = false;
      let near = true;
      for (let p = 0; p < 24; p += 4) {
        const d = planes[p] * x + planes[p + 1] * y + planes[p + 2] * z + planes[p + 3];
        if (d < -r) { vis = false; if (d !== -r - 1 / Q) near = false; } else if (d === -r) tie = true;
      }
      if (vis) {
        const s = slotOf(meta[2 * i + 1], tex[i]);
        expSlot[i] = s;
        counts[s]++;
        visible++;
        if (tie) ties++;
      } else {
        expSlot[i] = 255;
        if (near) nearOut++;
      }
    }
    return { N, counts, expSlot, visible, ties, nearOut, exact };
  };

  // ---- Comparator -----------------------------------------------------
  // words: the readback, args (SLOTS x 5) then the SLOTS regions of M words.
  const seen = new Uint8Array(M);
  const compare = (words, ref, detail) => {
    const { N, counts, expSlot: exp } = ref;
    seen.fill(0, 0, N);
    let pass = true;
    let countsOk = true;
    const failing = [];
    for (let b = 0; b < SLOTS; b++) {
      const a = b * 5;
      const cnt = counts[b];
      const gpu = words[a + 1];
      const argsIntact = words[a] === 6 && words[a + 2] === 0 && words[a + 3] === 0 && words[a + 4] === b * M;
      if (gpu !== cnt) countsOk = false;
      const base = ARGS_WORDS + b * M;
      const s = detail ? { dup: [], holes: [], foreign: [], stray: [] } : null;
      let found = 0;
      let dup = 0;
      let foreign = 0;
      let stray = 0;
      for (let k = 0; k < cnt; k++) {
        const v = words[base + k];
        if (v >= N || exp[v] !== b) {
          foreign++;
          if (s && s.foreign.length < MAX_SAMPLES) {
            s.foreign.push({ at: k, v: v === SENTINEL ? 'unwritten' : v, itsSlot: v < N ? exp[v] : null });
          }
        } else if (seen[v] !== 0) {
          dup++;
          if (s && s.dup.length < MAX_SAMPLES) s.dup.push(v);
        } else {
          seen[v] = 1;
          found++;
        }
      }
      for (let k = base + cnt, end = base + M; k < end; k++) {
        if (words[k] !== SENTINEL) {
          stray++;
          if (s && s.stray.length < MAX_SAMPLES) s.stray.push({ at: k - base, v: words[k] });
        }
      }
      const holes = cnt - found;
      if (gpu !== cnt || !argsIntact || dup + foreign + stray + holes > 0) {
        pass = false;
        failing.push({ slot: b, cpuCount: cnt, gpuCount: gpu, argsIntact, dup, holes, foreign, stray, samples: s });
      }
    }
    if (detail) {
      for (const f of failing) {
        for (let i = 0; i < N && f.holes > 0 && f.samples.holes.length < MAX_SAMPLES; i++) {
          if (exp[i] === f.slot && seen[i] === 0) f.samples.holes.push(i);
        }
      }
    }
    return { pass, countsOk, failing };
  };

  // ---- GPU --------------------------------------------------------------
  const report = {
    ok: false,
    adapter: null,
    sgMin: null,
    sgMax: null,
    liveConfig: null,
    laneProbe: {
      ok: false, subgroups: 0, mismatchCount: null, mismatches: [], firstLaneLowest: false, elected: null, errors: [],
    },
    pipelines: {},
    cases: {},
    controls: {},
    coverage: {},
    config: {
      M, sizes: SIZES, seeds: SEEDS, scenarios: SCENARIOS, quantum: `1/${Q}`, radius: RADIUS,
      frustum: `|x|,|y| <= ${XY}, |z| <= ${ZW}`, planned: SIZES.length * SEEDS * SCENARIOS.length,
    },
    setupErrors: [],
    error: null,
    deviceLost: null,
    elapsedMs: 0,
  };
  const made = [];
  let device = null;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('navigator.gpu.requestAdapter() returned null');
    const info = adapter.info ?? {};
    report.adapter = { vendor: info.vendor, architecture: info.architecture, description: info.description, fallback: info.isFallbackAdapter };
    report.sgMin = info.subgroupMinSize ?? null;
    report.sgMax = info.subgroupMaxSize ?? null;
    // What the renderer picks on this adapter (renderer.ts:222-256 and
    // 380-400): the subgroup path with subgroup_id needs 'subgroups', the
    // 'subgroup_id' language feature and subgroups of exactly 32 lanes. Not
    // visible from here: its fallback to the atomic path when its own first
    // requestDevice fails (renderer.ts:232-239).
    const sgSupport = detectSubgroupSupport(adapter.features);
    report.liveConfig = {
      subgroups: sgSupport.supported,
      subgroupId: sgSupport.hasSubgroupId,
      width32: subgroupCullSupported(adapter.info),
    };
    report.liveConfig.rendererRunsLive = report.liveConfig.subgroups && report.liveConfig.subgroupId
      && report.liveConfig.width32;
    device = await adapter.requestDevice({ requiredFeatures: ['subgroups'] });
    const dev = device;
    dev.lost.then((l) => { if (l.reason !== 'destroyed') report.deviceLost = `${l.reason}: ${l.message}`; });
    const U = GPUBufferUsage;
    const buffer = (size, usage, label) => {
      const b = dev.createBuffer({ size, usage, label: `m5-${label}` });
      made.push(b);
      return b;
    };
    const scoped = async (fn) => {
      dev.pushErrorScope('internal');
      dev.pushErrorScope('out-of-memory');
      dev.pushErrorScope('validation');
      let value;
      let thrown = null;
      try { value = await fn(); } catch (err) { thrown = String(err); }
      const errors = [];
      for (const kind of ['validation', 'out-of-memory', 'internal']) {
        const e = await dev.popErrorScope();
        if (e) errors.push(`${kind}: ${e.message}`);
      }
      if (thrown) errors.push(`threw: ${thrown}`);
      return { value, errors };
    };
    const messagesOf = async (module) => {
      const out = { errors: [], warnings: [] };
      for (const m of (await module.getCompilationInfo()).messages) {
        const list = m.type === 'error' ? out.errors : out.warnings;
        if (list.length < MAX_MESSAGES) list.push(`${m.type} ${m.lineNum}:${m.linePos} ${m.message}`);
      }
      return out;
    };

    // 1. Lane probes: one workgroup of 256 invocations, o[0..255] read back.
    const runProbe = async (code, entryPoint, label) => {
      const probeOut = buffer(WG * 4, U.STORAGE | U.COPY_SRC, label);
      const probeRead = buffer(WG * 4, U.MAP_READ | U.COPY_DST, `${label}-read`);
      const compileErrors = [];
      const { value, errors } = await scoped(async () => {
        const module = dev.createShaderModule({ code, label: `m5-${label}` });
        compileErrors.push(...(await messagesOf(module)).errors);
        const pipeline = dev.createComputePipeline({ layout: 'auto', compute: { module, entryPoint }, label: `m5-${label}` });
        const bindGroup = dev.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: probeOut } }] });
        const enc = dev.createCommandEncoder();
        const pass = enc.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(1);
        pass.end();
        enc.copyBufferToBuffer(probeOut, 0, probeRead, 0, WG * 4);
        dev.queue.submit([enc.finish()]);
        await probeRead.mapAsync(GPUMapMode.READ);
        const words = new Uint32Array(probeRead.getMappedRange()).slice();
        probeRead.unmap();
        return words;
      });
      return { got: value, errors: [...compileErrors, ...errors].map((e) => `${label}: ${e}`) };
    };
    const LANE_PROBE = [
      'enable subgroups;',
      '@group(0) @binding(0) var<storage, read_write> o: array<u32>;',
      '@compute @workgroup_size(256) fn m(@builtin(local_invocation_index) l: u32, @builtin(subgroup_size) s: u32) {',
      '  o[l] = select(0xFFFFFFFFu, subgroupMin(l) * 1000u + subgroupMax(l), s == 32u);',
      '}',
    ].join('\n');
    // The builtin cull.wgsl phase 1 calls, as it calls it: every invocation active.
    const ELECT_PROBE = [
      'enable subgroups;',
      '@group(0) @binding(0) var<storage, read_write> o: array<u32>;',
      '@compute @workgroup_size(256) fn e(@builtin(local_invocation_index) l: u32) {',
      '  o[l] = select(0u, 1u, subgroupElect());',
      '}',
    ].join('\n');
    {
      const lane = await runProbe(LANE_PROBE, 'm', 'lane-probe');
      const elect = await runProbe(ELECT_PROBE, 'e', 'elect-probe');
      report.laneProbe.errors.push(...lane.errors, ...elect.errors);
      const got = lane.got;
      const groups = new Set();
      let bad = 0;
      for (let l = 0; l < WG; l++) {
        const want = (l & ~31) * 1000 + (l | 31);
        const v = got ? got[l] : undefined;
        if (v !== undefined && v !== SENTINEL) groups.add(v);
        if (v === want) continue;
        bad++;
        if (report.laneProbe.mismatches.length < 8) {
          report.laneProbe.mismatches.push({
            l, want: [l & ~31, l | 31],
            got: v === undefined ? null : v === SENTINEL ? 'subgroup_size != 32' : [Math.floor(v / 1000), v % 1000],
          });
        }
      }
      report.laneProbe.subgroups = groups.size;
      report.laneProbe.mismatchCount = bad;
      // The invocations subgroupElect() picked (expected 0, 32, ..., 224).
      const elected = [];
      for (let l = 0; elect.got && l < WG; l++) if (elect.got[l] !== 0) elected.push(l);
      report.laneProbe.elected = elected.slice(0, 16);
      report.laneProbe.firstLaneLowest = !!elect.got && elect.errors.length === 0
        && elect.got.every((v, l) => v === ((l & 31) === 0 ? 1 : 0));
      report.laneProbe.ok = bad === 0 && report.laneProbe.errors.length === 0;
    }

    // 2. Cull pipelines, buffers, bind groups.
    const MAX_SG_LINE = 'const MAX_SUBGROUPS: u32 = 8u;';
    const src16 = src.includes(MAX_SG_LINE) ? src.replace(MAX_SG_LINE, 'const MAX_SUBGROUPS: u32 = 16u;') : null;
    const specs = [
      { key: 'live', code: prepareShaderSource(src, true, true), constants: { USE_SUBGROUPS: 1, SUBGROUP_SIZE: 32, USE_SUBGROUP_ID: 1 }, control: false },
      { key: 'handoff', code: prepareShaderSource(src, true), constants: { USE_SUBGROUPS: 1, SUBGROUP_SIZE: 32, USE_SUBGROUP_ID: 0 }, control: false },
      { key: 'atomic', code: prepareShaderSource(src, false), constants: { USE_SUBGROUPS: 0, SUBGROUP_SIZE: 32, USE_SUBGROUP_ID: 0 }, control: false },
      { key: 'wrongWidth', code: prepareShaderSource(src, true), constants: { USE_SUBGROUPS: 1, SUBGROUP_SIZE: 16, USE_SUBGROUP_ID: 0 }, control: true },
      { key: 'wrongWidthMax16', code: src16 && prepareShaderSource(src16, true), constants: { USE_SUBGROUPS: 1, SUBGROUP_SIZE: 16, USE_SUBGROUP_ID: 0 }, control: true },
    ];
    const layouts = await scoped(async () => {
      const bindGroupLayout = dev.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
          { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
          { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        ],
        label: 'm5-cull-layout',
      });
      return { bindGroupLayout, pipelineLayout: dev.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }) };
    });
    report.setupErrors.push(...layouts.errors);
    if (layouts.errors.length > 0) throw new Error('the cull layouts raised GPU errors');
    const { bindGroupLayout: layout, pipelineLayout } = layouts.value;
    for (const p of specs) {
      const rep = (report.pipelines[p.key] = {
        built: false, compileErrors: [], compileWarnings: [], scopeErrors: [], errorRuns: 0, runErrors: [],
      });
      report.cases[p.key] = { passed: 0, failed: 0, countsRightSetsWrong: 0, failedBy: {}, firstFailures: [] };
      if (!p.code) {
        rep.compileErrors.push(`'${MAX_SG_LINE}' is not in cull.wgsl: control not built`);
        continue;
      }
      const { value, errors } = await scoped(async () => {
        const module = dev.createShaderModule({ code: p.code, label: `m5-cull-${p.key}` });
        const msgs = await messagesOf(module);
        rep.compileErrors.push(...msgs.errors);
        rep.compileWarnings.push(...msgs.warnings);
        return dev.createComputePipeline({
          layout: pipelineLayout,
          compute: { module, entryPoint: 'cull_main', constants: p.constants },
          label: `m5-cull-${p.key}`,
        });
      });
      rep.scopeErrors.push(...errors.slice(0, MAX_MESSAGES));
      p.pipeline = value;
      rep.built = !!value && errors.length === 0 && rep.compileErrors.length === 0;
    }

    const argsTemplate = new Uint32Array(ARGS_WORDS);
    for (let b = 0; b < SLOTS; b++) argsTemplate.set([6, 0, 0, 0, b * M], b * 5);
    const uniformData = new ArrayBuffer(112);
    new Float32Array(uniformData, 0, 24).set(planes);
    const uniformU32 = new Uint32Array(uniformData, 96, 4);
    let uniform;
    let boundsBuf;
    let metaBuf;
    let texBuf;
    let sentinel;
    let poison;
    let readback;
    const filled = (size, word, label) => {
      const b = dev.createBuffer({ size, usage: U.COPY_SRC, mappedAtCreation: true, label: `m5-${label}` });
      made.push(b);
      new Uint32Array(b.getMappedRange()).fill(word);
      b.unmap();
      return b;
    };
    const setup = await scoped(async () => {
      uniform = buffer(112, U.UNIFORM | U.COPY_DST, 'uniform');
      boundsBuf = buffer(M * 16, U.STORAGE | U.COPY_DST, 'bounds');
      metaBuf = buffer(M * 8, U.STORAGE | U.COPY_DST, 'render-meta');
      texBuf = buffer(M * 4, U.STORAGE | U.COPY_DST, 'tex-indices');
      sentinel = filled(VIS_BYTES, SENTINEL, 'sentinel');
      poison = filled(ARGS_BYTES, 0xDEADBEEF, 'poison');
      readback = buffer(ARGS_BYTES + VIS_BYTES, U.MAP_READ | U.COPY_DST, 'readback');
      const outputs = (label) => {
        const out = {
          vis: buffer(VIS_BYTES, U.STORAGE | U.COPY_SRC | U.COPY_DST, `${label}-visible-indices`),
          args: buffer(ARGS_BYTES, U.STORAGE | U.INDIRECT | U.COPY_SRC | U.COPY_DST, `${label}-indirect-args`),
        };
        out.bindGroup = dev.createBindGroup({
          layout,
          label: `m5-${label}`,
          entries: [
            { binding: 0, resource: { buffer: uniform } },
            { binding: 1, resource: { buffer: boundsBuf } },
            { binding: 2, resource: { buffer: out.vis } },
            { binding: 3, resource: { buffer: out.args } },
            { binding: 4, resource: { buffer: metaBuf } },
            { binding: 5, resource: { buffer: texBuf } },
          ],
        });
        return out;
      };
      const main = outputs('main');
      const controls = outputs('control');
      for (const p of specs) p.out = p.control ? controls : main;
    });
    report.setupErrors.push(...setup.errors);
    if (setup.errors.length > 0) throw new Error('buffer set-up raised GPU errors');

    // One dispatch: args and visible-indices reset, cull, both copied to the
    // readback (args first). Returns the mapped words; the caller unmaps.
    // The readback's args part is poisoned first, in a submit of its own: if
    // the cull's command buffer never ran, the previous run's words (maybe
    // the same case) cannot pass.
    const runOnce = async (p, N) => {
      const { errors } = await scoped(async () => {
        const pre = dev.createCommandEncoder();
        pre.copyBufferToBuffer(poison, 0, readback, 0, ARGS_BYTES);
        dev.queue.submit([pre.finish()]);
        dev.queue.writeBuffer(p.out.args, 0, argsTemplate);
        const enc = dev.createCommandEncoder();
        enc.copyBufferToBuffer(sentinel, 0, p.out.vis, 0, VIS_BYTES);
        const pass = enc.beginComputePass();
        pass.setPipeline(p.pipeline);
        pass.setBindGroup(0, p.out.bindGroup);
        pass.dispatchWorkgroups(Math.ceil(N / WG));
        pass.end();
        enc.copyBufferToBuffer(p.out.args, 0, readback, 0, ARGS_BYTES);
        enc.copyBufferToBuffer(p.out.vis, 0, readback, ARGS_BYTES, VIS_BYTES);
        dev.queue.submit([enc.finish()]);
      });
      await readback.mapAsync(GPUMapMode.READ);
      return { words: new Uint32Array(readback.getMappedRange()), errors };
    };

    // 3-4. The case matrix.
    const coverage = {
      cases: 0, uploadFailures: 0, exact: true, allFullyVisible: true, minSlotCount: Infinity, ties: 0, nearOut: 0,
      visibleFraction: {},
    };
    const fractions = {};
    let selfTestSource = null;
    let truncated = false;
    let runs = 0;
    let runMs = 0;
    matrix: for (const N of SIZES) {
      for (let seed = 1; seed <= SEEDS; seed++) {
        for (let sc = 0; sc < SCENARIOS.length; sc++) {
          if (performance.now() - t0 > BUDGET_MS) { truncated = true; break matrix; }
          const scenario = SCENARIOS[sc];
          const caseSeed = caseSeedOf(seed, N, sc);
          generate(scenario, N, mulberry32(caseSeed));
          const ref = reference(N);
          coverage.cases++;
          coverage.exact = coverage.exact && ref.exact;
          if (scenario === 'all' && ref.visible !== N) coverage.allFullyVisible = false;
          coverage.minSlotCount = Math.min(coverage.minSlotCount, ...ref.counts);
          coverage.ties += ref.ties;
          coverage.nearOut += ref.nearOut;
          (fractions[scenario] = fractions[scenario] ?? []).push(ref.visible / N);
          uniformU32[0] = N;       // totalEntities
          uniformU32[1] = M;       // maxEntitiesPerType
          const upload = await scoped(async () => {
            dev.queue.writeBuffer(uniform, 0, uniformData);
            dev.queue.writeBuffer(boundsBuf, 0, bounds, 0, 4 * N);
            dev.queue.writeBuffer(metaBuf, 0, meta, 0, 2 * N);
            dev.queue.writeBuffer(texBuf, 0, tex, 0, N);
          });
          if (upload.errors.length > 0) {
            // The GPU would cull the previous case's inputs: run nothing on
            // them, so no pipeline reaches `planned`, and say why.
            coverage.uploadFailures++;
            if (report.setupErrors.length < MAX_MESSAGES) {
              report.setupErrors.push(`upload, ${scenario} N=${N} seed=${seed}: ${upload.errors[0]}`);
            }
            continue;
          }
          for (const p of specs) {
            if (!report.pipelines[p.key].built) continue;
            const r0 = performance.now();
            const { words, errors } = await runOnce(p, N);
            const result = compare(words, ref, false);
            const c = report.cases[p.key];
            const rep = report.pipelines[p.key];
            if (errors.length > 0) {
              rep.errorRuns++;
              if (rep.runErrors.length < MAX_MESSAGES) rep.runErrors.push(`${scenario} N=${N} seed=${seed}: ${errors[0]}`);
            }
            if (result.pass && errors.length === 0) {
              c.passed++;
              if (!p.control && (!selfTestSource || (selfTestSource.key !== 'live' && p.key === 'live'))) {
                selfTestSource = {
                  key: p.key, words: words.slice(),
                  ref: { N, counts: ref.counts.slice(), expSlot: expSlot.slice(0, N) },
                };
              }
            } else {
              c.failed++;
              // Only a readback whose counts are all right and whose windows are
              // not (dup + foreign = holes > 0). A run that failed on a GPU error
              // alone, the untouched args or the tail is not that failure class.
              if (!result.pass && result.countsOk && result.failing.some((f) => f.dup + f.foreign > 0)) {
                c.countsRightSetsWrong++;
              }
              const at = `${scenario}@${N}`;
              c.failedBy[at] = (c.failedBy[at] ?? 0) + 1;
              // The controls are meant to fail: two short records prove it.
              if (c.firstFailures.length < (p.control ? 2 : MAX_FAILURES)) {
                const detail = compare(words, ref, true);
                c.firstFailures.push({
                  scenario, N, seed, caseSeed, countsRight: detail.countsOk, failingSlots: detail.failing.length,
                  gpuErrors: errors.slice(0, 2), slots: detail.failing.slice(0, p.control ? 2 : 3),
                });
              }
            }
            readback.unmap();
            runs++;
            runMs += performance.now() - r0;
          }
        }
      }
    }
    for (const [scenario, list] of Object.entries(fractions)) {
      coverage.visibleFraction[scenario] = Number((list.reduce((s, f) => s + f, 0) / list.length).toFixed(4));
    }
    if (coverage.minSlotCount === Infinity) coverage.minSlotCount = 0;
    report.coverage = { ...coverage, truncated, runs, meanRunMs: runs ? Number((runMs / runs).toFixed(2)) : null };

    // 5. Comparator self-test on a passing readback (the live pipeline's when it has one).
    const selfTest = (() => {
      if (!selfTestSource) return { ok: false, reason: 'no passing readback to build it from' };
      const { words, ref } = selfTestSource;
      const base = (b) => ARGS_WORDS + b * M;
      const populated = [];
      for (let b = 0; b < SLOTS; b++) if (ref.counts[b] >= 2) populated.push(b);
      if (populated.length < 2) return { ok: false, reason: 'fewer than 2 slots with 2 entries' };
      const [b, c] = populated;
      const inject = (mutate) => {
        const w = words.slice();
        mutate(w);
        const r = compare(w, ref, false);
        return {
          fails: !r.pass, countsRight: r.countsOk,
          slots: r.failing.map((f) => ({
            slot: f.slot, cpuCount: f.cpuCount, gpuCount: f.gpuCount, argsIntact: f.argsIntact,
            dup: f.dup, holes: f.holes, foreign: f.foreign, stray: f.stray,
          })),
        };
      };
      const clean = compare(words, ref, false).pass;
      const dupHole = inject((w) => { w[base(b) + 1] = w[base(b)]; });
      const moved = inject((w) => {
        const at = base(b) + ref.counts[b] - 1;
        w[base(c) + ref.counts[c]] = w[at];
        w[at] = SENTINEL;
      });
      const swapped = inject((w) => {
        const t = w[base(b)];
        w[base(b)] = w[base(c)];
        w[base(c)] = t;
      });
      // One injection per remaining criterion, each visible to that one only.
      const overCount = inject((w) => { w[b * 5 + 1] += 1; });                       // instanceCount
      const strayOnly = inject((w) => { w[base(c) + ref.counts[c]] = w[base(c)]; }); // the tail
      const argsOnly = inject((w) => { w[c * 5 + 4] += 1; });                        // firstInstance
      const ok = clean && [dupHole, moved, swapped, strayOnly, argsOnly].every((r) => r.fails && r.countsRight)
        && overCount.fails && !overCount.countsRight;
      return {
        ok, source: `${selfTestSource.key}, N=${ref.N}`, cleanPasses: clean,
        dupHole, moved, swapped, overCount, strayOnly, argsOnly,
      };
    })();

    // A control counts only when it fails on the comparison: a GPU error
    // would say nothing about what the comparator can see.
    const failsAsExpected = (key) => report.pipelines[key].built && report.pipelines[key].errorRuns === 0
      && report.cases[key].failed > 0;
    const max16 = report.cases.wrongWidthMax16;
    report.controls = {
      wrongWidthFails: failsAsExpected('wrongWidth'),
      comparatorSelfTest: selfTest.ok,
      wrongWidthMax16Fails: failsAsExpected('wrongWidthMax16'),
      // Required to fail only when subgroupElect picks the first invocation of each 32 (header, item 2).
      wrongWidthMax16Required: report.laneProbe.firstLaneLowest,
      // The header's claim about it, recorded and not part of `ok`: every run
      // it failed had every count right and the windows wrong.
      wrongWidthMax16CountsRight: max16.failed > 0 && max16.countsRightSetsWrong === max16.failed,
      selfTest,
    };
    const planned = report.config.planned;
    const positive = ['live', 'handoff', 'atomic'].every((k) => report.pipelines[k].built
      && report.cases[k].passed === planned && report.cases[k].failed === 0 && report.pipelines[k].errorRuns === 0);
    const cov = report.coverage;
    const sound = !truncated && cov.cases === planned && cov.uploadFailures === 0 && cov.exact && cov.allFullyVisible
      && cov.minSlotCount >= 2 && cov.ties > 0 && cov.nearOut > 0;
    report.ok = report.laneProbe.ok && report.liveConfig.rendererRunsLive && positive
      && report.controls.wrongWidthFails && report.controls.comparatorSelfTest
      && (!report.controls.wrongWidthMax16Required || report.controls.wrongWidthMax16Fails)
      && sound && report.setupErrors.length === 0 && !report.deviceLost;
  } catch (err) {
    report.error = String(err && err.stack ? err.stack : err).slice(0, 2000);
    report.ok = false;
  } finally {
    for (const b of made) b.destroy();
    if (device) device.destroy();
  }
  report.elapsedMs = Math.round(performance.now() - t0);
  return report;
}
