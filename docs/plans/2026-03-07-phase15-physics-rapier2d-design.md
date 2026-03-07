# Phase 15 — Rapier2D Physics Integration: Design Document

> **Date**: 2026-03-07
> **Status**: Approved design, pending spike validation
> **Scope**: Full physics integration — rigid bodies, colliders, events, joints, character controller, debug rendering, snapshots
> **Rapier version**: 0.32.0 (released 2026-01-09)
> **Estimated effort**: ~8.5 weeks (spike through documentation)
> **Prerequisites**: Phase 14 complete (merged to master at `17bc7df`)

---

## 1. Motivation

Hyperion serves three markets: game engines, canvas applications, and desktop embedding. All three benefit from physics simulation:

- **Games**: Platformers, puzzle physics, ragdolls, projectiles
- **Canvas apps**: Snap-to-grid with physics-based settling, magnetic alignment, spring-connected nodes
- **Desktop embedding**: Data visualization with force-directed layouts, interactive simulations

The engine already has a SpatialGrid (TS-side) for hit-testing broadphase, but no rigid body simulation, collision detection/response, or constraint solving. Rapier2D provides all of these with proven WASM performance.

---

## 2. Rapier 0.32 — Key Changes from Masterplan SS16

The masterplan SS16 was written against Rapier 0.22. Ten major versions have shipped since. The changes are net positive for Hyperion.

### 2.1 nalgebra to glam Migration

| Aspect | Masterplan (0.22) | Rapier 0.32 |
|---|---|---|
| Math library | nalgebra (`Vector<f32>`, `Isometry2`) | glam + glamx (`Vec2`, `Pose2`, `Rot2`) |
| Hyperion conversion | Required: `glam::Vec3` -> `nalgebra::Vector2` | **ZERO** — Hyperion already uses glam |
| 2D rotation type | `Complex<f32>` | `Rot2` (glamx), `.angle() -> f32` |
| Vector macro | `nalgebra::vector![]` | `glamx::vector![]` (same syntax, different type) |

**Impact**: Eliminates the entire type conversion layer in `physics_sync_pre/post`. `Position.0` (`glam::Vec3`) passes directly to Rapier. `body.rotation().angle()` maps directly to `Transform2D.rotation`.

### 2.2 step() Signature Change

Rapier 0.32 uses 12 parameters (QueryPipeline removed from step):

```rust
physics_pipeline.step(
    &gravity,                    // &Vec2 (glam, not nalgebra)
    &integration_parameters,
    &mut island_manager,
    &mut broad_phase,
    &mut narrow_phase,
    &mut rigid_body_set,
    &mut collider_set,
    &mut impulse_joint_set,
    &mut multibody_joint_set,
    &mut ccd_solver,
    &physics_hooks,              // &() or &dyn PhysicsHooks
    &event_handler,              // &() or &dyn EventHandler
);

// QueryPipeline: ephemeral, obtained separately
let query_pipeline = broad_phase.as_query_pipeline();
```

### 2.3 Notable New Features in 0.23-0.32

| Feature | Version | Relevance |
|---|---|---|
| New BVH broadphase | 0.32 | Faster scene queries |
| Persistent islands | 0.32 | Less per-frame overhead |
| Manifold reduction (<=4 contacts) | 0.32 | Lighter solver |
| Block solver 2D + warmstarting | 0.28 | Better stacking |
| Soft CCD (predictive contacts) | 0.28 | Cheaper CCD alternative |
| 2-5x WASM performance | 0.32 | More frame budget headroom |

### 2.4 wasm-bindgen Feature

Rapier documents `wasm-bindgen` as a Cargo feature that "enables usage of rapier as a dependency of a WASM crate compiled with wasm-bindgen." It likely enables `web-time` for correct timing in WASM context. The spike will validate whether it's required.

```toml
rapier2d = { version = "0.32", features = ["simd-stable", "wasm-bindgen"], optional = true }
```

---

## 3. WASM Build Strategy — Hybrid (Feature Flag + TS Loader)

### 3.1 Decision

Single `hyperion-core` crate with `physics-2d` Cargo feature flag. Two WASM artifacts from the same source. The TS layer selects the correct binary at `Hyperion.create({ physics: '2d' })` time.

### 3.2 Why Not Separate WASM Modules

The retained-slot rendering pipeline (Phase 12) requires physics and ECS to share the same WASM linear memory. Specifically:

- `physics_sync_post` writes directly to ECS components (`Transform2D`, `Position`, `Rotation`)
- DirtyTracker marks slots dirty for GPU scatter upload
- `flush_pending_despawns()` must cascade to Rapier body removal

Separate WASM modules cannot share linear memory. This would require serializing all ECS state to physics, stepping, and deserializing back — defeating the zero-overhead integration.

### 3.3 Binary Size Estimate

| Factor | Direction | Estimate |
|---|---|---|
| Rapier 0.32 new features (voxels, BVH) | Larger | +20-40KB |
| glam migration (less nalgebra templates) | Smaller | -30-50KB |
| Shared glam dependency (deduplication via LTO) | Smaller | -10-20KB |
| `lto = "fat"` + `codegen-units = 1` (already configured) | Smaller | -10-15% |
| wasm-opt -O3 --enable-simd (already in pipeline) | Smaller | -5-10% |

**Estimate**: +250-350KB gzipped delta. Total with physics: ~310-410KB gzipped.

**Gate**: If delta exceeds 400KB gzipped, analyze with `twiggy` for tree-shaking opportunities.

### 3.4 Cargo.toml Changes

```toml
[features]
default = []
dev-tools = []
physics-2d = ["dep:rapier2d"]
physics-2d-deterministic = ["physics-2d", "rapier2d/enhanced-determinism"]
physics-serialization = ["physics-2d", "dep:bincode"]

[dependencies]
rapier2d = { version = "0.32", features = ["simd-stable", "wasm-bindgen"], optional = true }
bincode = { version = "2", optional = true }
```

### 3.5 Build Pipeline

```bash
# Without physics (current)
cd ts && npm run build:wasm
# -> ts/wasm/hyperion_core_bg.wasm (~60KB gzipped)

# With physics
cd ts && npm run build:wasm:physics
# -> ts/wasm-physics/hyperion_core_bg.wasm (~350KB gzipped)
```

TS loader (`wasm-loader.ts`) selects binary based on config:

```typescript
const wasmPath = config.physics === '2d'
  ? './wasm-physics/hyperion_core_bg.wasm'
  : './wasm/hyperion_core_bg.wasm';
```

---

## 4. Ring Buffer Protocol — Defaults + Override Commands

### 4.1 Design Principle

The ring buffer payload limit is 16 bytes. Physics commands decompose into small, self-contained messages:

- **Create commands**: Carry only the essential discriminant (body_type, shape_type). Everything else uses Rapier defaults.
- **Override commands**: Each sets a single property. Naturally coalescable (last-write-wins).
- **Force commands**: Additive, non-coalescable. Two `ApplyForce` in the same frame both execute.

### 4.2 PendingRigidBody Pattern

Commands arrive in any order during `process_commands()`. They accumulate on a `PendingRigidBody` component. Then `physics_sync_pre()` consumes the fully-configured pending into a real Rapier body in one shot.

```
Frame N (setup):
  process_commands():
    CreateRigidBody -> insert PendingRigidBody { body_type, ..defaults.. }
    SetGravityScale -> PendingRigidBody.gravity_scale = value
    SetLinearDamping -> PendingRigidBody.linear_damping = value
    CreateCollider -> insert PendingCollider { shape, ..defaults.. }
  physics_sync_pre():
    consume PendingRigidBody -> create Rapier body with all overrides applied
    consume PendingCollider -> create Rapier collider

Frame N+1 (runtime):
  process_commands():
    SetGravityScale -> entity has PhysicsBodyHandle -> modify Rapier body directly
```

The command processor branches:

```rust
// SetGravityScale handler
if let Ok(mut pending) = world.get::<&mut PendingRigidBody>(entity) {
    pending.gravity_scale = value;  // Not yet created
} else if let Ok(handle) = world.get::<&PhysicsBodyHandle>(entity) {
    physics.rigid_body_set[handle.0].set_gravity_scale(value, true);  // Already created
}
```

### 4.3 CommandType Allocation (14-39)

**Body commands (14-24): 11 commands**

