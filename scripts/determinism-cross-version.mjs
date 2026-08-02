// Confronto di determinismo fisico FRA DUE BUILD WASM DIVERSE.
//
//   node scripts/determinism-cross-version.mjs <wasmDir> <scenario>
//
// A cosa serve
// ------------
// `crates/hyperion-core/tests/verify_determinism.rs` copre il determinismo
// *dentro* una build. Questo script copre l'altra metà: se una build con la
// dipendenza vecchia e una con quella nuova producano lo stesso stato. È il
// controllo da fare a ogni upgrade di rapier / parry / glam, e non è
// esprimibile come test cargo perché richiede due alberi sorgente compilati.
//
// Come si usa (esempio: l'upgrade rapier 0.32 -> 0.34 del 2026-08)
// ----------------------------------------------------------------
//   SB=/tmp/detcmp && mkdir -p $SB
//   git archive <ref-vecchia> | tar -x -C $SB/old
//   (cd $SB/old/crates/hyperion-core && wasm-pack build --target web \
//        --out-dir $SB/out-old -- --features "physics-2d dev-tools")
//   (cd crates/hyperion-core && wasm-pack build --target web \
//        --out-dir $SB/out-new -- --features "physics-2d dev-tools")
//   for s in freefall stack ccd ccd-off epa-near epa-far raycast-zero; do
//     node scripts/determinism-cross-version.mjs $SB/out-old $s
//     node scripts/determinism-cross-version.mjs $SB/out-new $s
//   done
//
// Le due righe di ogni scenario devono coincidere carattere per carattere.
//
// ATTENZIONE — la bit-exactness vale PER TARGET, non fra target
// -------------------------------------------------------------
// Misurato il 2026-08-02: lo stesso scenario CCD dà y=2992.6257 su wasm32 e
// y=2992.6294 su aarch64 nativo. Confronta quindi sempre wasm-vs-wasm, mai
// wasm-vs-nativo, e non trasformare questi valori in golden hash in un test.
//
// TRAPPOLA — `SetVelocity` non muove un corpo fisico
// ---------------------------------------------------
// `velocity_system_filtered` salta le entità `PhysicsControlled`: SetVelocity
// scrive solo il componente ECS. Uno scenario costruito con SetVelocity lascia
// i corpi fermi e "passa" senza esercitare niente. La velocità va data con
// gravità o `ApplyImpulse` — ed è il motivo per cui esiste lo scenario di
// controllo `ccd-off`: se i corpi NON tunnelano senza CCD, lo scenario si è
// degradato e il caso positivo non prova più nulla.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const [, , wasmDir, scenario] = process.argv;
if (!wasmDir || !scenario) {
  console.error('uso: node scripts/determinism-cross-version.mjs <wasmDir> <scenario>');
  console.error('scenari: freefall stack ccd ccd-off epa-near epa-far raycast-zero');
  process.exit(2);
}

const mod = await import(pathToFileURL(path.join(wasmDir, 'hyperion_core.js')).href);
const bytes = fs.readFileSync(path.join(wasmDir, 'hyperion_core_bg.wasm'));
// wasm-bindgen <= 0.2.108 accetta i byte grezzi; >= 0.2.126 vuole { module_or_path }.
try {
  await mod.default({ module_or_path: bytes });
} catch {
  await mod.default(bytes);
}

// Protocollo ring buffer: [type:u8][entityId:u32 LE][payload]
const C = {
  SpawnEntity: 1, SetPosition: 3, CreateRigidBody: 17, CreateCollider: 19,
  SetCCDEnabled: 24, ApplyImpulse: 26, SetColliderRestitution: 30,
  SetColliderFriction: 31,
};
const SIZES = { 1: 1, 3: 12, 17: 1, 19: 16, 24: 1, 26: 8, 30: 4, 31: 4 };

const cmds = [];
function push(type, entityId, fill) {
  const buf = Buffer.alloc(5 + SIZES[type]);
  buf.writeUInt8(type, 0);
  buf.writeUInt32LE(entityId, 1);
  if (fill) fill(buf, 5);
  cmds.push(buf);
}
const flush = () => {
  if (!cmds.length) return;
  mod.engine_push_commands(new Uint8Array(Buffer.concat(cmds)));
  cmds.length = 0;
};

const spawn2D = (id) => push(C.SpawnEntity, id, (b, o) => b.writeUInt8(1, o));
const pos = (id, x, y) => push(C.SetPosition, id, (b, o) => {
  b.writeFloatLE(x, o); b.writeFloatLE(y, o + 4); b.writeFloatLE(0, o + 8);
});
// kind: 0=dynamic 1=fixed 2=kinematic
const body = (id, t) => push(C.CreateRigidBody, id, (b, o) => b.writeUInt8(t, o));
// shape: 0=ball(r) 1=cuboid(w,h) 2=capsule(halfH,r)
const collider = (id, shape, p0, p1 = 0, p2 = 0) => push(C.CreateCollider, id, (b, o) => {
  b.writeUInt8(shape, o);
  b.writeFloatLE(p0, o + 1); b.writeFloatLE(p1, o + 5); b.writeFloatLE(p2, o + 9);
});
const ccd = (id, on) => push(C.SetCCDEnabled, id, (b, o) => b.writeUInt8(on ? 1 : 0, o));
const impulse = (id, x, y) => push(C.ApplyImpulse, id, (b, o) => {
  b.writeFloatLE(x, o); b.writeFloatLE(y, o + 4);
});
const restitution = (id, v) => push(C.SetColliderRestitution, id, (b, o) => b.writeFloatLE(v, o));
const friction = (id, v) => push(C.SetColliderFriction, id, (b, o) => b.writeFloatLE(v, o));

