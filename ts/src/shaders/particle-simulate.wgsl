// particle-simulate.wgsl — GPU particle simulation compute shader
//
// Each particle: position(2f), velocity(2f), color(4f), lifetime(f), age(f), size(f), pad(f)
// Total: 12 f32 = 48 bytes per particle

struct Particle {
  position: vec2f,
  velocity: vec2f,
  color: vec4f,
  lifetime: f32,
  age: f32,
  size: f32,
  _pad: f32,
}

struct EmitterConfig {
  emitterPos: vec2f,
  dt: f32,
  emissionRate: f32,
  lifetimeMin: f32,
  lifetimeMax: f32,
  velocityMinX: f32,
  velocityMinY: f32,
  velocityMaxX: f32,
  velocityMaxY: f32,
  colorStartR: f32,
  colorStartG: f32,
  colorStartB: f32,
  colorStartA: f32,
  colorEndR: f32,
  colorEndG: f32,
  colorEndB: f32,
  colorEndA: f32,
  sizeStart: f32,
  sizeEnd: f32,
  gravityX: f32,
  gravityY: f32,
  maxParticles: u32,
  spawnCount: u32,
  _pad0: u32,
  _pad1: u32,
}

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> config: EmitterConfig;
@group(0) @binding(2) var<storage, read_write> counter: array<atomic<u32>>;

fn pcg_hash(input: u32) -> u32 {
  var state = input * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn rand_f32(seed: u32) -> f32 {
  return f32(pcg_hash(seed)) / 4294967295.0;
}

fn rand_range(seed: u32, lo: f32, hi: f32) -> f32 {
  return lo + rand_f32(seed) * (hi - lo);
}

@compute @workgroup_size(64)
fn simulate(@builtin(global_invocation_id) id: vec3u) {
  let idx = id.x;
  if (idx >= config.maxParticles) { return; }

  var p = particles[idx];

  if (p.age >= p.lifetime && p.lifetime > 0.0) { return; }
  if (p.lifetime <= 0.0) { return; }

  p.age += config.dt;

  if (p.age >= p.lifetime) {
    particles[idx] = p;
    return;
  }

  p.velocity += vec2f(config.gravityX, config.gravityY) * config.dt;
  p.position += p.velocity * config.dt;

  let t = clamp(p.age / p.lifetime, 0.0, 1.0);
  p.color = mix(
    vec4f(config.colorStartR, config.colorStartG, config.colorStartB, config.colorStartA),
    vec4f(config.colorEndR, config.colorEndG, config.colorEndB, config.colorEndA),
    t,
  );
  p.size = mix(config.sizeStart, config.sizeEnd, t);

  particles[idx] = p;
  atomicAdd(&counter[0], 1u);
}

@compute @workgroup_size(64)
fn spawn(@builtin(global_invocation_id) id: vec3u) {
  let spawnIdx = id.x;
  if (spawnIdx >= config.spawnCount) { return; }

  let startSlot = pcg_hash(spawnIdx * 1000u + atomicLoad(&counter[1])) % config.maxParticles;
  var slot = startSlot;
  for (var i = 0u; i < config.maxParticles; i++) {
    let candidate = (slot + i) % config.maxParticles;
    let p = particles[candidate];
    if (p.lifetime <= 0.0 || p.age >= p.lifetime) {
      let seed = pcg_hash(spawnIdx * 7919u + candidate * 6271u);
      var np: Particle;
      np.position = config.emitterPos;
      np.velocity = vec2f(
        rand_range(seed, config.velocityMinX, config.velocityMaxX),
        rand_range(seed + 1u, config.velocityMinY, config.velocityMaxY),
      );
      np.color = vec4f(config.colorStartR, config.colorStartG, config.colorStartB, config.colorStartA);
      np.lifetime = rand_range(seed + 2u, config.lifetimeMin, config.lifetimeMax);
      np.age = 0.0;
      np.size = config.sizeStart;
      np._pad = 0.0;
      particles[candidate] = np;
      atomicAdd(&counter[1], 1u);
      return;
    }
  }
}
