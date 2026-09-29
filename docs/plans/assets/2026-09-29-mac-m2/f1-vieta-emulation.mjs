// f32 emulation of bezier_sd (the WGSL tree, Math.fround after every op):
// old one-root branch vs Vieta, with and without the Newton candidate.
const f = Math.fround;
const add = (a, b) => f(a + b), sub = (a, b) => f(a - b), mul = (a, b) => f(a * b), div = (a, b) => f(a / b);
const v2 = (x, y) => [f(x), f(y)];
const vadd = (a, b) => [add(a[0], b[0]), add(a[1], b[1])];
const vsub = (a, b) => [sub(a[0], b[0]), sub(a[1], b[1])];
const vmul = (a, s) => [mul(a[0], s), mul(a[1], s)];
const dot = (a, b) => add(mul(a[0], b[0]), mul(a[1], b[1]));
// Two models of WGSL's pow(|x|, 1/3): a correctly rounded cube root, and
// exp2(y * log2(x)), the form the WGSL spec gives pow's accuracy in.
let POW = 'rounded';
const pow13 = (a) => (POW === 'rounded'
  ? f(Math.pow(a, f(1 / 3)))
  : f(Math.pow(2, f(f(1 / 3) * f(Math.log2(a))))));
const cbrt = (x) => (x === 0 ? 0 : f(Math.sign(x) * pow13(Math.abs(x))));
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function sd(posIn, aIn, bIn, cIn, { vieta, newton }) {
  const pos = v2(...posIn), a = v2(...aIn), b = v2(...bIn), c = v2(...cIn);
  const A = vsub(b, a);
  const B = vadd(vsub(a, vmul(b, 2)), c);
  const C = vmul(A, 2);
  const D = vsub(a, pos);
  let res = 0;
  if (dot(B, B) < 1e-9) {
    const ba = vsub(c, a);
    const h = clamp01(div(dot(vmul(D, -1), ba), Math.max(dot(ba, ba), 1e-12)));
    const d = vadd(D, vmul(ba, h));
    return Math.sqrt(dot(d, d));
  }
  const kk = div(1, dot(B, B));
  const kx = mul(kk, dot(A, B));
  const ky = div(mul(kk, add(mul(2, dot(A, A)), dot(D, B))), 3);
  const kz = mul(kk, dot(D, A));
  const p = sub(ky, mul(kx, kx));
  const q = add(mul(kx, sub(mul(mul(2, kx), kx), mul(3, ky))), kz);
  const p3 = mul(mul(p, p), p);
  const q2 = mul(q, q);
  let h = add(q2, mul(4, p3));
  const at = (t) => { const qp = vadd(D, vmul(vadd(C, vmul(B, t)), t)); return dot(qp, qp); };
  if (h >= 0) {
    h = f(Math.sqrt(h));
    let t;
    if (!vieta) {
      const x0 = div(sub(h, q), 2), x1 = div(sub(-h, q), 2);
      t = clamp01(sub(add(cbrt(x0), cbrt(x1)), kx));
    } else {
      const w = mul(-0.5, add(q, q >= 0 ? h : -h));
      const u = cbrt(w);
      const v = u !== 0 ? div(-p, u) : 0;
      t = clamp01(sub(add(u, v), kx));
    }
    res = at(t);
  } else {
    const z = f(Math.sqrt(-p));
    let arg = div(q, mul(mul(p, z), 2));
    arg = Math.max(-1, Math.min(1, arg));
    const vv = div(f(Math.acos(arg)), 3);
    const m = f(Math.cos(vv)), n = mul(f(Math.sin(vv)), 1.732050808);
    const t0 = clamp01(sub(mul(add(m, m), z), kx));
    const t1 = clamp01(sub(mul(sub(-n, m), z), kx));
    res = Math.min(at(t0), at(t1));
  }
  if (newton) {
    const ba = vsub(c, a);
    let tn = clamp01(div(dot(vmul(D, -1), ba), Math.max(dot(ba, ba), 1e-12)));
    for (let i = 0; i < 2; i++) {
      const toCurve = vadd(D, vmul(vadd(C, vmul(B, tn)), tn));
      const tangent = vadd(C, vmul(B, mul(2, tn)));
      const slope = add(dot(tangent, tangent), mul(2, dot(toCurve, B)));
      tn = clamp01(sub(tn, div(dot(toCurve, tangent), Math.max(slope, 1e-12))));
    }
    const cand = at(tn);
    res = Math.min(res < 1e30 ? res : 1e30, cand);
  }
  return f(Math.sqrt(res));
}