| ID | Name | Payload | Coalescable |
|---|---|---|---|
| 14 | `CreateRigidBody` | 1B: body_type (0=dynamic, 1=fixed, 2=kinematic) | No (critical) |
| 15 | `DestroyRigidBody` | 0B | No (critical) |
| 16 | `CreateCollider` | 1-9B: shape_type + shape_params | No (critical) |
| 17 | `DestroyCollider` | 0B | No (critical) |
| 18 | `SetLinearDamping` | 4B: f32 | Yes |
| 19 | `SetAngularDamping` | 4B: f32 | Yes |
| 20 | `SetGravityScale` | 4B: f32 | Yes |
| 21 | `SetCCDEnabled` | 1B: u8 bool | Yes |
| 22 | `ApplyForce` | 8B: fx(f32) + fy(f32) | No (additive) |
| 23 | `ApplyImpulse` | 8B: ix(f32) + iy(f32) | No (additive) |
| 24 | `ApplyTorque` | 4B: f32 | No (additive) |

**Collider overrides (25-30): 6 commands**

| ID | Name | Payload | Coalescable |
|---|---|---|---|
| 25 | `SetColliderSensor` | 1B: u8 bool | Yes |
| 26 | `SetColliderDensity` | 4B: f32 | Yes |
| 27 | `SetColliderRestitution` | 4B: f32 | Yes |
| 28 | `SetColliderFriction` | 4B: f32 | Yes |
| 29 | `SetCollisionGroups` | 4B: membership(u16) + filter(u16) | Yes |
| 30 | *(reserved)* | | |

**Joints (31-37): 7 commands**

| ID | Name | Payload | Coalescable |
|---|---|---|---|
| 31 | `CreateRevoluteJoint` | 12B: entity_b(u32) + anchor_a_x(f32) + anchor_a_y(f32) | No (critical) |
| 32 | `CreatePrismaticJoint` | 12B: entity_b(u32) + axis_x(f32) + axis_y(f32) | No (critical) |
| 33 | `CreateFixedJoint` | 4B: entity_b(u32) | No (critical) |
| 34 | `CreateRopeJoint` | 8B: entity_b(u32) + max_dist(f32) | No (critical) |
| 35 | `RemoveJoint` | 0B | No (critical) |
| 36 | `SetJointMotor` | 8B: target_vel(f32) + max_force(f32) | Yes |
| 37 | `SetJointLimits` | 8B: min(f32) + max(f32) | Yes |

**Character controller (38-39): 2 commands**

| ID | Name | Payload | Coalescable |
|---|---|---|---|
| 38 | `MoveCharacter` | 8B: dx(f32) + dy(f32) | No (movement) |
| 39 | `SetCharacterConfig` | 12B: autostep_h(f32) + max_slope(f32) + snap(f32) | Yes |

**Total**: 26 commands, range 14-39. Plugin range shifts to 40-63. `MAX_COMMAND_TYPE` updates from 17 to 40.

Note on restitution/friction: These are **collider** properties in Rapier's model, not body properties. A single rigid body can have multiple colliders with different friction (e.g., character feet vs head). The command allocation reflects this correctly.

### 4.4 CreateCollider Shape Encoding

All shapes fit in 16-byte payload:

| Shape | shape_type | Params | Total payload |
|---|---|---|---|
| Circle | 0 | radius(f32) | 5B |
| Box | 1 | half_w(f32) + half_h(f32) | 9B |
| Capsule | 2 | half_h(f32) + radius(f32) | 9B |
| Segment | 3 | ax(f32) + ay(f32) + bx(f32) + by(f32) | 16B (exact limit) |
| Triangle | 4 | ax(f32) + ay(f32) + bx(f32) | 13B (c = origin) |

### 4.5 BackpressuredProducer Classification

The existing `BackpressuredProducer` classifies commands as `critical` (never coalesced) or `overwrites` (last-write-wins). Physics commands extend this:

```typescript
function isNonCoalescable(cmdType: number): boolean {
  // ECS critical
  if (cmdType === CommandType.SpawnEntity || cmdType === CommandType.DespawnEntity) return true;
  // Physics critical: Create/Destroy/Apply/Move
  if (cmdType >= 14 && cmdType <= 17) return true;  // Create/DestroyRigidBody/Collider
  if (cmdType >= 22 && cmdType <= 24) return true;  // ApplyForce/Impulse/Torque
  if (cmdType >= 31 && cmdType <= 35) return true;  // Joint create/remove
  if (cmdType === 38) return true;                   // MoveCharacter
  return false;
}
```

`ApplyForce` in the overwrites map would silently discard forces — two 100N forces in the same frame would produce 100N instead of 200N. This is a correctness invariant.

---

## 5. ECS Components

All physics components are behind `#[cfg(feature = "physics-2d")]`.

### 5.1 New Components

