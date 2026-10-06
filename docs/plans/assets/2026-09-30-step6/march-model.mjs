// docs/plans/assets/2026-09-30-step6/march-model.mjs
//
// CPU model of the directional-light (sun) shadow march of the lit backend
// (round 2026-09-27, step 6): the basis of the thresholds of the Lighting tab's
// sun checks (ts/src/demo/lighting-directional.ts) and of the predictions of
// the step-6 GPU A/B. Pure, f64. Its numbers are pinned by
// march-model.test.mjs, next to it.
//
// - The camera: orthographic, 20 world units tall at zoom 1 (the harness's
//   camera, and Mode A's render worker), on the light buffer at half the
//   canvas resolution (halfResolution in occluder-seed-stage.ts: 960x540 and
//   27 texels per unit at 1080p). fitViewCamera frames a view the way the
//   harness's fitView does, zooming out on narrow canvases.
// - The SDF: signed, in texels, the EXACT distance transform (Felzenszwalb)
//   between texel centres inside and outside the casters, seeded only inside
//   the view, the way the occluder seed rasterises only the on-screen part of
//   a caster. The GPU's jump flood approximates it.
// - The march: the arithmetic of directionalRay, sunShadow, exitDistance,
//   shadow and sunFade in ts/src/shaders/light-accum.wgsl, in f64, with the
//   shader's edge clamp in sdfDistance.
//
// Not modelled: the GPU's f32 arithmetic, the jump flood's error, and the
// fp16 storage of the nearest seed's UV in the field (~2^-11).

/** A sun's shadow keeps full strength for this fraction of its length: SUN_FADE_START in light-accum.wgsl. */
export const FADE_START = 0.75;

/** The view's height at zoom 1, in world units. */
const VIEW_HEIGHT = 20;

/**
 * An orthographic camera centred on (cx, cy), 20 / zoom world units tall
 * (CameraAPI.zoom divides the view), over a canvas of canvasW x canvasH
 * pixels. `w` x `h` is the light buffer (and the SDF): half the canvas, as
 * halfResolution sizes it. `toTexel(x, y)` is toScreenUV(viewProjection *
 * world) times that size: the texture's y runs down. `texPerUnit`: texels per
 * world unit (27 at 1080p, zoom 1).
 */
export function makeCamera(cx, cy, canvasW = 1920, canvasH = 1080, zoom = 1) {
  const w = Math.max(1, Math.floor(canvasW / 2));
  const h = Math.max(1, Math.floor(canvasH / 2));
  const hh = VIEW_HEIGHT / 2 / zoom;
  const hw = (hh * canvasW) / canvasH;
  return {
    cx, cy, hw, hh, w, h, zoom,
    // Texels per world unit along x and y: equal unless a canvas side is odd.
    sx: w / (2 * hw),
    sy: h / (2 * hh),
    texPerUnit: h / (2 * hh),
    xL: cx - hw,
    xR: cx + hw,
    toTexel: (x, y) => [((x - cx) / hw * 0.5 + 0.5) * w, (0.5 - (y - cy) / hh * 0.5) * h],
  };
}

/**
 * The camera of probe-checks.ts fitView(engine, cx, cy, halfWidth) on a
 * canvasW x canvasH canvas (the backing store the harness hands
 * engine.resize): centred on (cx, cy); at zoom 1 the view is 20 units tall
 * and 20 · aspect wide (hyperion.ts resize), and fitView zooms out, never in,
 * until halfWidth world units fit on each side, so zoom = min(1, 10 · aspect
 * / halfWidth), through CameraAPI.zoom's floor of 0.01. fitView reads the half
 * width back from the f32 view-projection, so its zoom can differ from this
 * one by that rounding (under 1e-7). The Lighting tab frames its sun sub-scene
 * this way (half width 17.6): below an aspect of 1.76 the view is 35.2 units
 * wide, and the texels per unit fall with the canvas' width.
 */
export function fitViewCamera(cx, cy, canvasW, canvasH, halfWidth) {
  const visibleHalfWidth = (VIEW_HEIGHT / 2) * (canvasW / canvasH);
  return makeCamera(cx, cy, canvasW, canvasH, Math.max(0.01, Math.min(1, visibleHalfWidth / halfWidth)));
}