// f64 truth: dense sampling then Newton on the true curve.
function sdTrue(pos, a, b, c) {
  const P = (t) => [(1 - t) ** 2 * a[0] + 2 * t * (1 - t) * b[0] + t * t * c[0], (1 - t) ** 2 * a[1] + 2 * t * (1 - t) * b[1] + t * t * c[1]];
  let best = Infinity, bt = 0;
  for (let i = 0; i <= 2000; i++) { const t = i / 2000; const p = P(t); const d = Math.hypot(p[0] - pos[0], p[1] - pos[1]); if (d < best) { best = d; bt = t; } }
  for (let lo = Math.max(0, bt - 1e-3), hi = Math.min(1, bt + 1e-3), k = 0; k < 100; k++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    const d1 = Math.hypot(P(m1)[0] - pos[0], P(m1)[1] - pos[1]), d2 = Math.hypot(P(m2)[0] - pos[0], P(m2)[1] - pos[1]);
    if (d1 < d2) hi = m2; else lo = m1;
    best = Math.min(best, d1, d2);
  }
  return best;
}

const variants = { old: { vieta: false, newton: false }, oldNewton: { vieta: false, newton: true }, vieta: { vieta: true, newton: false }, vietaNewton: { vieta: true, newton: true } };
function run(label, a, b, c, points) {
  const out = {};
  for (const [k, opt] of Object.entries(variants)) {
    let worst = 0, over = 0, nan = 0;
    for (const p of points) {
      const d = sd(p, a, b, c, opt);
      if (!Number.isFinite(d)) { nan++; continue; }
      const e = Math.abs(d - sdTrue(p, a, b, c));
      worst = Math.max(worst, e); if (e > 1e-3) over++;
    }
    out[k] = `worst ${worst.toExponential(2)}, >1e-3: ${over}, nan ${nan}`;
  }
  console.log(label, JSON.stringify(out, null, 1));
}

for (const model of ['rounded', 'exp2log2']) {
POW = model;
console.log(`=== pow model: ${model}`);
// (1) The curved wave around its p = 0 crossing (t ~ 0.766), 1024-px grid, +-12 px.
{
  const a = [0.25, 0.25], b = [0.15, 0.65], c = [0.95, 0.85];
  const pts = [];
  for (let i = -12; i <= 12; i++) for (let j = -12; j <= 12; j++) pts.push([(Math.floor(0.6245 * 1024) + i + 0.5) / 1024, (Math.floor(0.7453 * 1024) + j + 0.5) / 1024]);
  run('curved @1024, 625 px around the crossing', a, b, c, pts);
}
// (2) Near-straight curves on the chord (0.1,0.5)-(0.9,0.5): the control point
// `off` from the chord's middle at `deg` degrees. 35.26 and 144.74 are the
// cancellation band of the harness check; 90 is 'Straight bezier' (A
// perpendicular to B, kx = -1/2); 1.6e-5 at 90 puts dot(B, B) just above the
// 1e-9 threshold. Rows: the check's inside rows (v 0.5 and +-0.008) plus +-0.015.
const cases = [];
for (const deg of [35.26, 144.74]) for (const off of [1e-4, 1e-3, 5e-3]) cases.push([`band ${deg} ${off}`, deg, off]);
for (const deg of [60, 75, 89, 90, 105, 120]) cases.push([`angle ${deg} 0.0001`, deg, 1e-4]);
for (const off of [1.6e-5, 1e-3]) cases.push([`perpendicular ${off}`, 90, off]);
for (const [label, deg, off] of cases) {
  const r = (deg * Math.PI) / 180;
  const a = [0.1, 0.5], b = [0.5 + off * Math.cos(r), 0.5 + off * Math.sin(r)], c = [0.9, 0.5];
  const pts = [];
  for (let u = 0.15; u <= 0.8501; u += 0.0025) for (const dv of [0, 0.008, -0.008, 0.015, -0.015]) pts.push([u, 0.5 + dv]);
  run(label, a, b, c, pts);
}
}