```rust
/// Pending rigid body creation — accumulates overrides before physics_sync_pre.
pub struct PendingRigidBody {
    pub body_type: u8,           // 0=dynamic, 1=fixed, 2=kinematic
    pub gravity_scale: f32,      // default 1.0
    pub linear_damping: f32,     // default 0.0
    pub angular_damping: f32,    // default 0.0
    pub ccd_enabled: bool,       // default false
}

/// Pending collider creation — consumed in physics_sync_pre.
pub struct PendingCollider {
    pub shape_type: u8,
    pub shape_params: [f32; 4],  // shape-dependent
    pub density: f32,            // default 1.0
    pub restitution: f32,        // default 0.0
    pub friction: f32,           // default 0.5
    pub is_sensor: bool,         // default false
    pub groups: u32,             // default 0xFFFF_FFFF (all groups)
}

/// Handle to a Rapier RigidBody. Present after physics_sync_pre consumes PendingRigidBody.
pub struct PhysicsBodyHandle(pub rapier2d::prelude::RigidBodyHandle);

/// Handle to a Rapier Collider. Present after physics_sync_pre consumes PendingCollider.
pub struct PhysicsColliderHandle(pub rapier2d::prelude::ColliderHandle);

/// Marker: this entity's position/rotation is driven by Rapier.
/// velocity_system skips entities with this marker.
pub struct PhysicsControlled;
```

Note: `PendingRigidBody` and `PendingCollider` are NOT `#[repr(C)]`/Pod — they are transient ECS components, never uploaded to GPU or serialized in snapshots.

### 5.2 Despawn Cleanup

When an entity with `PhysicsBodyHandle` is despawned, Rapier bodies/colliders/joints must be removed to prevent zombie objects:

```rust
// In process_commands, BEFORE world.despawn(entity):
#[cfg(feature = "physics-2d")]
if let Ok(handle) = world.get::<&PhysicsBodyHandle>(entity) {
    physics.rigid_body_set.remove(
        handle.0,
        &mut physics.island_manager,
        &mut physics.collider_set,
        &mut physics.impulse_joint_set,
        &mut physics.multibody_joint_set,
        true, // wake_up touching bodies
    );
}
```

Rapier's `remove()` on a rigid body automatically removes all attached colliders and joints. This cascading cleanup is a single call.

---

## 6. PhysicsWorld Struct

```rust
#[cfg(feature = "physics-2d")]
pub struct PhysicsWorld {
    pub gravity: glam::Vec2,
    pub integration_parameters: rapier2d::prelude::IntegrationParameters,
    pub physics_pipeline: rapier2d::prelude::PhysicsPipeline,
    pub island_manager: rapier2d::prelude::IslandManager,
    pub broad_phase: rapier2d::prelude::DefaultBroadPhase,
    pub narrow_phase: rapier2d::prelude::NarrowPhase,
    pub rigid_body_set: rapier2d::prelude::RigidBodySet,
    pub collider_set: rapier2d::prelude::ColliderSet,
    pub impulse_joint_set: rapier2d::prelude::ImpulseJointSet,
    pub multibody_joint_set: rapier2d::prelude::MultibodyJointSet,
    pub ccd_solver: rapier2d::prelude::CCDSolver,

    // Event collection
    collision_send: std::sync::mpsc::Sender<rapier2d::prelude::CollisionEvent>,
    collision_recv: std::sync::mpsc::Receiver<rapier2d::prelude::CollisionEvent>,
    force_send: std::sync::mpsc::Sender<rapier2d::prelude::ContactForceEvent>,
    force_recv: std::sync::mpsc::Receiver<rapier2d::prelude::ContactForceEvent>,

    // Frame event buffers (cleared at engine_update start, accumulate across multi-step)
    pub frame_collision_events: Vec<HyperionCollisionEvent>,
    pub frame_contact_force_events: Vec<HyperionContactForceEvent>,

    // Reverse map: ColliderHandle -> external entity ID
    pub collider_to_entity: Vec<Option<u32>>,

    // Character controller (optional)
    pub character_controller: Option<rapier2d::prelude::KinematicCharacterController>,
}

impl PhysicsWorld {
    pub fn new(pixels_per_meter: f32) -> Self {
        let mut params = IntegrationParameters::default();
        params.length_unit = pixels_per_meter;  // CRITICAL: default 100.0 for pixel space

        let (collision_send, collision_recv) = std::sync::mpsc::channel();
        let (force_send, force_recv) = std::sync::mpsc::channel();

        Self {
            gravity: glam::Vec2::new(0.0, -9.81 * pixels_per_meter),
            integration_parameters: params,
            // ... all sets initialized with ::new()
            collision_send, collision_recv,
            force_send, force_recv,
            frame_collision_events: Vec::new(),
            frame_contact_force_events: Vec::new(),
            collider_to_entity: Vec::new(),
            character_controller: None,
        }
    }
}
```

