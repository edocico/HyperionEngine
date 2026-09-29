async () => {
  // Phase 5b lossless baseline capture (spec §7.3.1): the body of ONE
  // chrome-devtools `evaluate_script` call, reused UNCHANGED at steps 0-4.
  //
  // Page: the dev harness opened with ?bench (no section at load), e.g.
  // http://localhost:5173/?mode=B&bench, 1920x1080, AMD low-power adapter.
  // Before each call an earlier evaluate_script sets
  //   window.__captureOpts = { tab: '<key>' }   one tab, in TAB_KEYS order, once per page load
  //   window.__captureOpts = { statuses: true } after the 10 tabs: the statuses of all of them
  //
  // Per tab: (1) click the tab; (2) wait for the END of its setup() (the
  // section module's setup is wrapped; main.ts's lazy import resolves to the
  // same module instance); (3) frames(4); (4) the window: 10 successive
  // probe reads of scene-hdr at a 64x36 UV grid plus the world points of the
  // tab's checks (projected with this frame's viewProjection, the ones off
  // the target dropped and recorded); (5) the check statuses at that point.
  // Around the window, two CPU snapshots >= 1 s apart give the motion
  // footprint M (entities whose row changed: their sphere, radius
  // max(0.5*(|col0|+|col1|), bounds radius), swept between the two positions,
  // dilated 2 px) and T (spheres of the .transparent() entities of types 0-5,
  // dilated 2 px). compare.mjs computes C = S_base ∩ S_run \ (M_base ∪ M_run).
  const TAB_KEYS = ['primitives', 'scene-graph', 'input', 'audio', 'particles', 'rendering-fx', 'lighting', 'debug-tools', 'lifecycle', 'twin-2d'];
  const GRID_W = 64;
  const GRID_H = 36;
  const READS = 10;
  const SNAPSHOT_GAP_MS = 1000;
  const DILATE_PX = 2;
  const SETUP_TIMEOUT_MS = 30000;
  const FIXED_WAIT_MS = 7000;
  const INTERACTION_CHECKS = ['Keyboard callback', 'Click callback', 'Pointer move callback', 'Scroll callback'];
  // Lighting animates everything its lights reach: covered by its checks and statuses only.
  const NO_BIT_EXACT = ['lighting'];

  const engine = window.__hyperion;
  if (!engine || !engine.debug) throw new Error('window.__hyperion with a debug API is required: open the dev harness');
  if (!new URLSearchParams(location.search).has('bench')) {
    throw new Error('capture from a ?bench page: without it Primitives is set up at load, and re-entering a tab re-runs its setup');
  }
  const opts = window.__captureOpts ?? {};
  window.__captureStatuses = window.__captureStatuses ?? {};
  if (opts.statuses) {
    return { format: 'hyperion-5b-statuses/1', mode: engine.mode, tabs: window.__captureStatuses };
  }

  const tab = opts.tab;
  const index = TAB_KEYS.indexOf(tab);
  if (index < 0) throw new Error(`unknown tab '${tab}' (window.__captureOpts.tab)`);
  const visited = (window.__captureVisited = window.__captureVisited ?? []);
  if (index !== visited.length) {
    throw new Error(`tab '${tab}' out of order: the next one is '${TAB_KEYS[visited.length] ?? '(none: all captured)'}'; navigate again to restart`);
  }
  visited.push(tab);

  const frames = (n) => new Promise((resolve) => {
    const step = (left) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(n);
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const { worldToUv } = await import('/src/render/debug-probe.ts');
  const canvas = document.getElementById('canvas');
  const tabs = document.querySelectorAll('.tab');
  if (tabs.length !== TAB_KEYS.length) throw new Error(`${tabs.length} tabs in the page, want ${TAB_KEYS.length}`);

  const domStatuses = () => [...document.querySelectorAll('#check-list .check-item')].map((item) => ({
    name: item.querySelector('.check-name')?.textContent ?? '',
    status: ['pass', 'fail', 'skip', 'pending'].find((s) => item.querySelector('.check-icon')?.classList.contains(s)) ?? 'unknown',
    detail: null,
  }));

  // (1) + (2): click, then wait for the end of setup().
  let reporter = null;
  let captureMode = 'wrapped';
  let section = null;
  try {
    section = (await import(`/src/demo/${tab}.ts`)).default;
  } catch {
    section = null;
  }
  if (section && typeof section.setup === 'function') {
    const original = section.setup;
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    section.setup = async function (eng, rep) {
      reporter = rep;
      try {
        return await original.call(this, eng, rep);
      } finally {
        section.setup = original;
        finish();
      }
    };
    tabs[index].click();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`setup of '${tab}' did not finish within ${SETUP_TIMEOUT_MS} ms`)), SETUP_TIMEOUT_MS);
    });
    try {
      await Promise.race([done, timeout]);
    } finally {
      clearTimeout(timer);
    }
  } else {
    // Fallback (spec §7.3.1): a fixed wait past the slowest setup, then two
    // identical status reads 1 s apart.
    captureMode = 'fixed-wait';
    tabs[index].click();
    await sleep(FIXED_WAIT_MS);
    let previous = JSON.stringify(domStatuses());
    for (let k = 0; ; k++) {
      await sleep(1000);
      const current = JSON.stringify(domStatuses());
      if (current === previous) break;
      if (k >= 20) throw new Error(`the statuses of '${tab}' never settled`);
      previous = current;
    }
  }

  // (3)
  await frames(4);

  // CPU snapshot of the frame's rows (a one-shot frameEnd hook: SystemViews
  // of the current frame), copied before the next frame reuses the arrays.
  const viewsSnapshot = () => new Promise((resolve) => {
    const hook = (_dt, views) => {
      engine.removeHook('frameEnd', hook);
      const n = views ? views.entityCount : 0;
      resolve({
        count: n,
        bounds: views ? views.bounds.slice(0, 4 * n) : new Float32Array(0),
        renderMeta: views ? views.renderMeta.slice(0, 2 * n) : new Uint32Array(0),
        ids: views ? views.entityIds.slice(0, n) : new Uint32Array(0),
      });
    };
    engine.addHook('frameEnd', hook);
  });

  const views1 = await viewsSnapshot();
  const rows1 = await engine.debug.readEntityTransforms();
  const t1 = performance.now();

  // Points: the 64x36 grid, then the world points of the tab's checks.
  const W = canvas.width;
  const H = canvas.height;
  const vp = new Float32Array(engine.cam.viewProjection);
  const worldPerPxX = 2 / (vp[0] * W);
  const worldPerPxY = 2 / vp[5] / H;
  const checkPointsOf = () => {
    const pts = [];
    const add = (check, list) => { for (const [x, y] of list) pts.push({ check, x, y }); };
    if (tab === 'primitives') {
      const quads = [];
      for (let row = 0; row < 5; row++) for (let col = 0; col < 5; col++) quads.push([(col - 2) * 2.5, (row - 2) * 2.5]);
      add('Quad grid (5x5)', [...quads, [1.25, 1.25], [-1.25, -1.25], [3.75, 1.25], [-3.75, 3.75]]);
      const gx = -12.5;
      add('Gradients (linear/radial/conic)', [[gx - 0.9, 4], [gx + 0.9, 4], [gx, 0], [gx + 1.35, 0], [gx - 0.9, -4 + 0.15], [gx - 0.9, -4 - 0.15], [gx + 0.9, -4]]);
      const sx = -8;
      const inset = (0.29 / 0.6) * 3;
      add('Box shadows (sharp/soft/rounded)', [[sx, 4], [sx + 1.65, 4 + 1.65], [sx, 0], [sx + 1.41, 0], [sx + inset, -4], [sx + inset, -4 + inset]]);
      const column = [];
      for (let k = -4; k <= 4; k++) column.push([9, 1 + k * worldPerPxY]);
      add('Lines (6V world + 4H 3px)', [[8, 2], [8.3, 2], ...column]);
      add('Bezier curves (arch/S/wave)', [[21, 4], [21, 5.8], [21, 2.2], [21, 0], [21, -4], [21, -3], [21, -5]]);
    } else if (tab === 'scene-graph') {
      add('Parent/child hierarchy', [[0, 6], [-4, 6], [4, 6], [-2, 6], [2, 6]]);
      add('Rotation', [[-2.8, -2], [-3.1, -1.1], [-4, -2]]);
      add('Scale', [[4, -2], [4.4, -2], [10.9, -2], [14.4, -2], [13, -1.3]]);
      add('Nested transforms', [[0, -6], [3, -6], [4.25, -6], [4.6, -6]]);
    } else if (tab === 'rendering-fx') {
      add('Bloom', [[-4 + 6 * worldPerPxY, -4.5], [-4.5, -4.5]]);
      add('Outline', [[-4 + worldPerPxY, -4.5], [-1 + worldPerPxY, -4.5]]);
      add('Resize', [[0, 0]]);
    } else if (tab === 'lighting') {
      add('Lit vs unlit', [[-12, 3], [-12, -3]]);
      add('Layer shadow on screen', [[15, 2], [15, 6]]);
    } else if (tab === 'lifecycle') {
      add('Spawn + destroy', [[-12, -6]]);
      const cells = [];
      for (let row = 0; row < 4; row++) for (let col = 0; col < 10; col++) cells.push([(col - 4.5) * 1.5, (row - 2) * 1.5 + 8]);
      add('Batch operation', cells);
      add('Immediate mode', [[5, 5], [0, 0]]);
      add('Prefab lifecycle', [[10, -4], [7.75, -4], [12.25, -4], [5, -2]]);
    } else if (tab === 'twin-2d') {
      const offset = Math.round(12 / worldPerPxX) * worldPerPxX;
      const lattice = [];
      for (let i = 0; i < 9; i++) {
        const cx = -6 + ((i % 3) - 1) * 3.2;
        const cy = (Math.floor(i / 3) - 1) * 3.2;
        for (let a = -4; a <= 4; a++) for (let b = -4; b <= 4; b++) lattice.push([cx + a * 0.3, cy + b * 0.3]);
      }
      add('Twins draw the same pixels', [...lattice, ...lattice.map(([x, y]) => [x + offset, y])]);
      add('Depth orders 2D sprites', [[36.2, 0], [42.64, 0], [42.28, 0], [41.8, 0]]);
    }
    return pts;
  };
  const grid = [];
  for (let j = 0; j < GRID_H; j++) for (let i = 0; i < GRID_W; i++) grid.push([(i + 0.5) / GRID_W, (j + 0.5) / GRID_H]);
  const checkPoints = [];
  const dropped = [];
  for (const p of checkPointsOf()) {
    const [u, v] = worldToUv(p.x, p.y, vp);
    // One point off the target makes the probe reject the whole request.
    (u >= 0 && u < 1 && v >= 0 && v < 1 ? checkPoints : dropped).push({ ...p, u, v });
  }
  const uv = [...grid, ...checkPoints.map((p) => [p.u, p.v])];
  const P = uv.length;

  // (4) the window: READS successive reads, S = the points bit-identical in all of them.
  const reads = [];
  for (let k = 0; k < READS; k++) reads.push(await engine.debug.probe({ target: 'scene-hdr', uv }));
  // (5) the statuses, at that same point.
  const checks = reporter
    ? reporter.results().map((r) => ({ name: r.name, status: r.status, detail: r.detail ?? null }))
    : domStatuses();
  const count = (s) => checks.filter((c) => c.status === s).length;
  let summary = `${count('pass')}/${checks.length} passed`;
  if (count('skip') > 0) summary += ` · ${count('skip')} skipped`;
  if (count('fail') > 0) summary += ` · ${count('fail')} failed`;
  const unexpectedPending = checks
    .filter((c) => c.status === 'pending' && !(tab === 'input' && INTERACTION_CHECKS.includes(c.name)))
    .map((c) => c.name);
  const statuses = { summary, checks, unexpectedPending };
  window.__captureStatuses[tab] = statuses;

  const first = new Float32Array(P * 4);
  reads[0].values.forEach((value, i) => first.set(value, 4 * i));
  const firstBits = new Uint32Array(first.buffer);
  const other = new Float32Array(4);
  const otherBits = new Uint32Array(other.buffer);
  const unstable = [];
  for (let i = 0; i < P; i++) {
    for (let k = 1; k < READS; k++) {
      other.set(reads[k].values[i]);
      if (otherBits[0] !== firstBits[4 * i] || otherBits[1] !== firstBits[4 * i + 1]
        || otherBits[2] !== firstBits[4 * i + 2] || otherBits[3] !== firstBits[4 * i + 3]) {
        unstable.push(i);
        break;
      }
    }
  }
  const cameraStable = reads.every((r) => r.targetSize[0] === W && r.targetSize[1] === H
    && r.viewProjection.every((x, i) => Object.is(x, vp[i])));

  // Second CPU snapshot, >= SNAPSHOT_GAP_MS after the first.
  const gap = SNAPSHOT_GAP_MS - (performance.now() - t1);
  if (gap > 0) await sleep(gap);
  const views2 = await viewsSnapshot();
  const rows2 = await engine.debug.readEntityTransforms();
  const snapshotGapMs = Math.round(performance.now() - t1);

  // Footprints in target pixels. Orthographic camera: pixels per world unit
  // from the Jacobian of world -> pixel (the larger axis when axis-aligned).
  const toPx = (x, y) => { const [u, v] = worldToUv(x, y, vp); return [u * W, v * H]; };
  const jx = [vp[0] * W / 2, vp[4] * W / 2];
  const jy = [vp[1] * H / 2, vp[5] * H / 2];
  const pxPerWorld = vp[1] === 0 && vp[4] === 0
    ? Math.max(Math.abs(jx[0]), Math.abs(jy[1]))
    : Math.hypot(jx[0], jx[1], jy[0], jy[1]);
  const segmentDistance = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  const covered = (shapes) => {
    const out = [];
    for (let i = 0; i < P; i++) {
      const px = uv[i][0] * W;
      const py = uv[i][1] * H;
      if (shapes.some((s) => segmentDistance(px, py, s.a[0], s.a[1], s.b[0], s.b[1]) <= s.r)) out.push(i);
    }
    return out;
  };

  // M: every entity whose CPU row differs between the two snapshots (or that
  // exists in only one of them).
  const rowsById = (t) => {
    const m = new Map();
    for (let s = 0; s < t.entityCount; s++) m.set(t.entityIds[s], t.cpuRows.subarray(16 * s, 16 * s + 16));
    return m;
  };
  const radiusById = (snap) => {
    const m = new Map();
    for (let s = 0; s < snap.count; s++) m.set(snap.ids[s], snap.bounds[4 * s + 3]);
    return m;
  };
  const sameRow = (a, b) => {
    const ua = new Uint32Array(a.buffer, a.byteOffset, 16);
    const ub = new Uint32Array(b.buffer, b.byteOffset, 16);
    for (let w = 0; w < 16; w++) if (ua[w] !== ub[w]) return false;
    return true;
  };
  const quadRadius = (row) => 0.5 * (Math.hypot(row[0], row[1], row[2]) + Math.hypot(row[4], row[5], row[6]));
  const r1 = rowsById(rows1);
  const r2 = rowsById(rows2);
  const b1 = radiusById(views1);
  const b2 = radiusById(views2);
  const movers = [];
  for (const id of new Set([...r1.keys(), ...r2.keys()])) {
    const a = r1.get(id);
    const b = r2.get(id);
    if (a && b && sameRow(a, b)) continue;
    const radius = Math.max(a ? quadRadius(a) : 0, b ? quadRadius(b) : 0, b1.get(id) ?? 0, b2.get(id) ?? 0);
    const from = a ? [a[12], a[13]] : [b[12], b[13]];
    const to = b ? [b[12], b[13]] : from;
    movers.push({ id, from, to, radius });
  }
  const moving = covered(movers.map((m) => ({ a: toPx(...m.from), b: toPx(...m.to), r: m.radius * pxPerWorld + DILATE_PX })));

  // T: the bounds spheres of the .transparent() entities of types 0-5 (a
  // Light2D, type 6 after the cull's clamp, is not drawn by ForwardPass).
  const transparents = [];
  const seen = new Set();
  for (const snap of [views1, views2]) {
    for (let s = 0; s < snap.count; s++) {
      const meta = snap.renderMeta[2 * s + 1];
      const type = Math.min(meta & 0xff, 6);
      if ((meta & 0x100) === 0 || type === 6) continue;
      const entry = { id: snap.ids[s], x: snap.bounds[4 * s], y: snap.bounds[4 * s + 1], radius: snap.bounds[4 * s + 3], type };
      const key = `${entry.id}:${entry.x}:${entry.y}:${entry.radius}`;
      if (seen.has(key)) continue;
      seen.add(key);
      transparents.push(entry);
    }
  }
  const transparent = covered(transparents.map((t) => {
    const c = toPx(t.x, t.y);
    return { a: c, b: c, r: t.radius * pxPerWorld + DILATE_PX };
  }));

  const toBase64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  return {
    format: 'hyperion-5b-capture/1',
    tab,
    mode: engine.mode,
    search: location.search,
    captureMode,
    canvasSize: [W, H],
    cssSize: [canvas.clientWidth, canvas.clientHeight],
    dpr: window.devicePixelRatio,
    targetSize: reads[0].targetSize,
    viewProjection: Array.from(vp),
    cameraStable,
    bitExact: cameraStable && !NO_BIT_EXACT.includes(tab),
    gridSize: [GRID_W, GRID_H],
    checkPoints,
    dropped,
    reads: READS,
    bitsB64: toBase64(new Uint8Array(first.buffer)),
    unstable,
    moving,
    movers,
    transparent,
    transparents,
    snapshotGapMs,
    statuses,
  };
}