/** Signed distance from (px, py) to the rectangle r = {x, y, hx, hy, rot}, world units: negative inside. */
function sdRect(px, py, r) {
  const c = Math.cos(-r.rot);
  const s = Math.sin(-r.rot);
  const dx = px - r.x;
  const dy = py - r.y;
  const lx = c * dx - s * dy;
  const ly = s * dx + c * dy;
  const qx = Math.abs(lx) - r.hx;
  const qy = Math.abs(ly) - r.hy;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
}

/**
 * Squared exact Euclidean distance transform of a w x h binary mask: for every
 * texel, the squared distance in texels to the nearest texel whose mask is set
 * (Felzenszwalb and Huttenlocher, columns then rows). ~1e20 where no texel is set.
 */
function edt(mask, w, h) {
  const INF = 1e20;
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = mask[i] ? 0 : INF;
  // The lower envelope of the parabolas (q - v)^2 + f[v], sampled at every q.
  const pass = (f, n) => {
    const d = new Float64Array(n);
    const v = new Int32Array(n);
    const z = new Float64Array(n + 1);
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s;
      while (true) {
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        if (s <= z[k]) {
          k--;
          if (k < 0) {
            k = 0;
            break;
          }
        } else break;
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
    return d;
  };
  for (let i = 0; i < w; i++) {
    const col = new Float64Array(h);
    for (let j = 0; j < h; j++) col[j] = g[j * w + i];
    const d = pass(col, h);
    for (let j = 0; j < h; j++) g[j * w + i] = d[j];
  }
  for (let j = 0; j < h; j++) {
    const d = pass(g.slice(j * w, j * w + w), w);
    for (let i = 0; i < w; i++) g[j * w + i] = d[i];
  }
  return g;
}

/**
 * The signed SDF of `rects` ({x, y, hx, hy, rot}, world units) on the camera's
 * light buffer: `{ w, h, dist }`, `dist` in texels, row-major from the top-left
 * texel, negative inside a caster. A texel is inside when its centre is. Only
 * the texels in view are seeded, so a caster off screen casts nothing. `null`
 * when no caster is in view: the shader then reads 1e6 everywhere (the field
 * found no texel of the other kind).
 */
export function buildSdf(cam, rects) {
  const { w, h } = cam;
  const inside = new Uint8Array(w * h);
  let any = false;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = cam.cx + ((i + 0.5) / w - 0.5) * 2 * cam.hw;
      const y = cam.cy - ((j + 0.5) / h - 0.5) * 2 * cam.hh;
      let d = Infinity;
      for (const r of rects) d = Math.min(d, sdRect(x, y, r));
      if (d <= 0) {
        inside[j * w + i] = 1;
        any = true;
      }
    }
  }
  if (!any) return null;
  const outside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) outside[i] = inside[i] ? 0 : 1;
  const toInside = edt(inside, w, h);   // for the texels outside
  const toOutside = edt(outside, w, h); // for the texels inside
  const dist = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) dist[i] = inside[i] ? -Math.sqrt(toOutside[i]) : Math.sqrt(toInside[i]);
  return { w, h, dist };
}

/** light-accum.wgsl sdfDistance: the texel under (x, y), clamped to the edge. */
function sdfDistance(sdf, x, y) {
  if (!sdf) return 1e6;
  const i = Math.min(Math.max(Math.floor(x), 0), sdf.w - 1);
  const j = Math.min(Math.max(Math.floor(y), 0), sdf.h - 1);
  return sdf.dist[j * sdf.w + i];
}

const smoothstep = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/** light-accum.wgsl sunFade: a caster t texels away casts at this strength. */
const sunFade = (t, reach) => (reach <= 0 ? 1 : 1 - smoothstep(FADE_START * reach, reach, t));

/**
 * light-accum.wgsl shadow(): how much light reaches the texel point (ox, oy),
 * 0..1. A sphere march on the signed SDF along the unit (dx, dy), in texels,
 * for `travel` texels, at most `steps` reads after the first; `angle` is the
 * penumbra's width per texel of distance. `fadeReach` > 0 (a sun): a caster t
 * texels away casts at sunFade(t, fadeReach); 0 (point, spot): the plain
 * Quilez term.
 */