**Critical**: `length_unit` MUST be set to `pixels_per_meter` (default 100.0). Rapier's default is 1.0 (meters). Without this, sleeping thresholds and contact tolerance are calibrated for metric scale, making pixel-space simulation erratic.

---

## 7. Tick Loop Integration

### 7.1 Modified engine_update

```
engine_update(dt):
  0. physics.frame_collision_events.clear()        // auto-clear
     physics.frame_contact_force_events.clear()
  1. process_commands()                             // routes physics commands
  2. fixed_tick() x N:
     a. plugin pre-tick hooks
     b. physics_sync_pre()                          // Pending -> Rapier bodies
     c. rapier.step(12 params, &event_handler)      // simulate
     d. drain mpsc -> APPEND to frame event buffers
     e. physics_sync_post() DUAL PATH               // Rapier -> ECS
     f. velocity_system() (skip PhysicsControlled)
     g. velocity_system_2d() (skip PhysicsControlled)
     h. transform_system()
     i. transform_system_2d()
     j. propagate_transforms()
     k. plugin post-tick hooks
  3. mark_post_system_dirty() (extended)
  4. collect / staging
```

### 7.2 Dirty Marking — Two Levels

**Command-level** (automatic via `process_commands`): Physics override commands (SetGravityScale, etc.) that modify `PendingRigidBody` trigger dirty marking through the existing `process_commands(&mut render_state)` path.

**System-level** (`mark_post_system_dirty`): `physics_sync_post` writes directly to ECS components, bypassing `process_commands`. It requires explicit dirty marking. The existing function is extended:

```rust
fn mark_post_system_dirty(&mut self) {
    // Existing: velocity-driven entities
    for (entity, vel, _active) in world.query::<(Entity, &Velocity, &Active)>().iter() {
        if vel.0 != Vec3::ZERO { /* mark transform+bounds dirty */ }
    }

    // Existing: children of dirty parents
    for (entity, parent, _active) in world.query::<(Entity, &Parent, &Active)>().iter() {
        /* if parent is dirty, mark child dirty */
    }

    // NEW: physics-controlled entities with non-sleeping bodies
    #[cfg(feature = "physics-2d")]
    for (entity, handle, _controlled) in
        world.query::<(Entity, &PhysicsBodyHandle, &PhysicsControlled)>().iter()
    {
        if !physics.rigid_body_set[handle.0].is_sleeping() {
            if let Some(slot) = render_state.get_slot(entity) {
                render_state.dirty_tracker.mark_transform_dirty(slot as usize);
                render_state.dirty_tracker.mark_bounds_dirty(slot as usize);
            }
        }
    }
}
```

### 7.3 physics_sync_post Dual Path

```rust
#[cfg(feature = "physics-2d")]
fn physics_sync_post(world: &mut World, physics: &PhysicsWorld) {
    // Path 2D: entities with Transform2D + PhysicsControlled
    for (t2d, handle) in world
        .query_mut::<(&mut Transform2D, &PhysicsBodyHandle)>()
    {
        let body = &physics.rigid_body_set[handle.0];
        if body.is_sleeping() { continue; }
        let pos = body.translation();  // glam Vec2, zero conversion
        t2d.x = pos.x;
        t2d.y = pos.y;
        t2d.rotation = body.rotation().angle();  // Rot2 -> f32
    }

    // Path 3D: entities with Position + Rotation + PhysicsControlled
    for (pos, rot, handle) in world
        .query_mut::<(&mut Position, &mut Rotation, &PhysicsBodyHandle)>()
    {
        let body = &physics.rigid_body_set[handle.0];
        if body.is_sleeping() { continue; }
        let translation = body.translation();
        pos.0.x = translation.x;
        pos.0.y = translation.y;
        rot.0 = glam::Quat::from_rotation_z(body.rotation().angle());
    }
}
```

### 7.4 velocity_system Skip

Entities with `PhysicsControlled` are driven by Rapier, not by the ECS velocity system. The existing `velocity_system` and `velocity_system_2d` must exclude them:

```rust
// velocity_system: skip PhysicsControlled entities
for (pos, vel) in world
    .query_mut::<(&mut Position, &Velocity)>()
    .without::<&PhysicsControlled>()
{
    pos.0 += vel.0 * dt;
}
```

---

## 8. Collision Events — Rust to TypeScript

### 8.1 Event Structs

```rust
#[repr(C)]
pub struct HyperionCollisionEvent {
    pub entity_a: u32,       // 4
    pub entity_b: u32,       // 4
    pub event_type: u8,      // 1 (0=started, 1=stopped)
    pub is_sensor: u8,       // 1
    pub _pad: [u8; 2],       // 2
}   // total: 12 bytes, 4-byte aligned

#[repr(C)]
pub struct HyperionContactForceEvent {
    pub entity_a: u32,                  // 4
    pub entity_b: u32,                  // 4
    pub total_force_magnitude: f32,     // 4
    pub max_force_direction_x: f32,     // 4
    pub max_force_direction_y: f32,     // 4
}   // total: 20 bytes
```

### 8.2 Event Flow

1. `engine_update` clears both event Vecs at the top (before `process_commands`)
2. Each `rapier.step()` produces events via `ChannelEventCollector`
3. After step, drain mpsc receivers: translate `ColliderHandle` -> entity ID via `collider_to_entity` map, append to frame Vecs
4. Multiple fixed ticks accumulate into the same frame Vecs
5. After `engine_update` returns, Worker reads events

### 8.3 WASM Exports

```rust
// Collision events (12 bytes each)
#[wasm_bindgen] pub fn engine_collision_events_ptr() -> *const u8
#[wasm_bindgen] pub fn engine_collision_events_count() -> u32

// Contact force events (20 bytes each)
#[wasm_bindgen] pub fn engine_contact_force_events_ptr() -> *const u8
#[wasm_bindgen] pub fn engine_contact_force_events_count() -> u32
```

No `_clear()` export. Clearing is automatic at `engine_update` start.

### 8.4 Mode-Specific Transport

**Mode C (single thread)**: Direct WASM linear memory read after `engine_update`. Zero copies.

**Mode B/A (worker)**: Worker copies event buffer (`new Uint8Array(...).slice()`), sends via `postMessage` with `Transferable`. Copy is necessary because the WASM buffer is overwritten at next `engine_update`.

### 8.5 On-Demand Queries

```rust
// Synchronous queries — result written to static buffer, read by TS
#[wasm_bindgen] pub fn engine_physics_contact_info(entity_a: u32, entity_b: u32) -> *const u8
#[wasm_bindgen] pub fn engine_physics_raycast(ox: f32, oy: f32, dx: f32, dy: f32, max_toi: f32) -> *const u8
#[wasm_bindgen] pub fn engine_physics_raycast_count() -> u32
#[wasm_bindgen] pub fn engine_physics_overlap_aabb(min_x: f32, min_y: f32, max_x: f32, max_y: f32) -> *const u8
#[wasm_bindgen] pub fn engine_physics_overlap_count() -> u32
```

QueryPipeline is ephemeral: `broad_phase.as_query_pipeline()` at query time.

### 8.6 Buffer Sizing

Event Vecs use Rust's standard `Vec` growth (no fixed-size buffer). Worst case: 10k rigid bodies, ~500 events/frame = 6KB. The Vec grows once and stabilizes. Same philosophy as SoA buffers.

---

## 9. TypeScript API

### 9.1 EntityHandle Fluent API

```typescript
const player = engine.spawn()
  .position(100, 200, 0)
  .rigidBody('dynamic')                           // CreateRigidBody: 1B
  .gravityScale(1.0)                              // SetGravityScale: 4B
  .linearDamping(0.5)                             // SetLinearDamping: 4B
  .collider('box', { width: 32, height: 48 })     // CreateCollider: 9B
  .colliderFriction(0.8)                          // SetColliderFriction: 4B
  .colliderRestitution(0.3);                      // SetColliderRestitution: 4B

// Forces (runtime)
player.applyForce(0, 500);                        // ApplyForce: 8B
player.applyImpulse(100, 0);                      // ApplyImpulse: 8B

// Joints
const wheel = engine.spawn()
  .position(100, 180, 0)
  .rigidBody('dynamic')
  .collider('circle', { radius: 8 })
  .revoluteJoint(player, { anchorX: 0, anchorY: -20 });  // CreateRevoluteJoint: 12B

// Character controller
const hero = engine.spawn()
  .position(50, 300, 0)
  .rigidBody('kinematic')
  .collider('capsule', { halfHeight: 16, radius: 8 })
  .characterController({ autostepHeight: 4, maxSlope: 0.8 });

hero.moveCharacter(dx * speed, dy * speed);       // MoveCharacter: 8B
```