mod.engine_init();
const DT = 1 / 60;
let ticks = 600;

switch (scenario) {
  // Baseline: solo il core del solver, che rapier non ha toccato.
  case 'freefall':
    mod.engine_physics_configure(0, 980, 100);
    spawn2D(1); pos(1, 0, 0); body(1, 0); collider(1, 0, 10);
    break;

  case 'stack':
    mod.engine_physics_configure(0, 980, 100);
    spawn2D(1); pos(1, 0, 500); body(1, 1); collider(1, 1, 400, 20);
    for (let i = 0; i < 12; i++) {
      const id = 10 + i;
      spawn2D(id); pos(id, 0, 460 - i * 42); body(id, 0); collider(id, 1, 40, 40);
    }
    break;

  // parry #1: soglia small-TOI dello shape cast 1e-5 -> 1e-4.
  // `ccd-off` è il controllo: DEVE tunnelare, altrimenti `ccd` non prova nulla.
  case 'ccd':
  case 'ccd-off': {
    const on = scenario === 'ccd';
    mod.engine_physics_configure(0, 980, 100);
    spawn2D(1); pos(1, 0, 3000); body(1, 1); collider(1, 1, 4000, 3); // pavimento da 3px
    for (let i = 0; i < 6; i++) {
      const id = 10 + i;
      spawn2D(id); pos(id, -300 + i * 100, 0); body(id, 0);
      collider(id, 0, 6); ccd(id, on); restitution(id, 0.3);
      impulse(id, 0, 60000 + i * 4000);
    }
    ticks = 300;
    break;
  }

  // parry #2: tolleranza EPA delle facce degeneri ora scalata sulla magnitudine
  // dei vertici invece che assoluta. `epa-near` è il controllo all'origine.
  case 'epa-near':
  case 'epa-far': {
    const ox = scenario === 'epa-far' ? 10000 : 0;
    mod.engine_physics_configure(0, 980, 100);
    spawn2D(1); pos(1, ox, 600); body(1, 1); collider(1, 1, 600, 20);
    for (let i = 0; i < 8; i++) {
      const id = 10 + i;
      spawn2D(id); pos(id, ox, 565 - i * 48); body(id, 0);
      collider(id, 1, 50, 50); friction(id, 0.4);
    }
    ticks = 400;
    break;
  }

  // parry #3: raycast con direzione nulla dentro un AABB (prima andava in panic).
  case 'raycast-zero': {
    mod.engine_physics_configure(0, 0, 100);
    spawn2D(1); pos(1, 0, 0); body(1, 1); collider(1, 1, 100, 100);
    flush();
    mod.engine_update(DT);
    let outcome;
    try {
      outcome = `returned:${mod.engine_physics_raycast(0, 0, 0, 0, 1000)}`;
    } catch (e) {
      outcome = `THREW:${String(e).slice(0, 120)}`;
    }
    console.log(JSON.stringify({ scenario, outcome }));
    process.exit(0);
  }

  default:
    console.error(`scenario sconosciuto: ${scenario}`);
    process.exit(2);
}

flush();
for (let i = 0; i < ticks; i++) mod.engine_update(DT);

// Posizioni mondo dalla SoA dei transform (mat4, colonna 3 = traslazione).
let positions = [];
try {
  const ptr = mod.engine_gpu_transforms_ptr();
  const len = mod.engine_gpu_transforms_f32_len();
  if (len > 0) {
    const f32 = new Float32Array(mod.engine_memory().buffer, ptr, len);
    for (let i = 0; i + 16 <= len; i += 16) {
      positions.push([+f32[i + 12].toFixed(4), +f32[i + 13].toFixed(4)]);
    }
  }
} catch (e) {
  positions = [`ERR:${String(e).slice(0, 80)}`];
}

// Secondo oracolo indipendente dallo state hash: lo snapshot HSNP completo.
let snapDigest;
try {
  const snap = mod.engine_snapshot_create();
  snapDigest = `${snap.length}:${crypto.createHash('sha256')
    .update(Buffer.from(snap)).digest('hex').slice(0, 16)}`;
} catch (e) {
  snapDigest = `ERR:${String(e).slice(0, 60)}`;
}

console.log(JSON.stringify({
  scenario,
  hash: String(mod.engine_state_hash()),
  tick: String(mod.engine_tick_count()),
  bodies: mod.engine_physics_body_count(),
  snapDigest,
  positions,
}));