export function shadow(sdf, ox, oy, dx, dy, travel, angle, fadeReach, steps) {
  const fading = fadeReach > 0;
  let t = 0;
  let h = sdfDistance(sdf, ox, oy);
  let i = 0;
  // Inside an occluder: leave it first.
  while (h <= 0 && i < steps) {
    t += Math.max(-h, 1);
    if (t >= travel) return 1;
    h = sdfDistance(sdf, ox + dx * t, oy + dy * t);
    i++;
  }
  if (h <= 0) return 1;
  const start = t;
  let res = 1;
  t += Math.max(h, 1);
  for (; i < steps; i++) {
    if (t >= travel) break;
    h = sdfDistance(sdf, ox + dx * t, oy + dy * t);
    if (h <= 0) return fading ? Math.min(res, 1 - sunFade(t, fadeReach)) : 0;
    const q = h / ((t - start) * angle);
    res = Math.min(res, fading ? 1 - sunFade(t, fadeReach) * (1 - q) : q);
    t += h;
  }
  // Out of steps: the last clearance holds to the end of the ray.
  if (t < travel) {
    const q = h / ((travel - start) * angle);
    res = Math.min(res, fading ? 1 - sunFade(t, fadeReach) * (1 - q) : q);
  }
  return Math.min(Math.max(res, 0), 1);
}

/** light-accum.wgsl exitDistance: texels from (ox, oy) to where the ray leaves the w x h rectangle. */
function exitDistance(ox, oy, dx, dy, w, h) {
  const tx = Math.abs(dx) > 1e-6 ? ((dx > 0 ? w : 0) - ox) / dx : 1e30;
  const ty = Math.abs(dy) > 1e-6 ? ((dy > 0 ? h : 0) - oy) / dy : 1e30;
  return Math.min(tx, ty);
}

/**
 * light-accum.wgsl directionalRay, for a sun at rotation `theta` (it shines
 * toward (cos, sin)): the unit direction toward the light in texels, the y
 * flipped like toScreenUV, and the shadow's length, `range` world units, in
 * texels along it.
 */
function directionalRay(cam, theta, range) {
  const px = -Math.cos(theta) * cam.sx;
  const py = Math.sin(theta) * cam.sy;
  const texels = Math.hypot(px, py);
  return [px / texels, py / texels, Math.max(range, 0) * texels];
}

/** light-accum.wgsl sunShadow, for the light buffer's texel whose centre is (ox, oy). */
function sunAtTexel(cam, sdf, ox, oy, theta, range, angle, steps) {
  const [dx, dy, reach] = directionalRay(cam, theta, range);
  const travel = Math.min(reach, exitDistance(ox, oy, dx, dy, cam.w, cam.h));
  if (travel < 1) return 1;
  return shadow(sdf, ox, oy, dx, dy, travel, angle, reach, steps);
}

/**
 * The sun's shadow factor (1 = lit) in the light buffer's texel under the
 * world point (x, y): the texel the probe reads there (pixel-probe.wgsl
 * texelAt), marched from its centre like its fragment. A point on a texel's
 * edge, to rounding, can land in either texel: here the f64 arithmetic picks
 * one, on the GPU the f32 of worldToUv and texelAt, and the two can differ
 * (march-model.test.mjs reads both where a check depends on it). A point
 * outside the view throws, as the probe rejects it.
 */
export function sunShadowAt(cam, sdf, x, y, theta, range, angle, steps) {
  const [u, v] = cam.toTexel(x, y);
  if (!(u >= 0 && u <= cam.w && v >= 0 && v <= cam.h)) {
    throw new Error(`(${x}, ${y}) is outside the view`);
  }
  const ox = Math.min(Math.floor(u), cam.w - 1) + 0.5;
  const oy = Math.min(Math.floor(v), cam.h - 1) + 0.5;
  return sunAtTexel(cam, sdf, ox, oy, theta, range, angle, steps);
}

/**
 * The sun's shadow factor at the centres of the cells of a gx x gy UV grid
 * over the light buffer, row-major from the top-left: the texels a probe of
 * those UV points reads.
 */
export function sunGrid(cam, sdf, theta, range, angle, steps, gx = 128, gy = 72) {
  const out = new Float64Array(gx * gy);
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      const ox = Math.floor(((i + 0.5) / gx) * cam.w) + 0.5;
      const oy = Math.floor(((j + 0.5) / gy) * cam.h) + 0.5;
      out[j * gx + i] = sunAtTexel(cam, sdf, ox, oy, theta, range, angle, steps);
    }
  }
  return out;
}