### 9.2 PhysicsAPI (on Hyperion facade)

```typescript
// Collision callbacks
engine.physics.onCollisionStart((entityA, entityB, isSensor) => { ... });
engine.physics.onCollisionEnd((entityA, entityB, isSensor) => { ... });
engine.physics.onContactForce((entityA, entityB, force, dirX, dirY) => { ... });

// Scene queries
const hit = engine.physics.raycast(originX, originY, dirX, dirY, maxDistance);
// hit: { entityId, toi, normalX, normalY } | null

const entities = engine.physics.queryAABB(minX, minY, maxX, maxY);
// entities: number[]

// On-demand contact info
const contact = engine.physics.getContactInfo(entityA, entityB);
// contact: { normalX, normalY, penetration } | null

// Character query
const grounded = engine.physics.isGrounded(entityId);

// Debug rendering
engine.physics.debugDraw = true;  // toggle wireframe overlay

// Config
engine.physics.gravity = { x: 0, y: -981 };
```

### 9.3 Hyperion.create Config

```typescript
const engine = await Hyperion.create({
  canvas: document.getElementById('game'),
  maxEntities: 100_000,
  physics: '2d',           // false (default) | '2d'
  physicsConfig: {
    pixelsPerMeter: 100,   // length_unit, default 100
    gravity: { x: 0, y: -981 },
  },
});
```

---

## 10. Snapshot Integration

### 10.1 Component Mask — Breaking Change

The existing snapshot format uses `component_mask: u16` with 15 component types. Physics adds:

- bit 15: `PhysicsControlled` (marker, 0 bytes)
- bit 16+: `PhysicsBodyHandle`, `PhysicsColliderHandle` would overflow u16

**Decision**: Upgrade `component_mask` to `u32`. This is a breaking change to the snapshot format (version 1 -> version 2).

- `PendingRigidBody` and `PendingCollider` are NOT serialized (they should be consumed before any snapshot)
- Rapier state is serialized separately via `bincode` (behind `physics-serialization` feature flag)
- Version 2 snapshots include a `physics_blob_len: u32` + raw bytes for the Rapier state

### 10.2 Physics Snapshot

```rust
#[cfg(all(feature = "physics-2d", feature = "physics-serialization"))]
pub fn physics_snapshot(&self) -> Vec<u8> {
    // Serialize: rigid_body_set, collider_set, joint sets, island_manager, etc.
    bincode::encode_to_vec(&self.physics, bincode::config::standard()).unwrap()
}

#[cfg(all(feature = "physics-2d", feature = "physics-serialization"))]
pub fn physics_restore(&mut self, data: &[u8]) -> bool {
    match bincode::decode_from_slice(data, bincode::config::standard()) {
        Ok((state, _)) => { self.physics = state; true }
        Err(_) => false,
    }
}
```

---

## 11. Debug Rendering

Custom `generate_physics_debug_lines()` in Rust (NOT Rapier's DebugRenderPipeline — too heavy):

- Ball -> circle (N line segments)
- Cuboid -> rectangle (4 segments)
- Capsule -> rectangle + semicircles
- Color by body type: dynamic=green, fixed=red, kinematic=blue
- Color by state: sleeping=gray, sensor=yellow transparent

WASM exports:
```rust
#[wasm_bindgen] pub fn engine_physics_debug_vertices_ptr() -> *const f32
#[wasm_bindgen] pub fn engine_physics_debug_vertices_count() -> u32
```

Rendered as a separate post-processing pass using the existing instanced line rendering (Phase 5.5). Toggle via `engine.physics.debugDraw`.

---

## 12. Deviations from Masterplan SS16

| Masterplan SS16 | This Design | Reason |
|---|---|---|
| Rapier 0.22 | Rapier 0.32 | 10 major versions of improvements; glam native eliminates conversion |
| nalgebra types | glam types (zero conversion) | Rapier 0.32 migrated to glam |
| 13-param step() | 12-param step() | QueryPipeline removed from step(), now ephemeral |
| Single Position/Rotation sync path | Dual path: Transform2D + Position/Rotation | Transform2D archetype added in Phase 13 |
| No DirtyTracker mention | DirtyTracker integration required | Scatter upload added in Phase 12 |
| No command coalescing mention | isNonCoalescable() classification | Command coalescing added in Phase 13 |
| Spatial Grid in Rust core | Eliminated | TS SpatialGrid (Phase 11) covers UI picking; Rapier BVH covers physics queries |
| CreateRigidBody 28B monolithic | Defaults + 26 override commands (14-39) | 16B payload limit; coalescing compatibility |
| component_mask u16 | component_mask u32 | Physics components exceed 16-bit mask |
| Plugin CommandType range 32-63 | Plugin range 40-63 | Physics uses 14-39 |
| Separate `_clear()` export | Auto-clear at engine_update start | Multi-step frame accumulation |
| Restitution/friction as body props | Restitution/friction as collider props | Correct Rapier semantics (per-collider) |

---

## 13. Feasibility Spike — rapier-spike

### 13.1 Scope

A minimal `crates/rapier-spike` crate (like `crates/loro-spike`) that validates 11 unknowns:

1. Binary size without `wasm-bindgen` feature
2. Binary size with `wasm-bindgen` feature
3. Delta vs current `hyperion-core`
4. `step()` signature (12 params confirmed?)
5. `broad_phase.as_query_pipeline()` exists?
6. Gravity type: `glam::Vec2` or `glamx::Vec2`?
7. Body rotation type: `Rot2` with `.angle() -> f32`?
8. Body translation type: `glam::Vec2`?
9. `IntegrationParameters::length_unit` field exists?
10. `ChannelEventCollector` with mpsc compiles?
11. `wasm-bindgen` feature: required for timing?

### 13.2 Gate

- Delta < 400KB gzipped -> **GO**, proceed to implementation
- Delta 400-500KB gzipped -> Analyze with `twiggy`, evaluate tree-shaking
- Delta > 500KB gzipped -> Re-evaluate approach (unlikely given Rapier's WASM track record)

### 13.3 Output

Report with concrete numbers replacing all estimates in this document.

---

## 14. Milestones

| Milestone | Content | Effort | Cumulative |
|---|---|---|---|
| **15-spike** | rapier-spike crate, 11-point validation report | 1 day | 1 day |
| **15-design** | Update this doc with real numbers from spike | 2-3 days | ~4 days |
| **15a** | Protocol + scaffolding (CommandTypes 14-39, dual build, PendingBody components) | 1 week | ~1.5 weeks |
| **15b** | Core simulation (step, sync dual-path, DirtyTracker, despawn cleanup) | 2 weeks | ~3.5 weeks |
| **15c** | Events + scene queries (collision callbacks, raycast, overlap) | 1 week | ~4.5 weeks |
| **15d** | Joints (revolute, prismatic, fixed, rope/spring, motor, limits) | 1 week | ~5.5 weeks |
| **15e** | Character controller + PhysicsHooks (autostep, slope, grounded) | 1 week | ~6.5 weeks |
| **15f** | Debug rendering (wireframe collider shapes, instanced lines) | 0.5 week | ~7 weeks |
| **15g** | Snapshot + determinism (bincode, component_mask u32, time-travel) | 0.5 week | ~7.5 weeks |
| **15h** | Benchmarks + verification harness tab 9 (6 checks) + CLAUDE.md | 0.5 week | ~8 weeks |
| **15-final** | Documentation (PROJECT_ARCHITECTURE, masterplan, physics-api guide) | 0.5 week | ~8.5 weeks |

### Verification Harness — Tab 9 "Physics"

| Check | Description |
|---|---|
| Rigid body + gravity | Ball falls under gravity, position updates |
| Collision events | Two bodies collide, callback fires |
| Raycast hit | Ray hits a collider, returns entity ID |
| Joint constraints | Revolute joint holds two bodies together |
| Character grounded | Character on platform reports grounded=true |
| Debug rendering | Wireframe shapes visible when toggled |

### Test Budget

| Milestone | Rust tests | TS tests |
|---|---|---|
| 15a | 10+ | 8+ |
| 15b | 20+ | 15+ |
| 15c | 12+ | 10+ |
| 15d | 8+ | 6+ |
| 15e | 8+ | 5+ |
| 15f | 4+ | 2+ |
| 15g | 4+ | 2+ |
| 15h | benchmarks | integration |
| **Total** | **66+** | **48+** |
